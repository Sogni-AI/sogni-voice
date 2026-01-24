import Joi from 'joi';
import Boom from '@hapi/boom';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { config } from '../config/index.js';
import { qwenTtsService } from '../services/qwenTts.js';
import { tempFileManager } from '../utils/tempFile.js';

const execFileAsync = promisify(execFile);

// Helper to check if Qwen TTS is enabled
const checkEnabled = (request, h) => {
  if (!config.qwenTts.enabled) {
    throw Boom.notFound('Qwen TTS is not enabled. Set QWEN_TTS_ENABLED=true to enable.');
  }
  return h.continue;
};

export const qwenTtsRoutes = [
  // Standard TTS generation
  {
    method: 'POST',
    path: '/qwen-tts',
    options: {
      pre: [{ method: checkEnabled }],
      validate: {
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
        const { text, voice, language, format } = request.payload;

        tempDir = await tempFileManager.createTempDir('qwen-tts-');
        const outputPath = await tempFileManager.createTempFile(tempDir, 'wav');

        const result = await qwenTtsService.generate(text, { voice, language, outputPath });

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
          ]);

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
        const { text, speaker, instruct, format } = request.payload;

        // Ensure daemon is running before checking features
        await qwenTtsService.initialize();

        if (!qwenTtsService.supportsFeature('custom_voice')) {
          throw Boom.badRequest('custom_voice feature requires the CustomVoice model variant');
        }

        tempDir = await tempFileManager.createTempDir('qwen-tts-');
        const outputPath = await tempFileManager.createTempFile(tempDir, 'wav');

        const result = await qwenTtsService.generateCustomVoice(text, { speaker, instruct, outputPath });

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
          ]);
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
        const { text, instruct, format } = request.payload;

        // Ensure daemon is running before checking features
        await qwenTtsService.initialize();

        if (!qwenTtsService.supportsFeature('voice_design')) {
          throw Boom.badRequest('voice_design feature requires the VoiceDesign model variant');
        }

        tempDir = await tempFileManager.createTempDir('qwen-tts-');
        const outputPath = await tempFileManager.createTempFile(tempDir, 'wav');

        const result = await qwenTtsService.generateVoiceDesign(text, { instruct, outputPath });

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
          ]);
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

        // Ensure daemon is running before checking features
        await qwenTtsService.initialize();

        if (!qwenTtsService.supportsFeature('voice_cloning')) {
          throw Boom.badRequest('voice_cloning feature requires a Base model variant');
        }

        // Use user-provided cloneId or generate a unique one
        const cloneId = userCloneId || `clone_${randomBytes(8).toString('hex')}`;

        // Save uploaded audio to temp file (preserve original format)
        tempDir = await tempFileManager.createTempDir('qwen-clone-');
        const uploadedPath = await tempFileManager.createTempFile(tempDir, 'audio');

        // Write the audio stream to file
        const chunks = [];
        for await (const chunk of audio) {
          chunks.push(chunk);
        }
        await writeFile(uploadedPath, Buffer.concat(chunks));

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
        ]);

        console.log('Audio conversion completed');

        // Create the voice clone using the converted WAV
        const result = await qwenTtsService.createVoiceClone(wavPath, transcript, cloneId);

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
      pre: [{ method: checkEnabled }],
      validate: {
        params: Joi.object({
          cloneId: Joi.string().required()
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

        // Ensure daemon is running before checking features
        await qwenTtsService.initialize();

        if (!qwenTtsService.supportsFeature('voice_cloning')) {
          throw Boom.badRequest('voice_cloning feature requires a Base model variant');
        }

        tempDir = await tempFileManager.createTempDir('qwen-tts-');
        const outputPath = await tempFileManager.createTempFile(tempDir, 'wav');

        const result = await qwenTtsService.generateVoiceClone(text, { cloneId, language, outputPath });

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
          ]);
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
        const modelInfo = qwenTtsService.getModelInfo();
        const voices = qwenTtsService.listVoices();
        const clonesResult = await qwenTtsService.listVoiceClones();

        return {
          voices,
          clones: clonesResult.clones,
          default: config.qwenTts.defaultVoice,
          defaultLanguage: config.qwenTts.defaultLanguage,
          modelVariant: modelInfo.variant || config.qwenTts.modelVariant,
          features: modelInfo.features,
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
      pre: [{ method: checkEnabled }],
      validate: {
        params: Joi.object({
          cloneId: Joi.string().required()
            .description('Voice clone ID to delete'),
        }),
      },
      description: 'Delete a voice clone',
      tags: ['api', 'qwen-tts'],
    },
    handler: async (request, h) => {
      try {
        const { cloneId } = request.params;

        await qwenTtsService.deleteVoiceClone(cloneId);

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
];
