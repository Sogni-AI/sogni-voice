import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

const findPythonWithSafetensors = () => {
  const candidates = [
    process.env.PYTHON,
    join(repoRoot, '.venv-qwen-tts/bin/python'),
    join(repoRoot, '.venv/bin/python'),
    'python3',
    'python',
  ].filter(Boolean);

  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['-c', 'import numpy, safetensors'], {
      encoding: 'utf8',
    });

    if (result.status === 0) {
      return candidate;
    }
  }

  return null;
};

const python = findPythonWithSafetensors();
const itWithPython = python ? it : it.skip;

describe('Qwen safetensors loader', () => {
  itWithPython('rejects untrusted dataclass metadata without executing constructors', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'qwen-safetensors-loader-'));

    try {
      const script = `
import importlib.util
import json
import numpy as np
import os
import sys
from safetensors.numpy import save_file

repo_root = ${JSON.stringify(repoRoot)}
work_dir = ${JSON.stringify(workDir)}
marker_path = os.path.join(work_dir, "constructor-executed")
clone_path = os.path.join(work_dir, "malicious.safetensors")
os.environ["QWEN_TTS_VOICE_CLONES_DIR"] = work_dir

structure = {
    "kind": "dataclass",
    "class_module": "subprocess",
    "class_name": "Popen",
    "fields": {
        "args": {
            "kind": "literal",
            "value": [
                sys.executable,
                "-c",
                f"open({marker_path!r}, 'w').write('executed')",
            ],
        },
    },
}

save_file(
    {"prompt": np.zeros(1, dtype=np.float32)},
    clone_path,
    metadata={
        "format": "structured",
        "structure": json.dumps(structure, separators=(",", ":")),
    },
)

spec = importlib.util.spec_from_file_location(
    "qwen_tts_daemon",
    os.path.join(repo_root, "scripts", "qwen_tts_daemon.py"),
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

try:
    module.load_voice_prompt(clone_path)
except ValueError as exc:
    if "Unsupported serialized voice prompt dataclass" not in str(exc):
        raise
else:
    raise AssertionError("malicious dataclass metadata was accepted")

if os.path.exists(marker_path):
    raise AssertionError("untrusted dataclass constructor executed")
`;

      const result = spawnSync(python, ['-c', script], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });

      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('');
      expect(result.status).toBe(0);
      expect(existsSync(join(workDir, 'constructor-executed'))).toBe(false);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  itWithPython('round-trips the safe legacy-compatible clone schema', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'qwen-safetensors-roundtrip-'));

    try {
      const script = `
import importlib.util
import numpy as np
import os

repo_root = ${JSON.stringify(repoRoot)}
work_dir = ${JSON.stringify(workDir)}
clone_path = os.path.join(work_dir, "roundtrip.safetensors")
os.environ["QWEN_TTS_VOICE_CLONES_DIR"] = work_dir

spec = importlib.util.spec_from_file_location(
    "qwen_tts_daemon",
    os.path.join(repo_root, "scripts", "qwen_tts_daemon.py"),
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

prompt = {
    "ref_code": np.arange(64, dtype=np.int64).reshape(4, 16),
    "ref_spk_embedding": np.linspace(-1, 1, 1024, dtype=np.float32),
    "ref_text": "Safe prompt round trip.",
}
module.save_voice_prompt(prompt, clone_path)
loaded = module.load_voice_prompt(clone_path)

np.testing.assert_array_equal(loaded["ref_code"], prompt["ref_code"])
np.testing.assert_allclose(
    loaded["ref_spk_embedding"],
    prompt["ref_spk_embedding"],
)
assert loaded["ref_text"] == prompt["ref_text"]
assert loaded["icl_mode"] is True
assert loaded["x_vector_only_mode"] is False
`;

      const result = spawnSync(python, ['-c', script], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });

      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('');
      expect(result.status).toBe(0);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
