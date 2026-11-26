#!/usr/bin/env node
import { tempFileManager } from '../src/utils/tempFile.js';
import { createSupervisor } from '../src/network/supervisor.js';
import { config } from '../src/config/index.js';

const args = new Set(process.argv.slice(2));

if (args.has('--help') || args.has('-h')) {
  console.log(`Usage: node scripts/sogni-voice-worker.mjs [--check]

Standalone Sogni Voice Supernet Worker sidecar.

Environment variables:
  SOGNI_API_KEY               Sogni Supernet worker API key (required; alias: API_KEY)
  SOGNI_NFT_TOKEN_ID          Fast-network NFT token ID (optional on Mac Relaxed; alias: NFT_TOKEN_ID)
  SOGNI_ENV                   production | staging | local (default: staging)
  SOGNI_VOICE_BACKEND_MODE    http | local (default: http for standalone sidecar)
  SOGNI_VOICE_API_URL         Target sogni-voice HTTP server (default: http://127.0.0.1:3000)
  SOGNI_VOICE_API_KEY         API key for target sogni-voice server (fallback: AUTH_API_KEY)
  SOGNI_WORKER_MODELS         Optional comma-separated model allowlist
  SOGNI_WORKER_NETWORK        fast | relaxed (default: fast on Linux, relaxed on macOS)
`);
  process.exit(0);
}

let workerBundle = null;
let shuttingDown = false;
let startupPromise = null;

const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n[sogni-voice-worker] Received ${signal}; draining in-flight jobs...`);
  let failed = false;
  const settle = async (label, step) => {
    try {
      await step();
    } catch (error) {
      failed = true;
      console.error(`[sogni-voice-worker] ${label} failed:`, error);
    }
  };

  if (startupPromise) {
    await settle('Startup wait', () => startupPromise);
  }
  if (workerBundle) {
    await settle('Supervisor shutdown', () => workerBundle.supervisor.shutdown());
    await settle('Backend shutdown', () => workerBundle.backend.shutdown());
  }
  await settle('Temp cleanup', () => tempFileManager.cleanupAll());
  process.exit(failed ? 1 : 0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => {
  console.error('[sogni-voice-worker] Unhandled rejection:', error);
  process.exit(1);
});

try {
  startupPromise = createSupervisor({
    defaultBackendMode: 'http',
    ownsDaemons: true,
  });
  workerBundle = await startupPromise;
  startupPromise = null;

  if (args.has('--check')) {
    console.log(JSON.stringify({
      ok: true,
      backendMode: workerBundle.backend.mode,
      sogniEnv: workerBundle.hosts.env,
      socketUrl: workerBundle.hosts.socket,
      apiUrl: workerBundle.hosts.api,
      hardwareRating: workerBundle.supervisor.hardwareRating,
      hardwareInfo: workerBundle.hardwareInfo,
      workerModels: workerBundle.workerModels.map((m) => m.id),
    }, null, 2));
    process.exit(0);
  }

  if (config.networkWorker?.preWarm ?? true) {
    await workerBundle.backend.preWarm(workerBundle.workerModels);
  }
  if (!shuttingDown) {
    await workerBundle.supervisor.start();
  }
} catch (error) {
  console.error(`[sogni-voice-worker] Fatal startup error: ${error.message}`);
  process.exit(1);
}
