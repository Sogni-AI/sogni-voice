import { requestCancellation } from '../utils/requestCancellation.js';
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
import { drama3TtsService } from '../services/drama3Tts.js';
import { tempFileManager } from '../utils/tempFile.js';
import { requestHasValidApiKey } from '../utils/apiKey.js';
import {
  ALLOWED_AUDIO_EXTENSIONS,
  getExtension,
  validateAudioUpload,
} from '../utils/audioValidation.js';

const execFileAsync = promisify(execFile);
const cloneIdSchema = Joi.string().min(1).max(100).pattern(/^[A-Za-z0-9_-]+$/);

const hasCloneAccess = (request) => (
  config.auth.dangerouslyAllowVoiceCloning
  || requestHasValidApiKey(request, config.auth.apiKey)
);

const cloneAuthorization = (label) => (request, h) => {
  if (hasCloneAccess(request)) return h.continue;
  throw Boom.unauthorized(
    `${label} voice cloning requires authentication. Provide a valid API key via X-API-Key or `
    + 'Authorization: Bearer <key>, or set DANGEROUSLY_ALLOW_VOICE_CLONING=1.',
  );
};

const throwMappedError = (error) => {
  if (error.isBoom) throw error;
  const message = error.message || '';
  if (message.includes('not found')) throw Boom.notFound(message);
  if (message.includes('already exists')) throw Boom.conflict(message);
  if (message.includes('transcript') || message.includes('required')) throw Boom.badRequest(message);
  // Drama 3 rejects text it cannot prompt with (structural tokens, speaker tags > 15).
  if (message.startsWith('invalid input:')) throw Boom.badRequest(message);
  if (typeof error.toBoom === 'function') throw error.toBoom();
  throw error;
};

const sendAudio = async ({ signal, h, outputPath, format, result, filename }) => {
  const wavBuffer = await readFile(outputPath, { signal });
  if (format === 'buffer') {
    return {
      success: true,
      audio: wavBuffer.toString('base64'),
      format: 'wav',
      model: result.model,
      duration: result.duration,
      rtf: result.rtf ?? null,
      ...(result.finishReason ? {
        finishReason: result.finishReason,
        complete: result.finishReason === 'stop',
      } : {}),
    };
  }
  if (format === 'opus') {
    const opusPath = outputPath.replace(/\.wav$/, '.opus');
    await execFileAsync('ffmpeg', [
      '-nostdin', '-y', '-loglevel', 'error',
      '-i', outputPath, '-c:a', 'libopus', '-b:a', '64k', opusPath,
    ], { timeout: 300000, signal });
    const opusBuffer = await readFile(opusPath, { signal });
    const response = h.response(opusBuffer)
      .type('audio/opus')
      .header('Content-Disposition', `attachment; filename="${filename}.opus"`);
    if (result.finishReason) response.header('X-Finish-Reason', result.finishReason);
    return response;
  }
  const response = h.response(wavBuffer)
    .type('audio/wav')
    .header('X-RTF', result.rtf == null ? '' : String(result.rtf))
    .header('Content-Disposition', `attachment; filename="${filename}.wav"`);
  if (result.finishReason) response.header('X-Finish-Reason', result.finishReason);
  return response;
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

/**
 * Generate, voice-clone CRUD, voice list and status routes for one Fish engine.
 * Both engines share the clone store (reference clip + transcript).
 */
const createFishTtsRoutes = ({
  basePath, service, engineConfig, label, enableHint, tag, filePrefix, description, status,
}) => {
  const checkEnabled = (request, h) => {
    if (!engineConfig?.enabled) throw Boom.notFound(`${label} TTS is not enabled. ${enableHint}`);
    return h.continue;
  };
  const checkCloneAuthorized = cloneAuthorization(label);

  return [
    {
      method: 'POST',
      path: basePath,
      options: {
        pre: [{ method: checkEnabled }],
        validate: {
          query: Joi.object({ format: Joi.string().valid('wav', 'opus', 'buffer') }).unknown(true),
          payload: Joi.object({
            text: Joi.string().trim().min(1).max(5000).required()
              .description('Text to synthesize, with the engine\'s inline tags'),
            format: Joi.string().valid('wav', 'opus', 'buffer').default('wav'),
            maxTokens: Joi.number().integer().min(8).max(4096),
            temperature: Joi.number().min(0).max(1.5),
          }),
        },
        description,
        tags: ['api', tag],
      },
      handler: async (request, h) => {
        const cancellation = requestCancellation(request);
        const { signal } = cancellation;
        let tempDir = null;
        try {
          const { text, format: payloadFormat, maxTokens, temperature } = request.payload;
          tempDir = await tempFileManager.createTempDir(`${tag}-`);
          const outputPath = await tempFileManager.createTempFile(tempDir, 'wav');
          const result = await service.generate(text, { signal, outputPath, maxTokens, temperature });
          return await sendAudio({
            signal,
            h, outputPath, format: request.query.format || payloadFormat, result,
            filename: `${filePrefix}-output`,
          });
        } catch (error) {
          if (signal.aborted && error.name === 'AbortError') return h.abandon;
          if (!error.isBoom) console.error(`${label} generation error:`, error);
          throwMappedError(error);
          throw Boom.badImplementation(`${label} generation failed`);
        } finally {
          cancellation.dispose();
          if (tempDir) await tempFileManager.cleanup(tempDir);
        }
      },
    },
    {
      method: 'POST',
      path: `${basePath}/voices/clone/{cloneId}/generate`,
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
        description: `Generate speech with a ${label} voice clone (reference + transcript)`,
        tags: ['api', tag, 'voice-cloning'],
      },
      handler: async (request, h) => {
        const cancellation = requestCancellation(request);
        const { signal } = cancellation;
        let tempDir = null;
        try {
          const { cloneId } = request.params;
          const { text, format: payloadFormat, maxTokens, temperature } = request.payload;
          tempDir = await tempFileManager.createTempDir(`${tag}-`);
          const outputPath = await tempFileManager.createTempFile(tempDir, 'wav');
          const result = await service.generateVoiceClone(text, {
            signal,
            cloneId, outputPath, maxTokens, temperature,
          });
          return await sendAudio({
            signal,
            h, outputPath, format: request.query.format || payloadFormat, result,
            filename: `${filePrefix}-${cloneId}`,
          });
        } catch (error) {
          if (signal.aborted && error.name === 'AbortError') return h.abandon;
          if (!error.isBoom) console.error(`${label} clone generation error:`, error);
          throwMappedError(error);
          throw Boom.badImplementation(`${label} clone generation failed`);
        } finally {
          cancellation.dispose();
          if (tempDir) await tempFileManager.cleanup(tempDir);
        }
      },
    },
    {
      method: 'POST',
      path: `${basePath}/voices/clone`,
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
        description: `Create a ${label} voice clone from reference audio + its transcript`,
        tags: ['api', tag, 'voice-cloning'],
      },
      handler: async (request) => {
        let tempDir = null;
        try {
          const { audio, transcript, cloneId: requestedCloneId } = request.payload;
          tempDir = await tempFileManager.createTempDir('fish-voice-');
          const wavPath = await decodeReference(audio, tempDir);
          const cloneId = requestedCloneId || `voice_${randomBytes(8).toString('hex')}`;
          const result = await service.createVoiceClone(wavPath, transcript, cloneId);
          return {
            success: true,
            cloneId: result.cloneId,
            message: `${label} voice clone created successfully`,
          };
        } catch (error) {
          if (!error.isBoom) console.error(`${label} voice clone creation error:`, error);
          throwMappedError(error);
          throw Boom.badImplementation(`${label} voice clone creation failed`);
        } finally {
          if (tempDir) await tempFileManager.cleanup(tempDir);
        }
      },
    },
    {
      method: 'DELETE',
      path: `${basePath}/voices/clone/{cloneId}`,
      options: {
        pre: [{ method: checkEnabled }, { method: checkCloneAuthorized }],
        validate: { params: Joi.object({ cloneId: cloneIdSchema.required() }) },
        description: `Delete a ${label} voice clone`,
        tags: ['api', tag, 'voice-cloning'],
      },
      handler: async (request) => {
        try {
          const result = await service.deleteVoiceClone(request.params.cloneId);
          return { success: true, cloneId: result.cloneId, message: 'Voice clone deleted' };
        } catch (error) {
          if (!error.isBoom) console.error(`${label} voice clone deletion error:`, error);
          throwMappedError(error);
          throw Boom.badImplementation(`Failed to delete ${label} voice clone`);
        }
      },
    },
    {
      method: 'PATCH',
      path: `${basePath}/voices/clone/{cloneId}`,
      options: {
        pre: [{ method: checkEnabled }, { method: checkCloneAuthorized }],
        validate: {
          params: Joi.object({ cloneId: cloneIdSchema.required() }),
          payload: Joi.object({ newCloneId: cloneIdSchema.required() }),
        },
        description: `Rename a ${label} voice clone`,
        tags: ['api', tag, 'voice-cloning'],
      },
      handler: async (request) => {
        try {
          const result = await service.renameVoiceClone(
            request.params.cloneId, request.payload.newCloneId,
          );
          return {
            success: true,
            oldCloneId: result.oldCloneId,
            cloneId: result.newCloneId,
            message: 'Voice clone renamed',
          };
        } catch (error) {
          if (!error.isBoom) console.error(`${label} voice clone rename error:`, error);
          throwMappedError(error);
          throw Boom.badImplementation(`Failed to rename ${label} voice clone`);
        }
      },
    },
    {
      method: 'GET',
      path: `${basePath}/voices`,
      options: {
        pre: [{ method: checkEnabled }],
        description: `List ${label} voices and saved voice clones`,
        tags: ['api', tag],
      },
      handler: async (request) => {
        try {
          const { voices, clones } = await service.listVoiceClones();
          return {
            voices,
            clones: hasCloneAccess(request) ? clones : [],
            model: service.getModelInfo().model,
            features: service.getModelInfo().features,
            referenceAudio: { minSeconds: 1, maxSeconds: 30, recommendedSeconds: '5-15' },
          };
        } catch (error) {
          if (!error.isBoom) console.error(`${label} list voices error:`, error);
          throwMappedError(error);
          throw Boom.badImplementation(`Failed to list ${label} voices`);
        }
      },
    },
    {
      method: 'GET',
      path: `${basePath}/status`,
      options: {
        pre: [{ method: checkEnabled }],
        description: `${label} capabilities and daemon state`,
        tags: ['api', tag],
      },
      handler: async () => {
        const modelInfo = service.getModelInfo();
        return {
          model: modelInfo.model,
          backend: modelInfo.backend,
          voices: modelInfo.voices,
          sampleRate: modelInfo.sampleRate,
          streaming: false,
          ready: service.isReady(),
          features: modelInfo.features,
          ...(typeof status === 'function' ? status(modelInfo) : status),
        };
      },
    },
  ];
};

export const fishTtsRoutes = createFishTtsRoutes({
  basePath: '/fish-tts',
  service: fishTtsService,
  engineConfig: config.fishTts,
  label: 'Fish S2',
  enableHint: 'Set FISH_TTS_ENABLED=1 to enable.',
  tag: 'fish-tts',
  filePrefix: 'fish-s2',
  description: 'Generate expressive speech with Fish Audio S2 Pro (8-bit MLX). '
    + 'Emotion/style is expressed inline via [bracket] tags and (paralanguage) cues.',
  status: {
    note: 'Expressive control via inline [emotion] tags and (paralanguage) cues; '
      + 'zero-shot voice cloning from a reference clip + transcript. '
      + 'Runs slower than realtime on Apple Silicon. '
      + 'Non-commercial (Fish Audio Research License) — evaluation only.',
    emotionTags: ['[happy]', '[sad]', '[angry]', '[excited]', '[whispers]', '[shouting]', '[laughing]'],
    paralanguageCues: ['(laugh)', '(break)', '(breath)', '(sigh)', '(cough)'],
  },
});

export const drama3TtsRoutes = createFishTtsRoutes({
  basePath: '/drama3-tts',
  service: drama3TtsService,
  engineConfig: config.drama3Tts,
  label: 'Fish Drama 3',
  enableHint: 'Set DRAMA3_TTS_ENABLED=1 to enable.',
  tag: 'drama3-tts',
  filePrefix: 'fish-drama3',
  description: 'Generate speech with Fish Audio Drama 3 (MLX port). Direct the delivery with '
    + 'plain-language [bracket] directions; <|speaker:N|> tags voice up to 16 characters.',
  status: (modelInfo) => modelInfo.backend === 'fish-drama3-tensorfold' ? {
    note: 'NVFP4 pruned Drama 3 through TensorFold. Inline directions and reference voice cloning; '
      + 'only speaker 0. Sampling is fixed at temperature 1.0, top-p 0.9, top-k 30. '
      + 'Per-request maxTokens is unsupported; the frame cap is configured on the server. '
      + 'Fish Audio Community License: no hosted service; commercial use only under USD 500k annual revenue.',
    directionExamples: ['[sighs]', '[laughs]', '[warmly]'],
    speakerTags: '<|speaker:0|>',
    sampling: { temperature: 1.0, topP: 0.9, topK: 30, configurable: false },
    perRequestMaxTokens: false,
  } : {
    note: 'Plain-language [direction] tags before or inside a line, paired tags such as '
      + '<whisper>…</whisper>, and <|speaker:0|>…<|speaker:15|> for multi-character scenes; '
      + 'zero-shot voice cloning from a reference clip + transcript (shared with Fish S2). '
      + 'Fish Audio Community License: no hosted service; commercial use only under '
      + 'USD 500k annual revenue.',
    directionExamples: ['[nervous, barely holding it together]', '[sighs]', '[laughs]', '<whisper>…</whisper>'],
    speakerTags: '<|speaker:0|> … <|speaker:15|>',
  },
});
