import Joi from 'joi';
import Boom from '@hapi/boom';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { config } from '../config/index.js';
import { qwenAsrService } from '../services/qwenAsr.js';
import { tempFileManager } from '../utils/tempFile.js';
import {
  getExtension,
  validateAudioUpload,
  ALLOWED_AUDIO_EXTENSIONS,
} from '../utils/audioValidation.js';
import { QWEN_ALIGNER_LANGUAGES } from '../utils/qwenAsrLanguages.js';

export const qwenAsrRoutes = [
  {
    method: 'POST',
    path: '/qwen-asr/align',
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
          file: Joi.any().required().description('Audio file to align'),
          text: Joi.string().trim().min(1).max(20000).required()
            .description('Known transcript to align to the audio'),
          language: Joi.string().valid(...QWEN_ALIGNER_LANGUAGES).insensitive().default('English')
            .description('Forced-alignment language'),
        }),
      },
      description: 'Align a known transcript to audio with Qwen3 ForcedAligner',
      tags: ['api', 'transcription', 'alignment'],
    },
    handler: async (request) => {
      let tempDir = null;
      try {
        if (!config.qwenAsr.enabled) {
          throw Boom.serviceUnavailable('Qwen3-ASR and ForcedAligner are disabled');
        }

        const { file, text, language } = request.payload;
        if (!file?.hapi) {
          throw Boom.badRequest('No audio file provided');
        }

        const { filename } = file.hapi;
        const claimedExtension = getExtension(filename);
        if (!claimedExtension || !ALLOWED_AUDIO_EXTENSIONS.includes(claimedExtension)) {
          throw Boom.unsupportedMediaType(
            `Unsupported file extension. Allowed: ${ALLOWED_AUDIO_EXTENSIONS.join(', ')}`,
          );
        }

        tempDir = await tempFileManager.createTempDir('qwen-align-');
        const tempFilePath = await tempFileManager.createTempFile(tempDir, claimedExtension);
        await pipeline(file, createWriteStream(tempFilePath));

        const { size } = await stat(tempFilePath);
        if (size === 0) throw Boom.badRequest('Uploaded audio file is empty');

        const fh = await open(tempFilePath, 'r');
        try {
          const headBytes = Buffer.alloc(16);
          await fh.read(headBytes, 0, 16, 0);
          validateAudioUpload({ filename, headBytes });
        } finally {
          await fh.close();
        }

        const result = await qwenAsrService.align(tempFilePath, text, language);
        return {
          success: true,
          text: result.text,
          language: result.language,
          model: result.model,
          timestamps: result.timestamps,
        };
      } catch (error) {
        if (error.isBoom) throw error;
        console.error('Qwen3 forced alignment error:', error);
        if (typeof error.toBoom === 'function') throw error.toBoom();
        throw Boom.badImplementation('Forced alignment failed');
      } finally {
        if (tempDir) await tempFileManager.cleanup(tempDir);
      }
    },
  },
];
