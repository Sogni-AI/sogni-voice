import Joi from 'joi';
import Boom from '@hapi/boom';
import { readFile, unlink, mkdir, writeFile, readdir, stat, lstat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { join, basename } from 'node:path';
import { config } from '../config/index.js';
import { qwenTtsBaseService, qwenTtsCustomVoiceService } from '../services/qwenTts.js';
import { tempFileManager } from '../utils/tempFile.js';
import { requestHasValidApiKey } from '../utils/apiKey.js';

const execFileAsync = promisify(execFile);
const OPTIONAL_QWEN_STATUS_TIMEOUT_MS = 5000;

// Helper to check if Qwen TTS is enabled
const checkEnabled = (request, h) => {
  if (!config.qwenTts.enabled) {
    throw Boom.notFound('Qwen TTS is not enabled. Set QWEN_TTS_ENABLED=1 to enable.');
  }
  return h.continue;
};

const hasCloneAccess = (request) => (
  config.auth.dangerouslyAllowVoiceCloning
  || requestHasValidApiKey(request, config.auth.apiKey)
);

const checkCloneAuthorized = (request, h) => {
  if (hasCloneAccess(request)) {
    return h.continue;
  }

  throw Boom.unauthorized(
    'Voice cloning requires authentication. Provide a valid API key via X-API-Key header or Authorization: Bearer <key>, or set DANGEROUSLY_ALLOW_VOICE_CLONING=1.'
  );
};

// Helper to check if voice clone imports are authorized.
// Requires either DANGEROUSLY_ALLOW_IMPORTS=1 or a valid API key.
const checkImportAuthorized = (request, h) => {
  if (config.auth.dangerouslyAllowImports) {
    return h.continue;
  }

  if (!config.auth.apiKey) {
    throw Boom.forbidden(
      'Voice clone import is disabled on this server. Set AUTH_API_KEY to allow authenticated imports or DANGEROUSLY_ALLOW_IMPORTS=1 to allow unauthenticated imports.'
    );
  }

  if (!requestHasValidApiKey(request, config.auth.apiKey)) {
    throw Boom.unauthorized(
      'Voice clone import requires a valid API key. Provide X-API-Key or Authorization: Bearer <key>, or set DANGEROUSLY_ALLOW_IMPORTS=1.'
    );
  }

  return h.continue;
};

const assertRegularArchiveFile = async (filePath, label) => {
  const stats = await lstat(filePath);

  if (stats.isSymbolicLink()) {
    throw Boom.badRequest(`Invalid ZIP file: ${label} cannot be a symbolic link`);
  }

  if (!stats.isFile()) {
    throw Boom.badRequest(`Invalid ZIP file: ${label} must be a regular file`);
  }
};

const initializeQwenService = async (name, service, options = {}) => {
  const { timeoutMs = 0 } = options;

  if (service.isReady?.()) {
    return {
      name,
      ready: true,
      info: service.getModelInfo(),
    };
  }

  const initializePromise = service.initialize()
    .then(() => ({
      name,
      ready: true,
      info: service.getModelInfo(),
    }))
    .catch((error) => {
      console.error(`Qwen TTS ${name} daemon unavailable:`, error);
      return {
        name,
        ready: false,
        info: service.getModelInfo(),
        error,
      };
    });

  if (!timeoutMs) {
    return initializePromise;
  }

  let timeoutId;
  try {
    return await Promise.race([
      initializePromise,
      new Promise((resolve) => {
        timeoutId = setTimeout(() => {
          resolve({
            name,
            ready: false,
            info: service.getModelInfo(),
            error: new Error(`${name} daemon initialization is still in progress`),
          });
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

const getErrorMessage = (error) => error?.message || String(error);

export const qwenTtsRoutes = [
  // Standard TTS generation
  {
    method: 'POST',
    path: '/qwen-tts',
    options: {
      pre: [{ method: checkEnabled }],
      validate: {
        query: Joi.object({
          format: Joi.string().valid('wav', 'opus', 'buffer')
            .description('Output format override via query string'),
        }).unknown(true),
        payload: Joi.object({
          text: Joi.string().required().min(1).max(10000)
            .description('Text to convert to speech'),
          voice: Joi.string().default(config.qwenTts.defaultVoice)
            .description('Voice to use for synthesis'),
          language: Joi.string().default(config.qwenTts.defaultLanguage)
            .description('Language for synthesis'),
          format: Joi.string().valid('wav', 'opus', 'buffer').default('wav')
            .description('Output format (wav, opus, or buffer for base64 wav)'),
        }),
      },
      description: 'Convert text to speech using Qwen3-TTS',
      tags: ['api', 'qwen-tts'],
    },
    handler: async (request, h) => {
      const startTime = performance.now();
      let tempDir = null;

      try {
        const { text, voice, language, format: payloadFormat } = request.payload;
        const format = request.query.format || payloadFormat;

        tempDir = await tempFileManager.createTempDir('qwen-tts-');
        const outputPath = await tempFileManager.createTempFile(tempDir, 'wav');

        const result = await qwenTtsCustomVoiceService.generateCustomVoice(text, {
          speaker: voice,
          outputPath,
        });

        const wavBuffer = await readFile(outputPath);

        if (format === 'buffer') {
          const durationMs = performance.now() - startTime;
          console.log(`Qwen TTS request completed in ${(durationMs / 1000).toFixed(3)}s`);
          return {
            success: true,
            audio: wavBuffer.toString('base64'),
            voice,
            language,
            format: 'wav',
            duration: result.duration,
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
          ], { timeout: 300000 });

          const opusBuffer = await readFile(opusPath);
          const durationMs = performance.now() - startTime;
          console.log(`Qwen TTS request completed in ${(durationMs / 1000).toFixed(3)}s`);
          return h.response(opusBuffer)
            .type('audio/opus')
            .header('Content-Disposition', 'attachment; filename="output.opus"');
        }

        const durationMs = performance.now() - startTime;
        console.log(`Qwen TTS request completed in ${(durationMs / 1000).toFixed(3)}s`);
        return h.response(wavBuffer)
          .type('audio/wav')
          .header('Content-Disposition', 'attachment; filename="output.wav"');
      } catch (error) {
        if (error.isBoom) throw error;
        console.error('Qwen TTS error:', error);
        throw Boom.badImplementation('Qwen TTS generation failed');
      } finally {
        if (tempDir) {
          await tempFileManager.cleanup(tempDir);
        }
      }
    },
  },

  // Custom voice generation (emotion/style control)
  {
    method: 'POST',
    path: '/qwen-tts/custom-voice',
    options: {
      pre: [{ method: checkEnabled }],
      validate: {
        query: Joi.object({
          format: Joi.string().valid('wav', 'opus', 'buffer')
            .description('Output format override via query string'),
        }).unknown(true),
        payload: Joi.object({
          text: Joi.string().required().min(1).max(10000)
            .description('Text to convert to speech'),
          speaker: Joi.string().default(config.qwenTts.defaultVoice)
            .description('Speaker voice to use'),
          instruct: Joi.string().required().min(1).max(500)
            .description('Emotion/style instruction (e.g., "Very happy and excited")'),
          format: Joi.string().valid('wav', 'opus', 'buffer').default('wav')
            .description('Output format'),
        }),
      },
      description: 'Generate speech with emotion/style control (requires CustomVoice model)',
      tags: ['api', 'qwen-tts'],
    },
    handler: async (request, h) => {
      const startTime = performance.now();
      let tempDir = null;

      try {
        const { text, speaker, instruct, format: payloadFormat } = request.payload;
        const format = request.query.format || payloadFormat;

        // Use the CustomVoice daemon for style instructions
        await qwenTtsCustomVoiceService.initialize();

        if (!qwenTtsCustomVoiceService.supportsFeature('custom_voice')) {
          throw Boom.badRequest('custom_voice feature requires the CustomVoice model variant');
        }

        tempDir = await tempFileManager.createTempDir('qwen-tts-');
        const outputPath = await tempFileManager.createTempFile(tempDir, 'wav');

        const result = await qwenTtsCustomVoiceService.generateCustomVoice(text, { speaker, instruct, outputPath });

        const wavBuffer = await readFile(outputPath);

        if (format === 'buffer') {
          const durationMs = performance.now() - startTime;
          console.log(`Qwen TTS custom-voice request completed in ${(durationMs / 1000).toFixed(3)}s`);
          return {
            success: true,
            audio: wavBuffer.toString('base64'),
            speaker,
            instruct,
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
          console.log(`Qwen TTS custom-voice request completed in ${(durationMs / 1000).toFixed(3)}s`);
          return h.response(opusBuffer)
            .type('audio/opus')
            .header('Content-Disposition', 'attachment; filename="output.opus"');
        }

        const durationMs = performance.now() - startTime;
        console.log(`Qwen TTS custom-voice request completed in ${(durationMs / 1000).toFixed(3)}s`);
        return h.response(wavBuffer)
          .type('audio/wav')
          .header('Content-Disposition', 'attachment; filename="output.wav"');
      } catch (error) {
        if (error.isBoom) throw error;
        console.error('Qwen TTS custom-voice error:', error);
        throw Boom.badImplementation('Qwen TTS custom-voice generation failed');
      } finally {
        if (tempDir) {
          await tempFileManager.cleanup(tempDir);
        }
      }
    },
  },

  // Voice design generation (create voice from description)
  {
    method: 'POST',
    path: '/qwen-tts/voice-design',
    options: {
      pre: [{ method: checkEnabled }],
      validate: {
        query: Joi.object({
          format: Joi.string().valid('wav', 'opus', 'buffer')
            .description('Output format override via query string'),
        }).unknown(true),
        payload: Joi.object({
          text: Joi.string().required().min(1).max(10000)
            .description('Text to convert to speech'),
          instruct: Joi.string().required().min(1).max(500)
            .description('Voice description (e.g., "A deep male voice with calm tone")'),
          format: Joi.string().valid('wav', 'opus', 'buffer').default('wav')
            .description('Output format'),
        }),
      },
      description: 'Generate speech with a designed voice (requires VoiceDesign model)',
      tags: ['api', 'qwen-tts'],
    },
    handler: async (request, h) => {
      const startTime = performance.now();
      let tempDir = null;

      try {
        const { text, instruct, format: payloadFormat } = request.payload;
        const format = request.query.format || payloadFormat;

        // VoiceDesign requires a specific model variant (not Base or CustomVoice)
        await qwenTtsBaseService.initialize();

        if (!qwenTtsBaseService.supportsFeature('voice_design')) {
          throw Boom.badRequest('voice_design feature requires the VoiceDesign model variant');
        }

        tempDir = await tempFileManager.createTempDir('qwen-tts-');
        const outputPath = await tempFileManager.createTempFile(tempDir, 'wav');

        const result = await qwenTtsBaseService.generateVoiceDesign(text, { instruct, outputPath });

        const wavBuffer = await readFile(outputPath);

        if (format === 'buffer') {
          const durationMs = performance.now() - startTime;
          console.log(`Qwen TTS voice-design request completed in ${(durationMs / 1000).toFixed(3)}s`);
          return {
            success: true,
            audio: wavBuffer.toString('base64'),
            instruct,
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
          console.log(`Qwen TTS voice-design request completed in ${(durationMs / 1000).toFixed(3)}s`);
          return h.response(opusBuffer)
            .type('audio/opus')
            .header('Content-Disposition', 'attachment; filename="output.opus"');
        }

        const durationMs = performance.now() - startTime;
        console.log(`Qwen TTS voice-design request completed in ${(durationMs / 1000).toFixed(3)}s`);
        return h.response(wavBuffer)
          .type('audio/wav')
          .header('Content-Disposition', 'attachment; filename="output.wav"');
      } catch (error) {
        if (error.isBoom) throw error;
        console.error('Qwen TTS voice-design error:', error);
        throw Boom.badImplementation('Qwen TTS voice-design generation failed');
      } finally {
        if (tempDir) {
          await tempFileManager.cleanup(tempDir);
        }
      }
    },
  },

  // Create voice clone
  {
    method: 'POST',
    path: '/qwen-tts/voices/clone',
    options: {
      pre: [{ method: checkEnabled }, { method: checkCloneAuthorized }],
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
            .description('Reference audio file (3-10 seconds, WAV/MP3/OGG)'),
          transcript: Joi.string().required().min(1).max(1000)
            .description('Text spoken in the reference audio'),
          cloneId: Joi.string().min(1).max(100).pattern(/^[a-zA-Z0-9_-]+$/)
            .description('Optional custom name for the voice clone (alphanumeric, underscore, hyphen only)'),
        }),
      },
      description: 'Create a voice clone from reference audio (requires Base model)',
      tags: ['api', 'qwen-tts'],
    },
    handler: async (request, h) => {
      let tempDir = null;

      try {
        const { audio, transcript, cloneId: userCloneId } = request.payload;

        // Use the Base daemon for voice cloning
        await qwenTtsBaseService.initialize();

        if (!qwenTtsBaseService.supportsFeature('voice_cloning')) {
          throw Boom.badRequest('voice_cloning feature requires a Base model variant');
        }

        // Use user-provided cloneId or generate a unique one
        const cloneId = userCloneId || `clone_${randomBytes(8).toString('hex')}`;

        // Save uploaded audio to temp file (preserve original format)
        tempDir = await tempFileManager.createTempDir('qwen-clone-');
        const uploadedPath = await tempFileManager.createTempFile(tempDir, 'audio');

        // Stream the audio directly to file
        await pipeline(audio, createWriteStream(uploadedPath));

        // Convert to WAV format (24kHz mono) for consistent processing
        const wavPath = await tempFileManager.createTempFile(tempDir, 'wav');
        console.log(`Converting audio to WAV: ${uploadedPath} -> ${wavPath}`);

        await execFileAsync('ffmpeg', [
          '-i', uploadedPath,
          '-ar', '24000',    // 24kHz sample rate (Qwen TTS native rate)
          '-ac', '1',        // Mono
          '-c:a', 'pcm_s16le', // 16-bit PCM
          '-y',              // Overwrite output
          wavPath,
        ], { timeout: 300000 });

        console.log('Audio conversion completed');

        // Create the voice clone using the converted WAV
        const result = await qwenTtsBaseService.createVoiceClone(wavPath, transcript, cloneId);

        return {
          success: true,
          cloneId: result.cloneId,
          message: 'Voice clone created successfully',
        };
      } catch (error) {
        if (error.isBoom) throw error;
        console.error('Qwen TTS voice clone error:', error);
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
    path: '/qwen-tts/voices/clone/{cloneId}/generate',
    options: {
      pre: [{ method: checkEnabled }, { method: checkCloneAuthorized }],
      validate: {
        params: Joi.object({
          cloneId: Joi.string().required().pattern(/^[a-zA-Z0-9_-]+$/)
            .description('Voice clone ID'),
        }),
        payload: Joi.object({
          text: Joi.string().required().min(1).max(10000)
            .description('Text to convert to speech'),
          language: Joi.string().default(config.qwenTts.defaultLanguage)
            .description('Language for synthesis'),
          format: Joi.string().valid('wav', 'opus', 'buffer').default('wav')
            .description('Output format'),
        }),
      },
      description: 'Generate speech using a cloned voice',
      tags: ['api', 'qwen-tts'],
    },
    handler: async (request, h) => {
      const startTime = performance.now();
      let tempDir = null;

      try {
        const { cloneId } = request.params;
        const { text, language, format } = request.payload;

        // Use the Base daemon for voice clone generation
        await qwenTtsBaseService.initialize();

        if (!qwenTtsBaseService.supportsFeature('voice_cloning')) {
          throw Boom.badRequest('voice_cloning feature requires a Base model variant');
        }

        tempDir = await tempFileManager.createTempDir('qwen-tts-');
        const outputPath = await tempFileManager.createTempFile(tempDir, 'wav');

        const result = await qwenTtsBaseService.generateVoiceClone(text, { cloneId, language, outputPath });

        const wavBuffer = await readFile(outputPath);

        if (format === 'buffer') {
          const durationMs = performance.now() - startTime;
          console.log(`Qwen TTS clone generation completed in ${(durationMs / 1000).toFixed(3)}s`);
          return {
            success: true,
            audio: wavBuffer.toString('base64'),
            cloneId,
            language,
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
          console.log(`Qwen TTS clone generation completed in ${(durationMs / 1000).toFixed(3)}s`);
          return h.response(opusBuffer)
            .type('audio/opus')
            .header('Content-Disposition', 'attachment; filename="output.opus"');
        }

        const durationMs = performance.now() - startTime;
        console.log(`Qwen TTS clone generation completed in ${(durationMs / 1000).toFixed(3)}s`);
        return h.response(wavBuffer)
          .type('audio/wav')
          .header('Content-Disposition', 'attachment; filename="output.wav"');
      } catch (error) {
        if (error.isBoom) throw error;
        if (error.message?.includes('not found')) {
          throw Boom.notFound(`Voice clone '${request.params.cloneId}' not found`);
        }
        console.error('Qwen TTS clone generation error:', error);
        throw Boom.badImplementation('Voice clone generation failed');
      } finally {
        if (tempDir) {
          await tempFileManager.cleanup(tempDir);
        }
      }
    },
  },

  // List voices and clones
  {
    method: 'GET',
    path: '/qwen-tts/voices',
    options: {
      pre: [{ method: checkEnabled }],
      description: 'List available Qwen TTS voices, clones, and capabilities',
      tags: ['api', 'qwen-tts'],
    },
    handler: async (request, h) => {
      try {
        const [baseStatus, customVoiceStatus] = await Promise.all([
          initializeQwenService('Base', qwenTtsBaseService),
          initializeQwenService('CustomVoice', qwenTtsCustomVoiceService, {
            timeoutMs: OPTIONAL_QWEN_STATUS_TIMEOUT_MS,
          }),
        ]);

        const readyStatuses = [baseStatus, customVoiceStatus].filter((status) => status.ready);
        if (readyStatuses.length === 0) {
          throw Boom.serverUnavailable('Qwen TTS is enabled, but no Qwen daemons are available');
        }

        const baseInfo = baseStatus.info;
        const customVoiceInfo = customVoiceStatus.info;

        const voices = customVoiceStatus.ready
          ? (
              customVoiceInfo.voices.length > 0
                ? customVoiceInfo.voices
                : qwenTtsCustomVoiceService.listVoices()
            )
          : baseInfo.voices;

        let clonesResult = { clones: [] };
        if (baseStatus.ready && hasCloneAccess(request)) {
          try {
            clonesResult = await qwenTtsBaseService.listVoiceClones();
          } catch (error) {
            console.error('Qwen TTS list voice clones error:', error);
          }
        }

        const allFeatures = [...new Set([
          ...readyStatuses.flatMap((status) => status.info.features || []),
        ])];
        const unavailableDaemons = [baseStatus, customVoiceStatus]
          .filter((status) => !status.ready)
          .map((status) => ({
            name: status.name,
            error: getErrorMessage(status.error),
          }));

        return {
          voices,
          clones: clonesResult.clones,
          default: config.qwenTts.defaultVoice,
          defaultLanguage: config.qwenTts.defaultLanguage,
          modelVariants: {
            base: baseInfo.variant || config.qwenTts.baseModelVariant,
            customVoice: customVoiceInfo.variant || config.qwenTts.customVoiceModelVariant,
          },
          features: allFeatures,
          status: unavailableDaemons.length > 0 ? 'degraded' : 'ready',
          unavailableDaemons,
        };
      } catch (error) {
        if (error.isBoom) throw error;
        console.error('Qwen TTS list voices error:', error);
        throw Boom.badImplementation('Failed to list voices');
      }
    },
  },

  // Delete voice clone
  {
    method: 'DELETE',
    path: '/qwen-tts/voices/clone/{cloneId}',
    options: {
      pre: [{ method: checkEnabled }, { method: checkCloneAuthorized }],
      validate: {
        params: Joi.object({
          cloneId: Joi.string().required().pattern(/^[a-zA-Z0-9_-]+$/)
            .description('Voice clone ID to delete'),
        }),
      },
      description: 'Delete a voice clone',
      tags: ['api', 'qwen-tts'],
    },
    handler: async (request, h) => {
      try {
        const { cloneId } = request.params;

        await qwenTtsBaseService.deleteVoiceClone(cloneId);

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
        console.error('Qwen TTS delete clone error:', error);
        throw Boom.badImplementation('Failed to delete voice clone');
      }
    },
  },

  // Rename voice clone
  {
    method: 'PATCH',
    path: '/qwen-tts/voices/clone/{cloneId}',
    options: {
      pre: [{ method: checkEnabled }, { method: checkCloneAuthorized }],
      validate: {
        params: Joi.object({
          cloneId: Joi.string().required().pattern(/^[a-zA-Z0-9_-]+$/)
            .description('Current voice clone ID'),
        }),
        payload: Joi.object({
          newCloneId: Joi.string().required().min(1).max(100).pattern(/^[a-zA-Z0-9_-]+$/)
            .description('New name for the voice clone (alphanumeric, underscore, hyphen only)'),
        }),
      },
      description: 'Rename a voice clone',
      tags: ['api', 'qwen-tts'],
    },
    handler: async (request, h) => {
      try {
        const { cloneId } = request.params;
        const { newCloneId } = request.payload;

        // Use the Base daemon for voice cloning operations
        await qwenTtsBaseService.initialize();

        if (!qwenTtsBaseService.supportsFeature('voice_cloning')) {
          throw Boom.badRequest('voice_cloning feature requires a Base model variant');
        }

        const result = await qwenTtsBaseService.renameVoiceClone(cloneId, newCloneId);

        return {
          success: true,
          oldCloneId: result.oldCloneId,
          newCloneId: result.newCloneId,
          message: 'Voice clone renamed successfully',
        };
      } catch (error) {
        if (error.isBoom) throw error;
        if (error.message?.includes('not found')) {
          throw Boom.notFound(`Voice clone '${request.params.cloneId}' not found`);
        }
        if (error.message?.includes('already exists')) {
          throw Boom.conflict(`Voice clone '${request.payload.newCloneId}' already exists`);
        }
        console.error('Qwen TTS rename clone error:', error);
        throw Boom.badImplementation('Failed to rename voice clone');
      }
    },
  },

  // Download voice clone as ZIP
  {
    method: 'GET',
    path: '/qwen-tts/voices/clone/{cloneId}/download',
    options: {
      pre: [{ method: checkEnabled }, { method: checkCloneAuthorized }],
      validate: {
        params: Joi.object({
          cloneId: Joi.string().required().pattern(/^[a-zA-Z0-9_-]+$/)
            .description('Voice clone ID to download'),
        }),
      },
      description: 'Download a voice clone as a ZIP file',
      tags: ['api', 'qwen-tts'],
    },
    handler: async (request, h) => {
      let tempDir = null;

      try {
        const { cloneId } = request.params;

        // Check if clone exists
        const exists = await qwenTtsBaseService.voiceCloneExists(cloneId);
        if (!exists) {
          throw Boom.notFound(`Voice clone '${cloneId}' not found`);
        }

        const clonePath = await qwenTtsBaseService.resolveVoiceClonePath(cloneId);
        if (!clonePath) {
          throw Boom.notFound(`Voice clone '${cloneId}' not found`);
        }
        const cloneFilename = basename(clonePath);

        // Create temp directory for the ZIP
        tempDir = await tempFileManager.createTempDir('qwen-download-');
        const zipDir = join(tempDir, 'package');
        await mkdir(zipDir, { recursive: true });

        // Create metadata.json
        const metadata = {
          clone_id: cloneId,
          format_version: '2.0',
          service: 'qwen-tts',
          created_at: new Date().toISOString(),
        };
        await writeFile(join(zipDir, 'metadata.json'), JSON.stringify(metadata, null, 2));

        // Copy the voice clone file to the package directory
        await execFileAsync('cp', [clonePath, join(zipDir, cloneFilename)], { timeout: 60000 });

        // Create ZIP
        const zipPath = join(tempDir, `${cloneId}.zip`);
        await execFileAsync('zip', ['-j', zipPath, join(zipDir, cloneFilename), join(zipDir, 'metadata.json')], {
          timeout: 60000,
        });

        const zipBuffer = await readFile(zipPath);

        return h.response(zipBuffer)
          .type('application/zip')
          .header('Content-Disposition', `attachment; filename="qwen-tts-${cloneId}.zip"`);
      } catch (error) {
        if (error.isBoom) throw error;
        console.error('Qwen TTS download clone error:', error);
        throw Boom.badImplementation('Failed to download voice clone');
      } finally {
        if (tempDir) {
          await tempFileManager.cleanup(tempDir);
        }
      }
    },
  },

  // Import voice clone from ZIP
  {
    method: 'POST',
    path: '/qwen-tts/voices/clone/import',
    options: {
      auth: false,
      pre: [{ method: checkEnabled }, { method: checkImportAuthorized }],
      payload: {
        maxBytes: config.upload.maxFileSizeBytes,
        output: 'stream',
        parse: true,
        multipart: true,
        allow: 'multipart/form-data',
      },
      validate: {
        payload: Joi.object({
          file: Joi.any().required()
            .description('ZIP file containing voice clone (.safetensors file and optionally metadata.json)'),
          cloneId: Joi.string().min(1).max(100).pattern(/^[a-zA-Z0-9_-]+$/)
            .description('Optional custom name for the imported voice clone'),
        }),
      },
      description: 'Import a voice clone from a ZIP file',
      tags: ['api', 'qwen-tts'],
    },
    handler: async (request, h) => {
      let tempDir = null;

      try {
        const { file, cloneId: userCloneId } = request.payload;

        // Use the Base daemon for voice cloning operations
        await qwenTtsBaseService.initialize();

        if (!qwenTtsBaseService.supportsFeature('voice_cloning')) {
          throw Boom.badRequest('voice_cloning feature requires a Base model variant');
        }

        // Create temp directory for extraction
        tempDir = await tempFileManager.createTempDir('qwen-import-');
        const zipPath = join(tempDir, 'upload.zip');
        const extractDir = join(tempDir, 'extracted');

        // Save uploaded ZIP
        await pipeline(file, createWriteStream(zipPath));

        // Create extraction directory
        await mkdir(extractDir, { recursive: true });

        // Extract ZIP using system unzip command
        await execFileAsync('unzip', ['-o', zipPath, '-d', extractDir], {
          timeout: 60000,
        });

        // Find the voice clone file in extracted contents.
        const extractedFiles = await readdir(extractDir);
        let cloneFilePath = null;
        let metadataPath = null;
        let extractedCloneId = null;

        const isCloneFile = (name) => name.endsWith('.safetensors');
        const getCloneId = (name) => basename(name, '.safetensors');

        // Check if files are directly in extractDir or in a subdirectory
        for (const item of extractedFiles) {
          const itemPath = join(extractDir, item);
          const itemStat = await lstat(itemPath);

          if (itemStat.isSymbolicLink()) {
            throw Boom.badRequest('Invalid ZIP file: symbolic links are not allowed');
          }

          if (itemStat.isDirectory()) {
            // Check inside subdirectory.
            const subFiles = await readdir(itemPath);
            for (const subFile of subFiles) {
              const subFilePath = join(itemPath, subFile);
              const subFileStat = await lstat(subFilePath);

              if (subFileStat.isSymbolicLink()) {
                throw Boom.badRequest('Invalid ZIP file: symbolic links are not allowed');
              }

              if (isCloneFile(subFile)) {
                if (!cloneFilePath) {
                  cloneFilePath = subFilePath;
                  extractedCloneId = getCloneId(subFile);
                }
              } else if (subFile === 'metadata.json') {
                metadataPath = subFilePath;
              }
            }
            if (cloneFilePath) break;
          } else if (isCloneFile(item)) {
            if (!cloneFilePath || item.endsWith('.safetensors')) {
              cloneFilePath = itemPath;
              extractedCloneId = getCloneId(item);
            }
          } else if (item === 'metadata.json') {
            metadataPath = itemPath;
          }
        }

        if (!cloneFilePath) {
          throw Boom.badRequest('Invalid ZIP file: must contain a .safetensors file');
        }

        await assertRegularArchiveFile(cloneFilePath, 'voice clone file');
        if (metadataPath) {
          await assertRegularArchiveFile(metadataPath, 'metadata.json');
        }

        // Determine clone ID: user provided > metadata > filename > random
        let cloneId = userCloneId;
        if (!cloneId && metadataPath) {
          try {
            const metadata = JSON.parse(await readFile(metadataPath, 'utf-8'));
            cloneId = metadata.clone_id;
          } catch {
            // Ignore metadata parsing errors
          }
        }
        if (!cloneId) {
          cloneId = extractedCloneId || `imported_${randomBytes(4).toString('hex')}`;
        }

        // Sanitize clone ID
        cloneId = cloneId.replace(/[^a-zA-Z0-9_-]/g, '_');
        if (!cloneId) {
          cloneId = `imported_${randomBytes(4).toString('hex')}`;
        }

        // Validate the voice clone file via daemon
        const validation = await qwenTtsBaseService.validateVoiceClone(cloneFilePath);
        if (!validation.valid) {
          throw Boom.badRequest(`Invalid voice clone file: ${validation.error || 'unknown error'}`);
        }

        // Import via daemon (loads, converts to safetensors, caches)
        const result = await qwenTtsBaseService.importVoiceClone(cloneFilePath, cloneId);

        return {
          success: true,
          cloneId: result.cloneId,
          message: 'Voice clone imported successfully',
        };
      } catch (error) {
        if (error.isBoom) throw error;
        if (error.message?.includes('already exists')) {
          throw Boom.conflict(`Voice clone already exists`);
        }
        console.error('Qwen TTS import clone error:', error);
        throw Boom.badImplementation('Failed to import voice clone');
      } finally {
        if (tempDir) {
          await tempFileManager.cleanup(tempDir);
        }
      }
    },
  },
];
