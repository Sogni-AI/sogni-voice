import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

describe('DiarizationService', () => {
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
        diarization: {
          modelId: 'pyannote/speaker-diarization-community-1',
          hfToken: null,
          timeout: 60000,
          daemonStartupTimeout: 60000,
        },
      },
    }));

    const { DiarizationService } = await import('../../../src/services/diarization.js');
    service = new DiarizationService();
  });

  afterEach(async () => {
    try {
      mockProcess?.emit('close', 0);
      await service?.shutdown();
    } catch {
      // Ignore cleanup errors from intentionally failed daemon tests.
    }
  });

  it('starts Community-1 without requiring an environment token', async () => {
    const initPromise = service.initialize();
    setTimeout(() => {
      mockStdout.push('{"status":"ready","model":"pyannote/speaker-diarization-community-1"}\n');
    }, 5);

    await initPromise;

    const { spawn } = await import('node:child_process');
    expect(spawn).toHaveBeenCalledTimes(1);
    const options = spawn.mock.calls[0][2];
    expect(options.env.DIARIZATION_MODEL_ID).toBe('pyannote/speaker-diarization-community-1');
    expect(service.isReady()).toBe(true);
  });

  it('reports gated-model startup failures', async () => {
    const initPromise = service.initialize();
    setTimeout(() => {
      mockStdout.push('{"status":"error","error":"Accept the model terms"}\n');
    }, 5);

    await expect(initPromise).rejects.toThrow('Accept the model terms');
  });

  it('passes speaker constraints and maps daemon output', async () => {
    const initPromise = service.initialize();
    setTimeout(() => mockStdout.push('{"status":"ready"}\n'), 5);
    await initPromise;

    const resultPromise = service.diarize('/tmp/conversation.wav', {
      minSpeakers: 2,
      maxSpeakers: 4,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const request = JSON.parse(mockStdin.lastWrite);
    expect(request).toMatchObject({
      audio_path: '/tmp/conversation.wav',
      num_speakers: null,
      min_speakers: 2,
      max_speakers: 4,
    });

    mockStdout.push(`${JSON.stringify({
      id: request.id,
      success: true,
      turns: [
        { start: 0, end: 1.2, speaker: 'SPEAKER_00' },
        { start: 1.2, end: 2.4, speaker: 'SPEAKER_01' },
      ],
      num_speakers: 2,
    })}\n`);

    await expect(resultPromise).resolves.toEqual({
      turns: [
        { start: 0, end: 1.2, speaker: 'SPEAKER_00' },
        { start: 1.2, end: 2.4, speaker: 'SPEAKER_01' },
      ],
      numSpeakers: 2,
    });
  });
});
