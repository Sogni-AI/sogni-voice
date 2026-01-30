import Joi from 'joi';
import Boom from '@hapi/boom';
import { readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { config } from '../config/index.js';
import { pocketTtsService } from '../services/pocketTts.js';
import { tempFileManager } from '../utils/tempFile.js';

const execFileAsync = promisify(execFile);

const checkEnabled = (request, h) => {
  if (!config.pocketTts.enabled) {
    throw Boom.notFound('Pocket TTS is not enabled. Set POCKET_TTS_ENABLED=true to enable.');
  }
  return h.continue;
};

export const pocketTtsRoutes = [
  // Generate speech
  {
    method: 'POST',
    path: '/pocket-tts',
    options: {
      pre: [{ method: checkEnabled }],
      validate: {
        payload: Joi.object({
          text: Joi.string().required().min(1).max(10000)
            .description('Text to convert to speech'),
          voice: Joi.string().default(config.pocketTts.defaultVoice)
            .description('Voice to use for synthesis'),
          format: Joi.string().valid('wav', 'opus', 'buffer').default('wav')
            .description('Output format (wav, opus, or buffer for base64 wav)'),
        }),
      },
      description: 'Convert text to speech using Pocket TTS',
      tags: ['api', 'pocket-tts'],
    },
    handler: async (request, h) => {
      const startTime = performance.now();
      let tempDir = null;

      try {
        const { text, voice, format } = request.payload;

        await pocketTtsService.initialize();

        tempDir = await tempFileManager.createTempDir('pocket-tts-');
        const outputPath = await tempFileManager.createTempFile(tempDir, 'wav');

        const result = await pocketTtsService.generate(text, { voice, outputPath });

        const wavBuffer = await readFile(outputPath);

        if (format === 'buffer') {
          const durationMs = performance.now() - startTime;
          console.log(`Pocket TTS request completed in ${(durationMs / 1000).toFixed(3)}s`);
          return {
            success: true,
            audio: wavBuffer.toString('base64'),
            voice,
            format: 'wav',
            duration: result.duration,
          };
        }

        if (format === 'opus') {
          const opusPath = outputPath.replace('.wav', '.opus');
          await execFileAsync('ffmpeg', [
            '-i', outputPath, '-c:a', 'libopus', '-b:a', '32k', '-y', opusPath,
          ], { timeout: 300000 });
          const opusBuffer = await readFile(opusPath);
          const durationMs = performance.now() - startTime;
          console.log(`Pocket TTS request completed in ${(durationMs / 1000).toFixed(3)}s`);
          return h.response(opusBuffer)
            .type('audio/opus')
            .header('Content-Disposition', 'attachment; filename="output.opus"');
        }

        const durationMs = performance.now() - startTime;
        console.log(`Pocket TTS request completed in ${(durationMs / 1000).toFixed(3)}s`);
        return h.response(wavBuffer)
          .type('audio/wav')
          .header('Content-Disposition', 'attachment; filename="output.wav"');
      } catch (error) {
        if (error.isBoom) throw error;
        console.error('Pocket TTS error:', error);
        throw Boom.badImplementation('Pocket TTS generation failed');
      } finally {
        if (tempDir) {
          await tempFileManager.cleanup(tempDir);
        }
      }
    },
  },

  // List voices
  {
    method: 'GET',
    path: '/pocket-tts/voices',
    options: {
      pre: [{ method: checkEnabled }],
      description: 'List available Pocket TTS voices and clones',
      tags: ['api', 'pocket-tts'],
    },
    handler: async (request, h) => {
      try {
        await pocketTtsService.initialize();

        const result = await pocketTtsService.listVoices();

        return {
          voices: result.voices,
          clones: result.clones,
          default: config.pocketTts.defaultVoice,
        };
      } catch (error) {
        if (error.isBoom) throw error;
        console.error('Pocket TTS list voices error:', error);
        throw Boom.badImplementation('Failed to list voices');
      }
    },
  },

  // Create voice clone
  {
    method: 'POST',
    path: '/pocket-tts/voices/clone',
    options: {
      pre: [{ method: checkEnabled }],
      payload: {
        maxBytes: config.upload.maxFileSizeBytes,
        output: 'stream',
        parse: true,
        multipart: true,
        allow: 'multipart/form-data',
      },
      validate: {
        payload: Joi.object({
          audio: Joi.any().required()
            .description('Reference audio file (WAV/MP3/OGG)'),
          cloneId: Joi.string().min(1).max(100).pattern(/^[a-zA-Z0-9_-]+$/)
            .description('Optional custom name for the voice clone'),
        }),
      },
      description: 'Create a voice clone from reference audio',
      tags: ['api', 'pocket-tts'],
    },
    handler: async (request, h) => {
      let tempDir = null;

      try {
        const { audio, cloneId: userCloneId } = request.payload;

        await pocketTtsService.initialize();

        const cloneId = userCloneId || `clone_${randomBytes(8).toString('hex')}`;

        tempDir = await tempFileManager.createTempDir('pocket-clone-');
        const uploadedPath = await tempFileManager.createTempFile(tempDir, 'audio');

        await pipeline(audio, createWriteStream(uploadedPath));

        // Convert to WAV format for consistent processing
        const wavPath = await tempFileManager.createTempFile(tempDir, 'wav');
        console.log(`Converting audio to WAV: ${uploadedPath} -> ${wavPath}`);

        await execFileAsync('ffmpeg', [
          '-i', uploadedPath,
          '-ar', '24000',
          '-ac', '1',
          '-c:a', 'pcm_s16le',
          '-y',
          wavPath,
        ], { timeout: 300000 });

        const result = await pocketTtsService.createVoiceClone(wavPath, cloneId);

        return {
          success: true,
          cloneId: result.cloneId,
          message: 'Voice clone created successfully',
        };
      } catch (error) {
        if (error.isBoom) throw error;
        console.error('Pocket TTS voice clone error:', error);
        throw Boom.badImplementation('Voice clone creation failed');
      } finally {
        if (tempDir) {
          await tempFileManager.cleanup(tempDir);
        }
      }
    },
  },

  // Generate with cloned voice
  {
    method: 'POST',
    path: '/pocket-tts/voices/clone/{cloneId}/generate',
    options: {
      pre: [{ method: checkEnabled }],
      validate: {
        params: Joi.object({
          cloneId: Joi.string().required().pattern(/^[a-zA-Z0-9_-]+$/)
            .description('Voice clone ID'),
        }),
        payload: Joi.object({
          text: Joi.string().required().min(1).max(10000)
            .description('Text to convert to speech'),
          format: Joi.string().valid('wav', 'opus', 'buffer').default('wav')
            .description('Output format'),
        }),
      },
      description: 'Generate speech using a cloned voice',
      tags: ['api', 'pocket-tts'],
    },
    handler: async (request, h) => {
      const startTime = performance.now();
      let tempDir = null;

      try {
        const { cloneId } = request.params;
        const { text, format } = request.payload;

        await pocketTtsService.initialize();

        tempDir = await tempFileManager.createTempDir('pocket-tts-');
        const outputPath = await tempFileManager.createTempFile(tempDir, 'wav');

        const result = await pocketTtsService.generateVoiceClone(text, { cloneId, outputPath });

        const wavBuffer = await readFile(outputPath);

        if (format === 'buffer') {
          const durationMs = performance.now() - startTime;
          console.log(`Pocket TTS clone generation completed in ${(durationMs / 1000).toFixed(3)}s`);
          return {
            success: true,
            audio: wavBuffer.toString('base64'),
            cloneId,
            format: 'wav',
            duration: result.duration,
          };
        }

        if (format === 'opus') {
          const opusPath = outputPath.replace('.wav', '.opus');
          await execFileAsync('ffmpeg', [
            '-i', outputPath, '-c:a', 'libopus', '-b:a', '32k', '-y', opusPath,
          ], { timeout: 300000 });
          const opusBuffer = await readFile(opusPath);
          const durationMs = performance.now() - startTime;
          console.log(`Pocket TTS clone generation completed in ${(durationMs / 1000).toFixed(3)}s`);
          return h.response(opusBuffer)
            .type('audio/opus')
            .header('Content-Disposition', 'attachment; filename="output.opus"');
        }

        const durationMs = performance.now() - startTime;
        console.log(`Pocket TTS clone generation completed in ${(durationMs / 1000).toFixed(3)}s`);
        return h.response(wavBuffer)
          .type('audio/wav')
          .header('Content-Disposition', 'attachment; filename="output.wav"');
      } catch (error) {
        if (error.isBoom) throw error;
        if (error.message?.includes('not found')) {
          throw Boom.notFound(`Voice clone '${request.params.cloneId}' not found`);
        }
        console.error('Pocket TTS clone generation error:', error);
        throw Boom.badImplementation('Voice clone generation failed');
      } finally {
        if (tempDir) {
          await tempFileManager.cleanup(tempDir);
        }
      }
    },
  },

  // Delete voice clone
  {
    method: 'DELETE',
    path: '/pocket-tts/voices/clone/{cloneId}',
    options: {
      pre: [{ method: checkEnabled }],
      validate: {
        params: Joi.object({
          cloneId: Joi.string().required().pattern(/^[a-zA-Z0-9_-]+$/)
            .description('Voice clone ID to delete'),
        }),
      },
      description: 'Delete a voice clone',
      tags: ['api', 'pocket-tts'],
    },
    handler: async (request, h) => {
      try {
        const { cloneId } = request.params;

        await pocketTtsService.deleteVoiceClone(cloneId);

        return {
          success: true,
          cloneId,
          message: 'Voice clone deleted successfully',
        };
      } catch (error) {
        if (error.isBoom) throw error;
        if (error.message?.includes('not found')) {
          throw Boom.notFound(`Voice clone '${request.params.cloneId}' not found`);
        }
        console.error('Pocket TTS delete clone error:', error);
        throw Boom.badImplementation('Failed to delete voice clone');
      }
    },
  },
];
