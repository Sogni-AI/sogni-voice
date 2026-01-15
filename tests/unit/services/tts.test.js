import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock kokoro-js before importing the service
vi.mock('kokoro-js', () => ({
  KokoroTTS: {
    from_pretrained: vi.fn(),
  },
}));

import { KokoroTTS } from 'kokoro-js';

describe('TTSService', () => {
  let service;
  let mockTTSInstance;
  let TTSService;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset modules to clear singleton state (ttsInstance, initPromise)
    vi.resetModules();

    // Re-import the service fresh for each test
    const module = await import('../../../src/services/tts.js');
    TTSService = module.TTSService;
    service = new TTSService();

    mockTTSInstance = {
      generate: vi.fn().mockResolvedValue({
        save: vi.fn().mockResolvedValue(undefined),
      }),
    };

    // Re-import kokoro-js mock and set it up
    const kokoroModule = await import('kokoro-js');
    kokoroModule.KokoroTTS.from_pretrained.mockResolvedValue(mockTTSInstance);
  });

  describe('initialize', () => {
    it('should initialize the TTS model', async () => {
      const result = await service.initialize();
      const kokoroModule = await import('kokoro-js');
      expect(kokoroModule.KokoroTTS.from_pretrained).toHaveBeenCalled();
      expect(result).toBe(mockTTSInstance);
    });

    it('should return existing instance if already initialized', async () => {
      const kokoroModule = await import('kokoro-js');

      // First initialization
      const result1 = await service.initialize();
      // Second call should return same instance without calling from_pretrained again
      const result2 = await service.initialize();

      expect(result1).toBe(result2);
      expect(kokoroModule.KokoroTTS.from_pretrained).toHaveBeenCalledTimes(1);
    });

    it('should handle initialization failure', async () => {
      const kokoroModule = await import('kokoro-js');
      kokoroModule.KokoroTTS.from_pretrained.mockRejectedValue(new Error('Model not found'));

      await expect(service.initialize()).rejects.toThrow('Failed to initialize TTS model');
    });

    it('should allow retry after initialization failure', async () => {
      const kokoroModule = await import('kokoro-js');

      // First call fails
      kokoroModule.KokoroTTS.from_pretrained.mockRejectedValueOnce(new Error('Network error'));
      await expect(service.initialize()).rejects.toThrow('Failed to initialize TTS model');

      // Reset mock for successful retry
      kokoroModule.KokoroTTS.from_pretrained.mockResolvedValueOnce(mockTTSInstance);

      // Second call should succeed
      const result = await service.initialize();
      expect(result).toBe(mockTTSInstance);
    });
  });

  describe('generate', () => {
    it('should generate audio with default options', async () => {
      const result = await service.generate('Hello world');

      expect(mockTTSInstance.generate).toHaveBeenCalledWith('Hello world', {
        voice: 'af_heart',
        speed: 1.0,
      });
      expect(result.voice).toBe('af_heart');
      expect(result.speed).toBe(1.0);
    });

    it('should generate audio with custom voice and speed', async () => {
      const result = await service.generate('Hello world', {
        voice: 'am_adam',
        speed: 1.5,
      });

      expect(mockTTSInstance.generate).toHaveBeenCalledWith('Hello world', {
        voice: 'am_adam',
        speed: 1.5,
      });
      expect(result.voice).toBe('am_adam');
      expect(result.speed).toBe(1.5);
    });

    it('should save to file when outputPath is provided', async () => {
      const mockAudio = {
        save: vi.fn().mockResolvedValue(undefined),
      };
      mockTTSInstance.generate.mockResolvedValue(mockAudio);

      await service.generate('Hello world', {
        outputPath: '/tmp/output.wav',
      });

      expect(mockAudio.save).toHaveBeenCalledWith('/tmp/output.wav');
    });

    it('should handle generation failure', async () => {
      mockTTSInstance.generate.mockRejectedValue(new Error('Generation failed'));

      await expect(service.generate('Hello')).rejects.toThrow('TTS generation failed');
    });

    it('should re-throw TTSError without wrapping', async () => {
      const { TTSError } = await import('../../../src/utils/errors.js');
      const originalError = new TTSError('Custom TTS error');
      mockTTSInstance.generate.mockRejectedValue(originalError);

      await expect(service.generate('Hello')).rejects.toBe(originalError);
    });

    it('should include audio object in result', async () => {
      const mockAudio = { data: 'audio data' };
      mockTTSInstance.generate.mockResolvedValue(mockAudio);

      const result = await service.generate('Hello world');

      expect(result.audio).toBe(mockAudio);
    });

    it('should include outputPath in result when provided', async () => {
      const result = await service.generate('Hello world', {
        outputPath: '/tmp/test.wav',
      });

      expect(result.outputPath).toBe('/tmp/test.wav');
    });
  });

  describe('listVoices', () => {
    it('should return available voices', () => {
      const voices = service.listVoices();
      expect(voices).toContain('af_heart');
      expect(voices).toContain('am_adam');
      expect(Array.isArray(voices)).toBe(true);
    });
  });
});
