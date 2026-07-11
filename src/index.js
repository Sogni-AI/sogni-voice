import { startServer } from './server.js';
import { tempFileManager } from './utils/tempFile.js';
import { transcriptionService } from './services/transcription.js';
import { ttsService } from './services/tts.js';
import {
  qwenTtsBaseService,
  qwenTtsCustomVoiceService,
  qwenTtsVoiceDesignService,
} from './services/qwenTts.js';
import { pocketTtsService } from './services/pocketTts.js';
import { diarizationService } from './services/diarization.js';
import { qwenAsrService } from './services/qwenAsr.js';
import { mossTtsService } from './services/mossTts.js';
import { fishTtsService } from './services/fishTts.js';
import { mossTranscribeDiarizeService } from './services/mossTranscribeDiarize.js';
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
    qwenTtsVoiceDesignService.shutdown(),
    pocketTtsService.shutdown(),
    diarizationService.shutdown(),
    qwenAsrService.shutdown(),
    mossTtsService.shutdown(),
    fishTtsService.shutdown(),
    mossTranscribeDiarizeService.shutdown(),
  ]);
  process.exit(0);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});

const preWarmDaemon = async (name, initialize) => {
  try {
    await initialize();
  } catch (error) {
    console.error(`${name} pre-warm failed:`, error);
  }
};

startServer()
  .then(async () => {
    // Optionally pre-warm the daemons
    const preWarmPromises = [];

    if (config.transcription.enabled && config.transcription.preWarmDaemon) {
      console.log('Pre-warming transcription daemon...');
      preWarmPromises.push(preWarmDaemon('Transcription daemon', () => transcriptionService.initialize()));
    }

    if (config.tts.enabled && config.tts.preWarmDaemon) {
      console.log('Pre-warming TTS daemon...');
      preWarmPromises.push(preWarmDaemon('TTS daemon', () => ttsService.initialize()));
    }

    if (config.qwenTts.enabled && config.qwenTts.preWarmDaemon) {
      console.log('Pre-warming Qwen3-TTS MLX daemons (Base + CustomVoice)...');
      preWarmPromises.push(
        preWarmDaemon('Qwen TTS Base daemon', () => qwenTtsBaseService.initialize()),
        preWarmDaemon('Qwen TTS CustomVoice daemon', () => qwenTtsCustomVoiceService.initialize()),
      );
    }

    if (config.qwenTts.enabled && config.qwenTts.preWarmVoiceDesign) {
      console.log('Pre-warming Qwen3-TTS MLX VoiceDesign daemon...');
      preWarmPromises.push(
        preWarmDaemon(
          'Qwen TTS VoiceDesign daemon',
          () => qwenTtsVoiceDesignService.initialize(),
        ),
      );
    }

    if (config.pocketTts.enabled && config.pocketTts.preWarmDaemon) {
      console.log('Pre-warming Pocket TTS daemon...');
      preWarmPromises.push(preWarmDaemon('Pocket TTS daemon', () => pocketTtsService.initialize()));
    }

    if (config.diarization.enabled && config.diarization.preWarmDaemon) {
      console.log('Pre-warming diarization daemon...');
      preWarmPromises.push(preWarmDaemon('Diarization daemon', () => diarizationService.initialize()));
    }

    if (config.qwenAsr.enabled && config.qwenAsr.preWarmDaemon) {
      console.log('Pre-warming Qwen3-ASR daemon...');
      preWarmPromises.push(preWarmDaemon('Qwen3-ASR daemon', () => qwenAsrService.initialize()));
    }

    if (config.mossTts.enabled && config.mossTts.preWarmDaemon) {
      console.log('Pre-warming MOSS-TTS-Nano daemon...');
      preWarmPromises.push(
        preWarmDaemon('MOSS-TTS-Nano daemon', () => mossTtsService.initialize()),
      );
    }

    if (config.fishTts.enabled && config.fishTts.preWarmDaemon) {
      console.log('Pre-warming Fish S2 Pro TTS daemon...');
      preWarmPromises.push(preWarmDaemon('Fish S2 TTS daemon', () => fishTtsService.initialize()));
    }

    if (config.mossTranscribeDiarize.enabled && config.mossTranscribeDiarize.preWarmDaemon) {
      console.log('Pre-warming experimental MOSS Transcribe-Diarize daemon...');
      preWarmPromises.push(
        preWarmDaemon(
          'MOSS Transcribe-Diarize daemon',
          () => mossTranscribeDiarizeService.initialize(),
        ),
      );
    }

    await Promise.all(preWarmPromises);
  })
  .catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
