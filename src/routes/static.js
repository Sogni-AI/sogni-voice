import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicPath = join(__dirname, '../../public');

export const staticRoutes = [
  {
    method: 'GET',
    path: '/{param*}',
    handler: {
      directory: {
        path: publicPath,
        index: true,
      },
    },
  },
];
