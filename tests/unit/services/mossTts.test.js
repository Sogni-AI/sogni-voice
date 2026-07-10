import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { mkdir, rm, writeFile } from 'node:fs/promises';

describe('MossTTSService', () => {
  const voicesDir = `/tmp/sogni-moss-service-test-${process.pid}`;
  let service;
  let mockProcess;
  let mockStdin;
  let mockStdout;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    await rm(voicesDir, { recursive: true, force: true });

    mockStdin = new Writable({
      write(chunk, encoding, callback) {
        mockStdin.lastWrite = chunk.toString();
        callback();
      },
    });
    mockStdin.lastWrite = '';
    mockStdout = new Readable({ read() {} });

    mockProcess = new EventEmitter();
    mockProcess.stdin = mockStdin;
    mockProcess.stdout = mockStdout;
    mockProcess.stderr = new Readable({ read() {} });
    mockProcess.kill = vi.fn();

    vi.doMock('node:child_process', () => ({
      spawn: vi.fn().mockReturnValue(mockProcess),
    }));
    vi.doMock('../../../src/config/index.js', () => ({
      config: {
        mossTts: {
          enabled: true,
          modelId: 'mlx-community/MOSS-TTS-Nano-100M',
          pythonPath: './.venv-moss-tts/bin/python3',
          defaultVoice: null,
          timeout: 1000,
          timeoutPerChar: 100,
          timeoutMax: 10000,
          daemonStartupTimeout: 1000,
          preWarmDaemon: false,
          voicesDir,
        },
      },
    }));

    const { MossTTSService } = await import('../../../src/services/mossTts.js');
    service = new MossTTSService();
  });

  afterEach(async () => {
    mockProcess?.emit('close', 0);
    await service?.shutdown();
    await rm(voicesDir, { recursive: true, force: true });
  });

  async function initialize() {
    const promise = service.initialize();
    setTimeout(() => {
      mockStdout.push(JSON.stringify({
        status: 'ready',
        model: 'mlx-community/MOSS-TTS-Nano-100M',
        features: ['multilingual_tts', 'voice_cloning'],
        streaming: false,
        sample_rate: 48000,
      }) + '\n');
    }, 5);
    await promise;
  }

  it('starts the isolated MLX daemon with model and voice directory', async () => {
    await initialize();
    const { spawn } = await import('node:child_process');
    const [pythonPath, args, options] = spawn.mock.calls[0];
    expect(pythonPath).toMatch(/\.venv-moss-tts\/bin\/python3$/);
    expect(args[0]).toMatch(/scripts\/moss_tts_daemon\.py$/);
    expect(options.env).toMatchObject({
      MOSS_TTS_MODEL_ID: 'mlx-community/MOSS-TTS-Nano-100M',
      MOSS_TTS_VOICES_DIR: voicesDir,
    });
    expect(service.isReady()).toBe(true);
    expect(service.getModelInfo()).toMatchObject({ streaming: false, sampleRate: 48000 });
  });

  it('generates with a saved reference voice', async () => {
    await initialize();
    const promise = service.generate('Hello world', {
      voiceId: 'my_voice',
      outputPath: '/tmp/moss-output.wav',
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const request = JSON.parse(mockStdin.lastWrite);
    expect(request).toMatchObject({
      type: 'generate',
      text: 'Hello world',
      voice_id: 'my_voice',
      output_path: '/tmp/moss-output.wav',
    });

    mockStdout.push(JSON.stringify({
      id: request.id,
      success: true,
      output_path: '/tmp/moss-output.wav',
      voice_id: 'my_voice',
      duration: 1.2,
      sample_rate: 48000,
      channels: 2,
      processing_seconds: 0.8,
      real_time_factor: 1.5,
      model: 'mlx-community/MOSS-TTS-Nano-100M',
    }) + '\n');

    await expect(promise).resolves.toMatchObject({
      voiceId: 'my_voice',
      duration: 1.2,
      sampleRate: 48000,
      channels: 2,
    });
  });

  it('creates, renames, and deletes reference voices through the daemon', async () => {
    await initialize();

    const createPromise = service.createVoice('/tmp/ref.wav', 'voice_one');
    await new Promise((resolve) => setTimeout(resolve, 5));
    let request = JSON.parse(mockStdin.lastWrite);
    expect(request).toMatchObject({
      type: 'create_voice',
      audio_path: '/tmp/ref.wav',
      voice_id: 'voice_one',
    });
    mockStdout.push(JSON.stringify({
      id: request.id,
      success: true,
      voice_id: 'voice_one',
      duration: 5,
    }) + '\n');
    await expect(createPromise).resolves.toEqual({ voiceId: 'voice_one', duration: 5 });

    const renamePromise = service.renameVoice('voice_one', 'voice_two');
    await new Promise((resolve) => setTimeout(resolve, 5));
    request = JSON.parse(mockStdin.lastWrite);
    expect(request).toMatchObject({
      type: 'rename_voice',
      old_voice_id: 'voice_one',
      voice_id: 'voice_two',
    });
    mockStdout.push(JSON.stringify({
      id: request.id,
      success: true,
      old_voice_id: 'voice_one',
      voice_id: 'voice_two',
    }) + '\n');
    await expect(renamePromise).resolves.toEqual({ oldVoiceId: 'voice_one', voiceId: 'voice_two' });

    const deletePromise = service.deleteVoice('voice_two');
    await new Promise((resolve) => setTimeout(resolve, 5));
    request = JSON.parse(mockStdin.lastWrite);
    expect(request).toMatchObject({ type: 'delete_voice', voice_id: 'voice_two' });
    mockStdout.push(JSON.stringify({
      id: request.id,
      success: true,
      voice_id: 'voice_two',
    }) + '\n');
    await expect(deletePromise).resolves.toEqual({ voiceId: 'voice_two' });
  });

  it('lists only complete reference profiles without starting the model', async () => {
    await mkdir(`${voicesDir}/valid_voice`, { recursive: true });
    await writeFile(`${voicesDir}/valid_voice/reference.wav`, 'wav');
    await mkdir(`${voicesDir}/incomplete`, { recursive: true });
    await mkdir(`${voicesDir}/invalid.name`, { recursive: true });
    await writeFile(`${voicesDir}/invalid.name/reference.wav`, 'wav');

    await expect(service.listVoices()).resolves.toEqual(['valid_voice']);
    const { spawn } = await import('node:child_process');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('scales long-text timeouts and enforces the configured ceiling', () => {
    expect(service.requestTimeout('create_voice', {})).toBe(1000);
    expect(service.requestTimeout('generate', { text: 'x'.repeat(50) })).toBe(5000);
    expect(service.requestTimeout('generate', { text: 'x'.repeat(500) })).toBe(10000);
  });

  it('surfaces startup errors', async () => {
    const promise = service.initialize();
    setTimeout(() => {
      mockStdout.push('{"status":"error","error":"model unavailable"}\n');
    }, 5);
    await expect(promise).rejects.toThrow('model unavailable');
  });
});
