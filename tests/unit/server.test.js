import { describe, it, expect, vi, afterEach } from 'vitest';

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
      routes: [],
    }));

    const { createServer } = await import('../../src/server.js');
    const server = await createServer();
    expect(server.settings.routes.cors).toMatchObject({
      origin: ['https://app.example.com'],
    });
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
    expect(server.settings.routes.cors).toBe(false);
    await server.stop();
  });
});
