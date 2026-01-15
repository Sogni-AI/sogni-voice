import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    // Clear all relevant environment variables
    delete process.env.PORT;
    delete process.env.HOST;
    delete process.env.TTS_MODEL_ID;
    delete process.env.TTS_DTYPE;
    delete process.env.TTS_DEVICE;
    delete process.env.TTS_DEFAULT_VOICE;
    delete process.env.TTS_DEFAULT_SPEED;
    delete process.env.TRANSCRIBE_TIMEOUT;
    delete process.env.MAX_FILE_SIZE_MB;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('server config', () => {
    it('should use default port 3000 when PORT not set', async () => {
      const { config } = await import('../../../src/config/index.js');
      expect(config.server.port).toBe(3000);
    });

    it('should use PORT from environment', async () => {
      process.env.PORT = '8080';
      const { config } = await import('../../../src/config/index.js');
      expect(config.server.port).toBe(8080);
    });

    it('should use default host 0.0.0.0 when HOST not set', async () => {
      const { config } = await import('../../../src/config/index.js');
      expect(config.server.host).toBe('0.0.0.0');
    });

    it('should use HOST from environment', async () => {
      process.env.HOST = '0.0.0.0';
      const { config } = await import('../../../src/config/index.js');
      expect(config.server.host).toBe('0.0.0.0');
    });
  });

  describe('tts config', () => {
    it('should use default TTS model ID', async () => {
      const { config } = await import('../../../src/config/index.js');
      expect(config.tts.modelId).toBe('onnx-community/Kokoro-82M-v1.0-ONNX');
    });

    it('should use TTS_MODEL_ID from environment', async () => {
      process.env.TTS_MODEL_ID = 'custom-model';
      const { config } = await import('../../../src/config/index.js');
      expect(config.tts.modelId).toBe('custom-model');
    });

    it('should use default dtype fp32', async () => {
      const { config } = await import('../../../src/config/index.js');
      expect(config.tts.dtype).toBe('fp32');
    });

    it('should use TTS_DTYPE from environment', async () => {
      process.env.TTS_DTYPE = 'fp16';
      const { config } = await import('../../../src/config/index.js');
      expect(config.tts.dtype).toBe('fp16');
    });

    it('should use default device cpu', async () => {
      const { config } = await import('../../../src/config/index.js');
      expect(config.tts.device).toBe('cpu');
    });

    it('should use TTS_DEVICE from environment', async () => {
      process.env.TTS_DEVICE = 'gpu';
      const { config } = await import('../../../src/config/index.js');
      expect(config.tts.device).toBe('gpu');
    });

    it('should use default voice af_heart', async () => {
      const { config } = await import('../../../src/config/index.js');
      expect(config.tts.defaultVoice).toBe('af_heart');
    });

    it('should use TTS_DEFAULT_VOICE from environment', async () => {
      process.env.TTS_DEFAULT_VOICE = 'am_adam';
      const { config } = await import('../../../src/config/index.js');
      expect(config.tts.defaultVoice).toBe('am_adam');
    });

    it('should use default speed 1.0', async () => {
      const { config } = await import('../../../src/config/index.js');
      expect(config.tts.defaultSpeed).toBe(1.0);
    });

    it('should use TTS_DEFAULT_SPEED from environment', async () => {
      process.env.TTS_DEFAULT_SPEED = '1.5';
      const { config } = await import('../../../src/config/index.js');
      expect(config.tts.defaultSpeed).toBe(1.5);
    });
  });

  describe('transcription config', () => {
    it('should use default timeout of 300000ms (5 minutes)', async () => {
      const { config } = await import('../../../src/config/index.js');
      expect(config.transcription.timeout).toBe(300000);
    });

    it('should use TRANSCRIBE_TIMEOUT from environment', async () => {
      process.env.TRANSCRIBE_TIMEOUT = '600000';
      const { config } = await import('../../../src/config/index.js');
      expect(config.transcription.timeout).toBe(600000);
    });
  });

  describe('upload config', () => {
    it('should use default max file size of 100MB', async () => {
      const { config } = await import('../../../src/config/index.js');
      expect(config.upload.maxFileSizeBytes).toBe(100 * 1024 * 1024);
    });

    it('should calculate max file size from MAX_FILE_SIZE_MB', async () => {
      process.env.MAX_FILE_SIZE_MB = '50';
      const { config } = await import('../../../src/config/index.js');
      expect(config.upload.maxFileSizeBytes).toBe(50 * 1024 * 1024);
    });
  });
});
