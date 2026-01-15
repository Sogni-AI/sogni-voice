import { startServer } from './server.js';
import { tempFileManager } from './utils/tempFile.js';

process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  await tempFileManager.cleanupAll();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nShutting down gracefully...');
  await tempFileManager.cleanupAll();
  process.exit(0);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
