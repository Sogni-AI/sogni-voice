import Joi from 'joi';
import Boom from '@hapi/boom';
import { createWriteStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { config } from '../config/index.js';
import { mossTtsService } from '../services/mossTts.js';
import { tempFileManager } from '../utils/tempFile.js';
import { requestHasValidApiKey } from '../utils/apiKey.js';
import {
  ALLOWED_AUDIO_EXTENSIONS,
  getExtension,
  validateAudioUpload,
} from '../utils/audioValidation.js';

const execFileAsync = promisify(execFile);
const voiceIdSchema = Joi.string().min(1).max(100).pattern(/^[A-Za-z0-9_-]+$/);
const mossConfig = {
  enabled: false,
  defaultVoice: null,
  ...(config.mossTts || {}),
};

const checkEnabled = (request, h) => {
  if (!mossConfig.enabled) {
    throw Boom.notFound('MOSS-TTS-Nano is not enabled. Set MOSS_TTS_ENABLED=1 to enable.');
  }
  return h.continue;
};

const hasCloneAccess = (request) => (
  config.auth.dangerouslyAllowVoiceCloning
  || requestHasValidApiKey(request, config.auth.apiKey)
);

const checkCloneAuthorized = (request, h) => {
  if (hasCloneAccess(request)) return h.continue;
  throw Boom.unauthorized(
    'MOSS reference-voice synthesis requires authentication. Provide a valid API key via X-API-Key or Authorization: Bearer <key>, or set DANGEROUSLY_ALLOW_VOICE_CLONING=1.',
  );
};

const throwMappedError = (error) => {
  if (error.isBoom) throw error;
  const message = error.message || '';
  if (message.includes('not found')) throw Boom.notFound(message);
  if (message.includes('already exists')) throw Boom.conflict(message);
  if (
    message.includes('Invalid voice ID')
    || message.includes('Reference audio')
    || message.includes('Text is required')
  ) {
    throw Boom.badRequest(message);
  }
  if (typeof error.toBoom === 'function') throw error.toBoom();
  throw error;
};

const sendAudio = async ({ h, outputPath, format, voiceId, result }) => {
  const wavBuffer = await readFile(outputPath);
  if (format === 'buffer') {
    return {
      success: true,
      audio: wavBuffer.toString('base64'),
      format: 'wav',
      voice: voiceId,
      model: result.model,
      duration: result.duration,
      sampleRate: result.sampleRate,
      channels: result.channels,
      processingSeconds: result.processingSeconds,
      realTimeFactor: result.realTimeFactor,
    };
  }

  if (format === 'opus') {
    const opusPath = outputPath.replace(/\.wav$/, '.opus');
    await execFileAsync('ffmpeg', [
      '-nostdin', '-y', '-loglevel', 'error',
      '-i', outputPath,
      '-c:a', 'libopus', '-b:a', '64k',
      opusPath,
    ], { timeout: 300000 });
    const opusBuffer = await readFile(opusPath);
    return h.response(opusBuffer)
      .type('audio/opus')
      .header('Content-Disposition', 'attachment; filename="moss-output.opus"');
  }

  return h.response(wavBuffer)
    .type('audio/wav')
    .header('Content-Disposition', 'attachment; filename="moss-output.wav"');
};

export const mossTtsRoutes = [
  {
    method: 'POST',
    path: '/moss-tts',
    options: {
      pre: [{ method: checkEnabled }, { method: checkCloneAuthorized }],
      validate: {
        query: Joi.object({
          format: Joi.string().valid('wav', 'opus', 'buffer'),
        }).unknown(true),
        payload: Joi.object({
          text: Joi.string().trim().min(1).max(10000).required(),
          voice: voiceIdSchema.description('Saved MOSS reference-voice ID'),
          format: Joi.string().valid('wav', 'opus', 'buffer').default('wav'),
        }),
      },
      description: 'Generate multilingual speech with MOSS-TTS-Nano and a saved reference voice',
      tags: ['api', 'moss-tts'],
    },
    handler: async (request, h) => {
      let tempDir = null;
      try {
        const { text, voice: requestedVoice, format: payloadFormat } = request.payload;
        const voiceId = requestedVoice || mossConfig.defaultVoice;
        if (!voiceId) {
          throw Boom.badRequest(
            'A reference voice is required. Create one at POST /moss-tts/voices/clone or set MOSS_TTS_DEFAULT_VOICE.',
          );
        }

        tempDir = await tempFileManager.createTempDir('moss-tts-');
        const outputPath = await tempFileManager.createTempFile(tempDir, 'wav');
        const result = await mossTtsService.generate(text, { voiceId, outputPath });
        return await sendAudio({
          h,
          outputPath,
          format: request.query.format || payloadFormat,
          voiceId,
          result,
        });
      } catch (error) {
        if (!error.isBoom) console.error('MOSS-TTS-Nano generation error:', error);
        throwMappedError(error);
        throw Boom.badImplementation('MOSS-TTS-Nano generation failed');
      } finally {
        if (tempDir) await tempFileManager.cleanup(tempDir);
      }
    },
  },
  {
    method: 'GET',
    path: '/moss-tts/voices',
    options: {
      pre: [{ method: checkEnabled }],
      description: 'List MOSS-TTS-Nano capabilities and saved reference voices',
      tags: ['api', 'moss-tts'],
    },
    handler: async (request) => {
      try {
        const voices = await mossTtsService.listVoices();
        const modelInfo = mossTtsService.getModelInfo();
        const visibleVoices = hasCloneAccess(request) ? voices : [];
        const configuredDefault = mossConfig.defaultVoice;
        return {
          voices: visibleVoices,
          default: visibleVoices.includes(configuredDefault)
            ? configuredDefault
            : (visibleVoices[0] || null),
          model: modelInfo.model,
          features: modelInfo.features,
          streaming: false,
          sampleRate: modelInfo.sampleRate,
          languages: modelInfo.languages,
          referenceAudio: {
            minSeconds: 1,
            maxSeconds: 30,
            recommendedSeconds: '5-10',
          },
        };
      } catch (error) {
        console.error('MOSS-TTS-Nano list voices error:', error);
        throwMappedError(error);
        throw Boom.badImplementation('Failed to list MOSS reference voices');
      }
    },
  },
  {
    method: 'POST',
    path: '/moss-tts/voices/clone',
    options: {
      pre: [{ method: checkEnabled }, { method: checkCloneAuthorized }],
      payload: {
        output: 'stream',
        parse: true,
        multipart: true,
        maxBytes: config.upload.transcribeMaxBytes || config.upload.maxFileSizeBytes,
        allow: 'multipart/form-data',
      },
      validate: {
        payload: Joi.object({
          audio: Joi.any().required().description('A 1-30 second voice reference'),
          voiceId: voiceIdSchema.description('Optional reference-voice name'),
        }),
      },
      description: 'Create a MOSS reference voice from audio',
      tags: ['api', 'moss-tts', 'voice-cloning'],
    },
    handler: async (request) => {
      let tempDir = null;
      try {
        const { audio, voiceId: requestedVoiceId } = request.payload;
        if (!audio?.hapi) throw Boom.badRequest('No reference audio file provided');

        const filename = audio.hapi.filename;
        const extension = getExtension(filename);
        if (!extension || !ALLOWED_AUDIO_EXTENSIONS.includes(extension)) {
          throw Boom.unsupportedMediaType(
            `Unsupported file extension. Allowed: ${ALLOWED_AUDIO_EXTENSIONS.join(', ')}`,
          );
        }

        tempDir = await tempFileManager.createTempDir('moss-voice-');
        const uploadedPath = await tempFileManager.createTempFile(tempDir, extension);
        await pipeline(audio, createWriteStream(uploadedPath));
        const { size } = await stat(uploadedPath);
        if (size === 0) throw Boom.badRequest('Uploaded reference audio is empty');

        const file = await open(uploadedPath, 'r');
        try {
          const headBytes = Buffer.alloc(16);
          await file.read(headBytes, 0, headBytes.length, 0);
          validateAudioUpload({ filename, headBytes });
        } finally {
          await file.close();
        }

        try {
          const probeResult = await execFileAsync('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            uploadedPath,
          ], { timeout: 30000 });
          const stdout = typeof probeResult === 'string'
            ? probeResult
            : probeResult.stdout;
          const duration = Number.parseFloat(stdout);
          if (!Number.isFinite(duration)) {
            throw new Error('ffprobe did not return a duration');
          }
          if (duration < 1 || duration > 30) {
            throw Boom.badRequest(
              `Reference audio must be between 1 and 30 seconds; received ${duration.toFixed(1)} seconds`,
            );
          }
        } catch (error) {
          if (error.isBoom) throw error;
          throw Boom.badRequest(`Reference audio could not be inspected: ${error.stderr || error.message}`);
        }

        const wavPath = await tempFileManager.createTempFile(tempDir, 'wav');
        try {
          await execFileAsync('ffmpeg', [
            '-nostdin', '-y', '-loglevel', 'error',
            '-i', uploadedPath,
            '-vn', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le',
            wavPath,
          ], { timeout: 300000 });
        } catch (error) {
          throw Boom.badRequest(`Reference audio could not be decoded: ${error.stderr || error.message}`);
        }

        const voiceId = requestedVoiceId || `voice_${randomBytes(8).toString('hex')}`;
        const result = await mossTtsService.createVoice(wavPath, voiceId);
        return {
          success: true,
          voiceId: result.voiceId,
          duration: result.duration,
          message: 'MOSS reference voice created successfully',
        };
      } catch (error) {
        if (!error.isBoom) console.error('MOSS reference-voice creation error:', error);
        throwMappedError(error);
        throw Boom.badImplementation('MOSS reference-voice creation failed');
      } finally {
        if (tempDir) await tempFileManager.cleanup(tempDir);
      }
    },
  },
  {
    method: 'DELETE',
    path: '/moss-tts/voices/clone/{voiceId}',
    options: {
      pre: [{ method: checkEnabled }, { method: checkCloneAuthorized }],
      validate: {
        params: Joi.object({ voiceId: voiceIdSchema.required() }),
      },
      description: 'Delete a MOSS reference voice',
      tags: ['api', 'moss-tts', 'voice-cloning'],
    },
    handler: async (request) => {
      try {
        const result = await mossTtsService.deleteVoice(request.params.voiceId);
        return {
          success: true,
          voiceId: result.voiceId,
          message: 'MOSS reference voice deleted successfully',
        };
      } catch (error) {
        console.error('MOSS reference-voice deletion error:', error);
        throwMappedError(error);
        throw Boom.badImplementation('Failed to delete MOSS reference voice');
      }
    },
  },
  {
    method: 'PATCH',
    path: '/moss-tts/voices/clone/{voiceId}',
    options: {
      pre: [{ method: checkEnabled }, { method: checkCloneAuthorized }],
      validate: {
        params: Joi.object({ voiceId: voiceIdSchema.required() }),
        payload: Joi.object({ newVoiceId: voiceIdSchema.required() }),
      },
      description: 'Rename a MOSS reference voice',
      tags: ['api', 'moss-tts', 'voice-cloning'],
    },
    handler: async (request) => {
      try {
        const result = await mossTtsService.renameVoice(
          request.params.voiceId,
          request.payload.newVoiceId,
        );
        return {
          success: true,
          oldVoiceId: result.oldVoiceId,
          voiceId: result.voiceId,
          message: 'MOSS reference voice renamed successfully',
        };
      } catch (error) {
        console.error('MOSS reference-voice rename error:', error);
        throwMappedError(error);
        throw Boom.badImplementation('Failed to rename MOSS reference voice');
      }
    },
  },
];
