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
let preWarmInFlight = null;

const gracefulShutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n[speech-worker] Shutting down gracefully... (received ${signal})`);

  // Every step runs even when an earlier one throws: a supervisor drain that
  // rejects must not strand the Python daemons or leave temp dirs on disk, since
  // nothing after this process gets another chance to clean them up.
  let failed = false;
  const settle = async (label, step) => {
    try {
      await step();
    } catch (error) {
      failed = true;
      console.error(`[speech-worker] ${label} failed during shutdown:`, error);
    }
  };

  // A signal landing mid-pre-warm would otherwise race daemon startup: initialize()
  // is still spawning while shutdown() looks for a handle that does not exist yet,
  // and the Python child outlives us. Wait it out first.
  if (preWarmInFlight) {
    const pending = preWarmInFlight;
    console.log('[speech-worker] Waiting for pre-warm to finish before shutdown...');
    await settle('Pre-warm', () => pending);
  }

  await settle('Supervisor drain', () => supervisor.shutdown());

  await Promise.all([
    settle('Temp file cleanup', () => tempFileManager.cleanupAll()),
    settle('Transcription daemon shutdown', () => transcriptionService.shutdown()),
    settle('Kokoro TTS daemon shutdown', () => ttsService.shutdown()),
    settle('Qwen TTS Base daemon shutdown', () => qwenTtsBaseService.shutdown()),
  ]);

  process.exit(failed ? 1 : 0);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('unhandledRejection', (err) => {
  console.error('[speech-worker] Unhandled rejection:', err);
  process.exit(1);
});

// Pre-warm before connecting, never after: start() opens the socket and sends
// workerInfo, and the broker can dispatch a job the moment it lands. Advertising
// capacity against cold weights buys a paid job a multi-minute model load inside
// its own deadline.
preWarmInFlight = preWarm();
await preWarmInFlight;
preWarmInFlight = null;

// A signal during pre-warm already ran the shutdown path; don't connect behind it.
if (!shuttingDown) supervisor.start();
