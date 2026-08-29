import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('network config', () => {
  const originalEnv = { ...process.env };
  let tempDir;

  beforeEach(async () => {
    vi.resetModules();
    // Use empty strings so dotenv does not repopulate these from .env during import.
    process.env.SOGNI_NETWORK_WORKER = '';
    process.env.SPEECH_WORKER_MAX_CONCURRENT = '';
    process.env.SPEECH_WORKER_CAPACITY_INTERVAL_MS = '';
    process.env.SPEECH_WORKER_RECONNECT_DELAY_MS = '';
    process.env.SPEECH_WORKER_RECONNECT_MAX_DELAY_MS = '';
    tempDir = await mkdtemp(join(tmpdir(), 'sogni-network-config-'));
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await rm(tempDir, { recursive: true, force: true });
  });

  it('resolves the staging and production socket URLs', async () => {
    const { resolveSocketUrl } = await import('../../../src/network/config.js');
    expect(resolveSocketUrl('staging')).toBe('wss://socket-staging.sogni.ai');
    expect(resolveSocketUrl('production')).toBe('wss://socket.sogni.ai');
  });

  it('rejects an unknown SOGNI_ENV', async () => {
    const { resolveSocketUrl } = await import('../../../src/network/config.js');
    expect(() => resolveSocketUrl('moon')).toThrow(/Unknown SOGNI_ENV/);
  });

  // The broker parses this exactly: 'Sogni' passes the bot gate, ' (macOS)'
  // selects the mac agent type, the segment after the last '/' before '[' must
  // version-compare >= 4.0.0, and the bracketed suffix is stripped first.
  it('builds the frozen user-agent string', async () => {
    const { buildUserAgent } = await import('../../../src/network/config.js');
    expect(buildUserAgent()).toBe('Sogni/4.0.0 (macOS) [sogni-voice-speech-worker/2.0.0]');
  });

  it('resolves the sogni-api base URL per environment, with env override', async () => {
    const { resolveApiUrl } = await import('../../../src/network/config.js');
    expect(resolveApiUrl('staging')).toBe('https://api-staging.sogni.ai');
    expect(resolveApiUrl('production')).toBe('https://api.sogni.ai');
    expect(() => resolveApiUrl('moon')).toThrow(/Unknown SOGNI_ENV/);
  });

  it('persists a stable worker id to disk', async () => {
    const { loadOrCreateWorkerId } = await import('../../../src/network/config.js');
    const idFile = join(tempDir, '.sogni-worker-id');

    const first = loadOrCreateWorkerId(idFile);
    const second = loadOrCreateWorkerId(idFile);

    expect(first).toMatch(/^[0-9A-F-]{36}$/);
    expect(second).toBe(first);
    expect((await readFile(idFile, 'utf-8')).trim()).toBe(first);
  });

  it('exposes networkWorker defaults on the shared config', async () => {
    const { config } = await import('../../../src/config/index.js');
    expect(config.networkWorker.enabled).toBe(false);
    expect(config.networkWorker.maxConcurrentJobs).toBe(1);
    expect(config.networkWorker.hardwareRating).toBe(70);
    expect(config.networkWorker.nftTokenId).toBeNull();
    expect(config.networkWorker.reconnectInitialDelayMs).toBe(5000);
    expect(config.networkWorker.reconnectMaxDelayMs).toBe(60000);
  });
});
