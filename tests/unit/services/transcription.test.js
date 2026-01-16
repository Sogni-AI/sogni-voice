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
      await service.shutdown();
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
