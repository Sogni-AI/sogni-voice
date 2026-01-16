import { startServer } from './server.js';
import { tempFileManager } from './utils/tempFile.js';
import { transcriptionService } from './services/transcription.js';
import { config } from './config/index.js';

const gracefulShutdown = async () => {
  console.log('\nShutting down gracefully...');
  await Promise.all([
    tempFileManager.cleanupAll(),
    transcriptionService.shutdown(),
  ]);
  process.exit(0);
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});

startServer()
  .then(async () => {
    // Optionally pre-warm the transcription daemon
    if (config.transcription.preWarmDaemon) {
      console.log('Pre-warming transcription daemon...');
      await transcriptionService.initialize();
    }
  })
  .catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
