import Joi from 'joi';
import Boom from '@hapi/boom';
import { readFile } from 'node:fs/promises';
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
      const startTime = performance.now();
      let tempDir = null;

      try {
        const { text, voice, speed, format } = request.payload;

        // Create temp directory and file for TTS output
        tempDir = await tempFileManager.createTempDir('tts-');
        const outputPath = await tempFileManager.createTempFile(tempDir, 'wav');

        // Generate audio to file (daemon-based MLX TTS)
        await ttsService.generate(text, { voice, speed, outputPath });

        // Read the generated WAV file
        const wavBuffer = await readFile(outputPath);

        if (format === 'buffer') {
          const durationMs = performance.now() - startTime;
          console.log(`TTS request completed in ${(durationMs / 1000).toFixed(3)}s (${durationMs.toFixed(0)}ms)`);
          return {
            success: true,
            audio: wavBuffer.toString('base64'),
            voice,
            speed,
            format: 'wav',
          };
        }

        if (format === 'opus') {
          const opusPath = outputPath.replace('.wav', '.opus');

          await execFileAsync('ffmpeg', [
            '-i', outputPath,
            '-c:a', 'libopus',
            '-b:a', '32k',
            '-y',
            opusPath,
          ]);

          const opusBuffer = await readFile(opusPath);
          const durationMs = performance.now() - startTime;
          console.log(`TTS request completed in ${(durationMs / 1000).toFixed(3)}s (${durationMs.toFixed(0)}ms)`);
          return h.response(opusBuffer)
            .type('audio/opus')
            .header('Content-Disposition', 'attachment; filename="output.opus"');
        }

        // Return WAV file
        const durationMs = performance.now() - startTime;
        console.log(`TTS request completed in ${(durationMs / 1000).toFixed(3)}s (${durationMs.toFixed(0)}ms)`);
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
