import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Mock the transcription service
vi.mock('../../src/services/transcription.js', () => ({
  transcriptionService: {
    transcribe: vi.fn().mockResolvedValue({
      text: 'This is a test transcript.',
      rawOutput: '',
    }),
  },
}));

import { initServer } from '../../src/server.js';

describe('POST /transcribe', () => {
  let server;

  beforeAll(async () => {
    server = await initServer();
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
});
