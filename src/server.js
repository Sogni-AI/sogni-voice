import Hapi from '@hapi/hapi';
import { config } from './config/index.js';
import { registerPlugins } from './plugins/index.js';
import { routes } from './routes/index.js';

export const createServer = async () => {
  const server = Hapi.server({
    port: config.server.port,
    host: config.server.host,
    routes: {
      cors: {
        origin: ['*'],
        headers: ['Accept', 'Authorization', 'Content-Type', 'X-API-Key'],
        additionalHeaders: ['X-Requested-With'],
      },
      validate: {
        failAction: async (request, h, err) => {
          throw err;
        },
      },
    },
  });

  await registerPlugins(server);
  server.route(routes);

  return server;
};

export const initServer = async () => {
  const server = await createServer();
  await server.initialize();
  return server;
};

export const startServer = async () => {
  const server = await createServer();
  await server.start();
  console.log(`Server running at: ${server.info.uri}`);
  return server;
};
