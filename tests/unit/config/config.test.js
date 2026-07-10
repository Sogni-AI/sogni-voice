import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { localCorsOrigins } from '../../../src/utils/cors.js';

describe('config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    // Use empty strings so dotenv does not repopulate these from .env during import.
    process.env.PORT = '';
    process.env.HOST = '';
    process.env.CORS_ORIGINS = '';
    process.env.DANGEROUSLY_ALLOW_VOICE_CLONING = '';
    process.env.TTS_MODEL_ID = '';
    process.env.TTS_DEFAULT_VOICE = '';
    process.env.TTS_DEFAULT_SPEED = '';
    process.env.TTS_TIMEOUT = '';
    process.env.TTS_DAEMON_STARTUP_TIMEOUT = '';
    process.env.PREWARM_TTS = '';
    process.env.TRANSCRIBE_TIMEOUT = '';
    process.env.DIARIZATION_MODEL_ID = '';
    process.env.QWEN_ASR_ENABLED = '';
    process.env.QWEN_ASR_MODEL_ID = '';
    process.env.QWEN_ASR_ALIGNER_MODEL_ID = '';
    process.env.QWEN_ASR_PYTHON_PATH = '';
    process.env.QWEN_ASR_DEFAULT_LANGUAGE = '';
    process.env.QWEN_ASR_TIMEOUT = '';
    process.env.QWEN_ASR_DAEMON_STARTUP_TIMEOUT = '';
    process.env.PREWARM_QWEN_ASR = '';
    process.env.MOSS_TTS_ENABLED = '';
    process.env.MOSS_TTS_MODEL_ID = '';
    process.env.MOSS_TTS_PYTHON_PATH = '';
    process.env.MOSS_TTS_DEFAULT_VOICE = '';
    process.env.MOSS_TTS_TIMEOUT = '';
    process.env.MOSS_TTS_TIMEOUT_PER_CHAR_MS = '';
    process.env.MOSS_TTS_TIMEOUT_MAX = '';
    process.env.MOSS_TTS_DAEMON_STARTUP_TIMEOUT = '';
    process.env.PREWARM_MOSS_TTS = '';
    process.env.MOSS_TTS_VOICES_DIR = '';
    process.env.MAX_FILE_SIZE_MB = '';
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

    it('should use default host 127.0.0.1 when HOST not set', async () => {
      const { config } = await import('../../../src/config/index.js');
      expect(config.server.host).toBe('127.0.0.1');
    });

    it('should use HOST from environment', async () => {
      process.env.HOST = '0.0.0.0';
      const { config } = await import('../../../src/config/index.js');
      expect(config.server.host).toBe('0.0.0.0');
    });

    it('should default CORS to local-only origins', async () => {
      const { config } = await import('../../../src/config/index.js');
      expect(config.server.corsOrigins).toEqual(localCorsOrigins);
    });

    it('should parse CORS_ORIGINS from environment', async () => {
      process.env.CORS_ORIGINS = 'https://app.example.com, https://admin.example.com';
      const { config } = await import('../../../src/config/index.js');
      expect(config.server.corsOrigins).toEqual([
        'https://app.example.com',
        'https://admin.example.com',
      ]);
    });

    it('should allow all origins when CORS_ORIGINS is wildcard', async () => {
      process.env.CORS_ORIGINS = '*';
      const { config } = await import('../../../src/config/index.js');
      expect(config.server.corsOrigins).toEqual(['*']);
    });

    it('should disable CORS when CORS_ORIGINS is off', async () => {
      process.env.CORS_ORIGINS = 'off';
      const { config } = await import('../../../src/config/index.js');
      expect(config.server.corsOrigins).toEqual([]);
    });
  });

  describe('auth config', () => {
    it('should disallow public voice cloning by default', async () => {
      const { config } = await import('../../../src/config/index.js');
      expect(config.auth.dangerouslyAllowVoiceCloning).toBe(false);
    });

    it('should allow public voice cloning only when explicitly enabled', async () => {
      process.env.DANGEROUSLY_ALLOW_VOICE_CLONING = '1';
      const { config } = await import('../../../src/config/index.js');
      expect(config.auth.dangerouslyAllowVoiceCloning).toBe(true);
    });
  });

  describe('boolean env parsing', () => {
    it.each([
      ['1', true],
      ['true', true],
      ['yes', true],
      ['on', true],
      ['0', false],
      ['false', false],
      ['no', false],
      ['off', false],
    ])('should parse POCKET_TTS_ENABLED=%s', async (value, expected) => {
      process.env.POCKET_TTS_ENABLED = value;
      const { config } = await import('../../../src/config/index.js');
      expect(config.pocketTts.enabled).toBe(expected);
    });

    it('should use the default for empty boolean env values', async () => {
      process.env.POCKET_TTS_ENABLED = '';
      const { config } = await import('../../../src/config/index.js');
      expect(config.pocketTts.enabled).toBe(false);
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

  it('should disable pre-warm when PREWARM_TTS is 0', async () => {
    process.env.PREWARM_TTS = '0';
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

  describe('diarization config', () => {
    it('should use pyannote Community-1 by default', async () => {
      const { config } = await import('../../../src/config/index.js');
      expect(config.diarization.modelId).toBe('pyannote/speaker-diarization-community-1');
    });

    it('should allow DIARIZATION_MODEL_ID override', async () => {
      process.env.DIARIZATION_MODEL_ID = 'pyannote/custom-diarization-model';
      const { config } = await import('../../../src/config/index.js');
      expect(config.diarization.modelId).toBe('pyannote/custom-diarization-model');
    });
  });

  describe('qwen asr config', () => {
    it('should be disabled by default and use isolated MLX model defaults', async () => {
      const { config } = await import('../../../src/config/index.js');
      expect(config.qwenAsr).toMatchObject({
        enabled: false,
        modelId: 'mlx-community/Qwen3-ASR-0.6B-8bit',
        alignerModelId: 'mlx-community/Qwen3-ForcedAligner-0.6B-8bit',
        pythonPath: './.venv-qwen-asr/bin/python3',
        defaultLanguage: 'auto',
      });
    });

    it('should accept Qwen3-ASR environment overrides', async () => {
      process.env.QWEN_ASR_ENABLED = '1';
      process.env.QWEN_ASR_MODEL_ID = 'local/asr';
      process.env.QWEN_ASR_ALIGNER_MODEL_ID = 'local/aligner';
      process.env.QWEN_ASR_PYTHON_PATH = '/opt/qwen/bin/python';
      const { config } = await import('../../../src/config/index.js');
      expect(config.qwenAsr).toMatchObject({
        enabled: true,
        modelId: 'local/asr',
        alignerModelId: 'local/aligner',
        pythonPath: '/opt/qwen/bin/python',
      });
    });
  });

  describe('moss tts config', () => {
    it('is disabled by default and uses an isolated MLX environment', async () => {
      const { config } = await import('../../../src/config/index.js');
      expect(config.mossTts).toMatchObject({
        enabled: false,
        modelId: 'mlx-community/MOSS-TTS-Nano-100M',
        pythonPath: './.venv-moss-tts/bin/python3',
        defaultVoice: null,
        voicesDir: './moss_voice_clones',
        preWarmDaemon: false,
      });
    });

    it('accepts MOSS-TTS-Nano environment overrides', async () => {
      process.env.MOSS_TTS_ENABLED = '1';
      process.env.MOSS_TTS_MODEL_ID = 'local/moss';
      process.env.MOSS_TTS_PYTHON_PATH = '/opt/moss/bin/python';
      process.env.MOSS_TTS_DEFAULT_VOICE = 'narrator';
      process.env.MOSS_TTS_VOICES_DIR = '/srv/moss-voices';
      const { config } = await import('../../../src/config/index.js');
      expect(config.mossTts).toMatchObject({
        enabled: true,
        modelId: 'local/moss',
        pythonPath: '/opt/moss/bin/python',
        defaultVoice: 'narrator',
        voicesDir: '/srv/moss-voices',
      });
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
