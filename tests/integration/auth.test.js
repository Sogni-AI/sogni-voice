import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Hapi from '@hapi/hapi';
import Inert from '@hapi/inert';

describe('Authentication Integration Tests', () => {
  describe('when auth is disabled', () => {
    let server;

    beforeAll(async () => {
      // Reset modules and mock config with auth disabled
      vi.resetModules();
      vi.doMock('../../src/config/index.js', () => ({
        config: {
          server: { port: 3000, host: '0.0.0.0' },
          auth: {
            enabled: false,
            apiKey: null,
            excludePaths: ['/health', '/auth/status'],
            dangerouslyAllowImports: false,
            dangerouslyAllowVoiceCloning: false,
          },
          tts: {
            modelId: 'test',
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
          qwenTts: { enabled: false },
        },
      }));

      // Import after mocking
      const { authPlugin } = await import('../../src/plugins/auth.js');
      const { authRoutes } = await import('../../src/routes/auth.js');
      const { healthRoutes } = await import('../../src/routes/health.js');

      server = Hapi.server({ port: 0 });
      await server.register([Inert, authPlugin]);
      server.route([...healthRoutes, ...authRoutes]);
      await server.initialize();
    });

    afterAll(async () => {
      await server.stop();
      vi.resetModules();
    });

    it('GET /auth/status should report blocked voice clone imports when no env override is configured', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/auth/status',
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.authEnabled).toBe(false);
      expect(payload.apiKeyConfigured).toBe(false);
      expect(payload.dangerouslyAllowImports).toBe(false);
      expect(payload.voiceCloneImports).toEqual({
        enabled: false,
        mode: 'blocked',
      });
    });

    it('GET /health should be accessible without API key', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.status).toBe('healthy');
    });
  });

  describe('when auth is enabled', () => {
    let server;
    const TEST_API_KEY = 'test-secret-api-key-12345';

    beforeAll(async () => {
      // Reset modules and mock config with auth enabled
      vi.resetModules();
      vi.doMock('../../src/config/index.js', () => ({
        config: {
          server: { port: 3000, host: '0.0.0.0' },
          auth: {
            enabled: true,
            apiKey: TEST_API_KEY,
            excludePaths: ['/health', '/auth/status'],
            dangerouslyAllowImports: false,
            dangerouslyAllowVoiceCloning: false,
          },
          tts: {
            modelId: 'test',
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
          qwenTts: { enabled: false },
        },
      }));

      // Import after mocking
      const { authPlugin } = await import('../../src/plugins/auth.js');
      const { authRoutes } = await import('../../src/routes/auth.js');
      const { healthRoutes } = await import('../../src/routes/health.js');

      server = Hapi.server({ port: 0 });
      await server.register([Inert, authPlugin]);
      server.route([...healthRoutes, ...authRoutes]);

      // Add a protected test route
      server.route({
        method: 'GET',
        path: '/protected',
        handler: () => ({ message: 'success' }),
      });

      await server.initialize();
    });

    afterAll(async () => {
      await server.stop();
      vi.resetModules();
    });

    it('GET /auth/status should report API-key-only voice clone imports when AUTH_API_KEY is configured', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/auth/status',
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.authEnabled).toBe(true);
      expect(payload.apiKeyConfigured).toBe(true);
      expect(payload.dangerouslyAllowImports).toBe(false);
      expect(payload.voiceCloneImports).toEqual({
        enabled: true,
        mode: 'api_key',
      });
    });

    it('GET /health should be accessible without API key', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.status).toBe('healthy');
    });

    it('protected route should return 401 without API key', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/protected',
      });

      expect(response.statusCode).toBe(401);
    });

    it('protected route should return 401 with invalid API key', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/protected',
        headers: {
          'X-API-Key': 'wrong-key',
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('protected route should succeed with valid X-API-Key header', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/protected',
        headers: {
          'X-API-Key': TEST_API_KEY,
        },
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.message).toBe('success');
    });

    it('protected route should succeed with valid Authorization Bearer header', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/protected',
        headers: {
          'Authorization': `Bearer ${TEST_API_KEY}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.message).toBe('success');
    });

    it('OPTIONS preflight request should not return 401 (CORS)', async () => {
      const response = await server.inject({
        method: 'OPTIONS',
        url: '/protected',
        headers: {
          'Origin': 'https://example.com',
          'Access-Control-Request-Method': 'POST',
        },
      });

      // OPTIONS should NOT return 401 Unauthorized - it should either be 200 (CORS handled)
      // or 404 (no explicit OPTIONS route), but never 401 which would block CORS preflight
      expect(response.statusCode).not.toBe(401);
    });
  });
});
