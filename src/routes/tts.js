import Joi from 'joi';
import Boom from '@hapi/boom';
import { writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config/index.js';
import { ttsService } from '../services/tts.js';
import { tempFileManager } from '../utils/tempFile.js';

const execFileAsync = promisify(execFile);

export const ttsRoutes = [
  {
    method: 'POST',
    path: '/tts',
    options: {
      validate: {
        payload: Joi.object({
          text: Joi.string().required().min(1).max(10000)
            .description('Text to convert to speech'),
          voice: Joi.string().default(config.tts.defaultVoice)
            .description('Voice to use for synthesis'),
          speed: Joi.number().min(0.5).max(2.0).default(config.tts.defaultSpeed)
            .description('Speech speed (0.5-2.0)'),
          format: Joi.string().valid('wav', 'opus', 'buffer').default('wav')
            .description('Output format (wav, opus, or buffer for base64 wav)'),
        }),
      },
      description: 'Convert text to speech audio',
      tags: ['api', 'tts'],
    },
    handler: async (request, h) => {
      let tempDir = null;

      try {
        const { text, voice, speed, format } = request.payload;

        // Generate audio (returns RawAudio object)
        const { audio } = await ttsService.generate(text, { voice, speed });

        // Convert to WAV in memory (no disk I/O for wav/buffer formats)
        const wavBuffer = Buffer.from(audio.toWav());

        if (format === 'buffer') {
          return {
            success: true,
            audio: wavBuffer.toString('base64'),
            voice,
            speed,
            format: 'wav',
          };
        }

        if (format === 'opus') {
          // Opus requires temp files for ffmpeg conversion
          tempDir = await tempFileManager.createTempDir('tts-');
          const wavPath = await tempFileManager.createTempFile(tempDir, 'wav');
          const opusPath = wavPath.replace('.wav', '.opus');

          await writeFile(wavPath, wavBuffer);
          await execFileAsync('ffmpeg', [
            '-i', wavPath,
            '-c:a', 'libopus',
            '-b:a', '32k',
            '-y',
            opusPath,
          ]);

          const opusBuffer = await readFile(opusPath);
          return h.response(opusBuffer)
            .type('audio/opus')
            .header('Content-Disposition', 'attachment; filename="output.opus"');
        }

        // Return WAV directly from memory
        return h.response(wavBuffer)
          .type('audio/wav')
          .header('Content-Disposition', 'attachment; filename="output.wav"');
      } catch (error) {
        if (error.isBoom) throw error;
        console.error('TTS error:', error);
        throw Boom.badImplementation('Text-to-speech generation failed');
      } finally {
        if (tempDir) {
          await tempFileManager.cleanup(tempDir);
        }
      }
    },
  },
  {
    method: 'GET',
    path: '/tts/voices',
    options: {
      description: 'List available TTS voices',
      tags: ['api', 'tts'],
    },
    handler: async (request, h) => {
      return {
        voices: ttsService.listVoices(),
        default: config.tts.defaultVoice,
      };
    },
  },
];
