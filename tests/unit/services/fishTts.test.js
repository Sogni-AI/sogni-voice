import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

// The service verifies the python + model paths exist before spawning; make
// those checks pass in tests.
vi.mock('node:fs/promises', () => ({ access: vi.fn().mockResolvedValue(undefined) }));

vi.mock('../../../src/config/index.js', () => ({
  config: {
    fishTts: {
      enabled: true,
      pythonPath: './.venv-fish-tts/bin/python3',
      serverDir: './vendor/fish-s2-mlx',
      modelPath: './checkpoints/fish-audio-s2-pro-8bit-mlx-normalized',
      modelId: 'fish-audio-s2-pro-8bit-mlx',
      defaultVoice: 'default',
      voiceClonesDir: './fish_voice_clones',
      maxTokens: 1024,
      timeout: 60000,
      timeoutPerChar: 400,
      timeoutMax: 900000,
      daemonStartupTimeout: 60000,
      preWarmDaemon: false,
    },
  },
}));

describe('FishTTSService', () => {
  let FishTTSService;
  let service;
  let mockProcess;
  let mockStdin;
  let mockStdout;
  let mockStderr;

  const ready = () => mockStdout.push(
    '{"status":"ready","voices":["default"],"clones":["demo"],"features":["tts","voice_cloning"],"sample_rate":44100,"model":"fish-audio-s2-pro-8bit-mlx"}\n',
  );

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    mockStdin = new Writable({
      write(chunk, encoding, callback) { mockStdin.lastWrite = chunk.toString(); callback(); },
    });
    mockStdin.lastWrite = '';
    mockStdout = new Readable({ read() {} });
    mockStderr = new Readable({ read() {} });

    mockProcess = new EventEmitter();
    mockProcess.stdin = mockStdin;
    mockProcess.stdout = mockStdout;
    mockProcess.stderr = mockStderr;
    mockProcess.kill = vi.fn();

    const { spawn } = await import('node:child_process');
    spawn.mockReturnValue(mockProcess);

    const module = await import('../../../src/services/fishTts.js');
    FishTTSService = module.FishTTSService;
    service = new FishTTSService();
  });

  afterEach(async () => {
    try { await service.shutdown(); } catch { /* ignore */ }
  });

  const initReady = async () => {
    const p = service.initialize();
    setTimeout(ready, 10);
    await p;
  };

  it('starts the daemon and captures model info from the ready signal', async () => {
    await initReady();
    expect(service.isReady()).toBe(true);
    const info = service.getModelInfo();
    expect(info.model).toBe('fish-audio-s2-pro-8bit-mlx');
    expect(info.sampleRate).toBe(44100);
    expect(info.clones).toEqual(['demo']);
  });

  it('sends a generate request with inline-tagged text', async () => {
    await initReady();
    const promise = service.generate('[happy] hi', { outputPath: '/tmp/out.wav' });
    await new Promise((r) => setTimeout(r, 10));
    const request = JSON.parse(mockStdin.lastWrite);
    expect(request.type).toBe('generate');
    expect(request.text).toBe('[happy] hi');
    expect(request.output_path).toBe('/tmp/out.wav');
    mockStdout.push(`{"id":"${request.id}","success":true,"output_path":"/tmp/out.wav","duration":1.2,"rtf":1.6}\n`);
    const result = await promise;
    expect(result.outputPath).toBe('/tmp/out.wav');
    expect(result.rtf).toBe(1.6);
  });

  it('sends transcript when creating a voice clone', async () => {
    await initReady();
    const promise = service.createVoiceClone('/tmp/ref.wav', 'the words spoken', 'my_clone');
    await new Promise((r) => setTimeout(r, 10));
    const request = JSON.parse(mockStdin.lastWrite);
    expect(request.type).toBe('create_voice_clone');
    expect(request.audio_path).toBe('/tmp/ref.wav');
    expect(request.transcript).toBe('the words spoken');
    expect(request.clone_id).toBe('my_clone');
    mockStdout.push(`{"id":"${request.id}","success":true,"clone_id":"my_clone"}\n`);
    expect(await promise).toEqual({ cloneId: 'my_clone' });
  });

  it('requires a transcript for createVoiceClone', async () => {
    await initReady();
    await expect(service.createVoiceClone('/tmp/ref.wav', '', 'my_clone')).rejects.toThrow('transcript is required');
  });

  it('sends a generate_voice_clone request', async () => {
    await initReady();
    const promise = service.generateVoiceClone('hello', { cloneId: 'my_clone', outputPath: '/tmp/c.wav' });
    await new Promise((r) => setTimeout(r, 10));
    const request = JSON.parse(mockStdin.lastWrite);
    expect(request.type).toBe('generate_voice_clone');
    expect(request.clone_id).toBe('my_clone');
    mockStdout.push(`{"id":"${request.id}","success":true,"output_path":"/tmp/c.wav","duration":1.0}\n`);
    const result = await promise;
    expect(result.cloneId).toBe('my_clone');
  });
});
