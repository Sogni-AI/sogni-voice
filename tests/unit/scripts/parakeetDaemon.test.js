import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const python = [join(repoRoot, '.venv/bin/python'), 'python3', 'python'].find((candidate) => (
  spawnSync(candidate, ['-c', 'import sys'], { encoding: 'utf8' }).status === 0
));
const itWithPython = python ? it : it.skip;

const runPython = (body) => {
  const script = `
import importlib.util
import json
from pathlib import Path

path = Path(${JSON.stringify(join(repoRoot, 'scripts/parakeet_daemon.py'))})
spec = importlib.util.spec_from_file_location("parakeet_daemon", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
${body}
`;
  const result = spawnSync(python, ['-c', script], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
};

const fakeStreamingModel = `
class Token:
    def __init__(self, text, start, end):
        self.text = text
        self.start = start
        self.end = end
        self.confidence = 0.9

class Result:
    text = "Hello world."
    tokens = [Token(" Hello", 0.0, 0.3), Token(" world", 0.3, 0.7), Token(".", 0.7, 0.8)]

class Transcriber:
    result = Result()
    finalized_tokens = [Result.tokens[0]]
    draft_tokens = Result.tokens[1:]
    def add_audio(self, audio):
        self.audio_size = audio.size

class Context:
    def __init__(self):
        self.closed = False
        self.transcriber = Transcriber()
    def __enter__(self):
        return self.transcriber
    def __exit__(self, *_args):
        self.closed = True

class Model:
    class Preprocessor:
        sample_rate = 16000
    preprocessor_config = Preprocessor()
    def transcribe_stream(self, **_kwargs):
        self.context = Context()
        return self.context
`;

describe('parakeet daemon realtime protocol', () => {
  itWithPython('streams float32 PCM and returns interim plus final word timings', () => {
    const result = runPython(`
${fakeStreamingModel}
import base64
import struct

daemon = module.ParakeetDaemon()
daemon.model = Model()
started = daemon.start_stream("session_one")
audio = base64.b64encode(struct.pack("<4f", 0.1, -0.1, 0.2, -0.2)).decode("ascii")
partial = daemon.stream_audio("session_one", audio)
context = daemon.stream["context"]
final = daemon.finish_stream("session_one")
print(json.dumps({
    "started": started,
    "partial": partial,
    "final": final,
    "closed": context.closed,
    "active": daemon.stream is not None,
}))
`);

    expect(result.started).toMatchObject({
      success: true,
      sample_rate: 16000,
      encoding: 'pcm_f32le',
    });
    expect(result.partial).toMatchObject({
      success: true,
      sequence: 1,
      text: 'Hello world.',
      finalized_text: 'Hello',
      draft_text: 'world.',
    });
    expect(result.final.timestamps).toEqual([
      { start: 0, end: 0.3, text: 'Hello' },
      { start: 0.3, end: 0.8, text: 'world.' },
    ]);
    expect(result.final.finalized_text).toBe('Hello world.');
    expect(result.final.draft_text).toBe('');
    expect(result.closed).toBe(true);
    expect(result.active).toBe(false);
  });

  itWithPython('does not let a mismatched session terminate the active stream', () => {
    const result = runPython(`
${fakeStreamingModel}
daemon = module.ParakeetDaemon()
daemon.model = Model()
daemon.start_stream("owner")
context = daemon.stream["context"]
wrong_finish = daemon.finish_stream("intruder")
wrong_abort = daemon.abort_stream("intruder")
still_active = daemon.stream is not None and not context.closed
right_abort = daemon.abort_stream("owner")
print(json.dumps({
    "wrong_finish": wrong_finish,
    "wrong_abort": wrong_abort,
    "still_active": still_active,
    "right_abort": right_abort,
    "closed": context.closed,
}))
`);

    expect(result.wrong_finish.success).toBe(false);
    expect(result.wrong_abort.success).toBe(false);
    expect(result.still_active).toBe(true);
    expect(result.right_abort).toMatchObject({ success: true, aborted: true });
    expect(result.closed).toBe(true);
  });

  itWithPython('rejects malformed and non-finite PCM payloads', () => {
    const result = runPython(`
${fakeStreamingModel}
import base64
import struct

daemon = module.ParakeetDaemon()
daemon.model = Model()
daemon.start_stream("owner")
malformed = daemon.stream_audio("owner", base64.b64encode(b"123").decode("ascii"))
non_finite = daemon.stream_audio(
    "owner",
    base64.b64encode(struct.pack("<f", float("nan"))).decode("ascii"),
)
daemon.abort_stream("owner")
print(json.dumps({"malformed": malformed, "non_finite": non_finite}))
`);

    expect(result.malformed).toMatchObject({ success: false });
    expect(result.malformed.error).toContain('float32 PCM');
    expect(result.non_finite).toMatchObject({ success: false });
    expect(result.non_finite.error).toContain('non-finite');
  });

  itWithPython('unwinds the native context when stream startup fails', () => {
    const result = runPython(`
class Context:
    def __init__(self):
        self.closed = False
    def __enter__(self):
        raise RuntimeError("stream setup failed")
    def __exit__(self, *_args):
        self.closed = True

class Model:
    def transcribe_stream(self, **_kwargs):
        self.context = Context()
        return self.context

model = Model()
daemon = module.ParakeetDaemon()
daemon.model = model
started = daemon.start_stream("owner")
print(json.dumps({
    "started": started,
    "closed": model.context.closed,
    "active": daemon.stream is not None,
}))
`);

    expect(result.started).toMatchObject({ success: false, error: 'stream setup failed' });
    expect(result.closed).toBe(true);
    expect(result.active).toBe(false);
  });
});
