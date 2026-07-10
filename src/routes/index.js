import { healthRoutes } from './health.js';
import { transcribeRoutes } from './transcribe.js';
import { ttsRoutes } from './tts.js';
import { qwenTtsRoutes } from './qwenTts.js';
import { pocketTtsRoutes } from './pocketTts.js';
import { qwenAsrRoutes } from './qwenAsr.js';
import { mossTtsRoutes } from './mossTts.js';
import { staticRoutes } from './static.js';
import { authRoutes } from './auth.js';

export const routes = [
  ...healthRoutes,
  ...transcribeRoutes,
  ...ttsRoutes,
  ...qwenTtsRoutes,
  ...pocketTtsRoutes,
  ...qwenAsrRoutes,
  ...mossTtsRoutes,
  ...authRoutes,
  ...staticRoutes,
];
