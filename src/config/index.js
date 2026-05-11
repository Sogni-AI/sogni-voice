import dotenv from 'dotenv';
import { parseCorsOrigins } from '../utils/cors.js';
dotenv.config();

const parseEnvBool = (value, defaultValue = false) => {
  if (value == null) return defaultValue;
  const normalizedValue = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalizedValue)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalizedValue)) return false;
  return defaultValue;
};

export const config = {
  server: {
    port: parseInt(process.env.PORT, 10) || 3000,
    host: process.env.HOST || '127.0.0.1',
    corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS),
  },
  auth: {
    enabled: parseEnvBool(process.env.AUTH_ENABLED, false),
    apiKey: process.env.AUTH_API_KEY || null,
    excludePaths: ['/health', '/auth/status'],
    dangerouslyAllowImports: parseEnvBool(process.env.DANGEROUSLY_ALLOW_IMPORTS, false),
    dangerouslyAllowVoiceCloning: parseEnvBool(process.env.DANGEROUSLY_ALLOW_VOICE_CLONING, false),
  },
  tts: {
    enabled: parseEnvBool(process.env.TTS_ENABLED, true),
    modelId: process.env.TTS_MODEL_ID || 'mlx-community/Kokoro-82M-bf16',
    defaultVoice: process.env.TTS_DEFAULT_VOICE || 'af_heart',
    defaultSpeed: parseFloat(process.env.TTS_DEFAULT_SPEED) || 1.0,
    timeout: parseInt(process.env.TTS_TIMEOUT, 10) || 60000,
    daemonStartupTimeout: parseInt(process.env.TTS_DAEMON_STARTUP_TIMEOUT, 10) || 60000,
    preWarmDaemon: parseEnvBool(process.env.PREWARM_TTS, true),
  },
  transcription: {
    enabled: parseEnvBool(process.env.TRANSCRIPTION_ENABLED, true),
    timeout: parseInt(process.env.TRANSCRIBE_TIMEOUT, 10) || 300000,
    daemonStartupTimeout: parseInt(process.env.DAEMON_STARTUP_TIMEOUT, 10) || 120000,
    preWarmDaemon: parseEnvBool(process.env.PREWARM_TRANSCRIPTION, true),
  },
  diarization: {
    enabled: parseEnvBool(process.env.DIARIZATION_ENABLED, false),
    hfToken: process.env.HF_TOKEN || null,
    timeout: parseInt(process.env.DIARIZATION_TIMEOUT, 10) || 600000,
    daemonStartupTimeout: parseInt(process.env.DIARIZATION_DAEMON_STARTUP_TIMEOUT, 10) || 180000,
    preWarmDaemon: parseEnvBool(process.env.PREWARM_DIARIZATION, false),
  },
  upload: {
    maxFileSizeBytes: (parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 100) * 1024 * 1024,
    transcribeMaxBytes: (parseInt(process.env.TRANSCRIBE_MAX_UPLOAD_MB, 10) || 25) * 1024 * 1024,
  },
  pocketTts: {
    enabled: parseEnvBool(process.env.POCKET_TTS_ENABLED, false),
    defaultVoice: process.env.POCKET_TTS_DEFAULT_VOICE || 'alba',
    timeout: parseInt(process.env.POCKET_TTS_TIMEOUT, 10) || 60000,
    daemonStartupTimeout: parseInt(process.env.POCKET_TTS_DAEMON_STARTUP_TIMEOUT, 10) || 60000,
    preWarmDaemon: parseEnvBool(process.env.PREWARM_POCKET_TTS, true),
    voiceClonesDir: process.env.POCKET_TTS_VOICE_CLONES_DIR || './pocket_voice_clones',
  },
  qwenTts: {
    enabled: parseEnvBool(process.env.QWEN_TTS_ENABLED, false),
    // Legacy single-model variant (unused in dual-daemon mode)
    modelVariant: process.env.QWEN_TTS_MODEL_VARIANT || 'base-0.6b',
    // Dual-daemon mode: run both Base (voice cloning) and CustomVoice (style) models
    baseModelVariant: process.env.QWEN_TTS_BASE_MODEL || 'base-0.6b',
    customVoiceModelVariant: process.env.QWEN_TTS_CUSTOM_VOICE_MODEL || 'custom-voice',
    defaultVoice: process.env.QWEN_TTS_DEFAULT_VOICE || 'Chelsie',
    defaultLanguage: process.env.QWEN_TTS_DEFAULT_LANGUAGE || 'English',
    timeout: parseInt(process.env.QWEN_TTS_TIMEOUT, 10) || 300000, // 5 minutes for voice cloning
    // Per-char generation budget used to scale the timeout for long-form text.
    // Observed MPS performance is ~10s per 100-char chunk; 120ms/char adds ~20% headroom.
    timeoutPerChar: parseInt(process.env.QWEN_TTS_TIMEOUT_PER_CHAR_MS, 10) || 120,
    timeoutMax: parseInt(process.env.QWEN_TTS_TIMEOUT_MAX, 10) || 1800000, // 30 min ceiling
    daemonStartupTimeout: parseInt(process.env.QWEN_TTS_DAEMON_STARTUP_TIMEOUT, 10) || 180000,
    preWarmDaemon: parseEnvBool(process.env.PREWARM_QWEN_TTS, true),
    voiceClonesDir: process.env.QWEN_TTS_VOICE_CLONES_DIR || './voice_clones',
  },
};
