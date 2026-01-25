import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the config before importing the auth plugin
vi.mock('../../../src/config/index.js', () => ({
  config: {
    auth: {
      enabled: false,
      apiKey: null,
      excludePaths: ['/health', '/auth/status'],
    },
  },
}));

describe('Auth Plugin', () => {
  let authPlugin;
  let mockServer;

  beforeEach(async () => {
    // Clear the module cache to get fresh imports
    vi.resetModules();

    // Create mock server
    mockServer = {
      auth: {
        scheme: vi.fn(),
        strategy: vi.fn(),
        default: vi.fn(),
      },
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('when auth is disabled', () => {
    beforeEach(async () => {
      vi.doMock('../../../src/config/index.js', () => ({
        config: {
          auth: {
            enabled: false,
            apiKey: null,
            excludePaths: ['/health', '/auth/status'],
          },
        },
      }));
      const module = await import('../../../src/plugins/auth.js');
      authPlugin = module.authPlugin;
    });

    it('should register the api-key scheme', async () => {
      await authPlugin.register(mockServer);

      expect(mockServer.auth.scheme).toHaveBeenCalledWith('api-key', expect.any(Function));
    });

    it('should not set up strategy or default when auth is disabled', async () => {
      await authPlugin.register(mockServer);

      expect(mockServer.auth.strategy).not.toHaveBeenCalled();
      expect(mockServer.auth.default).not.toHaveBeenCalled();
    });
  });

  describe('when auth is enabled', () => {
    beforeEach(async () => {
      vi.doMock('../../../src/config/index.js', () => ({
        config: {
          auth: {
            enabled: true,
            apiKey: 'test-api-key',
            excludePaths: ['/health', '/auth/status'],
          },
        },
      }));
      const module = await import('../../../src/plugins/auth.js');
      authPlugin = module.authPlugin;
    });

    it('should register scheme, strategy, and default', async () => {
      await authPlugin.register(mockServer);

      expect(mockServer.auth.scheme).toHaveBeenCalledWith('api-key', expect.any(Function));
      expect(mockServer.auth.strategy).toHaveBeenCalledWith('api-key-strategy', 'api-key');
      expect(mockServer.auth.default).toHaveBeenCalledWith('api-key-strategy');
    });
  });

  describe('api-key scheme', () => {
    let schemeFactory;

    beforeEach(async () => {
      vi.doMock('../../../src/config/index.js', () => ({
        config: {
          auth: {
            enabled: true,
            apiKey: 'valid-api-key',
            excludePaths: ['/health', '/auth/status'],
          },
        },
      }));
      const module = await import('../../../src/plugins/auth.js');
      authPlugin = module.authPlugin;

      mockServer.auth.scheme = vi.fn((name, factory) => {
        schemeFactory = factory;
      });

      await authPlugin.register(mockServer);
    });

    it('should authenticate with valid X-API-Key header', () => {
      const scheme = schemeFactory();
      const mockRequest = {
        headers: {
          'x-api-key': 'valid-api-key',
        },
      };
      const mockH = {
        authenticated: vi.fn((credentials) => credentials),
      };

      const result = scheme.authenticate(mockRequest, mockH);

      expect(mockH.authenticated).toHaveBeenCalledWith({ credentials: { apiKey: true } });
    });

    it('should authenticate with valid Authorization Bearer header', () => {
      const scheme = schemeFactory();
      const mockRequest = {
        headers: {
          authorization: 'Bearer valid-api-key',
        },
      };
      const mockH = {
        authenticated: vi.fn((credentials) => credentials),
      };

      const result = scheme.authenticate(mockRequest, mockH);

      expect(mockH.authenticated).toHaveBeenCalledWith({ credentials: { apiKey: true } });
    });

    it('should reject missing API key', () => {
      const scheme = schemeFactory();
      const mockRequest = {
        headers: {},
      };
      const mockH = {
        authenticated: vi.fn(),
      };

      expect(() => scheme.authenticate(mockRequest, mockH)).toThrow();
    });

    it('should reject invalid API key', () => {
      const scheme = schemeFactory();
      const mockRequest = {
        headers: {
          'x-api-key': 'wrong-api-key',
        },
      };
      const mockH = {
        authenticated: vi.fn(),
      };

      expect(() => scheme.authenticate(mockRequest, mockH)).toThrow();
    });
  });
});
