import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import dotenv from 'dotenv';

dotenv.config();

vi.mock('node:child_process', () => ({
  execFile: vi.fn((command, args, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const outputPath = args[args.length - 1];
    writeFileSync(outputPath, Buffer.from('OggS_mock_opus_output'));
    cb?.(null, '', '');
  }),
}));

vi.mock('../../src/config/index.js', () => ({
  config: {
    server: { port: 3000, host: '127.0.0.1', corsOrigins: [] },
    auth: {
      enabled: false,
      apiKey: null,
      excludePaths: ['/health', '/auth/status'],
      dangerouslyAllowImports: true,
      dangerouslyAllowVoiceCloning: true,
    },
    tts: {
      enabled: false,
      modelId: 'test-model',
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
      voiceClonesDir: process.env.POCKET_TTS_VOICE_CLONES_DIR || './pocket_voice_clones',
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

vi.mock('../../src/services/pocketTts.js', () => ({
  pocketTtsService: {
    initialize: vi.fn().mockResolvedValue(undefined),
    generate: vi.fn().mockImplementation(async (text, options) => {
      writeFileSync(options.outputPath, createFakeWavBuffer());
      return {
        outputPath: options.outputPath,
        duration: 1.0,
        voice: options.voice || 'alba',
      };
    }),
    generateVoiceClone: vi.fn().mockImplementation(async (text, options) => {
      writeFileSync(options.outputPath, createFakeWavBuffer());
      return {
        outputPath: options.outputPath,
        duration: 1.0,
        cloneId: options.cloneId,
      };
    }),
    listVoices: vi.fn().mockResolvedValue({ voices: ['alba'], clones: ['Marvin'] }),
  },
}));

import { initServer } from '../../src/server.js';

describe('Pocket TTS Routes', () => {
  let server;

  beforeAll(async () => {
    server = await initServer();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('supports query-string format=opus on /pocket-tts', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/pocket-tts?format=opus',
      payload: {
        text: 'Hello world',
        voice: 'alba',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('audio/opus');
    expect(response.headers['content-disposition']).toContain('output.opus');
  });

  it('lets query-string format override payload format on /pocket-tts', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/pocket-tts?format=opus',
      payload: {
        text: 'Override test',
        voice: 'alba',
        format: 'wav',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('audio/opus');
  });
});
