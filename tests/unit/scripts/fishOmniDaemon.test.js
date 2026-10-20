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
    const result = spawnSync(candidate, ['-c', 'import numpy, soundfile, sys; sys.exit(0)'], {
      encoding: 'utf8',
    });
    if (result.status === 0) return candidate;
  }
  return null;
};

const python = findPython();
const itWithPython = python ? it : it.skip;

// Runs scripts/fish_omni_daemon.py against a stand-in vLLM-Omni server whose
// replies are scripted per test: each reply is [status, seconds of tone,
// seconds of leading silence], consumed in order.
const runHarness = ({ engine, model, replies, text }) => {
  const script = `
import base64, io, json, os, sys, tempfile, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import numpy as np
import soundfile as sf

config = json.loads(sys.stdin.read())
replies = list(config["replies"])
requests = []

def tone(seconds, silence):
    rate = 44100
    t = np.arange(int(seconds * rate)) / rate
    audio = np.concatenate([np.zeros(int(silence * rate)), 0.3 * np.sin(2 * np.pi * 220 * t)])
    buffer = io.BytesIO()
    sf.write(buffer, audio.astype("float32"), rate, format="WAV", subtype="PCM_16")
    return buffer.getvalue()

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def _send(self, status, body, kind):
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        self._send(200, json.dumps({"data": [{"id": config["model"]}]}).encode(), "application/json")
    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        requests.append(payload)
        status, seconds, silence = replies.pop(0)
        if status != 200:
            self._send(status, b'{"error": "speaker tag out of range"}', "application/json")
        else:
            self._send(200, tone(seconds, silence), "audio/wav")

server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()

workdir = tempfile.mkdtemp()
clone_dir = os.path.join(workdir, "aurochs")
os.makedirs(clone_dir)
with open(os.path.join(clone_dir, "reference.wav"), "wb") as f:
    f.write(tone(2.0, 0.0))
with open(os.path.join(clone_dir, "metadata.json"), "w") as f:
    json.dump({"clone_id": "aurochs", "transcript": "The words in the clip."}, f)

os.environ.update({
    "FISH_OMNI_ENGINE": config["engine"],
    "FISH_OMNI_URL": f"http://127.0.0.1:{server.server_address[1]}",
    "FISH_OMNI_MODEL": config["model"],
    "FISH_TTS_VOICE_CLONES_DIR": workdir,
})
sys.path.insert(0, ${JSON.stringify(join(repoRoot, 'scripts'))})
import fish_omni_daemon as omni

daemon = (omni.OmniDrama3TTSDaemon if config["engine"] == "drama3" else omni.OmniFishTTSDaemon)()
assert daemon.load_model()
output = os.path.join(workdir, "out.wav")
result = daemon.generate_with_clone(config["text"], "aurochs", output)
duration = sf.info(output).duration if result.get("success") else None
for request in requests:
    request["ref_audio"] = request.get("ref_audio", "")[:22]
print(json.dumps({"result": result, "requests": requests, "duration": duration}))
`;
  const run = spawnSync(python, ['-c', script], {
    input: JSON.stringify({ engine, model, replies, text }),
    encoding: 'utf8',
  });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout.trim().split('\n').pop());
};

const twoChunks = `${'One sentence that is long enough to matter here. '.repeat(3).trim()} `
  + `${'Another sentence that fills the second chunk too. '.repeat(2).trim()}`;

describe('fish_omni_daemon.py', () => {
  itWithPython('renders an S2 clone chunk by chunk with the reference and transcript', () => {
    const { result, requests, duration } = runHarness({
      engine: 's2',
      model: 'fishaudio/s2-pro',
      replies: [[200, 1.0, 0], [200, 1.0, 0]],
      text: twoChunks,
    });
    expect(result.success).toBe(true);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request).toMatchObject({
        model: 'fishaudio/s2-pro',
        ref_audio: 'data:audio/wav;base64,',
        ref_text: 'The words in the clip.',
        extra_params: { temperature: 0.7 },
      });
      expect(request.max_new_tokens).toBe(Math.max(256, 3 * Buffer.byteLength(request.input)));
    }
    // Two 1 s chunks joined by the daemon's 0.12 s pause.
    expect(duration).toBeCloseTo(2.12, 1);
  });

  itWithPython('samples an S2 chunk again, tighter, when it fills its frame budget', () => {
    const text = 'Short line.';
    const { result, requests } = runHarness({
      engine: 's2',
      model: 'fishaudio/s2-pro',
      // 256 frames is the floor budget: 11.9 s of audio means it never stopped.
      replies: [[200, 12.0, 0], [200, 1.0, 0]],
      text,
    });
    expect(result.success).toBe(true);
    expect(requests.map((r) => r.extra_params)).toEqual([
      { temperature: 0.7 },
      { temperature: 0.5, top_p: 0.6, top_k: 20 },
    ]);
  });

  itWithPython('re-renders a Drama 3 chunk that stalls into silence', () => {
    const { result, requests, duration } = runHarness({
      engine: 'drama3',
      model: 'fishaudio/drama-3',
      replies: [[200, 1.0, 3.0], [200, 1.0, 0]],
      text: '[sighs] Fine. Have it your way.',
    });
    expect(result.success).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      model: 'fishaudio/drama-3',
      max_new_tokens: 600,
      extra_params: { temperature: 1.0, top_p: 0.9 },
    });
    expect(duration).toBeCloseTo(1.0, 1);
  });

  itWithPython('reports a Drama 3 request the server rejects as invalid input', () => {
    const { result } = runHarness({
      engine: 'drama3',
      model: 'fishaudio/drama-3',
      replies: [[400, 0, 0]],
      text: '<|speaker:1|> Who am I?',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^invalid input: /);
  });

  itWithPython('rejects text drama3-mlx rejects, before calling the server', () => {
    for (const text of ['<|speaker:16|> Who am I?', 'Done.<|im_end|>', '<|speaker:03|> Hi.']) {
      const { result, requests } = runHarness({
        engine: 'drama3',
        model: 'fishaudio/drama-3',
        replies: [],
        text,
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/^invalid input: text: /);
      expect(requests).toHaveLength(0);
    }
  });

  itWithPython('splits a long Drama 3 scene by speaker like drama3-mlx and joins it without pauses', () => {
    const line = 'This line is long enough that a few of them fill a chunk. ';
    const text = [0, 1, 2, 3].map((speaker) => `<|speaker:${speaker}|> ${line.repeat(3)}`).join('\n');
    const { result, requests, duration } = runHarness({
      engine: 'drama3',
      model: 'fishaudio/drama-3',
      replies: Array.from({ length: 8 }, () => [200, 1.0, 0]),
      text,
    });
    expect(result.success).toBe(true);
    // 4 speakers × 177 bytes: at most 300 bytes and 3 speakers per chunk.
    expect(requests).toHaveLength(4);
    for (const request of requests) {
      expect(Buffer.byteLength(request.input)).toBeLessThanOrEqual(300);
      expect(request.max_new_tokens).toBe(600);
    }
    expect(duration).toBeCloseTo(4.0, 1);
  });
});

describe('parakeet_transformers_daemon.py helpers', () => {
  itWithPython('groups tokens into sentences and cuts long audio at a quiet spot', () => {
    const script = `
import json, sys
from types import SimpleNamespace as T
import numpy as np
sys.path.insert(0, ${JSON.stringify(join(repoRoot, 'scripts'))})
from parakeet_transformers_daemon import quietest_cut, sentences_from_tokens

tokens = [T(text="Hel", start=0.0, end=0.2), T(text="lo.", start=0.2, end=0.4),
          T(text=" How", start=0.5, end=0.7), T(text=" are", start=0.7, end=0.8),
          T(text=" you?", start=0.8, end=1.0), T(text=" Fine", start=1.2, end=1.4)]
sentences = [vars(s) for s in sentences_from_tokens(tokens)]

rate = 16000
audio = np.full(rate * 30, 0.5, dtype=np.float32)
audio[rate * 25 : rate * 25 + rate // 10] = 0.0
cut = quietest_cut(audio, 0, rate * 28, rate)
print(json.dumps({"sentences": sentences, "cut_seconds": cut / rate}))
`;
    const run = spawnSync(python, ['-c', script], { encoding: 'utf8' });
    if (run.status !== 0) throw new Error(run.stderr);
    const { sentences, cut_seconds: cutSeconds } = JSON.parse(run.stdout);
    expect(sentences).toEqual([
      { text: 'Hello.', start: 0.0, end: 0.4 },
      { text: 'How are you?', start: 0.5, end: 1.0 },
      { text: 'Fine', start: 1.2, end: 1.4 },
    ]);
    expect(cutSeconds).toBeCloseTo(25.05, 2);
  });

  itWithPython('keeps words apart at window boundaries and offsets each window', () => {
    const script = `
import json, sys
from types import SimpleNamespace as T
sys.path.insert(0, ${JSON.stringify(join(repoRoot, 'scripts'))})
from parakeet_transformers_daemon import TranscriptionResult

windows = {"w1": (["Hello there."], [{"token": "Hello", "start": 0.0, "end": 0.4}, {"token": " there.", "start": 0.4, "end": 0.9}]),
           "w2": (["General Kenobi."], [{"token": "General", "start": 0.1, "end": 0.6}, {"token": " Kenobi.", "start": 0.6, "end": 1.1}])}

class Processor:
    def batch_decode(self, sequences, skip_special_tokens=True):
        return windows[sequences][0]
    def decode(self, sequences, durations=None, skip_special_tokens=True):
        return windows[sequences][0], [windows[sequences][1]]

result = TranscriptionResult(Processor(), [(T(sequences="w1", durations=None), 0.0),
                                           (T(sequences="w2", durations=None), 120.0)])
print(json.dumps({"text": result.text, "tokens": [vars(t) for t in result.tokens],
                  "sentences": [vars(s) for s in result.sentences]}))
`;
    const run = spawnSync(python, ['-c', script], { encoding: 'utf8' });
    if (run.status !== 0) throw new Error(run.stderr);
    const { text, tokens, sentences } = JSON.parse(run.stdout);
    expect(text).toBe('Hello there. General Kenobi.');
    expect(tokens[2]).toEqual({ text: ' General', start: 120.1, end: 120.6 });
    expect(sentences.map((sentence) => sentence.text)).toEqual(['Hello there.', 'General Kenobi.']);
  });
});
