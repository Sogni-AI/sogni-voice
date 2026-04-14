import { config } from '../config/index.js';

const getVoiceCloneImportStatus = () => {
  if (config.auth.dangerouslyAllowImports) {
    return {
      enabled: true,
      mode: 'public',
    };
  }

  if (config.auth.apiKey) {
    return {
      enabled: true,
      mode: 'api_key',
    };
  }

  return {
    enabled: false,
    mode: 'blocked',
  };
};

export const authRoutes = [
  {
    method: 'GET',
    path: '/auth/status',
    options: {
      auth: false,
      description: 'Check if authentication is enabled',
      tags: ['api', 'auth'],
    },
    handler: async (request, h) => {
      const voiceCloneImports = getVoiceCloneImportStatus();

      return {
        authEnabled: config.auth.enabled,
        apiKeyConfigured: Boolean(config.auth.apiKey),
        dangerouslyAllowImports: Boolean(config.auth.dangerouslyAllowImports),
        voiceCloneImports,
      };
    },
  },
];
