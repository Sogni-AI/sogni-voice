import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
