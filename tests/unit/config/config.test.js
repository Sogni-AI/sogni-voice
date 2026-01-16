import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    // Clear all relevant environment variables
    delete process.env.PORT;
    delete process.env.HOST;
    delete process.env.TTS_MODEL_ID;
    delete process.env.TTS_DEFAULT_VOICE;
    delete process.env.TTS_DEFAULT_SPEED;
    delete process.env.TTS_TIMEOUT;
    delete process.env.TTS_DAEMON_STARTUP_TIMEOUT;
    delete process.env.PREWARM_TTS;
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
    it('should use default TTS model ID (MLX)', async () => {
      const { config } = await import('../../../src/config/index.js');
      expect(config.tts.modelId).toBe('mlx-community/Kokoro-82M-bf16');
    });

    it('should use TTS_MODEL_ID from environment', async () => {
      process.env.TTS_MODEL_ID = 'custom-model';
      const { config } = await import('../../../src/config/index.js');
      expect(config.tts.modelId).toBe('custom-model');
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

    it('should use default timeout of 60000ms', async () => {
      const { config } = await import('../../../src/config/index.js');
      expect(config.tts.timeout).toBe(60000);
    });

    it('should use TTS_TIMEOUT from environment', async () => {
      process.env.TTS_TIMEOUT = '120000';
      const { config } = await import('../../../src/config/index.js');
      expect(config.tts.timeout).toBe(120000);
    });

    it('should use default daemon startup timeout of 60000ms', async () => {
      const { config } = await import('../../../src/config/index.js');
      expect(config.tts.daemonStartupTimeout).toBe(60000);
    });

    it('should use TTS_DAEMON_STARTUP_TIMEOUT from environment', async () => {
      process.env.TTS_DAEMON_STARTUP_TIMEOUT = '90000';
      const { config } = await import('../../../src/config/index.js');
      expect(config.tts.daemonStartupTimeout).toBe(90000);
    });

    it('should pre-warm daemon by default', async () => {
      const { config } = await import('../../../src/config/index.js');
      expect(config.tts.preWarmDaemon).toBe(true);
    });

    it('should disable pre-warm when PREWARM_TTS is false', async () => {
      process.env.PREWARM_TTS = 'false';
      const { config } = await import('../../../src/config/index.js');
      expect(config.tts.preWarmDaemon).toBe(false);
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
