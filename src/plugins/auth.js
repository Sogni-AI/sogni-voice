import Boom from '@hapi/boom';
import { config } from '../config/index.js';

// Get auth config with defaults for safety
const getAuthConfig = () => ({
  enabled: config.auth?.enabled ?? false,
  apiKey: config.auth?.apiKey ?? null,
  excludePaths: config.auth?.excludePaths ?? ['/health', '/auth/status'],
});

/**
 * API Key authentication scheme for Hapi
 */
const apiKeyScheme = () => {
  return {
    authenticate: (request, h) => {
      const authConfig = getAuthConfig();

      // Allow CORS preflight requests through without authentication
      if (request.method === 'options') {
        return h.authenticated({ credentials: { preflight: true } });
      }

      // Check for API key in X-API-Key header or Authorization Bearer header
      const apiKeyHeader = request.headers['x-api-key'];
      const authHeader = request.headers.authorization;

      let providedKey = null;

      if (apiKeyHeader) {
        providedKey = apiKeyHeader;
      } else if (authHeader && authHeader.startsWith('Bearer ')) {
        providedKey = authHeader.slice(7);
      }

      if (!providedKey) {
        throw Boom.unauthorized('Missing API key. Provide X-API-Key header or Authorization: Bearer <key>');
      }

      if (providedKey !== authConfig.apiKey) {
        throw Boom.unauthorized('Invalid API key');
      }

      // Authentication successful
      return h.authenticated({ credentials: { apiKey: true } });
    },
  };
};

/**
 * Register the authentication plugin
 */
export const authPlugin = {
  name: 'auth',
  version: '1.0.0',
  register: async (server) => {
    const authConfig = getAuthConfig();

    // Register the API key authentication scheme
    server.auth.scheme('api-key', apiKeyScheme);

    // Only set up strategy and default if auth is enabled
    if (authConfig.enabled) {
      if (!authConfig.apiKey) {
        console.warn('WARNING: AUTH_ENABLED is true but AUTH_API_KEY is not set. Authentication will fail for all requests.');
      }

      // Create the strategy
      server.auth.strategy('api-key-strategy', 'api-key');

      // Set as default authentication for all routes
      server.auth.default('api-key-strategy');

      console.log('API key authentication enabled');
    } else {
      console.log('API key authentication disabled (set AUTH_ENABLED=true to enable)');
    }
  },
};
