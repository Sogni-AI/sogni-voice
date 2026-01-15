import Inert from '@hapi/inert';

export const registerPlugins = async (server) => {
  await server.register([
    Inert,
  ]);
};
