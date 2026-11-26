import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('network config', () => {
  const originalEnv = { ...process.env };
  let tempDir;

  beforeEach(async () => {
    vi.resetModules();
    process.env.SOGNI_NETWORK_WORKER = '';
    process.env.SOGNI_SOCKET_URL = '';
    process.env.SOGNI_SOCKET_API_URL = '';
    process.env.SOGNI_API_URL = '';
    process.env.SOGNI_VOICE_BACKEND_MODE = '';
    process.env.SOGNI_VOICE_API_URL = '';
    process.env.SOGNI_WORKER_ID = '';
    tempDir = await mkdtemp(join(tmpdir(), 'sogni-network-config-'));
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await rm(tempDir, { recursive: true, force: true });
  });

  it('resolves local, staging, and production Sogni hosts plus explicit overrides', async () => {
    const { resolveSogniHosts } = await import('../../../src/network/config.js');
    expect(resolveSogniHosts({ sogniEnv: 'local' })).toEqual({
      env: 'local',
      socket: 'wss://socket-local.sogni.ai',
      socketApi: 'https://socket-local.sogni.ai/api',
      api: 'https://api-local.sogni.ai',
    });
    expect(resolveSogniHosts({ sogniEnv: 'staging' }).socket).toBe('wss://socket-staging.sogni.ai');
    expect(resolveSogniHosts({ sogniEnv: 'production' }).api).toBe('https://api.sogni.ai');
    expect(resolveSogniHosts({
      sogniEnv: 'staging',
      socketUrl: 'ws://127.0.0.1:9999/',
      socketApiUrl: 'http://127.0.0.1:9999/api/',
      apiUrl: 'http://127.0.0.1:8888/',
    })).toEqual({
      env: 'staging',
      socket: 'ws://127.0.0.1:9999',
      socketApi: 'http://127.0.0.1:9999/api',
      api: 'http://127.0.0.1:8888',
    });
  });

  it('rejects an unknown SOGNI_ENV', async () => {
    const { resolveSocketUrl } = await import('../../../src/network/config.js');
    expect(() => resolveSocketUrl('moon')).toThrow(/Unknown SOGNI_ENV/);
  });

  it('builds the comfy-worker user-agent using linux or darwin (NEVER macOS) and distinct sogni-voice image identity', async () => {
    const {
      buildUserAgent,
      clampMediaWorkerConcurrency,
      workerImageIdentity,
    } = await import('../../../src/network/config.js');
    expect(buildUserAgent({ platform: 'linux', workerVersion: '1.0.260' }))
      .toBe('Sogni/3.0.0129 (linux) | IMG:COMFY | comfy-worker/1.0.260');
    const macUa = buildUserAgent({ platform: 'darwin', workerVersion: '1.0.260' });
    expect(macUa).toBe('Sogni/3.0.0129 (darwin) | IMG:COMFY | comfy-worker/1.0.260');
    expect(macUa).not.toContain('macOS');

    expect(workerImageIdentity(undefined, 'linux')).toBe('sogni-voice/1.0.0');
    expect(workerImageIdentity(undefined, 'darwin')).toBe('sogni-voice-mac/1.0.0');
    expect(workerImageIdentity('1.2.3', 'linux')).toBe('sogni-voice/1.2.3');
    expect(clampMediaWorkerConcurrency(8)).toBe(1);
  });

  it('detects NVIDIA GB10 unified memory from os.totalmem() when nvidia-smi reports [N/A]', async () => {
    const { probeHardwareInfo } = await import('../../../src/network/config.js');
    const hw = await probeHardwareInfo({
      env: {},
      platform: 'linux',
      arch: 'arm64',
      totalMemBytes: 120 * (1024 ** 3),
      cpus: [{ model: 'ARM Cortex-X925', speed: 3000 }],
      hostname: 'dgx-spark-01',
      execFileImpl: async () => ({ stdout: 'NVIDIA GB10, [N/A], 580.178.04\n' }),
    });
    expect(hw).toMatchObject({
      cpuBrand: 'ARM Cortex-X925',
      gpuBrand: 'NVIDIA GB10',
      ram: 120,
      vram: 120,
      nvidiaDriverVersion: '580.178.04',
      supportedControlnets: {},
    });
  });

  it('ignores "Unknown" in /proc/driver/nvidia and lowercase "processor : 0" on ARM64 GB10 containers', async () => {
    const { probeHardwareInfo } = await import('../../../src/network/config.js');
    const hw = await probeHardwareInfo({
      env: {},
      platform: 'linux',
      arch: 'arm64',
      totalMemBytes: 122 * (1024 ** 3),
      cpus: [{ model: 'unknown', speed: 2808 }],
      hostname: 'dgx-spark-01',
      execFileImpl: async (cmd) => {
        if (cmd === 'lscpu') return { stdout: 'Architecture: aarch64\nModel name: Cortex-X925\n' };
        throw new Error('nvidia-smi unavailable');
      },
      readdirSyncImpl: () => ['0000:01:00.0'],
      readFileSyncImpl: (path) => {
        if (String(path).includes('/proc/driver/nvidia/gpus/')) return 'Model: \t\t Unknown\n';
        if (path === '/proc/cpuinfo') return 'processor\t: 0\nBogoMIPS\t: 2000.00\n';
        throw new Error('ENOENT');
      },
    });
    expect(hw).toMatchObject({
      cpuBrand: 'Cortex-X925',
      gpuBrand: 'NVIDIA GB10',
      ram: 122,
      vram: 122,
    });
  });

  it('resolves backend mode from SOGNI_VOICE_BACKEND_MODE or SOGNI_VOICE_API_URL', async () => {
    const { resolveBackendMode } = await import('../../../src/network/config.js');
    expect(resolveBackendMode('', { defaultMode: 'local', apiUrl: '' })).toBe('local');
    expect(resolveBackendMode('', { defaultMode: 'local', apiUrl: 'http://127.0.0.1:3000' })).toBe('http');
    expect(resolveBackendMode('http', { defaultMode: 'local', apiUrl: '' })).toBe('http');
    expect(() => resolveBackendMode('grpc')).toThrow(/Unsupported SOGNI_VOICE_BACKEND_MODE/);
  });

  it('persists a stable worker id to disk', async () => {
    const { loadOrCreateWorkerId } = await import('../../../src/network/config.js');
    const idFile = join(tempDir, 'nested', '.sogni-worker-id');

    const first = loadOrCreateWorkerId(idFile, '');
    const second = loadOrCreateWorkerId(idFile, '');

    expect(first).toMatch(/^[0-9A-F-]{36}$/);
    expect(second).toBe(first);
    expect((await readFile(idFile, 'utf-8')).trim()).toBe(first);
  });
});
