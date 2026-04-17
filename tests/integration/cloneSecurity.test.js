import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { writeFileSync } from 'node:fs';

const createFakeWavBuffer = () => {
  const buffer = Buffer.alloc(44);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(24000, 24);
  buffer.writeUInt32LE(48000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(0, 40);
  return buffer;
};

vi.mock('../../src/config/index.js', () => ({
  config: {
    server: { port: 3000, host: '127.0.0.1', corsOrigins: [] },
    auth: {
      enabled: false,
      apiKey: 'test-clone-key',
      excludePaths: ['/health', '/auth/status'],
      dangerouslyAllowImports: false,
      dangerouslyAllowVoiceCloning: false,
    },
    tts: {
      enabled: false,
      defaultVoice: 'af_heart',
      defaultSpeed: 1.0,
      timeout: 60000,
      daemonStartupTimeout: 60000,
      preWarmDaemon: false,
    },
    transcription: {
      enabled: false,
      timeout: 300000,
      daemonStartupTimeout: 120000,
      preWarmDaemon: false,
    },
    upload: { maxFileSizeBytes: 100 * 1024 * 1024 },
    pocketTts: {
      enabled: true,
      defaultVoice: 'alba',
      timeout: 60000,
      daemonStartupTimeout: 60000,
      preWarmDaemon: false,
      voiceClonesDir: './pocket_voice_clones',
    },
    qwenTts: {
      enabled: true,
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

vi.mock('../../src/services/qwenTts.js', () => ({
  qwenTtsBaseService: {
    initialize: vi.fn().mockResolvedValue(undefined),
    generateVoiceClone: vi.fn().mockImplementation(async (text, options) => {
      writeFileSync(options.outputPath, createFakeWavBuffer());
      return { outputPath: options.outputPath, duration: 1.0, cloneId: options.cloneId };
    }),
    listVoiceClones: vi.fn().mockResolvedValue({ clones: ['secret-qwen-clone'] }),
    getModelInfo: vi.fn().mockReturnValue({ variant: 'base-0.6b', features: ['tts', 'voice_cloning'], voices: [] }),
    supportsFeature: vi.fn().mockReturnValue(true),
    shutdown: vi.fn().mockResolvedValue(undefined),
  },
  qwenTtsCustomVoiceService: {
    initialize: vi.fn().mockResolvedValue(undefined),
    listVoices: vi.fn().mockReturnValue(['Chelsie']),
    getModelInfo: vi.fn().mockReturnValue({ variant: 'custom-voice', features: ['tts', 'custom_voice'], voices: ['Chelsie'] }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  },
  qwenTtsService: {
    shutdown: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/services/pocketTts.js', () => ({
  pocketTtsService: {
    initialize: vi.fn().mockResolvedValue(undefined),
    generateVoiceClone: vi.fn().mockImplementation(async (text, options) => {
      writeFileSync(options.outputPath, createFakeWavBuffer());
      return { outputPath: options.outputPath, duration: 1.0, cloneId: options.cloneId };
    }),
    listVoices: vi.fn().mockResolvedValue({ voices: ['alba'], clones: ['secret-pocket-clone'] }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/services/tts.js', () => ({
  ttsService: {
    shutdown: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/services/transcription.js', () => ({
  transcriptionService: {
    shutdown: vi.fn().mockResolvedValue(undefined),
  },
}));

import { initServer } from '../../src/server.js';

describe('Voice Clone Security', () => {
  let server;

  beforeAll(async () => {
    server = await initServer();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('hides Qwen clone IDs from unauthenticated callers', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/qwen-tts/voices',
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.payload);
    expect(payload.clones).toEqual([]);
  });

  it('requires an API key for Qwen clone generation', async () => {
    const unauthorized = await server.inject({
      method: 'POST',
      url: '/qwen-tts/voices/clone/secret-qwen-clone/generate',
      payload: {
        text: 'test',
        format: 'buffer',
      },
    });

    expect(unauthorized.statusCode).toBe(401);

    const authorized = await server.inject({
      method: 'POST',
      url: '/qwen-tts/voices/clone/secret-qwen-clone/generate',
      headers: {
        'X-API-Key': 'test-clone-key',
      },
      payload: {
        text: 'test',
        format: 'buffer',
      },
    });

    expect(authorized.statusCode).toBe(200);
  });

  it('hides Pocket clone IDs from unauthenticated callers', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/pocket-tts/voices',
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.payload);
    expect(payload.clones).toEqual([]);
  });

  it('requires an API key for Pocket clone generation', async () => {
    const unauthorized = await server.inject({
      method: 'POST',
      url: '/pocket-tts/voices/clone/secret-pocket-clone/generate',
      payload: {
        text: 'test',
        format: 'buffer',
      },
    });

    expect(unauthorized.statusCode).toBe(401);

    const authorized = await server.inject({
      method: 'POST',
      url: '/pocket-tts/voices/clone/secret-pocket-clone/generate',
      headers: {
        'Authorization': 'Bearer test-clone-key',
      },
      payload: {
        text: 'test',
        format: 'buffer',
      },
    });

    expect(authorized.statusCode).toBe(200);
  });
});
