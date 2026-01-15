export const healthRoutes = [
  {
    method: 'GET',
    path: '/health',
    handler: async (request, h) => {
      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      };
    },
  },
];
