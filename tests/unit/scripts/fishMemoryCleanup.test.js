import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

const findPython = () => {
  const candidates = [
    process.env.PYTHON,
    join(repoRoot, '.venv-fish-tts/bin/python'),
    join(repoRoot, '.venv/bin/python'),
    'python3',
    'python',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['-c', 'import sys; sys.exit(0)']);
    if (result.status === 0) return candidate;
  }
  return null;
};

const python = findPython();
const itWithPython = python ? it : it.skip;

const runHarness = () => {
  const script = `
import importlib.util
import json

spec = importlib.util.spec_from_file_location(
    'fish_tts_daemon',
    ${JSON.stringify(join(repoRoot, 'scripts/fish_tts_daemon.py'))},
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

GIB = 1024 ** 3

class FakeMx:
    def __init__(self, fail_clear=False):
        self.events = []
        self.cache = 8 * GIB
        self.active = 7 * GIB
        self.peak = 20 * GIB
        self.fail_clear = fail_clear
        self.cache_limit = None

    def set_cache_limit(self, limit):
        self.events.append('set_cache_limit')
        self.cache_limit = limit
        return 60 * GIB

    def synchronize(self):
        self.events.append('synchronize')

    def clear_cache(self):
        self.events.append('clear_cache')
        if self.fail_clear:
            raise RuntimeError('synthetic clear failure')
        self.cache = 0

    def get_active_memory(self):
        return self.active

    def get_cache_memory(self):
        return self.cache

    def get_peak_memory(self):
        return self.peak

    def reset_peak_memory(self):
        self.events.append('reset_peak_memory')
        self.peak = self.active


configured = FakeMx()
daemon = module.FishTTSDaemon()
daemon._configure_mlx_memory(configured)
daemon._release_request_memory('generate')

ignored = FakeMx()
daemon._mx = ignored
daemon._release_request_memory('list_voices')

failed = FakeMx(fail_clear=True)
daemon._mx = failed
daemon._release_request_memory('generate_voice_clone')

order = []
daemon = module.FishTTSDaemon()
daemon.handle_request = lambda _line: order.append('handle') or {'success': True}
daemon.send_response = lambda _response: order.append('respond')
daemon._release_request_memory = lambda request_type: order.append(f'cleanup:{request_type}')
daemon._handle_line(json.dumps({'type': 'generate', 'text': 'hello'}))

print(json.dumps({
    'configured_events': configured.events,
    'configured_cache': configured.cache,
    'configured_limit': configured.cache_limit,
    'ignored_events': ignored.events,
    'failed_events': failed.events,
    'order': order,
    'expected_limit': module.MLX_CACHE_LIMIT_BYTES,
}))
`;
  const result = spawnSync(python, ['-c', script], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Fish memory-cleanup harness failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
};

describe('fish_tts_daemon MLX memory cleanup', () => {
  itWithPython('caps and clears free Metal buffers while keeping requests successful', () => {
    const output = runHarness();

    expect(output.expected_limit).toBe(2 * (1024 ** 3));
    expect(output.configured_limit).toBe(output.expected_limit);
    expect(output.configured_cache).toBe(0);
    expect(output.configured_events).toEqual([
      'set_cache_limit',
      'synchronize',
      'clear_cache',
      'reset_peak_memory',
    ]);
  });

  itWithPython('skips metadata-only requests and treats cleanup failures as non-fatal', () => {
    const output = runHarness();

    expect(output.ignored_events).toEqual([]);
    expect(output.failed_events).toEqual([
      'synchronize',
      'clear_cache',
      'reset_peak_memory',
    ]);
  });

  itWithPython('responds before reclaiming memory, then cleans before another request', () => {
    expect(runHarness().order).toEqual(['handle', 'respond', 'cleanup:generate']);
  });
});
