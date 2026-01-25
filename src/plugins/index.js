import Inert from '@hapi/inert';
import { authPlugin } from './auth.js';

export const registerPlugins = async (server) => {
  await server.register([
    Inert,
    authPlugin,
  ]);
};
