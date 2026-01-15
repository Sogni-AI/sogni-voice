import { KokoroTTS } from 'kokoro-js';
import { config } from '../config/index.js';
import { TTSError } from '../utils/errors.js';

let ttsInstance = null;
let initPromise = null;

export class TTSService {
  async initialize() {
    if (ttsInstance) return ttsInstance;

    // Prevent multiple simultaneous initializations
    if (initPromise) return initPromise;

    initPromise = (async () => {
      try {
        console.log('Initializing TTS model (this may take a moment on first run)...');
        ttsInstance = await KokoroTTS.from_pretrained(config.tts.modelId, {
          dtype: config.tts.dtype,
          device: config.tts.device,
        });
        console.log('TTS model initialized successfully');
        return ttsInstance;
      } catch (error) {
        initPromise = null;
        throw new TTSError(`Failed to initialize TTS model: ${error.message}`, error);
      }
    })();

    return initPromise;
  }

  async generate(text, options = {}) {
    const {
      voice = config.tts.defaultVoice,
      speed = config.tts.defaultSpeed,
      outputPath,
    } = options;

    try {
      const tts = await this.initialize();

      const audio = await tts.generate(text, {
        voice,
        speed,
      });

      if (outputPath) {
        await audio.save(outputPath);
      }

      return {
        audio,
        voice,
        speed,
        outputPath,
      };
    } catch (error) {
      if (error instanceof TTSError) throw error;
      throw new TTSError(`TTS generation failed: ${error.message}`, error);
    }
  }

  listVoices() {
    return [
      'af_heart', 'af_alloy', 'af_aoede', 'af_bella', 'af_jessica',
      'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah',
      'af_sky', 'am_adam', 'am_echo', 'am_eric', 'am_fenrir',
      'am_liam', 'am_michael', 'am_onyx', 'am_puck', 'am_santa',
    ];
  }
}

export const ttsService = new TTSService();
