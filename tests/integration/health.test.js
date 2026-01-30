import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Mock config to disable auth and set test values
vi.mock('../../src/config/index.js', () => ({
  config: {
    server: { port: 3000, host: '0.0.0.0' },
    auth: {
      enabled: false,
      apiKey: null,
      excludePaths: ['/health', '/auth/status'],
    },
    tts: {
      modelId: 'test-model',
      defaultVoice: 'af_heart',
      defaultSpeed: 1.0,
      timeout: 60000,
      daemonStartupTimeout: 60000,
      preWarmDaemon: false,
    },
    transcription: {
      timeout: 300000,
      daemonStartupTimeout: 120000,
      preWarmDaemon: false,
    },
    upload: { maxFileSizeBytes: 100 * 1024 * 1024 },
    pocketTts: {
      enabled: false,
      defaultVoice: 'alba',
      timeout: 60000,
      daemonStartupTimeout: 60000,
      preWarmDaemon: false,
      voiceClonesDir: './pocket_voice_clones',
    },
    qwenTts: {
      enabled: false,
      modelVariant: 'base-0.6b',
      baseModelVariant: 'base-0.6b',
      customVoiceModelVariant: 'custom-voice',
      defaultVoice: 'Chelsie',
      defaultLanguage: 'English',
      timeout: 120000,
      daemonStartupTimeout: 180000,
      preWarmDaemon: false,
      voiceClonesDir: './voice_clones',
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
