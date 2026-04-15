import Hapi from '@hapi/hapi';
import Boom from '@hapi/boom';
import { config } from './config/index.js';
import { registerPlugins } from './plugins/index.js';
import { routes } from './routes/index.js';
import {
  buildCorsPolicy,
  getCorsAllowOrigin,
  isCorsOriginAllowed,
  normalizeCorsRequestHeaders,
} from './utils/cors.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

const isLoopbackHost = (host) => LOOPBACK_HOSTS.has(host);

const appendVaryHeader = (currentValue, headerName) => {
  const existingValues = (currentValue || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (!existingValues.some((item) => item.toLowerCase() === headerName.toLowerCase())) {
    existingValues.push(headerName);
  }

  return existingValues.join(', ');
};

const setResponseHeader = (response, name, value) => {
  if (!value) {
    return;
  }

  if (response.isBoom) {
    response.output.headers[name] = value;
    return;
  }

  response.header(name, value);
};

const applyCorsResponseHeaders = (response, origin, corsPolicy) => {
  setResponseHeader(response, 'access-control-allow-origin', getCorsAllowOrigin(origin, corsPolicy));

  if (corsPolicy.allowAnyOrigin) {
    return;
  }

  if (response.isBoom) {
    response.output.headers.vary = appendVaryHeader(response.output.headers.vary, 'Origin');
    return;
  }

  response.header('vary', 'Origin', { append: true });
};

const createCorsPreflightHandler = (corsPolicy) => (request, h) => {
  const requestedMethod = request.headers['access-control-request-method'];

  if (!requestedMethod) {
    throw Boom.notFound('CORS error: Missing Access-Control-Request-Method header');
  }

  const matchedRoute = request.server.match(requestedMethod, request.path, request.info.hostname);
  if (!matchedRoute) {
    throw Boom.notFound();
  }

  const origin = request.headers.origin;
  if (!isCorsOriginAllowed(origin, corsPolicy)) {
    throw Boom.forbidden('CORS error: Origin not allowed');
  }

  const response = h.response().code(200);
  applyCorsResponseHeaders(response, origin, corsPolicy);
  response.header('access-control-allow-methods', requestedMethod.toUpperCase());

  const requestedHeaders = normalizeCorsRequestHeaders(
    request.headers['access-control-request-headers']
  );

  if (requestedHeaders) {
    response.header('access-control-allow-headers', requestedHeaders);
  }

  return response;
};

export const createServer = async () => {
  if (!isLoopbackHost(config.server.host) && (!config.auth.enabled || !config.auth.apiKey)) {
    throw new Error(
      `Refusing to bind to non-loopback host "${config.server.host}" without API key authentication`
    );
  }

  const corsPolicy = buildCorsPolicy(config.server.corsOrigins || []);

  const server = Hapi.server({
    port: config.server.port,
    host: config.server.host,
    routes: {
      cors: false,
      validate: {
        failAction: async (request, h, err) => {
          throw err;
        },
      },
    },
  });

  if (corsPolicy.enabled) {
    server.route({
      method: 'OPTIONS',
      path: '/{p*}',
      options: {
        auth: false,
      },
      handler: createCorsPreflightHandler(corsPolicy),
    });

    server.ext('onPreResponse', (request, h) => {
      const origin = request.headers.origin;

      if (!isCorsOriginAllowed(origin, corsPolicy)) {
        return h.continue;
      }

      applyCorsResponseHeaders(request.response, origin, corsPolicy);
      return h.continue;
    });
  }

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
