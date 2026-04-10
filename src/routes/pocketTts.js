import Joi from 'joi';
import Boom from '@hapi/boom';
import { readFile, mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { join, basename } from 'node:path';
import { config } from '../config/index.js';
import { pocketTtsService } from '../services/pocketTts.js';
import { tempFileManager } from '../utils/tempFile.js';

const execFileAsync = promisify(execFile);

const checkEnabled = (request, h) => {
  if (!config.pocketTts.enabled) {
    throw Boom.notFound('Pocket TTS is not enabled. Set POCKET_TTS_ENABLED=1 to enable.');
  }
  return h.continue;
};

// Helper to check if voice clone imports are authorized.
// Requires either DANGEROUSLY_ALLOW_IMPORTS=1 or a valid API key.
const checkImportAuthorized = (request, h) => {
  if (config.auth.dangerouslyAllowImports) {
    return h.continue;
  }

  // Check for a valid API key
  const apiKeyHeader = request.headers['x-api-key'];
  const authHeader = request.headers.authorization;
  let providedKey = null;

  if (apiKeyHeader) {
    providedKey = apiKeyHeader;
  } else if (authHeader && authHeader.startsWith('Bearer ')) {
    providedKey = authHeader.slice(7);
  }

  if (!providedKey || !config.auth.apiKey || providedKey !== config.auth.apiKey) {
    throw Boom.unauthorized(
      'Voice clone import requires authentication. Provide a valid API key via X-API-Key header or Authorization: Bearer <key>, or set DANGEROUSLY_ALLOW_IMPORTS=1.'
    );
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
        query: Joi.object({
          format: Joi.string().valid('wav', 'opus', 'buffer')
            .description('Output format override via query string'),
        }).unknown(true),
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
        const { text, voice, format: payloadFormat } = request.payload;
        const format = request.query.format || payloadFormat;

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

  // Rename voice clone
  {
    method: 'PATCH',
    path: '/pocket-tts/voices/clone/{cloneId}',
    options: {
      pre: [{ method: checkEnabled }],
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
      tags: ['api', 'pocket-tts'],
    },
    handler: async (request, h) => {
      try {
        const { cloneId } = request.params;
        const { newCloneId } = request.payload;

        await pocketTtsService.initialize();

        const result = await pocketTtsService.renameVoiceClone(cloneId, newCloneId);

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
        console.error('Pocket TTS rename clone error:', error);
        throw Boom.badImplementation('Failed to rename voice clone');
      }
    },
  },

  // Download voice clone as ZIP
  {
    method: 'GET',
    path: '/pocket-tts/voices/clone/{cloneId}/download',
    options: {
      pre: [{ method: checkEnabled }],
      validate: {
        params: Joi.object({
          cloneId: Joi.string().required().pattern(/^[a-zA-Z0-9_-]+$/)
            .description('Voice clone ID to download'),
        }),
      },
      description: 'Download a voice clone as a ZIP file',
      tags: ['api', 'pocket-tts'],
    },
    handler: async (request, h) => {
      let tempDir = null;

      try {
        const { cloneId } = request.params;

        // Check if clone exists
        const exists = await pocketTtsService.voiceCloneExists(cloneId);
        if (!exists) {
          throw Boom.notFound(`Voice clone '${cloneId}' not found`);
        }

        const clonePath = pocketTtsService.getVoiceClonePath(cloneId);

        // Create temp directory for the ZIP
        tempDir = await tempFileManager.createTempDir('pocket-download-');
        const zipPath = join(tempDir, `${cloneId}.zip`);

        // Create ZIP using system zip command
        await execFileAsync('zip', ['-j', zipPath, join(clonePath, 'reference.wav'), join(clonePath, 'metadata.json')], {
          timeout: 60000,
        });

        const zipBuffer = await readFile(zipPath);

        return h.response(zipBuffer)
          .type('application/zip')
          .header('Content-Disposition', `attachment; filename="pocket-tts-${cloneId}.zip"`);
      } catch (error) {
        if (error.isBoom) throw error;
        console.error('Pocket TTS download clone error:', error);
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
    path: '/pocket-tts/voices/clone/import',
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
            .description('ZIP file containing voice clone (reference.wav and optionally metadata.json)'),
          cloneId: Joi.string().min(1).max(100).pattern(/^[a-zA-Z0-9_-]+$/)
            .description('Optional custom name for the imported voice clone'),
        }),
      },
      description: 'Import a voice clone from a ZIP file',
      tags: ['api', 'pocket-tts'],
    },
    handler: async (request, h) => {
      let tempDir = null;

      try {
        const { file, cloneId: userCloneId } = request.payload;

        await pocketTtsService.initialize();

        // Create temp directory for extraction
        tempDir = await tempFileManager.createTempDir('pocket-import-');
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

        // Find reference.wav in extracted contents (may be in root or subdirectory)
        const extractedFiles = await readdir(extractDir);
        let referenceWavPath = null;
        let metadataPath = null;
        let extractedCloneId = null;

        // Check if files are directly in extractDir or in a subdirectory
        for (const item of extractedFiles) {
          const itemPath = join(extractDir, item);
          const itemStat = await stat(itemPath);

          if (itemStat.isDirectory()) {
            // Check inside subdirectory
            const subFiles = await readdir(itemPath);
            if (subFiles.includes('reference.wav')) {
              referenceWavPath = join(itemPath, 'reference.wav');
              extractedCloneId = item; // Use directory name as clone ID
              if (subFiles.includes('metadata.json')) {
                metadataPath = join(itemPath, 'metadata.json');
              }
              break;
            }
          } else if (item === 'reference.wav') {
            referenceWavPath = itemPath;
          } else if (item === 'metadata.json') {
            metadataPath = itemPath;
          }
        }

        if (!referenceWavPath) {
          throw Boom.badRequest('Invalid ZIP file: must contain reference.wav');
        }

        // Determine clone ID: user provided > metadata > extracted directory name > ZIP filename
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

        // Convert audio to correct format (24000 Hz, mono, 16-bit PCM)
        const convertedWavPath = join(tempDir, 'converted.wav');
        await execFileAsync('ffmpeg', [
          '-i', referenceWavPath,
          '-ar', '24000',
          '-ac', '1',
          '-c:a', 'pcm_s16le',
          '-y',
          convertedWavPath,
        ], { timeout: 300000 });

        // Create voice clone using the service (this will copy to the clones directory)
        const result = await pocketTtsService.createVoiceClone(convertedWavPath, cloneId);

        return {
          success: true,
          cloneId: result.cloneId,
          message: 'Voice clone imported successfully',
        };
      } catch (error) {
        if (error.isBoom) throw error;
        console.error('Pocket TTS import clone error:', error);
        throw Boom.badImplementation('Failed to import voice clone');
      } finally {
        if (tempDir) {
          await tempFileManager.cleanup(tempDir);
        }
      }
    },
  },
];
