import Joi from 'joi';
import Boom from '@hapi/boom';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { config } from '../config/index.js';
import { transcriptionService } from '../services/transcription.js';
import { tempFileManager } from '../utils/tempFile.js';

export const transcribeRoutes = [
  {
    method: 'POST',
    path: '/transcribe',
    options: {
      payload: {
        output: 'stream',
        parse: true,
        multipart: true,
        maxBytes: config.upload.maxFileSizeBytes,
        allow: 'multipart/form-data',
      },
      validate: {
        payload: Joi.object({
          file: Joi.any().required().description('Audio file to transcribe'),
        }),
      },
      description: 'Transcribe an audio file to text',
      tags: ['api', 'transcription'],
    },
    handler: async (request, h) => {
      let tempDir = null;

      try {
        const { file } = request.payload;

        if (!file || !file.hapi) {
          throw Boom.badRequest('No audio file provided');
        }

        const { filename } = file.hapi;
        const extension = filename.split('.').pop() || 'mp3';

        // Create temp directory and file
        tempDir = await tempFileManager.createTempDir('transcribe-');
        const tempFilePath = await tempFileManager.createTempFile(tempDir, extension);

        // Write uploaded file to temp location
        const writeStream = createWriteStream(tempFilePath);
        await pipeline(file, writeStream);

        // Perform transcription
        const result = await transcriptionService.transcribe(tempFilePath);

        return {
          success: true,
          transcript: result.text,
          filename,
        };
      } catch (error) {
        if (error.isBoom) throw error;
        console.error('Transcription error:', error);
        throw Boom.badImplementation('Transcription failed');
      } finally {
        if (tempDir) {
          await tempFileManager.cleanup(tempDir);
        }
      }
    },
  },
];
