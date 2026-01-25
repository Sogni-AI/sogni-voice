import { startServer } from './server.js';
import { tempFileManager } from './utils/tempFile.js';
import { transcriptionService } from './services/transcription.js';
import { ttsService } from './services/tts.js';
import { qwenTtsBaseService, qwenTtsCustomVoiceService } from './services/qwenTts.js';
import { config } from './config/index.js';

const gracefulShutdown = async (signal) => {
  console.log(`\nShutting down gracefully... (received ${signal})`);
  console.log('Stack trace at shutdown:');
  console.trace();
  await Promise.all([
    tempFileManager.cleanupAll(),
    transcriptionService.shutdown(),
    ttsService.shutdown(),
    qwenTtsBaseService.shutdown(),
    qwenTtsCustomVoiceService.shutdown(),
  ]);
  process.exit(0);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});

startServer()
  .then(async () => {
    // Optionally pre-warm the daemons
    const preWarmPromises = [];

    if (config.transcription.preWarmDaemon) {
      console.log('Pre-warming transcription daemon...');
      preWarmPromises.push(transcriptionService.initialize());
    }

    if (config.tts.preWarmDaemon) {
      console.log('Pre-warming TTS daemon...');
      preWarmPromises.push(ttsService.initialize());
    }

    if (config.qwenTts.enabled && config.qwenTts.preWarmDaemon) {
      console.log('Pre-warming Qwen TTS daemons (Base + CustomVoice)...');
      preWarmPromises.push(
        qwenTtsBaseService.initialize(),
        qwenTtsCustomVoiceService.initialize(),
      );
    }

    await Promise.all(preWarmPromises);
  })
  .catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
