import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const daemonPath = fileURLToPath(new URL('../../../scripts/nemotron_daemon.py', import.meta.url));
const run = (body) => {
  const result = spawnSync('python3', ['-c', `
import importlib.util, json, io, wave
from types import SimpleNamespace
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('nemotron', ${JSON.stringify(daemonPath)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
${body}
`], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
};

describe('Nemotron transcription contract', () => {
  it('keeps speaker changes and sentence boundaries without losing aligned words', () => {
    const result = run(`
words = [
    {'text': 'Hello', 'start': 0.1, 'end': 0.3, 'speaker': 'S01'},
    {'text': 'there.', 'start': 0.3, 'end': 0.6, 'speaker': 'S01'},
    {'text': 'Yes', 'start': 0.8, 'end': 1.0, 'speaker': 'S02'},
    {'text': 'okay', 'start': 1.1, 'end': 1.3, 'speaker': 'S01'},
]
print(json.dumps(module.sentence_segments(words)))
`);
    expect(result).toEqual([
      { text: 'Hello there.', start: 0.1, end: 0.6, speaker: 'S01' },
      { text: 'Yes', start: 0.8, end: 1, speaker: 'S02' },
      { text: 'okay', start: 1.1, end: 1.3, speaker: 'S01' },
    ]);
  });

  it('parses untimed native speaker tags without fabricating timestamp fields', () => {
    expect(run(`print(json.dumps(module.speaker_segments('<spk:0> Hi. <spk:7> Hello.')))`))
      .toEqual([{ speaker: 'S01', text: 'Hi.' }, { speaker: 'S08', text: 'Hello.' }]);
  });

  const fakeDecode = `
def decode(args, **kwargs):
    with wave.open(args[-1], 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(bytes(32000))
    return SimpleNamespace(returncode=0)
daemon = module.NemotronDaemon()
daemon.backend = 'vllm'
`;

  it('uses NVIDIA audio chat, preserves cap status, and converts native word timestamps', () => {
    const result = run(`${fakeDecode}
sent = []
def respond(request, **kwargs):
    sent.append(json.loads(request.data))
    return io.StringIO(json.dumps({
        'choices': [{'message': {'content': '<spk:0> Hello'}, 'finish_reason': 'length'}],
        'usage': {'completion_tokens': 64},
        'ctc_timestamps': {'error': None, 'words': [
            {'word': 'Hello', 'start': 0.2, 'end': 0.6, 'speaker': '<spk:0>'}
        ]}
    }))
with patch.object(module.subprocess, 'run', decode), patch.object(module, 'urlopen', respond):
    result = daemon.transcribe({'audio_path': '/tmp/input.webm', 'diarize': True,
                               'word_timestamps': True, 'max_new_tokens': 64})
print(json.dumps({'result': result, 'sent': sent[0]}))
`);
    expect(result.sent).toMatchObject({
      temperature: 0, max_tokens: 64, skip_special_tokens: false,
      chat_template_kwargs: { enable_thinking: false },
      mm_processor_kwargs: { capture_ctc_timestamps: true },
    });
    expect(result.sent.messages[0].content[1].audio_url.url).toMatch(/^data:audio\/wav;base64,/);
    expect(result.result).toMatchObject({
      finish_reason: 'length', metrics: { audioSeconds: 1, generatedTokens: 64 },
      timestamps: [{ text: 'Hello', start: 0.2, end: 0.6, speaker: 'S01' }],
    });
  });

  it('surfaces CTC alignment failures instead of returning misleading timestamps', () => {
    const result = run(`${fakeDecode}
def respond(*args, **kwargs):
    return io.StringIO(json.dumps({
        'choices': [{'message': {'content': 'Hello'}, 'finish_reason': 'stop'}],
        'ctc_timestamps': {'error': 'alignment unavailable', 'words': []}
    }))
with patch.object(module.subprocess, 'run', decode), patch.object(module, 'urlopen', respond):
    try:
        daemon.transcribe({'audio_path': '/tmp/input.wav', 'timestamps': True})
    except RuntimeError as error:
        print(json.dumps({'error': str(error)}))
    else:
        raise AssertionError('CTC error was swallowed')
`);
    expect(result.error).toContain('alignment unavailable');
  });
});
