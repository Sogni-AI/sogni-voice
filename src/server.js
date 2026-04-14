import Hapi from '@hapi/hapi';
import { config } from './config/index.js';
import { registerPlugins } from './plugins/index.js';
import { routes } from './routes/index.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

const isLoopbackHost = (host) => LOOPBACK_HOSTS.has(host);

export const createServer = async () => {
  if (!isLoopbackHost(config.server.host) && (!config.auth.enabled || !config.auth.apiKey)) {
    throw new Error(
      `Refusing to bind to non-loopback host "${config.server.host}" without API key authentication`
    );
  }

  const corsOrigins = config.server.corsOrigins || [];
  const cors = corsOrigins.length > 0
    ? {
        origin: corsOrigins,
        headers: ['Accept', 'Authorization', 'Content-Type', 'X-API-Key'],
        additionalHeaders: ['X-Requested-With'],
      }
    : false;

  const server = Hapi.server({
    port: config.server.port,
    host: config.server.host,
    routes: {
      cors,
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
