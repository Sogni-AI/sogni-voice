import dotenv from 'dotenv';
dotenv.config();

export const config = {
  server: {
    port: parseInt(process.env.PORT, 10) || 3000,
    host: process.env.HOST || '0.0.0.0',
  },
  tts: {
    modelId: process.env.TTS_MODEL_ID || 'mlx-community/Kokoro-82M-bf16',
    defaultVoice: process.env.TTS_DEFAULT_VOICE || 'af_heart',
    defaultSpeed: parseFloat(process.env.TTS_DEFAULT_SPEED) || 1.0,
    timeout: parseInt(process.env.TTS_TIMEOUT, 10) || 60000,
    daemonStartupTimeout: parseInt(process.env.TTS_DAEMON_STARTUP_TIMEOUT, 10) || 60000,
    preWarmDaemon: process.env.PREWARM_TTS !== 'false',
  },
  transcription: {
    timeout: parseInt(process.env.TRANSCRIBE_TIMEOUT, 10) || 300000,
    daemonStartupTimeout: parseInt(process.env.DAEMON_STARTUP_TIMEOUT, 10) || 120000,
    preWarmDaemon: process.env.PREWARM_TRANSCRIPTION !== 'false',
  },
  upload: {
    maxFileSizeBytes: (parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 100) * 1024 * 1024,
  },
  qwenTts: {
    enabled: process.env.QWEN_TTS_ENABLED === 'true',
    modelVariant: process.env.QWEN_TTS_MODEL_VARIANT || 'base-0.6b',
    defaultVoice: process.env.QWEN_TTS_DEFAULT_VOICE || 'Chelsie',
    defaultLanguage: process.env.QWEN_TTS_DEFAULT_LANGUAGE || 'English',
    timeout: parseInt(process.env.QWEN_TTS_TIMEOUT, 10) || 300000, // 5 minutes for voice cloning
    daemonStartupTimeout: parseInt(process.env.QWEN_TTS_DAEMON_STARTUP_TIMEOUT, 10) || 180000,
    preWarmDaemon: process.env.PREWARM_QWEN_TTS === 'true',
    voiceClonesDir: process.env.QWEN_TTS_VOICE_CLONES_DIR || './voice_clones',
  },
};
