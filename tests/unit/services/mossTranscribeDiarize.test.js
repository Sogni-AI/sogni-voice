import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

describe('MossTranscribeDiarizeService', () => {
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
        mossTranscribeDiarize: {
          enabled: true,
          modelId: 'OpenMOSS-Team/MOSS-Transcribe-Diarize',
          modelRevision: 'model-revision',
          packageRevision: 'package-revision',
          pythonPath: './.venv-moss-transcribe/bin/python3',
          device: 'mps',
          dtype: 'fp16',
          maxNewTokens: 5120,
          maxAudioSeconds: 5400,
          timeout: 60000,
          daemonStartupTimeout: 60000,
          preWarmDaemon: false,
        },
      },
    }));

    const { MossTranscribeDiarizeService } = await import(
      '../../../src/services/mossTranscribeDiarize.js'
    );
    service = new MossTranscribeDiarizeService();
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
        model: 'OpenMOSS-Team/MOSS-Transcribe-Diarize',
        revision: 'model-revision',
      }) + '\n');
    }, 5);
    await promise;
  }

  it('starts the pinned isolated MPS daemon', async () => {
    await initialize();

    const { spawn } = await import('node:child_process');
    expect(spawn).toHaveBeenCalledTimes(1);
    const [pythonPath, args, options] = spawn.mock.calls[0];
    expect(pythonPath).toMatch(/\.venv-moss-transcribe\/bin\/python3$/);
    expect(args[0]).toMatch(/scripts\/moss_transcribe_diarize_daemon\.py$/);
    expect(options.env).toMatchObject({
      MOSS_TD_MODEL_ID: 'OpenMOSS-Team/MOSS-Transcribe-Diarize',
      MOSS_TD_MODEL_REVISION: 'model-revision',
      MOSS_TD_PACKAGE_REVISION: 'package-revision',
      MOSS_TD_DEVICE: 'mps',
      MOSS_TD_DTYPE: 'fp16',
      MOSS_TD_MAX_NEW_TOKENS: '5120',
      MOSS_TD_MAX_AUDIO_SECONDS: '5400',
      PYTORCH_ENABLE_MPS_FALLBACK: '1',
    });
    expect(service.isReady()).toBe(true);
  });

  it('returns parsed speaker segments and runtime metrics', async () => {
    await initialize();
    const resultPromise = service.transcribe('/tmp/meeting.wav', {
      prompt: 'Transcribe with speakers.',
      hotwords: 'Sogni, MLX',
      maxNewTokens: 4096,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const request = JSON.parse(mockStdin.lastWrite);
    expect(request).toMatchObject({
      type: 'transcribe',
      audio_path: '/tmp/meeting.wav',
      prompt: 'Transcribe with speakers.',
      hotwords: 'Sogni, MLX',
      max_new_tokens: 4096,
    });

    mockStdout.push(JSON.stringify({
      id: request.id,
      success: true,
      text: 'Hello. Hi.',
      raw_transcript: '[0.00][S01]Hello.[0.80][0.90][S02]Hi.[1.30]',
      segments: [
        { start: 0, end: 0.8, speaker: 'S01', text: 'Hello.' },
        { start: 0.9, end: 1.3, speaker: 'S02', text: 'Hi.' },
      ],
      num_speakers: 2,
      model: 'OpenMOSS-Team/MOSS-Transcribe-Diarize',
      revision: 'model-revision',
      metrics: {
        audio_seconds: 1.3,
        elapsed_seconds: 0.7,
        real_time_factor: 0.54,
        prompt_tokens: 220,
        generated_tokens: 42,
        max_new_tokens: 4096,
        truncated: false,
      },
    }) + '\n');

    await expect(resultPromise).resolves.toEqual({
      text: 'Hello. Hi.',
      rawTranscript: '[0.00][S01]Hello.[0.80][0.90][S02]Hi.[1.30]',
      timestamps: [
        { start: 0, end: 0.8, speaker: 'S01', text: 'Hello.' },
        { start: 0.9, end: 1.3, speaker: 'S02', text: 'Hi.' },
      ],
      numSpeakers: 2,
      model: 'OpenMOSS-Team/MOSS-Transcribe-Diarize',
      revision: 'model-revision',
      timestampLevel: 'segment',
      metrics: {
        audioSeconds: 1.3,
        elapsedSeconds: 0.7,
        realTimeFactor: 0.54,
        promptTokens: 220,
        generatedTokens: 42,
        maxNewTokens: 4096,
        truncated: false,
      },
    });
  });

  it('surfaces daemon startup errors', async () => {
    const promise = service.initialize();
    setTimeout(() => {
      mockStdout.push('{"status":"error","error":"revision mismatch"}\n');
    }, 5);
    await expect(promise).rejects.toThrow('revision mismatch');
  });
});
