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

path = Path(${JSON.stringify(join(repoRoot, 'scripts/qwen_asr_daemon.py'))})
spec = importlib.util.spec_from_file_location("qwen_asr_daemon", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
${body}
`;
  const result = spawnSync(python, ['-c', script], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
};

describe('qwen_asr_daemon helpers', () => {
  itWithPython('normalizes ISO aliases and automatic language detection', () => {
    const result = runPython(`
print(json.dumps({
    "auto": module.normalize_language("auto"),
    "english": module.normalize_language("en"),
    "japanese": module.normalize_language("japanese"),
}))
`);
    expect(result).toEqual({ auto: null, english: 'English', japanese: 'Japanese' });
  });

  itWithPython('splits English and CJK sentences without losing punctuation', () => {
    const result = runPython(`
daemon = module.QwenAsrDaemon()
print(json.dumps({
    "english": daemon.split_sentences("Hello world. How are you?"),
    "cjk": daemon.split_sentences("你好。世界！"),
}))
`);
    expect(result.english).toEqual(['Hello world.', 'How are you?']);
    expect(result.cjk).toEqual(['你好。', '世界！']);
  });

  itWithPython('rejects alignment languages outside the upstream 11-language set', () => {
    const result = runPython(`
daemon = module.QwenAsrDaemon()
try:
    daemon.align_normalized("/not/read.wav", "hello", "Arabic")
except ValueError as exc:
    print(json.dumps({"error": str(exc)}))
else:
    raise AssertionError("unsupported alignment language was accepted")
`);
    expect(result.error).toContain('Forced alignment does not support Arabic');
  });
});
