import { config } from '../config/index.js';
import { tempFileManager } from '../utils/tempFile.js';
import { startVoiceSupernetWorker } from './supervisor.js';

if (!config.networkWorker.enabled) {
  console.log('[voice-worker] SOGNI_NETWORK_WORKER is not enabled; exiting.');
  process.exit(0);
}

let workerBundle = null;
let shuttingDown = false;
let startupPromise = null;

const gracefulShutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n[voice-worker] Shutting down gracefully... (received ${signal})`);
  let failed = false;
  const settle = async (label, fn) => {
    try {
      await fn();
    } catch (error) {
      failed = true;
      console.error(`[voice-worker] ${label} failed during shutdown:`, error);
    }
  };

  if (startupPromise) {
    await settle('Worker startup wait', () => startupPromise);
  }

  if (workerBundle) {
    await settle('Supervisor drain', () => workerBundle.supervisor.shutdown());
    await settle('Backend shutdown', () => workerBundle.backend.shutdown());
  }
  await settle('Temp file cleanup', () => tempFileManager.cleanupAll());

  process.exit(failed ? 1 : 0);
};

process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('unhandledRejection', (error) => {
  console.error('[voice-worker] Unhandled rejection:', error);
  process.exit(1);
});

startupPromise = startVoiceSupernetWorker({
  defaultBackendMode: process.env.SOGNI_VOICE_API_URL ? 'http' : 'local',
  ownsDaemons: true,
});

try {
  workerBundle = await startupPromise;
} catch (error) {
  console.error(`[voice-worker] Failed to start Sogni Supernet worker: ${error.message}`);
  process.exit(1);
} finally {
  startupPromise = null;
}
