import { config } from '../config/index.js';
import { transcriptionService } from '../services/transcription.js';
import { ttsService } from '../services/tts.js';
import { qwenTtsBaseService } from '../services/qwenTts.js';
import { tempFileManager } from '../utils/tempFile.js';
import { buildSpeechModels } from './capabilities.js';
import { createSupervisor } from './supervisor.js';

if (!config.networkWorker.enabled) {
  console.log('[speech-worker] SOGNI_NETWORK_WORKER is not enabled; exiting.');
  process.exit(0);
}

if (!config.networkWorker.apiKey) {
  console.error('[speech-worker] SOGNI_WORKER_API_KEY is required; exiting.');
  process.exit(1);
}

const speechModels = buildSpeechModels();
if (speechModels.length === 0) {
  console.error('[speech-worker] No speech engines are enabled; nothing to advertise. Exiting.');
  process.exit(1);
}

const supervisor = createSupervisor({ speechModels });

// This process owns its own Python daemons: the service modules keep daemon
// handles in module-level state, so nothing is shared with the Hapi process.
const preWarm = async () => {
  if (!config.networkWorker.preWarm) return;

  const engines = new Set(speechModels.map((model) => model.engine));
  const targets = [
    ['parakeet', 'Transcription daemon', () => transcriptionService.initialize()],
    ['kokoro', 'Kokoro TTS daemon', () => ttsService.initialize()],
    ['qwen-preset', 'Qwen TTS Base daemon', () => qwenTtsBaseService.initialize()],
  ].filter(([engine]) => engines.has(engine));

  await Promise.all(targets.map(async ([, name, initialize]) => {
    console.log(`[speech-worker] Pre-warming ${name}...`);
    try {
      await initialize();
    } catch (error) {
      console.error(`[speech-worker] ${name} pre-warm failed:`, error);
    }
  }));
};

let shuttingDown = false;
const gracefulShutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n[speech-worker] Shutting down gracefully... (received ${signal})`);
  await supervisor.shutdown();
  await Promise.all([
    tempFileManager.cleanupAll(),
    transcriptionService.shutdown(),
    ttsService.shutdown(),
    qwenTtsBaseService.shutdown(),
  ]);
  process.exit(0);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('unhandledRejection', (err) => {
  console.error('[speech-worker] Unhandled rejection:', err);
  process.exit(1);
});

supervisor.start();
await preWarm();
