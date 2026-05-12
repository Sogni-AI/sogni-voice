import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import { writeFileSync, copyFileSync } from 'node:fs';
import dotenv from 'dotenv';

// Load .env before mocking
dotenv.config();

// Mock child_process.execFile for ffmpeg conversion
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    execFile: vi.fn((cmd, args, ...rest) => {
      // Support both (cmd, args, callback) and (cmd, args, options, callback)
      const callback = typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1] : rest[0];
      // For ffmpeg conversion, just copy the input to output
      if (cmd === 'ffmpeg' && args.includes('-i')) {
        const inputIndex = args.indexOf('-i') + 1;
        const inputPath = args[inputIndex];
        const outputPath = args[args.length - 1];
        try {
          copyFileSync(inputPath, outputPath);
          callback(null, '', '');
        } catch (e) {
          callback(e, '', '');
        }
      } else {
        original.execFile(cmd, args, callback);
      }
    }),
  };
});

// Create a fake WAV header (minimal valid WAV structure)
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

// Mock the config using environment variables
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
      enabled: process.env.TTS_ENABLED === '1',
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
      modelVariant: process.env.QWEN_TTS_MODEL_VARIANT || 'base-1.7b',
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

// Mock the Qwen TTS services (dual-daemon setup)
// Note: Factory function is inlined to avoid hoisting issues with vi.mock
vi.mock('../../src/services/qwenTts.js', () => {
  const { writeFileSync } = require('node:fs');

  // Create fake WAV buffer inline
  const createFakeWav = () => {
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

  const createMockService = (variant, features) => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    generate: vi.fn().mockImplementation(async (text, options) => {
      if (options.outputPath) {
        writeFileSync(options.outputPath, createFakeWav());
      }
      return {
        outputPath: options.outputPath,
        duration: 1.5,
        voice: options.voice || 'Chelsie',
        language: options.language || 'English',
      };
    }),
    generateCustomVoice: vi.fn().mockImplementation(async (text, options) => {
      if (options.outputPath) {
        writeFileSync(options.outputPath, createFakeWav());
      }
      return {
        outputPath: options.outputPath,
        duration: 1.5,
        speaker: options.speaker || 'Chelsie',
        instruct: options.instruct,
      };
    }),
    generateVoiceDesign: vi.fn().mockImplementation(async (text, options) => {
      if (options.outputPath) {
        writeFileSync(options.outputPath, createFakeWav());
      }
      return {
        outputPath: options.outputPath,
        duration: 1.5,
        instruct: options.instruct,
      };
    }),
    createVoiceClone: vi.fn().mockResolvedValue({ cloneId: 'clone_test123' }),
    generateVoiceClone: vi.fn().mockImplementation(async (text, options) => {
      if (options.outputPath) {
        writeFileSync(options.outputPath, createFakeWav());
      }
      return {
        outputPath: options.outputPath,
        duration: 1.5,
        cloneId: options.cloneId,
        language: options.language || 'English',
      };
    }),
    deleteVoiceClone: vi.fn().mockResolvedValue({ cloneId: 'clone_test123' }),
    renameVoiceClone: vi.fn().mockResolvedValue({ oldCloneId: 'clone_test123', newCloneId: 'renamed_clone' }),
    listVoiceClones: vi.fn().mockResolvedValue({ clones: ['clone_test123', 'clone_test456'] }),
    listVoices: vi.fn().mockReturnValue(['Chelsie', 'Ethan', 'Serena', 'Vivian']),
    getModelInfo: vi.fn().mockReturnValue({
      variant,
      features,
      voices: ['Chelsie', 'Ethan'],
    }),
    supportsFeature: vi.fn().mockImplementation((feature) => features.includes(feature)),
    shutdown: vi.fn().mockResolvedValue(undefined),
    isEnabled: vi.fn().mockReturnValue(true),
    voiceCloneExists: vi.fn().mockResolvedValue(true),
    getVoiceClonePath: vi.fn().mockImplementation((cloneId) => `./voice_clones/${cloneId}.safetensors`),
    resolveVoiceClonePath: vi.fn().mockImplementation(async (cloneId) => `./voice_clones/${cloneId}.safetensors`),
    validateVoiceClone: vi.fn().mockResolvedValue({ valid: true }),
    importVoiceClone: vi.fn().mockResolvedValue({ cloneId: 'imported_clone' }),
  });

  return {
    qwenTtsBaseService: createMockService('base-0.6b', ['tts', 'voice_cloning', 'voice_design']),
    qwenTtsCustomVoiceService: createMockService('custom-voice', ['tts', 'custom_voice']),
    qwenTtsService: createMockService('base-0.6b', ['tts', 'voice_cloning', 'voice_design']),
  };
});

// Mock the TTS service (to avoid conflicts)
vi.mock('../../src/services/tts.js', () => ({
  ttsService: {
    generate: vi.fn().mockResolvedValue({ outputPath: '/tmp/test.wav', duration: 1.0 }),
    listVoices: vi.fn().mockReturnValue(['af_heart']),
    shutdown: vi.fn().mockResolvedValue(undefined),
  },
}));

import { initServer } from '../../src/server.js';
import { qwenTtsBaseService, qwenTtsCustomVoiceService } from '../../src/services/qwenTts.js';

describe('Qwen TTS Routes', () => {
  let server;

  beforeAll(async () => {
    server = await initServer();
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /qwen-tts', () => {
    it('should generate audio from text', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/qwen-tts',
        payload: {
          text: 'Hello world',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('audio/wav');
    });

    it('should support query-string format=opus', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/qwen-tts?format=opus',
        payload: {
          text: 'Hello world',
          format: 'wav',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('audio/opus');
    });

    it('should return base64 when format is buffer', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/qwen-tts',
        payload: {
          text: 'Hello world',
          format: 'buffer',
        },
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.success).toBe(true);
      expect(payload.audio).toBeDefined();
      // Default voice comes from env config
      expect(payload.voice).toBe(process.env.QWEN_TTS_DEFAULT_VOICE || 'Chelsie');
      expect(payload.language).toBe(process.env.QWEN_TTS_DEFAULT_LANGUAGE || 'English');
    });

    it('should accept custom voice and language', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/qwen-tts',
        payload: {
          text: 'Hello',
          voice: 'Ethan',
          language: 'Chinese',
          format: 'buffer',
        },
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.voice).toBe('Ethan');
      expect(payload.language).toBe('Chinese');
    });

    it('should return 400 for empty text', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/qwen-tts',
        payload: {
          text: '',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 400 for text exceeding max length', async () => {
      const longText = 'a'.repeat(10001);
      const response = await server.inject({
        method: 'POST',
        url: '/qwen-tts',
        payload: {
          text: longText,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 400 for missing text', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/qwen-tts',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 400 for invalid format', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/qwen-tts',
        payload: {
          text: 'Hello',
          format: 'mp3',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /qwen-tts/custom-voice', () => {
    it('should generate audio with emotion instruction', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/qwen-tts/custom-voice',
        payload: {
          text: 'Hello world',
          speaker: 'Chelsie',
          instruct: 'Very happy and excited',
          format: 'buffer',
        },
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.success).toBe(true);
      expect(payload.speaker).toBe('Chelsie');
      expect(payload.instruct).toBe('Very happy and excited');
    });

    it('should return 400 for missing instruct', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/qwen-tts/custom-voice',
        payload: {
          text: 'Hello world',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 400 for empty instruct', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/qwen-tts/custom-voice',
        payload: {
          text: 'Hello world',
          instruct: '',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /qwen-tts/voice-design', () => {
    it('should generate audio with voice description', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/qwen-tts/voice-design',
        payload: {
          text: 'Hello world',
          instruct: 'A deep male voice with calm tone',
          format: 'buffer',
        },
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.success).toBe(true);
      expect(payload.instruct).toBe('A deep male voice with calm tone');
    });

    it('should return 400 for missing instruct', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/qwen-tts/voice-design',
        payload: {
          text: 'Hello world',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /qwen-tts/voices/clone', () => {
    it('should create a voice clone from audio', async () => {
      // Create multipart form data
      const formData = new FormData();
      formData.append('transcript', 'Hello, this is a test');

      // Create a mock audio file
      const audioBuffer = createFakeWavBuffer();
      const audioBlob = new Blob([audioBuffer], { type: 'audio/wav' });
      formData.append('audio', audioBlob, 'reference.wav');

      const response = await server.inject({
        method: 'POST',
        url: '/qwen-tts/voices/clone',
        headers: {
          'content-type': 'multipart/form-data; boundary=----WebKitFormBoundary',
        },
        payload:
          '------WebKitFormBoundary\r\n' +
          'Content-Disposition: form-data; name="transcript"\r\n\r\n' +
          'Hello, this is a test\r\n' +
          '------WebKitFormBoundary\r\n' +
          'Content-Disposition: form-data; name="audio"; filename="reference.wav"\r\n' +
          'Content-Type: audio/wav\r\n\r\n' +
          audioBuffer.toString('binary') + '\r\n' +
          '------WebKitFormBoundary--\r\n',
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.success).toBe(true);
      expect(payload.cloneId).toBeDefined();
    });
  });

  describe('POST /qwen-tts/voices/clone/:cloneId/generate', () => {
    it('should generate audio using cloned voice', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/qwen-tts/voices/clone/clone_test123/generate',
        payload: {
          text: 'Hello world',
          language: 'English',
          format: 'buffer',
        },
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.success).toBe(true);
      expect(payload.cloneId).toBe('clone_test123');
    });

    it('should return 400 for missing text', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/qwen-tts/voices/clone/clone_test123/generate',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /qwen-tts/voices', () => {
    it('should return list of voices, clones, and capabilities', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/qwen-tts/voices',
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      // Voices come from the mock service, verify structure
      expect(Array.isArray(payload.voices)).toBe(true);
      expect(payload.voices.length).toBeGreaterThan(0);
      expect(payload.clones).toEqual(['clone_test123', 'clone_test456']);
      // Default values come from config (env vars)
      expect(payload.default).toBe(process.env.QWEN_TTS_DEFAULT_VOICE || 'Chelsie');
      expect(payload.defaultLanguage).toBe(process.env.QWEN_TTS_DEFAULT_LANGUAGE || 'English');
      // Dual-daemon setup returns modelVariants object
      expect(payload.modelVariants).toBeDefined();
      expect(payload.modelVariants.base).toBe('base-0.6b');
      expect(payload.modelVariants.customVoice).toBe('custom-voice');
      // Features merged from both daemons
      expect(payload.features).toContain('voice_cloning');
      expect(payload.features).toContain('custom_voice');
    });

    it('should remain available when the CustomVoice daemon is unavailable', async () => {
      qwenTtsCustomVoiceService.initialize.mockRejectedValueOnce(new Error('CustomVoice unavailable'));

      const response = await server.inject({
        method: 'GET',
        url: '/qwen-tts/voices',
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.status).toBe('degraded');
      expect(payload.features).toContain('voice_cloning');
      expect(payload.features).not.toContain('custom_voice');
      expect(payload.unavailableDaemons).toEqual([
        {
          name: 'CustomVoice',
          error: 'CustomVoice unavailable',
        },
      ]);
    });
  });

  describe('DELETE /qwen-tts/voices/clone/:cloneId', () => {
    it('should delete a voice clone', async () => {
      const response = await server.inject({
        method: 'DELETE',
        url: '/qwen-tts/voices/clone/clone_test123',
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.success).toBe(true);
      expect(payload.cloneId).toBe('clone_test123');
    });
  });

  describe('GET /qwen-tts/voices/clone/:cloneId/download', () => {
    it('should return 404 for non-existent clone', async () => {
      // Override voiceCloneExists to return false for this test
      qwenTtsBaseService.voiceCloneExists.mockResolvedValueOnce(false);

      const response = await server.inject({
        method: 'GET',
        url: '/qwen-tts/voices/clone/nonexistent_clone/download',
      });

      expect(response.statusCode).toBe(404);
      const payload = JSON.parse(response.payload);
      expect(payload.message).toContain('not found');
    });

    it('should validate clone ID format', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/qwen-tts/voices/clone/invalid..clone/download',
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /qwen-tts/voices/clone/import', () => {
    it('should return 400 for missing file', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/qwen-tts/voices/clone/import',
        headers: {
          'content-type': 'multipart/form-data; boundary=----WebKitFormBoundary',
        },
        payload:
          '------WebKitFormBoundary\r\n' +
          'Content-Disposition: form-data; name="cloneId"\r\n\r\n' +
          'my-clone\r\n' +
          '------WebKitFormBoundary--\r\n',
      });

      expect(response.statusCode).toBe(400);
    });

    it('should validate clone ID format', async () => {
      const fakeZipBuffer = Buffer.from('PK..fake zip content');

      const response = await server.inject({
        method: 'POST',
        url: '/qwen-tts/voices/clone/import',
        headers: {
          'content-type': 'multipart/form-data; boundary=----WebKitFormBoundary',
        },
        payload:
          '------WebKitFormBoundary\r\n' +
          'Content-Disposition: form-data; name="cloneId"\r\n\r\n' +
          'invalid..clone/id\r\n' +
          '------WebKitFormBoundary\r\n' +
          'Content-Disposition: form-data; name="file"; filename="clone.zip"\r\n' +
          'Content-Type: application/zip\r\n\r\n' +
          fakeZipBuffer.toString('binary') + '\r\n' +
          '------WebKitFormBoundary--\r\n',
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 403 when imports are blocked by server config', async () => {
      vi.resetModules();

      vi.doMock('../../src/config/index.js', () => ({
        config: {
          server: { port: 3000, host: '127.0.0.1', corsOrigins: [] },
          auth: {
            enabled: false,
            apiKey: null,
            excludePaths: ['/health', '/auth/status'],
            dangerouslyAllowImports: false,
            dangerouslyAllowVoiceCloning: true,
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
            modelVariant: process.env.QWEN_TTS_MODEL_VARIANT || 'base-1.7b',
            baseModelVariant: 'base-0.6b',
            customVoiceModelVariant: 'custom-voice',
            defaultVoice: process.env.QWEN_TTS_DEFAULT_VOICE || 'Chelsie',
            defaultLanguage: process.env.QWEN_TTS_DEFAULT_LANGUAGE || 'English',
            timeout: 120000,
            daemonStartupTimeout: 180000,
            preWarmDaemon: false,
            voiceClonesDir: './voice_clones',
          },
        },
      }));

      const { initServer: initServerBlocked } = await import('../../src/server.js');
      const blockedServer = await initServerBlocked();

      try {
        const fakeZipBuffer = Buffer.from('PK..fake zip content');

        const response = await blockedServer.inject({
          method: 'POST',
          url: '/qwen-tts/voices/clone/import',
          headers: {
            'content-type': 'multipart/form-data; boundary=----WebKitFormBoundary',
          },
          payload:
            '------WebKitFormBoundary\r\n' +
            'Content-Disposition: form-data; name="file"; filename="clone.zip"\r\n' +
            'Content-Type: application/zip\r\n\r\n' +
            fakeZipBuffer.toString('binary') + '\r\n' +
            '------WebKitFormBoundary--\r\n',
        });

        expect(response.statusCode).toBe(403);
        const payload = JSON.parse(response.payload);
        expect(payload.message).toContain('Voice clone import is disabled on this server');
      } finally {
        await blockedServer.stop();
      }
    });
  });
});

describe('Qwen TTS Routes (disabled)', () => {
  let server;

  beforeAll(async () => {
    // Reset mocks to disable Qwen TTS
    vi.resetModules();

    vi.doMock('../../src/config/index.js', () => ({
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
      enabled: true,
      defaultVoice: 'alba',
      timeout: 60000,
      daemonStartupTimeout: 60000,
      preWarmDaemon: false,
      voiceClonesDir: './pocket_voice_clones',
    },
        qwenTts: {
          enabled: false,
          modelVariant: 'base-1.7b',
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

    const disabledMockService = {
      shutdown: vi.fn().mockResolvedValue(undefined),
      isEnabled: vi.fn().mockReturnValue(false),
    };

    vi.doMock('../../src/services/qwenTts.js', () => ({
      qwenTtsBaseService: disabledMockService,
      qwenTtsCustomVoiceService: disabledMockService,
      qwenTtsService: disabledMockService,
    }));

    vi.doMock('../../src/services/tts.js', () => ({
      ttsService: {
        generate: vi.fn().mockResolvedValue({ outputPath: '/tmp/test.wav', duration: 1.0 }),
        listVoices: vi.fn().mockReturnValue(['af_heart']),
        shutdown: vi.fn().mockResolvedValue(undefined),
      },
    }));

    const { initServer: initServerFresh } = await import('../../src/server.js');
    server = await initServerFresh();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('should return 404 when Qwen TTS is disabled', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/qwen-tts',
      payload: {
        text: 'Hello world',
      },
    });

    expect(response.statusCode).toBe(404);
    const payload = JSON.parse(response.payload);
    expect(payload.message).toContain('not enabled');
  });
});
