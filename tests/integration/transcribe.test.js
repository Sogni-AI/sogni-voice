import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import dotenv from 'dotenv';

// Load .env before mocking
dotenv.config();

// Create mock function before mocking module
const mockTranscribe = vi.hoisted(() => vi.fn());

// Mock config using environment variables
vi.mock('../../src/config/index.js', () => ({
  config: {
    server: { port: 3000, host: '127.0.0.1', corsOrigins: [] },
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
    upload: { maxFileSizeBytes: 100 * 1024 * 1024, transcribeMaxBytes: 25 * 1024 * 1024 },
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

// Mock the transcription service
vi.mock('../../src/services/transcription.js', () => ({
  transcriptionService: {
    transcribe: mockTranscribe,
  },
}));

import { initServer } from '../../src/server.js';

describe('POST /transcribe', () => {
  let server;

  beforeAll(async () => {
    server = await initServer();
  });

  beforeEach(() => {
    mockTranscribe.mockReset();
    // Default mock implementation
    mockTranscribe.mockResolvedValue({
      text: 'This is a test transcript.',
      rawOutput: '',
    });
  });

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });

  it('should transcribe an uploaded audio file', async () => {
    // Real MP3 ID3 magic header so the upload passes server-side magic-byte validation.
    const audioContent = Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00fake audio content');

    const response = await server.inject({
      method: 'POST',
      url: '/transcribe',
      headers: {
        'content-type': 'multipart/form-data; boundary=----WebKitFormBoundary',
      },
      payload:
        '------WebKitFormBoundary\r\n' +
        'Content-Disposition: form-data; name="file"; filename="test.mp3"\r\n' +
        'Content-Type: audio/mpeg\r\n\r\n' +
        audioContent.toString() +
        '\r\n------WebKitFormBoundary--\r\n',
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.payload);
    expect(payload.success).toBe(true);
    expect(payload.transcript).toBe('This is a test transcript.');
  });

  it('should return 400 for missing file', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/transcribe',
      headers: {
        'content-type': 'multipart/form-data; boundary=----WebKitFormBoundary',
      },
      payload: '------WebKitFormBoundary--\r\n',
    });

    expect(response.statusCode).toBe(400);
  });

  it('should return word-level timestamps when wordTimestamps=true', async () => {
    const wordTimestamps = [
      { start: 0.0, end: 0.3, text: 'This' },
      { start: 0.3, end: 0.5, text: 'is' },
      { start: 0.5, end: 0.7, text: 'a' },
      { start: 0.7, end: 1.0, text: 'test' },
    ];
    mockTranscribe.mockResolvedValue({
      text: 'This is a test',
      rawOutput: '',
      timestamps: wordTimestamps,
    });

    // Real MP3 ID3 magic header so the upload passes server-side magic-byte validation.
    const audioContent = Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00fake audio content');

    const response = await server.inject({
      method: 'POST',
      url: '/transcribe',
      headers: {
        'content-type': 'multipart/form-data; boundary=----WebKitFormBoundary',
      },
      payload:
        '------WebKitFormBoundary\r\n' +
        'Content-Disposition: form-data; name="file"; filename="test.mp3"\r\n' +
        'Content-Type: audio/mpeg\r\n\r\n' +
        audioContent.toString() +
        '\r\n------WebKitFormBoundary\r\n' +
        'Content-Disposition: form-data; name="wordTimestamps"\r\n\r\n' +
        'true\r\n' +
        '------WebKitFormBoundary--\r\n',
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.payload);
    expect(payload.success).toBe(true);
    expect(payload.timestamps).toEqual(wordTimestamps);
    expect(payload.transcript).toBeUndefined(); // timestamps mode returns only timestamps

    // Verify the service was called with correct options
    expect(mockTranscribe).toHaveBeenCalledWith(
      expect.any(String),
      { timestamps: false, wordTimestamps: true }
    );
  });

  it('should return sentence-level timestamps when timestamps=true', async () => {
    const sentenceTimestamps = [
      { start: 0.0, end: 2.5, text: 'This is a test transcript.' },
    ];
    mockTranscribe.mockResolvedValue({
      text: 'This is a test transcript.',
      rawOutput: '',
      timestamps: sentenceTimestamps,
    });

    // Real MP3 ID3 magic header so the upload passes server-side magic-byte validation.
    const audioContent = Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00fake audio content');

    const response = await server.inject({
      method: 'POST',
      url: '/transcribe',
      headers: {
        'content-type': 'multipart/form-data; boundary=----WebKitFormBoundary',
      },
      payload:
        '------WebKitFormBoundary\r\n' +
        'Content-Disposition: form-data; name="file"; filename="test.mp3"\r\n' +
        'Content-Type: audio/mpeg\r\n\r\n' +
        audioContent.toString() +
        '\r\n------WebKitFormBoundary\r\n' +
        'Content-Disposition: form-data; name="timestamps"\r\n\r\n' +
        'true\r\n' +
        '------WebKitFormBoundary--\r\n',
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.payload);
    expect(payload.success).toBe(true);
    expect(payload.timestamps).toEqual(sentenceTimestamps);

    // Verify the service was called with correct options
    expect(mockTranscribe).toHaveBeenCalledWith(
      expect.any(String),
      { timestamps: true, wordTimestamps: false }
    );
  });

  it('should return transcript without timestamps by default', async () => {
    // Real MP3 ID3 magic header so the upload passes server-side magic-byte validation.
    const audioContent = Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00fake audio content');

    const response = await server.inject({
      method: 'POST',
      url: '/transcribe',
      headers: {
        'content-type': 'multipart/form-data; boundary=----WebKitFormBoundary',
      },
      payload:
        '------WebKitFormBoundary\r\n' +
        'Content-Disposition: form-data; name="file"; filename="test.mp3"\r\n' +
        'Content-Type: audio/mpeg\r\n\r\n' +
        audioContent.toString() +
        '\r\n------WebKitFormBoundary--\r\n',
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.payload);
    expect(payload.success).toBe(true);
    expect(payload.transcript).toBe('This is a test transcript.');
    expect(payload.timestamps).toBeUndefined();

    // Verify the service was called with correct options
    expect(mockTranscribe).toHaveBeenCalledWith(
      expect.any(String),
      { timestamps: false, wordTimestamps: false }
    );
  });
});
