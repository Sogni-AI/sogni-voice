import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const python = process.env.PYTHON || 'python3';

const generateThroughDaemon = (expertFormat, override) => {
  // Stub the model and MLX allocation only. Exercise the real daemon's load,
  // default generation and cloned-reference dispatch without GPU inference.
  const script = `
import json, os, sys, tempfile, types
from pathlib import Path
from types import SimpleNamespace

request = json.loads(sys.stdin.read())
os.environ.pop("DRAMA3_TTS_CFG_GAMMA", None)
if request["override"] is not None:
    os.environ["DRAMA3_TTS_CFG_GAMMA"] = str(request["override"])

mx = types.ModuleType("mlx.core")
mx.reset_peak_memory = lambda: None
mx.get_active_memory = lambda: 0
mlx = types.ModuleType("mlx")
mlx.core = mx
sys.modules.update({"mlx": mlx, "mlx.core": mx})
np = types.ModuleType("numpy")
np.concatenate = lambda items: items
sys.modules["numpy"] = np
sf = types.ModuleType("soundfile")
sf.read = lambda *args, **kwargs: (SimpleNamespace(mean=lambda axis: "mono original"), 44100)
sys.modules["soundfile"] = sf

calls = []
reference_calls = []
class Model:
    model = SimpleNamespace(expert_format=request["expert_format"])
    sample_rate = 44100
    def generate(self, text, **options):
        calls.append({"text": text, "cfg_gamma": options["cfg_gamma"], "references": options["references"]})
        yield SimpleNamespace(audio="stub audio", finish_reason="eos", text=text)
    def reference(self, audio, sample_rate, transcript):
        reference_calls.append([audio, sample_rate, transcript])
        return {"original_reference": transcript}

package = types.ModuleType("drama3_mlx")
package.Drama3 = SimpleNamespace(load=lambda path, experts: Model())
prompt = types.ModuleType("drama3_mlx.prompt")
prompt.InvalidInputError = type("InvalidInputError", (ValueError,), {})
sys.modules.update({"drama3_mlx": package, "drama3_mlx.prompt": prompt})
sys.path.insert(0, ${JSON.stringify(join(repoRoot, 'scripts'))})
from drama3_tts_daemon import Drama3TTSDaemon

daemon = Drama3TTSDaemon()
daemon._configure_mlx_memory = lambda _mx: None
daemon._write_wav = lambda audio, path: 1.0
assert daemon.load_model()
plain = daemon.generate("The author sentence.", "unused.wav")
with tempfile.TemporaryDirectory() as directory:
    reference_path = Path(directory) / "reference.wav"
    reference_path.touch()
    daemon._reference_path = lambda clone_id: str(reference_path)
    daemon._read_transcript = lambda clone_id: "Exact original words."
    cloned = daemon.generate_with_clone("A cloned sentence.", "Marvin", "unused.wav")
print(json.dumps({"plain": plain, "cloned": cloned, "calls": calls, "reference_calls": reference_calls}))
`;
  const result = spawnSync(python, ['-c', script], {
    input: JSON.stringify({ expert_format: expertFormat, override }),
    encoding: 'utf8',
    timeout: 10000,
  });
  if (result.status !== 0) throw new Error(`Drama 3 MLX daemon harness failed: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split('\n').pop());
};

describe('Drama 3 MLX guidance selection', () => {
  it.each([
    ['q8', null, 1.0],
    ['nvfp4', null, 1.5],
    ['nvfp4', 1.0, 1.0],
    ['q8', 1.25, 1.25],
  ])('forwards loaded format %s and explicit override %s as guidance %s', (format, override, expected) => {
    const result = generateThroughDaemon(format, override);
    expect(result.plain.success).toBe(true);
    expect(result.cloned.success).toBe(true);
    expect(result.calls).toEqual([
      { text: 'The author sentence.', cfg_gamma: expected, references: [] },
      { text: 'A cloned sentence.', cfg_gamma: expected, references: [{ original_reference: 'Exact original words.' }] },
    ]);
    expect(result.reference_calls).toEqual([['mono original', 44100, 'Exact original words.']]);
  });
});
