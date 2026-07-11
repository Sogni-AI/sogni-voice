import Joi from 'joi';
import Boom from '@hapi/boom';
import { createWriteStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { config } from '../config/index.js';
import { fishTtsService } from '../services/fishTts.js';
import { tempFileManager } from '../utils/tempFile.js';
import { requestHasValidApiKey } from '../utils/apiKey.js';
import {
  ALLOWED_AUDIO_EXTENSIONS,
  getExtension,
  validateAudioUpload,
} from '../utils/audioValidation.js';

const execFileAsync = promisify(execFile);
const cloneIdSchema = Joi.string().min(1).max(100).pattern(/^[A-Za-z0-9_-]+$/);

const fishConfig = {
  enabled: false,
  ...(config.fishTts || {}),
};

const checkEnabled = (request, h) => {
  if (!fishConfig.enabled) {
    throw Boom.notFound('Fish S2 TTS is not enabled. Set FISH_TTS_ENABLED=1 to enable.');
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
    'Fish S2 voice cloning requires authentication. Provide a valid API key via X-API-Key or '
    + 'Authorization: Bearer <key>, or set DANGEROUSLY_ALLOW_VOICE_CLONING=1.',
  );
};

const throwMappedError = (error) => {
  if (error.isBoom) throw error;
  const message = error.message || '';
  if (message.includes('not found')) throw Boom.notFound(message);
  if (message.includes('already exists')) throw Boom.conflict(message);
  if (message.includes('transcript') || message.includes('required')) throw Boom.badRequest(message);
  if (typeof error.toBoom === 'function') throw error.toBoom();
  throw error;
};

const sendAudio = async ({ h, outputPath, format, result, filename = 'fish-s2-output' }) => {
  const wavBuffer = await readFile(outputPath);
  if (format === 'buffer') {
    return {
      success: true,
      audio: wavBuffer.toString('base64'),
      format: 'wav',
      model: result.model,
      duration: result.duration,
      rtf: result.rtf ?? null,
    };
  }
  if (format === 'opus') {
    const opusPath = outputPath.replace(/\.wav$/, '.opus');
    await execFileAsync('ffmpeg', [
      '-nostdin', '-y', '-loglevel', 'error',
      '-i', outputPath, '-c:a', 'libopus', '-b:a', '64k', opusPath,
    ], { timeout: 300000 });
    const opusBuffer = await readFile(opusPath);
    return h.response(opusBuffer)
      .type('audio/opus')
      .header('Content-Disposition', `attachment; filename="${filename}.opus"`);
  }
  return h.response(wavBuffer)
    .type('audio/wav')
    .header('X-RTF', result.rtf == null ? '' : String(result.rtf))
    .header('Content-Disposition', `attachment; filename="${filename}.wav"`);
};

// Decode any uploaded reference clip to 44.1 kHz mono 16-bit WAV (the Fish
// codec's native rate) and enforce a 1-30s duration bound.
const decodeReference = async (audio, tempDir) => {
  if (!audio?.hapi) throw Boom.badRequest('No reference audio file provided');
  const filename = audio.hapi.filename;
  const extension = getExtension(filename);
  if (!extension || !ALLOWED_AUDIO_EXTENSIONS.includes(extension)) {
    throw Boom.unsupportedMediaType(
      `Unsupported file extension. Allowed: ${ALLOWED_AUDIO_EXTENSIONS.join(', ')}`,
    );
  }

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
    const probe = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', uploadedPath,
    ], { timeout: 30000 });
    const duration = Number.parseFloat(typeof probe === 'string' ? probe : probe.stdout);
    if (!Number.isFinite(duration)) throw new Error('ffprobe did not return a duration');
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
      '-i', uploadedPath, '-vn', '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', wavPath,
    ], { timeout: 300000 });
  } catch (error) {
    throw Boom.badRequest(`Reference audio could not be decoded: ${error.stderr || error.message}`);
  }
  return wavPath;
};

export const fishTtsRoutes = [
  {
    method: 'POST',
    path: '/fish-tts',
    options: {
      pre: [{ method: checkEnabled }],
      validate: {
        query: Joi.object({ format: Joi.string().valid('wav', 'opus', 'buffer') }).unknown(true),
        payload: Joi.object({
          text: Joi.string().trim().min(1).max(5000).required()
            .description('Text to synthesize; supports inline [emotion] tags and (paralanguage) cues'),
          format: Joi.string().valid('wav', 'opus', 'buffer').default('wav'),
          maxTokens: Joi.number().integer().min(8).max(4096),
          temperature: Joi.number().min(0).max(1.5),
        }),
      },
      description: 'Generate expressive speech with Fish Audio S2 Pro (8-bit MLX). '
        + 'Emotion/style is expressed inline via [bracket] tags and (paralanguage) cues.',
      tags: ['api', 'fish-tts'],
    },
    handler: async (request, h) => {
      let tempDir = null;
      try {
        const { text, format: payloadFormat, maxTokens, temperature } = request.payload;
        tempDir = await tempFileManager.createTempDir('fish-tts-');
        const outputPath = await tempFileManager.createTempFile(tempDir, 'wav');
        const result = await fishTtsService.generate(text, { outputPath, maxTokens, temperature });
        return await sendAudio({ h, outputPath, format: request.query.format || payloadFormat, result });
      } catch (error) {
        if (!error.isBoom) console.error('Fish S2 generation error:', error);
        throwMappedError(error);
        throw Boom.badImplementation('Fish S2 generation failed');
      } finally {
        if (tempDir) await tempFileManager.cleanup(tempDir);
      }
    },
  },
  {
    method: 'POST',
    path: '/fish-tts/voices/clone/{cloneId}/generate',
    options: {
      pre: [{ method: checkEnabled }, { method: checkCloneAuthorized }],
      validate: {
        params: Joi.object({ cloneId: cloneIdSchema.required() }),
        query: Joi.object({ format: Joi.string().valid('wav', 'opus', 'buffer') }).unknown(true),
        payload: Joi.object({
          text: Joi.string().trim().min(1).max(5000).required(),
          format: Joi.string().valid('wav', 'opus', 'buffer').default('wav'),
          maxTokens: Joi.number().integer().min(8).max(4096),
          temperature: Joi.number().min(0).max(1.5),
        }),
      },
      description: 'Generate speech with a Fish S2 voice clone (reference + transcript)',
      tags: ['api', 'fish-tts', 'voice-cloning'],
    },
    handler: async (request, h) => {
      let tempDir = null;
      try {
        const { cloneId } = request.params;
        const { text, format: payloadFormat, maxTokens, temperature } = request.payload;
        tempDir = await tempFileManager.createTempDir('fish-tts-');
        const outputPath = await tempFileManager.createTempFile(tempDir, 'wav');
        const result = await fishTtsService.generateVoiceClone(text, {
          cloneId, outputPath, maxTokens, temperature,
        });
        return await sendAudio({
          h, outputPath, format: request.query.format || payloadFormat, result,
          filename: `fish-s2-${cloneId}`,
        });
      } catch (error) {
        if (!error.isBoom) console.error('Fish S2 clone generation error:', error);
        throwMappedError(error);
        throw Boom.badImplementation('Fish S2 clone generation failed');
      } finally {
        if (tempDir) await tempFileManager.cleanup(tempDir);
      }
    },
  },
  {
    method: 'POST',
    path: '/fish-tts/voices/clone',
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
          transcript: Joi.string().trim().min(1).max(2000).required()
            .description('Text spoken in the reference audio'),
          cloneId: cloneIdSchema.description('Optional reference-voice name'),
        }),
      },
      description: 'Create a Fish S2 voice clone from reference audio + its transcript',
      tags: ['api', 'fish-tts', 'voice-cloning'],
    },
    handler: async (request) => {
      let tempDir = null;
      try {
        const { audio, transcript, cloneId: requestedCloneId } = request.payload;
        tempDir = await tempFileManager.createTempDir('fish-voice-');
        const wavPath = await decodeReference(audio, tempDir);
        const cloneId = requestedCloneId || `voice_${randomBytes(8).toString('hex')}`;
        const result = await fishTtsService.createVoiceClone(wavPath, transcript, cloneId);
        return {
          success: true,
          cloneId: result.cloneId,
          message: 'Fish S2 voice clone created successfully',
        };
      } catch (error) {
        if (!error.isBoom) console.error('Fish S2 voice clone creation error:', error);
        throwMappedError(error);
        throw Boom.badImplementation('Fish S2 voice clone creation failed');
      } finally {
        if (tempDir) await tempFileManager.cleanup(tempDir);
      }
    },
  },
  {
    method: 'DELETE',
    path: '/fish-tts/voices/clone/{cloneId}',
    options: {
      pre: [{ method: checkEnabled }, { method: checkCloneAuthorized }],
      validate: { params: Joi.object({ cloneId: cloneIdSchema.required() }) },
      description: 'Delete a Fish S2 voice clone',
      tags: ['api', 'fish-tts', 'voice-cloning'],
    },
    handler: async (request) => {
      try {
        const result = await fishTtsService.deleteVoiceClone(request.params.cloneId);
        return { success: true, cloneId: result.cloneId, message: 'Voice clone deleted' };
      } catch (error) {
        if (!error.isBoom) console.error('Fish S2 voice clone deletion error:', error);
        throwMappedError(error);
        throw Boom.badImplementation('Failed to delete Fish S2 voice clone');
      }
    },
  },
  {
    method: 'PATCH',
    path: '/fish-tts/voices/clone/{cloneId}',
    options: {
      pre: [{ method: checkEnabled }, { method: checkCloneAuthorized }],
      validate: {
        params: Joi.object({ cloneId: cloneIdSchema.required() }),
        payload: Joi.object({ newCloneId: cloneIdSchema.required() }),
      },
      description: 'Rename a Fish S2 voice clone',
      tags: ['api', 'fish-tts', 'voice-cloning'],
    },
    handler: async (request) => {
      try {
        const result = await fishTtsService.renameVoiceClone(
          request.params.cloneId, request.payload.newCloneId,
        );
        return {
          success: true,
          oldCloneId: result.oldCloneId,
          cloneId: result.newCloneId,
          message: 'Voice clone renamed',
        };
      } catch (error) {
        if (!error.isBoom) console.error('Fish S2 voice clone rename error:', error);
        throwMappedError(error);
        throw Boom.badImplementation('Failed to rename Fish S2 voice clone');
      }
    },
  },
  {
    method: 'GET',
    path: '/fish-tts/voices',
    options: {
      pre: [{ method: checkEnabled }],
      description: 'List Fish S2 voices and saved voice clones',
      tags: ['api', 'fish-tts'],
    },
    handler: async (request) => {
      try {
        const { voices, clones } = await fishTtsService.listVoiceClones();
        return {
          voices,
          clones: hasCloneAccess(request) ? clones : [],
          model: fishTtsService.getModelInfo().model,
          referenceAudio: { minSeconds: 1, maxSeconds: 30, recommendedSeconds: '5-15' },
        };
      } catch (error) {
        if (!error.isBoom) console.error('Fish S2 list voices error:', error);
        throwMappedError(error);
        throw Boom.badImplementation('Failed to list Fish S2 voices');
      }
    },
  },
  {
    method: 'GET',
    path: '/fish-tts/status',
    options: {
      pre: [{ method: checkEnabled }],
      description: 'Fish S2 Pro capabilities and daemon state',
      tags: ['api', 'fish-tts'],
    },
    handler: async () => {
      const modelInfo = fishTtsService.getModelInfo();
      return {
        model: modelInfo.model,
        backend: modelInfo.backend,
        voices: modelInfo.voices,
        sampleRate: modelInfo.sampleRate,
        streaming: false,
        ready: fishTtsService.isReady(),
        features: modelInfo.features,
        note: 'Expressive control via inline [emotion] tags and (paralanguage) cues; '
          + 'zero-shot voice cloning from a reference clip + transcript. '
          + 'Runs slower than realtime on Apple Silicon. '
          + 'Non-commercial (Fish Audio Research License) — evaluation only.',
        emotionTags: ['[happy]', '[sad]', '[angry]', '[excited]', '[whispers]', '[shouting]', '[laughing]'],
        paralanguageCues: ['(laugh)', '(break)', '(breath)', '(sigh)', '(cough)'],
      };
    },
  },
];
