import Joi from 'joi';
import Boom from '@hapi/boom';
import { readFile } from 'node:fs/promises';
import { config } from '../config/index.js';
import { ttsService } from '../services/tts.js';
import { tempFileManager } from '../utils/tempFile.js';

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
          format: Joi.string().valid('wav', 'buffer').default('wav')
            .description('Output format'),
        }),
      },
      description: 'Convert text to speech audio',
      tags: ['api', 'tts'],
    },
    handler: async (request, h) => {
      let tempDir = null;

      try {
        const { text, voice, speed, format } = request.payload;

        // Create temp directory for output
        tempDir = await tempFileManager.createTempDir('tts-');
        const outputPath = await tempFileManager.createTempFile(tempDir, 'wav');

        // Generate audio
        await ttsService.generate(text, {
          voice,
          speed,
          outputPath,
        });

        if (format === 'buffer') {
          const audioBuffer = await readFile(outputPath);
          return {
            success: true,
            audio: audioBuffer.toString('base64'),
            voice,
            speed,
            format: 'wav',
          };
        }

        // Return file as download
        const audioBuffer = await readFile(outputPath);

        return h.response(audioBuffer)
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
