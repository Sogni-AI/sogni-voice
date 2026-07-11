import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

const findPython = () => {
  const candidates = [
    process.env.PYTHON,
    join(repoRoot, '.venv/bin/python'),
    'python3',
    'python',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['-c', 'import numpy, sys; sys.exit(0)'], {
      encoding: 'utf8',
    });
    if (result.status === 0) return candidate;
  }
  return null;
};

const python = findPython();
const itWithPython = python ? it : it.skip;

const prompt = [
  'If you’re using Hermes Agent you should be following ',
  '@tonbistudio',
  ' and watching his Masterclass series - some of the best content you’ll find on Hermes Agent',
  '',
  'Need to tell my agent to dedicate a page to this masterclass series on Hermes Atlas',
].join('\n');

const runHarness = (mode, text = prompt) => {
  const script = `
import importlib.util
import io
import json
import os
import sys
import tempfile
import wave

import numpy as np

spec = importlib.util.spec_from_file_location(
    'fish_tts_daemon',
    ${JSON.stringify(join(repoRoot, 'scripts/fish_tts_daemon.py'))},
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
request = json.loads(sys.stdin.read())

def encode_wav(audio, sample_rate):
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype('<i2')
    output = io.BytesIO()
    with wave.open(output, 'wb') as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm.tobytes())
    return output.getvalue()

class StubServer:
    def __init__(self):
        self.calls = []
        self.last_audio = None

    def synthesize(self, payload):
        self.calls.append(payload['input'])
        audio = np.full((441,), len(self.calls) / 10.0, dtype=np.float32)
        self.last_audio = encode_wav(audio, 44100)
        return self.last_audio, 'audio/wav', {
            'audio_seconds': 0.01,
            'gen_seconds': 0.1,
            'rtf': 10.0,
        }

with tempfile.TemporaryDirectory() as temp_dir:
    daemon = module.FishTTSDaemon()
    daemon._np = np
    daemon._encode_wav = encode_wav
    output_path = os.path.join(temp_dir, 'output.wav')

    if request['mode'] == 'default':
        server = StubServer()
        daemon.server = server
        result = daemon.generate(request['text'], output_path)
        calls = server.calls
    else:
        reference_path = os.path.join(temp_dir, 'reference.wav')
        with open(reference_path, 'wb') as reference_file:
            reference_file.write(b'reference')
        daemon.model = object()
        daemon.server = object()
        daemon._reference_path = lambda _clone_id: reference_path
        daemon._load_audio = lambda _path, _sample_rate: np.zeros((441,), dtype=np.float32)
        daemon._read_transcript = lambda _clone_id: 'Reference words.'
        calls = []
        def synthesize_reference(text, _ref_audio, _ref_text, _max_tokens, _temperature):
            calls.append(text)
            return np.full((441,), len(calls) / 10.0, dtype=np.float32)
        daemon._synthesize_with_reference = synthesize_reference
        result = daemon.generate_with_clone(
            request['text'], 'test_clone', output_path
        )

    with wave.open(output_path, 'rb') as wav_file:
        frames = wav_file.getnframes()
        sample_rate = wav_file.getframerate()
        channels = wav_file.getnchannels()
    with open(output_path, 'rb') as output_file:
        output_bytes = output_file.read()
    passthrough = (
        output_bytes == server.last_audio if request['mode'] == 'default' else None
    )

print(json.dumps({
    'calls': calls,
    'result': result,
    'frames': frames,
    'sample_rate': sample_rate,
    'channels': channels,
    'passthrough': passthrough,
}))
`;
  const result = spawnSync(python, ['-c', script], {
    input: JSON.stringify({ mode, text }),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`Fish generation harness failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
};

const expectedChunks = [
  'If you’re using Hermes Agent you should be following at tonbistudio and watching his Masterclass series - some of the best content you’ll find on Hermes Agent',
  'Need to tell my agent to dedicate a page to this masterclass series on Hermes Atlas',
];

describe('fish_tts_daemon chunk generation', () => {
  itWithPython('renders and joins every prepared chunk for the default voice', () => {
    const output = runHarness('default');

    expect(output.calls).toEqual(expectedChunks);
    expect(output.result.success).toBe(true);
    expect(output.frames).toBe((441 * 2) + Math.floor(44100 * 0.12));
    expect(output.sample_rate).toBe(44100);
    expect(output.channels).toBe(1);
  });

  itWithPython('renders and joins every prepared chunk for a cloned voice', () => {
    const output = runHarness('clone');

    expect(output.calls).toEqual(expectedChunks);
    expect(output.result.success).toBe(true);
    expect(output.frames).toBe((441 * 2) + Math.floor(44100 * 0.12));
    expect(output.sample_rate).toBe(44100);
    expect(output.channels).toBe(1);
  });

  itWithPython('keeps short text to one generation without adding a pause', () => {
    for (const mode of ['default', 'clone']) {
      const output = runHarness(mode, 'Short sentence.');

      expect(output.calls).toEqual(['Short sentence.']);
      expect(output.result.success).toBe(true);
      expect(output.frames).toBe(441);
    }
    expect(runHarness('default', 'Short sentence.').passthrough).toBe(true);
  });
});
