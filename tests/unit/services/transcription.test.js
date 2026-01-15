import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Mock child_process before importing the service
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { TranscriptionService } from '../../../src/services/transcription.js';

describe('TranscriptionService', () => {
  let service;

  beforeEach(() => {
    service = new TranscriptionService();
    vi.clearAllMocks();
  });

  describe('transcribe', () => {
    it('should successfully transcribe an audio file', async () => {
      const mockStdout = new EventEmitter();
      const mockStderr = new EventEmitter();
      const mockChild = new EventEmitter();
      mockChild.stdout = mockStdout;
      mockChild.stderr = mockStderr;
      mockChild.kill = vi.fn();

      spawn.mockReturnValue(mockChild);
      readFile.mockResolvedValue('This is the transcribed text.');

      const transcribePromise = service.transcribe('/path/to/audio.mp3');

      // Simulate successful completion
      setTimeout(() => {
        mockChild.emit('close', 0);
      }, 10);

      const result = await transcribePromise;
      expect(result.text).toBe('This is the transcribed text.');
    });

    it('should handle transcription failure', async () => {
      const mockStdout = new EventEmitter();
      const mockStderr = new EventEmitter();
      const mockChild = new EventEmitter();
      mockChild.stdout = mockStdout;
      mockChild.stderr = mockStderr;
      mockChild.kill = vi.fn();

      spawn.mockReturnValue(mockChild);

      const transcribePromise = service.transcribe('/path/to/audio.mp3');

      setTimeout(() => {
        mockStderr.emit('data', 'Error message');
        mockChild.emit('close', 1);
      }, 10);

      await expect(transcribePromise).rejects.toThrow('Transcription failed');
    });

    it('should handle spawn errors', async () => {
      const mockStdout = new EventEmitter();
      const mockStderr = new EventEmitter();
      const mockChild = new EventEmitter();
      mockChild.stdout = mockStdout;
      mockChild.stderr = mockStderr;
      mockChild.kill = vi.fn();

      spawn.mockReturnValue(mockChild);

      const transcribePromise = service.transcribe('/path/to/audio.mp3');

      setTimeout(() => {
        mockChild.emit('error', new Error('spawn failed'));
      }, 10);

      await expect(transcribePromise).rejects.toThrow('Failed to spawn uvx');
    });

    it('should fallback to stdout when output file is not found', async () => {
      const mockStdout = new EventEmitter();
      const mockStderr = new EventEmitter();
      const mockChild = new EventEmitter();
      mockChild.stdout = mockStdout;
      mockChild.stderr = mockStderr;
      mockChild.kill = vi.fn();

      spawn.mockReturnValue(mockChild);
      readFile.mockRejectedValue(new Error('ENOENT: no such file'));

      const transcribePromise = service.transcribe('/path/to/audio.mp3');

      setTimeout(() => {
        mockStdout.emit('data', 'Stdout transcription output');
        mockChild.emit('close', 0);
      }, 10);

      const result = await transcribePromise;
      expect(result.text).toBe('Stdout transcription output');
      expect(result.rawOutput).toBe('Stdout transcription output');
    });

    it('should pass custom outputFormat option', async () => {
      const mockStdout = new EventEmitter();
      const mockStderr = new EventEmitter();
      const mockChild = new EventEmitter();
      mockChild.stdout = mockStdout;
      mockChild.stderr = mockStderr;
      mockChild.kill = vi.fn();

      spawn.mockReturnValue(mockChild);
      readFile.mockResolvedValue('{"text": "json output"}');

      const transcribePromise = service.transcribe('/path/to/audio.mp3', { outputFormat: 'json' });

      setTimeout(() => {
        mockChild.emit('close', 0);
      }, 10);

      await transcribePromise;

      expect(spawn).toHaveBeenCalledWith('uvx', [
        'parakeet-mlx',
        '/path/to/audio.mp3',
        '--output-format', 'json',
      ], expect.any(Object));
    });

    it('should accumulate stderr data', async () => {
      const mockStdout = new EventEmitter();
      const mockStderr = new EventEmitter();
      const mockChild = new EventEmitter();
      mockChild.stdout = mockStdout;
      mockChild.stderr = mockStderr;
      mockChild.kill = vi.fn();

      spawn.mockReturnValue(mockChild);

      const transcribePromise = service.transcribe('/path/to/audio.mp3');

      setTimeout(() => {
        mockStderr.emit('data', 'Error part 1');
        mockStderr.emit('data', ' Error part 2');
        mockChild.emit('close', 1);
      }, 10);

      await expect(transcribePromise).rejects.toThrow('Error part 1 Error part 2');
    });
  });
});
