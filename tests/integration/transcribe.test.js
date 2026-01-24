import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

// Create mock function before mocking module
const mockTranscribe = vi.hoisted(() => vi.fn());

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
    await server.stop();
  });

  it('should transcribe an uploaded audio file', async () => {
    const audioContent = Buffer.from('fake audio content');

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

    const audioContent = Buffer.from('fake audio content');

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

    const audioContent = Buffer.from('fake audio content');

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
    const audioContent = Buffer.from('fake audio content');

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
