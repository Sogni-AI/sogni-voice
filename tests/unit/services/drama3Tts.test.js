import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs/promises', () => ({ access: vi.fn().mockResolvedValue(undefined) }));

vi.mock('../../../src/config/index.js', () => ({
  config: {
    fishTts: { enabled: false, modelId: 'fish-audio-s2-pro-8bit-mlx' },
    drama3Tts: {
      enabled: true,
      pythonPath: './.venv-drama3/bin/python3',
      modelPath: './checkpoints/drama-3',
      experts: 'q8',
      modelId: 'fish-drama-3',
      voiceClonesDir: './fish_voice_clones',
      maxNewTokens: 0,
      timeout: 60000,
      timeoutPerChar: 400,
      timeoutMax: 900000,
      daemonStartupTimeout: 60000,
      preWarmDaemon: false,
    },
  },
}));

describe('Drama3TTSService', () => {
  let service;
  let spawn;
  let mockStdin;
  let mockStdout;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockStdin = new Writable({
      write(chunk, encoding, callback) { mockStdin.lastWrite = chunk.toString(); callback(); },
    });
    mockStdout = new Readable({ read() {} });
    const mockProcess = new EventEmitter();
    mockProcess.stdin = mockStdin;
    mockProcess.stdout = mockStdout;
    mockProcess.stderr = new Readable({ read() {} });
    mockProcess.kill = vi.fn();
    ({ spawn } = await import('node:child_process'));
    spawn.mockReturnValue(mockProcess);
    const { Drama3TTSService } = await import('../../../src/services/drama3Tts.js');
    service = new Drama3TTSService();
  });

  afterEach(async () => {
    try { await service.shutdown(); } catch { /* ignore */ }
  });

  const initReady = async () => {
    const started = service.initialize();
    setTimeout(() => mockStdout.push(
      '{"status":"ready","voices":["default"],"clones":["marvin"],'
      + '"features":["tts","direction_tags","speaker_tags","voice_cloning"],'
      + '"sample_rate":44100,"model":"fish-drama-3"}\n',
    ), 10);
    await started;
  };

  it('spawns the Drama 3 daemon in its own venv on the shared clone store', async () => {
    await initReady();
    const [python, [script], { env }] = spawn.mock.calls[0];
    expect(python).toMatch(/\.venv-drama3\/bin\/python3$/);
    expect(script).toMatch(/scripts\/drama3_tts_daemon\.py$/);
    expect(env.DRAMA3_TTS_MODEL_PATH).toMatch(/checkpoints\/drama-3$/);
    expect(env.DRAMA3_TTS_EXPERTS).toBe('q8');
    expect(env.DRAMA3_TTS_MODEL_ID).toBe('fish-drama-3');
    expect(env.DRAMA3_TTS_MAX_NEW_TOKENS).toBe('0');
    expect(env.FISH_TTS_VOICE_CLONES_DIR).toMatch(/fish_voice_clones$/);
    expect(env.PYTHONPATH).toBe(process.env.PYTHONPATH);
  });

  it('reports the Drama 3 backend and features', async () => {
    await initReady();
    const info = service.getModelInfo();
    expect(info.backend).toBe('fish-drama3-mlx');
    expect(info.features).toContain('speaker_tags');
    expect(info.clones).toEqual(['marvin']);
    expect(service.isEnabled()).toBe(true);
  });

  it('sends generate requests in the Fish protocol', async () => {
    await initReady();
    const result = service.generate('<|speaker:0|> [quietly] Hello.', { outputPath: '/tmp/d3.wav' });
    await new Promise((r) => setTimeout(r, 10));
    const request = JSON.parse(mockStdin.lastWrite);
    expect(request).toMatchObject({ type: 'generate', output_path: '/tmp/d3.wav' });
    mockStdout.push(`{"id":"${request.id}","success":true,"output_path":"/tmp/d3.wav","duration":2.5,"rtf":0.9}\n`);
    expect(await result).toMatchObject({ outputPath: '/tmp/d3.wav', rtf: 0.9 });
  });
});
