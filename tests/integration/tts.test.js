import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { writeFileSync } from 'node:fs';

// Create a fake WAV header (minimal valid WAV structure)
const createFakeWavBuffer = () => {
  const buffer = Buffer.alloc(44);
  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36, 4); // file size - 8
  buffer.write('WAVE', 8);
  // fmt chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // chunk size
  buffer.writeUInt16LE(1, 20); // audio format (PCM)
  buffer.writeUInt16LE(1, 22); // num channels
  buffer.writeUInt32LE(24000, 24); // sample rate
  buffer.writeUInt32LE(48000, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  // data chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(0, 40); // data size
  return buffer;
};

// Mock the TTS service (daemon-based API that writes to outputPath)
vi.mock('../../src/services/tts.js', () => ({
  ttsService: {
    generate: vi.fn().mockImplementation(async (text, options) => {
      // Write fake WAV file to the outputPath
      if (options.outputPath) {
        writeFileSync(options.outputPath, createFakeWavBuffer());
      }
      return {
        outputPath: options.outputPath,
        duration: 1.0,
        voice: options.voice || 'af_heart',
        speed: options.speed || 1.0,
      };
    }),
    listVoices: vi.fn().mockReturnValue([
      'af_heart', 'af_alloy', 'am_adam',
    ]),
    shutdown: vi.fn().mockResolvedValue(undefined),
  },
}));

import { initServer } from '../../src/server.js';

describe('TTS Routes', () => {
  let server;

  beforeAll(async () => {
    server = await initServer();
  });

  afterAll(async () => {
    await server.stop();
  });

  describe('POST /tts', () => {
    it('should generate audio from text', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/tts',
        payload: {
          text: 'Hello world',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('audio/wav');
    });

    it('should return base64 when format is buffer', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/tts',
        payload: {
          text: 'Hello world',
          format: 'buffer',
        },
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.success).toBe(true);
      expect(payload.audio).toBeDefined();
    });

    it('should return 400 for empty text', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/tts',
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
        url: '/tts',
        payload: {
          text: longText,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 400 for speed below 0.5', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/tts',
        payload: {
          text: 'Hello',
          speed: 0.4,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 400 for speed above 2.0', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/tts',
        payload: {
          text: 'Hello',
          speed: 2.5,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should accept valid speed at boundaries', async () => {
      const responseMin = await server.inject({
        method: 'POST',
        url: '/tts',
        payload: {
          text: 'Hello',
          speed: 0.5,
        },
      });
      expect(responseMin.statusCode).toBe(200);

      const responseMax = await server.inject({
        method: 'POST',
        url: '/tts',
        payload: {
          text: 'Hello',
          speed: 2.0,
        },
      });
      expect(responseMax.statusCode).toBe(200);
    });

    it('should accept custom voice parameter', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/tts',
        payload: {
          text: 'Hello',
          voice: 'am_adam',
        },
      });

      expect(response.statusCode).toBe(200);
    });

    it('should return 400 for invalid format', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/tts',
        payload: {
          text: 'Hello',
          format: 'mp3',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 400 for missing text', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/tts',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /tts/voices', () => {
    it('should return list of voices', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/tts/voices',
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.voices).toContain('af_heart');
      expect(payload.default).toBe('af_heart');
    });
  });
});
