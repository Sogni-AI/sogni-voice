/**
 * Shared test configuration that reads from environment variables.
 * Import this in test files to get consistent config that respects .env settings.
 */
import dotenv from 'dotenv';

// Load .env file
dotenv.config();

const toBool = (value, defaultValue = false) => {
  if (value == null) return defaultValue;
  const normalizedValue = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalizedValue)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalizedValue)) return false;
  return defaultValue;
};

export const testConfig = {
  server: { port: 3000, host: '0.0.0.0' },
  auth: {
    enabled: false, // Always disable auth in tests for simplicity
    apiKey: null,
    excludePaths: ['/health', '/auth/status'],
  },
  tts: {
    enabled: toBool(process.env.TTS_ENABLED, true),
    modelId: process.env.TTS_MODEL_ID || 'test-model',
    defaultVoice: process.env.TTS_DEFAULT_VOICE || 'af_heart',
    defaultSpeed: parseFloat(process.env.TTS_DEFAULT_SPEED) || 1.0,
    timeout: parseInt(process.env.TTS_TIMEOUT) || 60000,
    daemonStartupTimeout: parseInt(process.env.TTS_DAEMON_STARTUP_TIMEOUT) || 60000,
    preWarmDaemon: false,
  },
  transcription: {
    enabled: toBool(process.env.TRANSCRIPTION_ENABLED, true),
    timeout: parseInt(process.env.TRANSCRIBE_TIMEOUT) || 300000,
    daemonStartupTimeout: parseInt(process.env.DAEMON_STARTUP_TIMEOUT) || 120000,
    preWarmDaemon: false,
  },
  upload: {
    maxFileSizeBytes: (parseInt(process.env.MAX_FILE_SIZE_MB) || 100) * 1024 * 1024,
  },
  pocketTts: {
    enabled: toBool(process.env.POCKET_TTS_ENABLED, false),
    defaultVoice: process.env.POCKET_TTS_DEFAULT_VOICE || 'alba',
    timeout: parseInt(process.env.POCKET_TTS_TIMEOUT) || 60000,
    daemonStartupTimeout: parseInt(process.env.POCKET_TTS_DAEMON_STARTUP_TIMEOUT) || 60000,
    preWarmDaemon: false,
    voiceClonesDir: process.env.POCKET_TTS_VOICE_CLONES_DIR || './pocket_voice_clones',
  },
  mossTts: {
    enabled: toBool(process.env.MOSS_TTS_ENABLED, false),
    modelId: process.env.MOSS_TTS_MODEL_ID || 'mlx-community/MOSS-TTS-Nano-100M',
    pythonPath: process.env.MOSS_TTS_PYTHON_PATH || './.venv-moss-tts/bin/python3',
    defaultVoice: process.env.MOSS_TTS_DEFAULT_VOICE || null,
    timeout: parseInt(process.env.MOSS_TTS_TIMEOUT) || 300000,
    timeoutPerChar: parseInt(process.env.MOSS_TTS_TIMEOUT_PER_CHAR_MS) || 120,
    timeoutMax: parseInt(process.env.MOSS_TTS_TIMEOUT_MAX) || 1800000,
    daemonStartupTimeout: parseInt(process.env.MOSS_TTS_DAEMON_STARTUP_TIMEOUT) || 300000,
    preWarmDaemon: false,
    voicesDir: process.env.MOSS_TTS_VOICES_DIR || './moss_voice_clones',
  },
  qwenTts: {
    enabled: toBool(process.env.QWEN_TTS_ENABLED, false),
    modelVariant: process.env.QWEN_TTS_MODEL_VARIANT || 'base-0.6b',
    baseModelVariant: 'base-0.6b',
    customVoiceModelVariant: 'custom-voice',
    defaultVoice: process.env.QWEN_TTS_DEFAULT_VOICE || 'Chelsie',
    defaultLanguage: process.env.QWEN_TTS_DEFAULT_LANGUAGE || 'English',
    timeout: parseInt(process.env.QWEN_TTS_TIMEOUT) || 120000,
    daemonStartupTimeout: parseInt(process.env.QWEN_TTS_DAEMON_STARTUP_TIMEOUT) || 180000,
    preWarmDaemon: false,
    voiceClonesDir: process.env.QWEN_TTS_VOICE_CLONES_DIR || './voice_clones',
  },
};
