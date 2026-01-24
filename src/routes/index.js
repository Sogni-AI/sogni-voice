import { healthRoutes } from './health.js';
import { transcribeRoutes } from './transcribe.js';
import { ttsRoutes } from './tts.js';
import { qwenTtsRoutes } from './qwenTts.js';
import { staticRoutes } from './static.js';

export const routes = [
  ...healthRoutes,
  ...transcribeRoutes,
  ...ttsRoutes,
  ...qwenTtsRoutes,
  ...staticRoutes,
];
