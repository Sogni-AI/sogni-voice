import { healthRoutes } from './health.js';
import { transcribeRoutes } from './transcribe.js';
import { ttsRoutes } from './tts.js';
import { staticRoutes } from './static.js';

export const routes = [
  ...healthRoutes,
  ...transcribeRoutes,
  ...ttsRoutes,
  ...staticRoutes,
];
