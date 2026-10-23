import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const python = [process.env.PYTHON, join(repoRoot, '.venv/bin/python'), 'python3']
  .filter(Boolean).find((candidate) => spawnSync(candidate, ['-c', 'import numpy, soundfile']).status === 0);
const itWithPython = python ? it : it.skip;

// Uses the pinned speech.zig contract: raw audio and sampling modifiers are not
// accepted. The native encoder is replaced with a codec-code fixture, so these
// are CPU-only HTTP/protocol tests, not model-quality or GPU tests.
const runHarness = (options = {}) => {
  const script = `
import io, json, os, pathlib, sys, tempfile, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import numpy as np
import soundfile as sf
options = json.loads(sys.stdin.read())
requests, encodes = [], []
audio = io.BytesIO()
samples = np.concatenate([np.zeros(int(options.get("silence", 0) * 44100)), np.full(44100, 0.1)])
sf.write(audio, samples, 44100, format="WAV", subtype="PCM_16")
wav = audio.getvalue()
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def send(self, status, body, kind):
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Finish-Reason", options.get("finish", "stop"))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        self.send(200, b'{"data":[{"id":"fishaudio/drama-3"}]}', "application/json")
    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        requests.append(payload)
        allowed = {"model", "input", "voice", "response_format", "references"}
        if set(payload) - allowed: self.send(400, b'unsupported field', 'text/plain')
        elif options.get("http_error"): self.send(options["http_error"], b'fixture rejected request', 'text/plain')
        else: self.send(200, wav, "audio/wav")
server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
with tempfile.TemporaryDirectory() as directory:
    clone = pathlib.Path(directory) / "Marvin"
    clone.mkdir()
    reference = clone / "reference.wav"
    reference.write_bytes(wav)
    metadata = clone / "metadata.json"
    metadata.write_text(json.dumps({"clone_id": "Marvin", "transcript": "The original reference words."}))
    os.environ.update({"FISH_OMNI_URL": f"http://127.0.0.1:{server.server_address[1]}",
                       "FISH_OMNI_MODEL": "fishaudio/drama-3", "FISH_TTS_VOICE_CLONES_DIR": directory,
                       "DRAMA3_TTS_TENSORFOLD_NATIVE_PATH": "/test/tensorfold-native",
                       "DRAMA3_TTS_MODEL_PATH": "/test/drama-3-NVFP4-Pruned"})
    sys.path.insert(0, ${JSON.stringify(join(repoRoot, 'scripts'))})
    import drama3_tensorfold_daemon as tf
    def encode(command, **kwargs):
        encodes.append(command)
        pathlib.Path(command[-1]).write_text(json.dumps({"format": "drama3-voice/1",
            "text": command[command.index("--text") + 1], "vq_codes": [[i, i + 1] for i in range(10)]}))
    tf.subprocess.run = encode
    daemon = tf.TensorFoldDrama3TTSDaemon()
    assert daemon.load_model()
    output = pathlib.Path(directory) / "output.wav"
    results = []
    for iteration in range(options.get("repeat", 1)):
        if iteration == 1 and options.get("replace_reference"):
            reference.write_bytes(wav + b"changed")
        if iteration == 1 and options.get("replace_transcript"):
            metadata.write_text(json.dumps({"transcript": "A changed reference transcript."}))
        args = (options.get("text", "Hello from Marvin."), str(output), options.get("max_tokens"), options.get("temperature"))
        if options.get("default_voice"):
            results.append(daemon.generate(*args))
        else:
            results.append(daemon.generate_with_clone(args[0], "Marvin", *args[1:]))
    print(json.dumps({"requests": requests, "encodes": encodes, "results": results,
                      "duration": sf.info(output).duration if output.exists() else None,
                      "features": daemon.FEATURES, "original_wav_preserved": reference.read_bytes() == wav}))
`;
  const result = spawnSync(python, ['-c', script], { input: JSON.stringify(options), encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').pop());
};

describe('Drama 3 TensorFold HTTP adapter', () => {
  itWithPython('encodes the original reference once and forwards codes and transcript on every request', () => {
    const result = runHarness({ repeat: 2, temperature: 1 });
    expect(result.encodes).toHaveLength(1);
    expect(result.encodes[0].slice(0, 3)).toEqual(['/test/tensorfold-native', 'voice', 'encode']);
    expect(result.encodes[0]).toContain('/test/drama-3-NVFP4-Pruned');
    expect(result.requests).toHaveLength(2);
    expect(result.requests[0].references).toEqual([{
      text: 'The original reference words.', vq_codes: Array.from({ length: 10 }, (_, i) => [i, i + 1]),
    }]);
    expect(result.requests[0]).not.toHaveProperty('ref_audio');
    expect(result.requests[0]).not.toHaveProperty('extra_params');
    expect(result.duration).toBe(1);
    expect(result.original_wav_preserved).toBe(true);
    expect(result.features).not.toContain('speaker_tags');
  });

  itWithPython('refreshes encoded references when an existing clone is replaced', () => {
    for (const field of ['replace_reference', 'replace_transcript']) {
      const result = runHarness({ repeat: 2, [field]: true });
      expect(result.encodes).toHaveLength(2);
    }
  });

  itWithPython('uses the default voice without running the reference encoder', () => {
    const result = runHarness({ default_voice: true });
    expect(result.encodes).toHaveLength(0);
    expect(result.requests[0].references).toEqual([]);
    expect(result.results[0].success).toBe(true);
  });

  itWithPython('rejects unsupported sampling, token caps and other speakers before synthesis', () => {
    for (const options of [{ temperature: 0.7 }, { max_tokens: 1024 }, { text: '<|speaker:1|> Hello.' }]) {
      const result = runHarness(options);
      expect(result.requests).toHaveLength(0);
      expect(result.results[0]).toMatchObject({ success: false, error: expect.stringMatching(/^invalid input:/) });
    }
  });

  itWithPython('keeps the same reference across chunks and reports a frame-cap finish without retrying', () => {
    const result = runHarness({ text: 'This sentence fills a longer passage. '.repeat(12), finish: 'length' });
    expect(result.requests.length).toBeGreaterThan(1);
    expect(result.encodes).toHaveLength(1);
    for (const request of result.requests) expect(request.references).toEqual(result.requests[0].references);
    expect(result.duration).toBe(result.requests.length);
    expect(result.results[0].finish_reason).toBe('length');
  });

  itWithPython('maps engine input rejection and service errors without retries', () => {
    for (const status of [400, 503]) {
      const result = runHarness({ http_error: status });
      expect(result.requests).toHaveLength(1);
      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error).toContain(status === 400 ? 'invalid input:' : 'HTTP 503');
    }
  });

  itWithPython('marks a stalled take incomplete once without deterministic retries', () => {
    const result = runHarness({ silence: 2.5 });
    expect(result.requests).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ success: true, finish_reason: 'silence' });
    expect(result.duration).toBe(3.5);
  });
});
