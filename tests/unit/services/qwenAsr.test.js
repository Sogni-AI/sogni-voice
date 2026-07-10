import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

describe('QwenASRService', () => {
  let service;
  let mockProcess;
  let mockStdin;
  let mockStdout;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

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

    const spawn = vi.fn().mockReturnValue(mockProcess);
    vi.doMock('node:child_process', () => ({ spawn }));
    vi.doMock('../../../src/config/index.js', () => ({
      config: {
        qwenAsr: {
          enabled: true,
          modelId: 'mlx-community/Qwen3-ASR-0.6B-8bit',
          alignerModelId: 'mlx-community/Qwen3-ForcedAligner-0.6B-8bit',
          pythonPath: './.venv-qwen-asr/bin/python3',
          defaultLanguage: 'auto',
          timeout: 60000,
          daemonStartupTimeout: 60000,
          preWarmDaemon: false,
        },
      },
    }));

    const { QwenASRService } = await import('../../../src/services/qwenAsr.js');
    service = new QwenASRService();
  });

  afterEach(async () => {
    try {
      mockProcess?.emit('close', 0);
      await service?.shutdown();
    } catch {
      // Ignore cleanup errors from intentional failure paths.
    }
  });

  async function initialize() {
    const promise = service.initialize();
    setTimeout(() => {
      mockStdout.push(JSON.stringify({
        status: 'ready',
        model: 'mlx-community/Qwen3-ASR-0.6B-8bit',
      }) + '\n');
    }, 5);
    await promise;
  }

  it('starts the isolated MLX-Audio daemon with both model IDs', async () => {
    await initialize();

    const { spawn } = await import('node:child_process');
    expect(spawn).toHaveBeenCalledTimes(1);
    const [pythonPath, args, options] = spawn.mock.calls[0];
    expect(pythonPath).toMatch(/\.venv-qwen-asr\/bin\/python3$/);
    expect(args[0]).toMatch(/scripts\/qwen_asr_daemon\.py$/);
    expect(options.env).toMatchObject({
      QWEN_ASR_MODEL_ID: 'mlx-community/Qwen3-ASR-0.6B-8bit',
      QWEN_ASR_ALIGNER_MODEL_ID: 'mlx-community/Qwen3-ForcedAligner-0.6B-8bit',
    });
    expect(service.isReady()).toBe(true);
  });

  it('transcribes with language detection and word alignment options', async () => {
    await initialize();
    const resultPromise = service.transcribe('/tmp/speech.m4a', {
      language: 'auto',
      wordTimestamps: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const request = JSON.parse(mockStdin.lastWrite);
    expect(request).toMatchObject({
      type: 'transcribe',
      audio_path: '/tmp/speech.m4a',
      language: 'auto',
      timestamps: false,
      word_timestamps: true,
    });

    mockStdout.push(JSON.stringify({
      id: request.id,
      success: true,
      text: 'Hello world.',
      language: 'English',
      languages: ['English'],
      model: 'mlx-community/Qwen3-ASR-0.6B-8bit',
      timestamp_level: 'word',
      timestamps: [{ text: 'Hello', start: 0, end: 0.4 }],
    }) + '\n');

    await expect(resultPromise).resolves.toEqual({
      text: 'Hello world.',
      rawOutput: '',
      language: 'English',
      languages: ['English'],
      model: 'mlx-community/Qwen3-ASR-0.6B-8bit',
      timestampLevel: 'word',
      timestamps: [{ text: 'Hello', start: 0, end: 0.4 }],
    });
  });

  it('sends explicit forced-alignment requests', async () => {
    await initialize();
    const resultPromise = service.align('/tmp/speech.wav', 'Hello world.', 'English');
    await new Promise((resolve) => setTimeout(resolve, 5));

    const request = JSON.parse(mockStdin.lastWrite);
    expect(request).toMatchObject({
      type: 'align',
      audio_path: '/tmp/speech.wav',
      text: 'Hello world.',
      language: 'English',
    });

    mockStdout.push(JSON.stringify({
      id: request.id,
      success: true,
      text: 'Hello world.',
      language: 'English',
      model: 'mlx-community/Qwen3-ForcedAligner-0.6B-8bit',
      timestamps: [
        { text: 'Hello', start: 0, end: 0.4 },
        { text: 'world', start: 0.4, end: 0.8 },
      ],
    }) + '\n');

    const result = await resultPromise;
    expect(result.timestamps).toHaveLength(2);
    expect(result.model).toContain('ForcedAligner');
  });

  it('surfaces daemon startup errors without leaving a live timeout', async () => {
    const promise = service.initialize();
    setTimeout(() => {
      mockStdout.push('{"status":"error","error":"model unavailable"}\n');
    }, 5);
    await expect(promise).rejects.toThrow('model unavailable');
  });
});
