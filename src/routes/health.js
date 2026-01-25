export const healthRoutes = [
  {
    method: 'GET',
    path: '/health',
    options: {
      auth: false,
      description: 'Health check endpoint',
      tags: ['api', 'health'],
    },
    handler: async (request, h) => {
      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      };
    },
  },
];
