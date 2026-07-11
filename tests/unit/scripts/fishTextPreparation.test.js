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

const prepareText = (text, maxBytes = 200) => {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location(
    'fish_tts_daemon',
    ${JSON.stringify(join(repoRoot, 'scripts/fish_tts_daemon.py'))},
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
request = json.loads(sys.stdin.read())
print(json.dumps(module.prepare_text_chunks(request['text'], request['max_bytes'])))
`;
  const result = spawnSync(python, ['-c', script], {
    input: JSON.stringify({ text, max_bytes: maxBytes }),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`Fish text preparation failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
};

describe('fish_tts_daemon prepare_text_chunks', () => {
  itWithPython('returns no chunks for empty input', () => {
    expect(prepareText('')).toEqual([]);
    expect(prepareText('  \n\t ')).toEqual([]);
  });

  itWithPython('normalizes pasted lines while preserving paragraphs and Fish tags', () => {
    const text = [
      '[happy] First pasted line ',
      '@tonbistudio',
      'and (laugh) the rest of the paragraph.',
      '',
      '[whispers] Second paragraph.',
    ].join('\n');

    expect(prepareText(text)).toEqual([
      '[happy] First pasted line at tonbistudio and (laugh) the rest of the paragraph.',
      '[whispers] Second paragraph.',
    ]);
  });

  itWithPython('expands standalone handles without changing email addresses', () => {
    expect(prepareText(
      'Email jane.doe+voice@example.com, keep https://x.com/@linked, '
      + 'or ping @tonbistudio and @_helper.',
    )).toEqual([
      'Email jane.doe+voice@example.com, keep https://x.com/@linked, '
      + 'or ping at tonbistudio and at _helper.',
    ]);
  });

  itWithPython('groups sentences and splits overlong prose at word boundaries', () => {
    const text = 'First sentence has several useful words. '
      + 'Second sentence also contains useful detail. '
      + 'This final unpunctuated section has enough words to require another clean split';
    const chunks = prepareText(text, 55);

    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((chunk) => expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(55));
    expect(chunks.join(' ')).toBe(text);
  });

  itWithPython('hard-splits a single word only when no word boundary is available', () => {
    const text = 'x'.repeat(125);
    const chunks = prepareText(text, 40);

    expect(chunks.map((chunk) => chunk.length)).toEqual([40, 40, 40, 5]);
    expect(chunks.join('')).toBe(text);
  });

  itWithPython('uses UTF-8 bytes without splitting Unicode characters', () => {
    const text = '你好世界。'.repeat(20);
    const chunks = prepareText(text, 40);

    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((chunk) => {
      expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(40);
      expect(chunk).not.toContain('�');
    });
    expect(chunks.join('')).toBe(text);
  });

  itWithPython('leaves explicit multi-speaker control input unchanged', () => {
    const text = '<|speaker:0|>[happy] Hello\n@alice\n\n<|speaker:1|>(laugh) Reply to @bob';
    expect(prepareText(text, 20)).toEqual([text]);
  });
});
