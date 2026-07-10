import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

// Mock child_process before importing the service
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';

describe('TranscriptionService', () => {
  let TranscriptionService;
  let service;
  let mockProcess;
  let mockStdin;
  let mockStdout;
  let mockStderr;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset modules to clear singleton state
    vi.resetModules();

    // Re-mock after reset
    vi.doMock('node:child_process', () => ({
      spawn: vi.fn(),
    }));

    // Create mock streams
    mockStdin = new Writable({
      write(chunk, encoding, callback) {
        // Store written data for assertions
        mockStdin.lastWrite = chunk.toString();
        callback();
      }
    });
    mockStdin.lastWrite = '';

    mockStdout = new Readable({ read() {} });
    mockStderr = new Readable({ read() {} });

    // Create mock process
    mockProcess = new EventEmitter();
    mockProcess.stdin = mockStdin;
    mockProcess.stdout = mockStdout;
    mockProcess.stderr = mockStderr;
    mockProcess.kill = vi.fn();

    // Get fresh spawn mock and configure it
    const { spawn: freshSpawn } = await import('node:child_process');
    freshSpawn.mockReturnValue(mockProcess);

    // Import fresh service
    const module = await import('../../../src/services/transcription.js');
    TranscriptionService = module.TranscriptionService;
    service = new TranscriptionService();
  });

  afterEach(async () => {
    // Cleanup daemon if running
    try {
      const shutdownPromise = service.shutdown();
      if (mockProcess.listenerCount('close') > 0) {
        setTimeout(() => mockProcess.emit('close', 0), 0);
      }
      await shutdownPromise;
    } catch (e) {
      // Ignore shutdown errors in tests
    }
  });

  describe('initialize', () => {
    it('should start daemon and wait for ready signal', async () => {
      const initPromise = service.initialize();

      // Simulate daemon sending ready signal
      setTimeout(() => {
        mockStdout.push('{"status":"ready"}\n');
      }, 10);

      await initPromise;
      expect(service.isReady()).toBe(true);
    });

    it('should reject if daemon fails to start', async () => {
      const initPromise = service.initialize();

      // Simulate spawn error
      setTimeout(() => {
        mockProcess.emit('error', new Error('spawn failed'));
      }, 10);

      await expect(initPromise).rejects.toThrow('Failed to spawn daemon');
    });

    it('should reject if daemon sends error status', async () => {
      const initPromise = service.initialize();

      // Simulate daemon error during startup
      setTimeout(() => {
        mockStdout.push('{"status":"error","error":"Failed to load model"}\n');
      }, 10);

      await expect(initPromise).rejects.toThrow('Daemon failed to start');
    });

    it('should deduplicate concurrent initialization calls', async () => {
      const { spawn: freshSpawn } = await import('node:child_process');

      const promise1 = service.initialize();
      const promise2 = service.initialize();

      // Simulate ready
      setTimeout(() => {
        mockStdout.push('{"status":"ready"}\n');
      }, 10);

      await Promise.all([promise1, promise2]);

      // Spawn should only be called once despite two initialize() calls
      expect(freshSpawn).toHaveBeenCalledTimes(1);
    });

    it('should pass pinned model and realtime settings to the daemon', async () => {
      const { spawn: freshSpawn } = await import('node:child_process');
      const { config } = await import('../../../src/config/index.js');
      const initPromise = service.initialize();
      setTimeout(() => mockStdout.push('{"status":"ready","realtime":true}\n'), 10);
      await initPromise;

      expect(freshSpawn).toHaveBeenCalledWith(
        expect.any(String),
        [expect.stringContaining('scripts/parakeet_daemon.py')],
        expect.objectContaining({
          env: expect.objectContaining({
            PARAKEET_MODEL_ID: config.transcription.modelId,
            PARAKEET_MODEL_REVISION: config.transcription.modelRevision,
            PARAKEET_REALTIME_ENABLED: config.transcription.realtimeEnabled ? '1' : '0',
            PARAKEET_REALTIME_MAX_SECONDS: String(
              config.transcription.realtimeMaxSeconds,
            ),
          }),
        }),
      );
    });
  });

  describe('transcribe', () => {
    beforeEach(async () => {
      // Initialize daemon first
      const initPromise = service.initialize();
      setTimeout(() => {
        mockStdout.push('{"status":"ready"}\n');
      }, 10);
      await initPromise;
    });

    it('should successfully transcribe an audio file', async () => {
      const transcribePromise = service.transcribe('/path/to/audio.mp3');

      // Get the request ID from what was written to stdin
      await new Promise(resolve => setTimeout(resolve, 10));
      const request = JSON.parse(mockStdin.lastWrite);
      expect(request.audio_path).toBe('/path/to/audio.mp3');

      // Simulate successful response
      mockStdout.push(`{"id":"${request.id}","success":true,"text":"This is the transcribed text."}\n`);

      const result = await transcribePromise;
      expect(result.text).toBe('This is the transcribed text.');
    });

    it('should handle transcription errors', async () => {
      const transcribePromise = service.transcribe('/path/to/audio.mp3');

      await new Promise(resolve => setTimeout(resolve, 10));
      const request = JSON.parse(mockStdin.lastWrite);

      // Simulate error response
      mockStdout.push(`{"id":"${request.id}","success":false,"error":"Audio file not found"}\n`);

      await expect(transcribePromise).rejects.toThrow('Audio file not found');
    });

    it('should handle daemon crash during transcription', async () => {
      const transcribePromise = service.transcribe('/path/to/audio.mp3');

      // Simulate daemon crash
      setTimeout(() => {
        mockProcess.emit('close', 1);
      }, 10);

      await expect(transcribePromise).rejects.toThrow('Daemon process terminated');
    });

    it('should pass wordTimestamps option to daemon', async () => {
      const transcribePromise = service.transcribe('/path/to/audio.mp3', { wordTimestamps: true });

      await new Promise(resolve => setTimeout(resolve, 10));
      const request = JSON.parse(mockStdin.lastWrite);

      expect(request.audio_path).toBe('/path/to/audio.mp3');
      expect(request.word_timestamps).toBe(true);

      // Simulate response with word timestamps
      const wordTimestamps = [
        { start: 0.0, end: 0.5, text: 'This' },
        { start: 0.5, end: 0.8, text: 'is' },
        { start: 0.8, end: 1.0, text: 'a' },
        { start: 1.0, end: 1.5, text: 'test' },
      ];
      mockStdout.push(`{"id":"${request.id}","success":true,"text":"This is a test","timestamps":${JSON.stringify(wordTimestamps)}}\n`);

      const result = await transcribePromise;
      expect(result.text).toBe('This is a test');
      expect(result.timestamps).toEqual(wordTimestamps);
    });

    it('should pass timestamps option to daemon for sentence-level', async () => {
      const transcribePromise = service.transcribe('/path/to/audio.mp3', { timestamps: true });

      await new Promise(resolve => setTimeout(resolve, 10));
      const request = JSON.parse(mockStdin.lastWrite);

      expect(request.timestamps).toBe(true);
      expect(request.word_timestamps).toBe(false);

      // Simulate response with sentence timestamps
      const sentenceTimestamps = [
        { start: 0.0, end: 2.5, text: 'This is a test sentence.' },
      ];
      mockStdout.push(`{"id":"${request.id}","success":true,"text":"This is a test sentence.","timestamps":${JSON.stringify(sentenceTimestamps)}}\n`);

      const result = await transcribePromise;
      expect(result.timestamps).toEqual(sentenceTimestamps);
    });

    it('should not include timestamps when not requested', async () => {
      const transcribePromise = service.transcribe('/path/to/audio.mp3');

      await new Promise(resolve => setTimeout(resolve, 10));
      const request = JSON.parse(mockStdin.lastWrite);

      expect(request.timestamps).toBe(false);
      expect(request.word_timestamps).toBe(false);

      mockStdout.push(`{"id":"${request.id}","success":true,"text":"This is a test"}\n`);

      const result = await transcribePromise;
      expect(result.text).toBe('This is a test');
      expect(result.timestamps).toBeUndefined();
    });
  });

  describe('realtime transcription', () => {
    beforeEach(async () => {
      const initPromise = service.initialize();
      setTimeout(() => {
        mockStdout.push(JSON.stringify({
          status: 'ready',
          model: 'mlx-community/parakeet-tdt-0.6b-v3',
          revision: 'test-revision',
          parakeet_mlx_version: '0.5.2',
          sample_rate: 16000,
          realtime: true,
        }) + '\n');
      }, 10);
      await initPromise;
    });

    it('starts, streams PCM, and finalizes a native realtime session', async () => {
      const startPromise = service.startRealtimeSession();
      await new Promise(resolve => setTimeout(resolve, 10));
      const startRequest = JSON.parse(mockStdin.lastWrite);
      expect(startRequest).toMatchObject({ type: 'stream_start' });
      expect(startRequest.session_id).toMatch(/^[a-f0-9]{32}$/);

      mockStdout.push(`${JSON.stringify({
        id: startRequest.id,
        success: true,
        session_id: startRequest.session_id,
        sample_rate: 16000,
        encoding: 'pcm_f32le',
        max_seconds: 300,
        context_size: [256, 256],
        depth: 1,
      })}\n`);
      const started = await startPromise;
      expect(started.session_id).toBe(startRequest.session_id);
      expect(service.isRealtimeActive()).toBe(true);

      const pcm = Buffer.alloc(8);
      const audioPromise = service.sendRealtimeAudio(started.session_id, pcm);
      await new Promise(resolve => setTimeout(resolve, 10));
      const audioRequest = JSON.parse(mockStdin.lastWrite);
      expect(audioRequest).toMatchObject({
        type: 'stream_audio',
        session_id: started.session_id,
        audio: pcm.toString('base64'),
      });
      mockStdout.push(`${JSON.stringify({
        id: audioRequest.id,
        success: true,
        session_id: started.session_id,
        sequence: 1,
        text: 'Hello',
        finalized_text: '',
        draft_text: 'Hello',
        finalized_delta: [],
        audio_seconds: 0.5,
        processing_seconds: 0.1,
        real_time_factor: 0.2,
        final: false,
      })}\n`);
      await expect(audioPromise).resolves.toMatchObject({ text: 'Hello', sequence: 1 });

      const finishPromise = service.finishRealtimeSession(started.session_id);
      await new Promise(resolve => setTimeout(resolve, 10));
      const finishRequest = JSON.parse(mockStdin.lastWrite);
      expect(finishRequest.type).toBe('stream_finish');
      mockStdout.push(`${JSON.stringify({
        id: finishRequest.id,
        success: true,
        session_id: started.session_id,
        sequence: 1,
        text: 'Hello.',
        finalized_text: 'Hello.',
        draft_text: '',
        timestamps: [{ start: 0, end: 0.5, text: 'Hello.' }],
        audio_seconds: 0.5,
        real_time_factor: 0.2,
        final: true,
      })}\n`);
      await expect(finishPromise).resolves.toMatchObject({ text: 'Hello.', final: true });
      expect(service.isRealtimeActive()).toBe(false);
    });

    it('blocks batch work while the Parakeet streaming context is active', async () => {
      const startPromise = service.startRealtimeSession();
      await new Promise(resolve => setTimeout(resolve, 10));
      const startRequest = JSON.parse(mockStdin.lastWrite);
      mockStdout.push(`${JSON.stringify({
        id: startRequest.id,
        success: true,
        session_id: startRequest.session_id,
      })}\n`);
      const started = await startPromise;

      await expect(service.transcribe('/tmp/batch.wav')).rejects.toThrow(
        'busy with a realtime session',
      );

      const abortPromise = service.abortRealtimeSession(started.session_id);
      await new Promise(resolve => setTimeout(resolve, 10));
      const abortRequest = JSON.parse(mockStdin.lastWrite);
      mockStdout.push(`${JSON.stringify({
        id: abortRequest.id,
        success: true,
        session_id: started.session_id,
        aborted: true,
      })}\n`);
      await abortPromise;
      expect(service.isRealtimeActive()).toBe(false);
    });

    it('attempts stream cleanup when realtime startup fails', async () => {
      const startPromise = service.startRealtimeSession();
      const rejection = expect(startPromise).rejects.toThrow('stream setup failed');
      await new Promise(resolve => setTimeout(resolve, 10));
      const startRequest = JSON.parse(mockStdin.lastWrite);
      mockStdout.push(`${JSON.stringify({
        id: startRequest.id,
        success: false,
        error: 'stream setup failed',
      })}\n`);

      await new Promise(resolve => setTimeout(resolve, 10));
      const abortRequest = JSON.parse(mockStdin.lastWrite);
      expect(abortRequest).toMatchObject({
        type: 'stream_abort',
        session_id: startRequest.session_id,
      });
      mockStdout.push(`${JSON.stringify({ id: abortRequest.id, success: true })}\n`);

      await rejection;
      expect(service.isRealtimeActive()).toBe(false);
    });

    it('rejects oversized PCM chunks before sending them to the daemon', async () => {
      const startPromise = service.startRealtimeSession();
      await new Promise(resolve => setTimeout(resolve, 10));
      const startRequest = JSON.parse(mockStdin.lastWrite);
      mockStdout.push(`${JSON.stringify({
        id: startRequest.id,
        success: true,
        session_id: startRequest.session_id,
      })}\n`);
      const started = await startPromise;
      const previousWrite = mockStdin.lastWrite;

      await expect(
        service.sendRealtimeAudio(started.session_id, Buffer.alloc(256 * 1024 + 4)),
      ).rejects.toThrow('size limit');
      expect(mockStdin.lastWrite).toBe(previousWrite);

      const abortPromise = service.abortRealtimeSession(started.session_id);
      await new Promise(resolve => setTimeout(resolve, 10));
      const abortRequest = JSON.parse(mockStdin.lastWrite);
      mockStdout.push(`${JSON.stringify({ id: abortRequest.id, success: true })}\n`);
      await abortPromise;
    });

    it('reports the pinned runtime metadata from the daemon ready signal', () => {
      expect(service.getModelInfo()).toEqual({
        model: 'mlx-community/parakeet-tdt-0.6b-v3',
        revision: 'test-revision',
        parakeetMlxVersion: '0.5.2',
        sampleRate: 16000,
        realtime: true,
      });
    });
  });

  describe('shutdown', () => {
    beforeEach(async () => {
      const initPromise = service.initialize();
      setTimeout(() => {
        mockStdout.push('{"status":"ready"}\n');
      }, 10);
      await initPromise;
    });

    it('should send shutdown command and wait for close', async () => {
      const shutdownPromise = service.shutdown();

      // Verify shutdown command was sent
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(mockStdin.lastWrite).toContain('"command":"shutdown"');

      // Simulate process close
      mockProcess.emit('close', 0);

      await shutdownPromise;
      expect(service.isReady()).toBe(false);
    });

    it('should force kill if shutdown times out', async () => {
      vi.useFakeTimers();

      const shutdownPromise = service.shutdown();

      // Fast-forward past the 5 second timeout
      vi.advanceTimersByTime(6000);

      await shutdownPromise;
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL');

      vi.useRealTimers();
    });

    it('should do nothing if daemon is not running', async () => {
      // Shutdown first time
      mockProcess.emit('close', 0);
      await service.shutdown();

      // Second shutdown should be a no-op
      await service.shutdown();
      // No errors thrown
    });
  });

  describe('daemon log forwarding', () => {
    it('should forward stderr to console', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const initPromise = service.initialize();

      // Simulate stderr output
      mockStderr.push('Loading model...');

      setTimeout(() => {
        mockStdout.push('{"status":"ready"}\n');
      }, 20);

      await initPromise;

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[parakeet-daemon]')
      );

      consoleSpy.mockRestore();
    });
  });
});
