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
    modelId: process.env.PARAKEET_MODEL_ID || 'mlx-community/parakeet-tdt-0.6b-v3',
    modelRevision: process.env.PARAKEET_MODEL_REVISION
      || 'ed2b7e8c15f9aaa0b5772e2efb986255eaef7e15',
    pythonPath: process.env.PARAKEET_PYTHON_PATH || './.venv/bin/python3',
    timeout: parseInt(process.env.TRANSCRIBE_TIMEOUT, 10) || 300000,
    daemonStartupTimeout: parseInt(process.env.DAEMON_STARTUP_TIMEOUT, 10) || 120000,
    preWarmDaemon: parseEnvBool(process.env.PREWARM_TRANSCRIPTION, true),
    realtimeEnabled: parseEnvBool(process.env.PARAKEET_REALTIME_ENABLED, true),
    realtimeMaxSeconds: parseInt(process.env.PARAKEET_REALTIME_MAX_SECONDS, 10) || 300,
    realtimeIdleTimeout: parseInt(process.env.PARAKEET_REALTIME_IDLE_TIMEOUT_MS, 10) || 15000,
    realtimeChunkTimeout: parseInt(process.env.PARAKEET_REALTIME_CHUNK_TIMEOUT_MS, 10) || 30000,
    realtimeMaxChunkBytes: parseInt(process.env.PARAKEET_REALTIME_MAX_CHUNK_BYTES, 10)
      || 256 * 1024,
    realtimeContextLeft: parseInt(process.env.PARAKEET_REALTIME_CONTEXT_LEFT, 10) || 256,
    realtimeContextRight: parseInt(process.env.PARAKEET_REALTIME_CONTEXT_RIGHT, 10) || 256,
    realtimeDepth: parseInt(process.env.PARAKEET_REALTIME_DEPTH, 10) || 1,
  },
  qwenAsr: {
    enabled: parseEnvBool(process.env.QWEN_ASR_ENABLED, false),
    modelId: process.env.QWEN_ASR_MODEL_ID || 'mlx-community/Qwen3-ASR-0.6B-8bit',
    alignerModelId: process.env.QWEN_ASR_ALIGNER_MODEL_ID || 'mlx-community/Qwen3-ForcedAligner-0.6B-8bit',
    pythonPath: process.env.QWEN_ASR_PYTHON_PATH || './.venv-qwen-asr/bin/python3',
    defaultLanguage: process.env.QWEN_ASR_DEFAULT_LANGUAGE || 'auto',
    timeout: parseInt(process.env.QWEN_ASR_TIMEOUT, 10) || 300000,
    daemonStartupTimeout: parseInt(process.env.QWEN_ASR_DAEMON_STARTUP_TIMEOUT, 10) || 300000,
    preWarmDaemon: parseEnvBool(process.env.PREWARM_QWEN_ASR, false),
  },
  mossTranscribeDiarize: {
    enabled: parseEnvBool(process.env.MOSS_TD_ENABLED, false),
    modelId: process.env.MOSS_TD_MODEL_ID || 'OpenMOSS-Team/MOSS-Transcribe-Diarize',
    modelRevision: process.env.MOSS_TD_MODEL_REVISION
      || 'd7231bbae2587a4af278735eb765b318c4f64edd',
    packageRevision: process.env.MOSS_TD_PACKAGE_REVISION
      || 'b5ad0f8386b155ddb89f9332ba3ca71891900357',
    pythonPath: process.env.MOSS_TD_PYTHON_PATH || './.venv-moss-transcribe/bin/python3',
    device: process.env.MOSS_TD_DEVICE || 'mps',
    dtype: process.env.MOSS_TD_DTYPE || 'fp16',
    maxNewTokens: parseInt(process.env.MOSS_TD_MAX_NEW_TOKENS, 10) || 5120,
    maxAudioSeconds: parseInt(process.env.MOSS_TD_MAX_AUDIO_SECONDS, 10) || 5400,
    timeout: parseInt(process.env.MOSS_TD_TIMEOUT, 10) || 3600000,
    daemonStartupTimeout: parseInt(process.env.MOSS_TD_DAEMON_STARTUP_TIMEOUT, 10) || 300000,
    preWarmDaemon: parseEnvBool(process.env.PREWARM_MOSS_TD, false),
  },
  diarization: {
    enabled: parseEnvBool(process.env.DIARIZATION_ENABLED, false),
    modelId: process.env.DIARIZATION_MODEL_ID || 'pyannote/speaker-diarization-community-1',
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
  mossTts: {
    enabled: parseEnvBool(process.env.MOSS_TTS_ENABLED, false),
    modelId: process.env.MOSS_TTS_MODEL_ID || 'mlx-community/MOSS-TTS-Nano-100M',
    pythonPath: process.env.MOSS_TTS_PYTHON_PATH || './.venv-moss-tts/bin/python3',
    defaultVoice: process.env.MOSS_TTS_DEFAULT_VOICE || null,
    timeout: parseInt(process.env.MOSS_TTS_TIMEOUT, 10) || 300000,
    timeoutPerChar: parseInt(process.env.MOSS_TTS_TIMEOUT_PER_CHAR_MS, 10) || 120,
    timeoutMax: parseInt(process.env.MOSS_TTS_TIMEOUT_MAX, 10) || 1800000,
    daemonStartupTimeout: parseInt(process.env.MOSS_TTS_DAEMON_STARTUP_TIMEOUT, 10) || 300000,
    preWarmDaemon: parseEnvBool(process.env.PREWARM_MOSS_TTS, false),
    voicesDir: process.env.MOSS_TTS_VOICES_DIR || './moss_voice_clones',
  },
  qwenTts: {
    enabled: parseEnvBool(process.env.QWEN_TTS_ENABLED, false),
    // Legacy single-model variant (unused in dual-daemon mode)
    modelVariant: process.env.QWEN_TTS_MODEL_VARIANT || 'base-0.6b',
    // Dual-daemon mode: run both Base (voice cloning) and CustomVoice (style) models
    baseModelVariant: process.env.QWEN_TTS_BASE_MODEL || 'base-0.6b',
    customVoiceModelVariant: process.env.QWEN_TTS_CUSTOM_VOICE_MODEL || 'custom-voice',
    voiceDesignModelVariant: process.env.QWEN_TTS_VOICE_DESIGN_MODEL || 'voice-design',
    pythonPath: process.env.QWEN_TTS_PYTHON_PATH || './.venv-qwen-tts/bin/python3',
    mlxPrecision: process.env.QWEN_TTS_MLX_PRECISION || '8bit',
    defaultVoice: process.env.QWEN_TTS_DEFAULT_VOICE || 'Ryan',
    defaultLanguage: process.env.QWEN_TTS_DEFAULT_LANGUAGE || 'English',
    timeout: parseInt(process.env.QWEN_TTS_TIMEOUT, 10) || 120000,
    timeoutPerChar: parseInt(process.env.QWEN_TTS_TIMEOUT_PER_CHAR_MS, 10) || 40,
    timeoutMax: parseInt(process.env.QWEN_TTS_TIMEOUT_MAX, 10) || 900000,
    daemonStartupTimeout: parseInt(process.env.QWEN_TTS_DAEMON_STARTUP_TIMEOUT, 10) || 300000,
    preWarmDaemon: parseEnvBool(process.env.PREWARM_QWEN_TTS, false),
    preWarmVoiceDesign: parseEnvBool(process.env.PREWARM_QWEN_TTS_VOICE_DESIGN, false),
    voiceClonesDir: process.env.QWEN_TTS_VOICE_CLONES_DIR || './voice_clones',
  },
};
