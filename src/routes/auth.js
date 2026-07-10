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

const getVoiceCloningStatus = () => {
  if (config.auth.dangerouslyAllowVoiceCloning) {
    return { enabled: true, mode: 'public' };
  }
  if (config.auth.apiKey) {
    return { enabled: true, mode: 'api_key' };
  }
  return { enabled: false, mode: 'blocked' };
};

const getServiceStatus = () => ({
  tts: { enabled: Boolean(config.tts?.enabled) },
  transcription: { enabled: Boolean(config.transcription?.enabled) },
  qwenAsr: { enabled: Boolean(config.qwenAsr?.enabled) },
  pocketTts: { enabled: Boolean(config.pocketTts?.enabled) },
  qwenTts: { enabled: Boolean(config.qwenTts?.enabled) },
  mossTts: { enabled: Boolean(config.mossTts?.enabled) },
});

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
      const services = getServiceStatus();
      const voiceCloning = getVoiceCloningStatus();

      return {
        authEnabled: config.auth.enabled,
        apiKeyConfigured: Boolean(config.auth.apiKey),
        dangerouslyAllowImports: Boolean(config.auth.dangerouslyAllowImports),
        voiceCloneImports,
        voiceCloning,
        services,
      };
    },
  },
];
