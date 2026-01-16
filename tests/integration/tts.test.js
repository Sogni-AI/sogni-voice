import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Create a fake WAV header (minimal valid WAV structure)
const createFakeWavBuffer = () => {
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  // RIFF header
  view.setUint32(0, 0x52494646, false); // "RIFF"
  view.setUint32(4, 36, true); // file size - 8
  view.setUint32(8, 0x57415645, false); // "WAVE"
  // fmt chunk
  view.setUint32(12, 0x666d7420, false); // "fmt "
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // audio format (PCM)
  view.setUint16(22, 1, true); // num channels
  view.setUint32(24, 24000, true); // sample rate
  view.setUint32(28, 48000, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  // data chunk
  view.setUint32(36, 0x64617461, false); // "data"
  view.setUint32(40, 0, true); // data size
  return buffer;
};

// Mock the TTS service
vi.mock('../../src/services/tts.js', () => ({
  ttsService: {
    generate: vi.fn().mockImplementation(async (text, options) => {
      return {
        audio: {
          toWav: () => createFakeWavBuffer(),
        },
        voice: options.voice || 'af_heart',
        speed: options.speed || 1.0,
      };
    }),
    listVoices: vi.fn().mockReturnValue([
      'af_heart', 'af_alloy', 'am_adam',
    ]),
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
