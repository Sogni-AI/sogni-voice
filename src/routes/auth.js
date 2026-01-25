import { config } from '../config/index.js';

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
      return {
        authEnabled: config.auth.enabled,
      };
    },
  },
];
