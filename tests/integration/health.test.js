import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import dotenv from 'dotenv';

// Load .env before mocking
dotenv.config();

// Mock config using environment variables
vi.mock('../../src/config/index.js', () => ({
  config: {
    server: { port: 3000, host: '0.0.0.0' },
    auth: {
      enabled: false,
      apiKey: null,
      excludePaths: ['/health', '/auth/status'],
    },
    tts: {
      enabled: process.env.TTS_ENABLED === '1',
      modelId: process.env.TTS_MODEL_ID || 'test-model',
      defaultVoice: process.env.TTS_DEFAULT_VOICE || 'af_heart',
      defaultSpeed: parseFloat(process.env.TTS_DEFAULT_SPEED) || 1.0,
      timeout: 60000,
      daemonStartupTimeout: 60000,
      preWarmDaemon: false,
    },
    transcription: {
      enabled: process.env.TRANSCRIPTION_ENABLED === '1',
      timeout: 300000,
      daemonStartupTimeout: 120000,
      preWarmDaemon: false,
    },
    upload: { maxFileSizeBytes: 100 * 1024 * 1024 },
    pocketTts: {
      enabled: process.env.POCKET_TTS_ENABLED === '1',
      defaultVoice: process.env.POCKET_TTS_DEFAULT_VOICE || 'alba',
      timeout: 60000,
      daemonStartupTimeout: 60000,
      preWarmDaemon: false,
      voiceClonesDir: process.env.POCKET_TTS_VOICE_CLONES_DIR || './pocket_voice_clones',
    },
    qwenTts: {
      enabled: process.env.QWEN_TTS_ENABLED === '1',
      modelVariant: process.env.QWEN_TTS_MODEL_VARIANT || 'base-0.6b',
      baseModelVariant: 'base-0.6b',
      customVoiceModelVariant: 'custom-voice',
      defaultVoice: process.env.QWEN_TTS_DEFAULT_VOICE || 'Chelsie',
      defaultLanguage: process.env.QWEN_TTS_DEFAULT_LANGUAGE || 'English',
      timeout: 120000,
      daemonStartupTimeout: 180000,
      preWarmDaemon: false,
      voiceClonesDir: process.env.QWEN_TTS_VOICE_CLONES_DIR || './voice_clones',
    },
  },
}));

import { initServer } from '../../src/server.js';

describe('GET /health', () => {
  let server;

  beforeAll(async () => {
    server = await initServer();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('should return healthy status', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.payload);
    expect(payload.status).toBe('healthy');
    expect(payload).toHaveProperty('timestamp');
    expect(payload).toHaveProperty('uptime');
  });
});
