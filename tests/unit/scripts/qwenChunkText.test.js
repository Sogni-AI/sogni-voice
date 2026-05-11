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
    const result = spawnSync(candidate, ['-c', 'import sys; sys.exit(0)'], { encoding: 'utf8' });
    if (result.status === 0) return candidate;
  }
  return null;
};

const python = findPython();
const itWithPython = python ? it : it.skip;

const runChunker = (text, maxChars) => {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('qwen_tts_daemon', ${JSON.stringify(join(repoRoot, 'scripts/qwen_tts_daemon.py'))})
m = importlib.util.module_from_spec(spec)
# Stub heavy deps so we can import without the venv.
class _Stub:
    def __getattr__(self, name):
        return _Stub()
    def __call__(self, *args, **kwargs):
        return _Stub()
for name in ('safetensors', 'safetensors.torch'):
    sys.modules.setdefault(name, _Stub())
spec.loader.exec_module(m)
text = json.loads(sys.stdin.read())
print(json.dumps(m.chunk_text(text['text'], max_chars=text['max_chars'])))
`;
  const result = spawnSync(python, ['-c', script], {
    input: JSON.stringify({ text, max_chars: maxChars }),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`chunker failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
};

describe('qwen_tts_daemon chunk_text', () => {
  itWithPython('returns empty list for empty input', () => {
    expect(runChunker('', 300)).toEqual([]);
    expect(runChunker('   ', 300)).toEqual([]);
  });

  itWithPython('keeps short text as a single chunk', () => {
    expect(runChunker('Hello world.', 300)).toEqual(['Hello world.']);
  });

  itWithPython('groups sentences greedily up to the cap', () => {
    const chunks = runChunker('First sentence one. Second one! Third one? Fourth.', 30);
    expect(chunks).toEqual(['First sentence one.', 'Second one! Third one? Fourth.']);
  });

  itWithPython('splits a single overlong sentence at clause/word boundaries', () => {
    const longSentence = `${'a'.repeat(800)}`;
    const chunks = runChunker(longSentence, 300);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(300));
    expect(chunks.join('')).toBe(longSentence);
  });

  itWithPython('respects newline boundaries (markdown paragraphs)', () => {
    const text = '# Heading\n\nFirst paragraph here. Some more.\n\nSecond paragraph.';
    const chunks = runChunker(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(40));
  });
});
