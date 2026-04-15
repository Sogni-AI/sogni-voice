import { describe, it, expect, vi, afterEach } from 'vitest';
import { localCorsOrigins } from '../../src/utils/cors.js';

describe('server security configuration', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('should refuse public host without auth', async () => {
    vi.doMock('../../src/config/index.js', () => ({
      config: {
        server: {
          port: 3000,
          host: '0.0.0.0',
          corsOrigins: [],
        },
        auth: {
          enabled: false,
          apiKey: null,
        },
      },
    }));
    vi.doMock('../../src/plugins/index.js', () => ({
      registerPlugins: vi.fn(),
    }));
    vi.doMock('../../src/routes/index.js', () => ({
      routes: [],
    }));

    const { createServer } = await import('../../src/server.js');
    await expect(createServer()).rejects.toThrow(/Refusing to bind to non-loopback host "0.0.0.0" without API key authentication/);
  });

  it('should allow public host with auth and API key', async () => {
    vi.doMock('../../src/config/index.js', () => ({
      config: {
        server: {
          port: 3000,
          host: '0.0.0.0',
          corsOrigins: ['https://app.example.com'],
        },
        auth: {
          enabled: true,
          apiKey: 'test-api-key',
        },
      },
    }));
    vi.doMock('../../src/plugins/index.js', () => ({
      registerPlugins: vi.fn(),
    }));
    vi.doMock('../../src/routes/index.js', () => ({
      routes: [
        {
          method: 'GET',
          path: '/test',
          handler: () => ({ ok: true }),
        },
      ],
    }));

    const { createServer } = await import('../../src/server.js');
    const server = await createServer();

    const response = await server.inject({
      method: 'GET',
      url: '/test',
      headers: {
        origin: 'https://app.example.com',
      },
    });

    expect(response.headers['access-control-allow-origin']).toBe('https://app.example.com');
    await server.stop();
  });

  it('should respond to preflight requests with requested headers', async () => {
    vi.doMock('../../src/config/index.js', () => ({
      config: {
        server: {
          port: 3000,
          host: '0.0.0.0',
          corsOrigins: ['*'],
        },
        auth: {
          enabled: true,
          apiKey: 'test-api-key',
        },
      },
    }));
    vi.doMock('../../src/plugins/index.js', () => ({
      registerPlugins: vi.fn(),
    }));
    vi.doMock('../../src/routes/index.js', () => ({
      routes: [
        {
          method: 'POST',
          path: '/test',
          handler: () => ({ ok: true }),
        },
      ],
    }));

    const { createServer } = await import('../../src/server.js');
    const server = await createServer();

    const response = await server.inject({
      method: 'OPTIONS',
      url: '/test',
      headers: {
        origin: 'https://anywhere.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type,x-api-key,x-debug-token',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-allow-methods']).toContain('POST');
    expect(response.headers['access-control-allow-headers']).toContain('x-debug-token');
    await server.stop();
  });

  it('should allow loopback host without auth', async () => {
    vi.doMock('../../src/config/index.js', () => ({
      config: {
        server: {
          port: 3000,
          host: '127.0.0.1',
          corsOrigins: [],
        },
        auth: {
          enabled: false,
          apiKey: null,
        },
      },
    }));
    vi.doMock('../../src/plugins/index.js', () => ({
      registerPlugins: vi.fn(),
    }));
    vi.doMock('../../src/routes/index.js', () => ({
      routes: [],
    }));

    const { createServer } = await import('../../src/server.js');
    const server = await createServer();
    expect(server.settings.host).toBe('127.0.0.1');
    await server.stop();
  });

  it('should allow local browser origins by default', async () => {
    vi.doMock('../../src/config/index.js', () => ({
      config: {
        server: {
          port: 3000,
          host: '127.0.0.1',
          corsOrigins: localCorsOrigins,
        },
        auth: {
          enabled: false,
          apiKey: null,
        },
      },
    }));
    vi.doMock('../../src/plugins/index.js', () => ({
      registerPlugins: vi.fn(),
    }));
    vi.doMock('../../src/routes/index.js', () => ({
      routes: [
        {
          method: 'GET',
          path: '/test',
          handler: () => ({ ok: true }),
        },
      ],
    }));

    const { createServer } = await import('../../src/server.js');
    const server = await createServer();

    const allowedOriginResponse = await server.inject({
      method: 'GET',
      url: '/test',
      headers: {
        origin: 'http://localhost:5173',
      },
    });

    const blockedOriginResponse = await server.inject({
      method: 'GET',
      url: '/test',
      headers: {
        origin: 'https://example.com',
      },
    });

    expect(allowedOriginResponse.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(blockedOriginResponse.headers['access-control-allow-origin']).toBeUndefined();
    await server.stop();
  });
});
