import Joi from 'joi';
import Boom from '@hapi/boom';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { config } from '../config/index.js';
import { transcriptionService } from '../services/transcription.js';
import { tempFileManager } from '../utils/tempFile.js';
import {
  getExtension,
  sanitizeEchoFilename,
  validateAudioUpload,
  ALLOWED_AUDIO_EXTENSIONS,
} from '../utils/audioValidation.js';

export const transcribeRoutes = [
  {
    method: 'POST',
    path: '/transcribe',
    options: {
      payload: {
        output: 'stream',
        parse: true,
        multipart: true,
        maxBytes: config.upload.transcribeMaxBytes,
        allow: 'multipart/form-data',
      },
      validate: {
        payload: Joi.object({
          file: Joi.any().required().description('Audio file to transcribe'),
          timestamps: Joi.string().valid('true', 'false').optional()
            .description('Include sentence-level subtitle timings in response'),
          wordTimestamps: Joi.string().valid('true', 'false').optional()
            .description('Include word-level subtitle timings in response (overrides timestamps)'),
        }),
      },
      description: 'Transcribe an audio file to text',
      tags: ['api', 'transcription'],
    },
    handler: async (request, h) => {
      let tempDir = null;

      try {
        if (!config.transcription.enabled) {
          throw Boom.serviceUnavailable('Transcription is disabled');
        }

        const { file, timestamps: timestampsParam, wordTimestamps: wordTimestampsParam } = request.payload;
        const timestamps = timestampsParam === 'true';
        const wordTimestamps = wordTimestampsParam === 'true';

        if (!file || !file.hapi) {
          throw Boom.badRequest('No audio file provided');
        }

        const { filename } = file.hapi;
        const claimedExtension = getExtension(filename);
        if (!claimedExtension || !ALLOWED_AUDIO_EXTENSIONS.includes(claimedExtension)) {
          throw Boom.unsupportedMediaType(
            `Unsupported file extension. Allowed: ${ALLOWED_AUDIO_EXTENSIONS.join(', ')}`,
          );
        }

        tempDir = await tempFileManager.createTempDir('transcribe-');
        const tempFilePath = await tempFileManager.createTempFile(tempDir, claimedExtension);

        const writeStream = createWriteStream(tempFilePath);
        await pipeline(file, writeStream);

        const { size } = await stat(tempFilePath);
        if (size === 0) {
          throw Boom.badRequest('Uploaded audio file is empty');
        }

        const fh = await open(tempFilePath, 'r');
        try {
          const headBytes = Buffer.alloc(16);
          await fh.read(headBytes, 0, 16, 0);
          validateAudioUpload({ filename, headBytes });
        } finally {
          await fh.close();
        }

        const result = await transcriptionService.transcribe(tempFilePath, { timestamps, wordTimestamps });

        // When timestamps requested, only return timestamps for programmatic use
        if ((timestamps || wordTimestamps) && result.timestamps) {
          return {
            success: true,
            timestamps: result.timestamps,
          };
        }

        return {
          success: true,
          transcript: result.text,
          filename: sanitizeEchoFilename(filename),
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
