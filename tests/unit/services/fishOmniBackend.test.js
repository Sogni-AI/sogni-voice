import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs/promises', () => ({ access: vi.fn().mockResolvedValue(undefined) }));

const engineConfig = {
  enabled: true,
  backend: 'vllm-omni',
  pythonPath: './.venv/bin/python3',
  voiceClonesDir: './fish_voice_clones',
  timeout: 60000,
  timeoutPerChar: 400,
  timeoutMax: 900000,
  daemonStartupTimeout: 60000,
  preWarmDaemon: false,
};

vi.mock('../../../src/config/index.js', () => ({
  config: {
    fishTts: {
      ...engineConfig,
      omniUrl: 'http://127.0.0.1:8001',
      omniModel: 'fishaudio/s2-pro',
      modelId: 'fishaudio/s2-pro',
      modelPath: './checkpoints/fish-audio-s2-pro-8bit-mlx-normalized',
      serverDir: './vendor/fish-s2-mlx',
      maxTokens: 1024,
    },
    drama3Tts: {
      ...engineConfig,
      omniUrl: 'http://127.0.0.1:8002',
      omniModel: 'fishaudio/drama-3',
      modelId: 'fish-drama-3',
      modelPath: './checkpoints/drama-3',
      maxNewTokens: 0,
    },
  },
}));

describe('Fish engines on the vLLM-Omni backend', () => {
  let spawn;
  let access;
  let mockStdout;
  let service;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockStdout = new Readable({ read() {} });
    const mockProcess = new EventEmitter();
    mockProcess.stdin = new Writable({ write(chunk, encoding, callback) { callback(); } });
    mockProcess.stdout = mockStdout;
    mockProcess.stderr = new Readable({ read() {} });
    mockProcess.kill = vi.fn();
    ({ spawn } = await import('node:child_process'));
    ({ access } = await import('node:fs/promises'));
    spawn.mockReturnValue(mockProcess);
  });

  afterEach(async () => {
    try { await service?.shutdown(); } catch { /* ignore */ }
  });

  const initReady = async (model) => {
    const started = service.initialize();
    setTimeout(() => mockStdout.push(
      `{"status":"ready","voices":["default"],"clones":["aurochs"],"features":["tts"],"sample_rate":44100,"model":"${model}"}\n`,
    ), 10);
    await started;
  };

  it('spawns Fish S2 as a client of its vLLM-Omni server', async () => {
    const { FishTTSService } = await import('../../../src/services/fishTts.js');
    service = new FishTTSService();
    await initReady('fishaudio/s2-pro');
    const [python, [script], { env }] = spawn.mock.calls[0];
    expect(python).toMatch(/\.venv\/bin\/python3$/);
    expect(script).toMatch(/scripts\/fish_omni_daemon\.py$/);
    expect(env).toMatchObject({
      FISH_OMNI_ENGINE: 's2',
      FISH_OMNI_URL: 'http://127.0.0.1:8001',
      FISH_OMNI_MODEL: 'fishaudio/s2-pro',
      FISH_TTS_MODEL_ID: 'fishaudio/s2-pro',
      FISH_TTS_MAX_TOKENS: '1024',
    });
    expect(env.FISH_TTS_VOICE_CLONES_DIR).toMatch(/fish_voice_clones$/);
    // The weights live in the server, so only the interpreter must exist here.
    expect(access).toHaveBeenCalledTimes(1);
    expect(service.getModelInfo().backend).toBe('fish-s2-pro-vllm-omni');
  });

  it('spawns Drama 3 as a client of its vLLM-Omni server on the shared clone store', async () => {
    const { Drama3TTSService } = await import('../../../src/services/drama3Tts.js');
    service = new Drama3TTSService();
    await initReady('fish-drama-3');
    const [, [script], { env }] = spawn.mock.calls[0];
    expect(script).toMatch(/scripts\/fish_omni_daemon\.py$/);
    expect(env).toMatchObject({
      FISH_OMNI_ENGINE: 'drama3',
      FISH_OMNI_URL: 'http://127.0.0.1:8002',
      FISH_OMNI_MODEL: 'fishaudio/drama-3',
      DRAMA3_TTS_MODEL_ID: 'fish-drama-3',
      DRAMA3_TTS_MAX_NEW_TOKENS: '0',
    });
    expect(env.FISH_TTS_VOICE_CLONES_DIR).toMatch(/fish_voice_clones$/);
    expect(env.DRAMA3_TTS_MODEL_PATH).toBeUndefined();
    expect(service.getModelInfo().backend).toBe('fish-drama3-vllm-omni');
  });
});
