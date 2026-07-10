import Joi from 'joi';
import Boom from '@hapi/boom';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { config } from '../config/index.js';
import { transcriptionService } from '../services/transcription.js';
import { qwenAsrService } from '../services/qwenAsr.js';
import { diarizationService } from '../services/diarization.js';
import { tempFileManager } from '../utils/tempFile.js';
import {
  getExtension,
  sanitizeEchoFilename,
  validateAudioUpload,
  ALLOWED_AUDIO_EXTENSIONS,
} from '../utils/audioValidation.js';
import { mergeSpeakers, summarizeSpeakers } from '../utils/diarizationMerge.js';
import {
  QWEN_ASR_LANGUAGES,
  QWEN_ASR_LANGUAGE_CODES,
  QWEN_ALIGNER_LANGUAGES,
} from '../utils/qwenAsrLanguages.js';

export const transcribeRoutes = [
  {
    method: 'GET',
    path: '/transcription/models',
    options: {
      description: 'List configured speech recognition providers and capabilities',
      tags: ['api', 'transcription'],
    },
    handler: async () => ({
      default: 'parakeet',
      models: [
        {
          id: 'parakeet',
          name: 'Parakeet TDT v3',
          enabled: Boolean(config.transcription.enabled),
          timestamps: ['sentence', 'word'],
          description: 'Fast Apple Silicon transcription for 25 European languages.',
        },
        {
          id: 'qwen3',
          name: 'Qwen3-ASR 0.6B',
          enabled: Boolean(config.qwenAsr.enabled),
          model: config.qwenAsr.modelId,
          alignerModel: config.qwenAsr.alignerModelId,
          languages: QWEN_ASR_LANGUAGES,
          alignmentLanguages: QWEN_ALIGNER_LANGUAGES,
          timestamps: ['sentence', 'word'],
          description: 'Multilingual ASR with language detection and forced alignment.',
        },
      ],
    }),
  },
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
          engine: Joi.string().valid('parakeet', 'qwen3').optional()
            .description('Speech recognition provider (default: parakeet)'),
          language: Joi.string().valid('auto', ...QWEN_ASR_LANGUAGES, ...QWEN_ASR_LANGUAGE_CODES)
            .insensitive().optional()
            .description('Qwen3-ASR language name/code, or auto (default)'),
          timestamps: Joi.string().valid('true', 'false').optional()
            .description('Include sentence-level subtitle timings in response'),
          wordTimestamps: Joi.string().valid('true', 'false').optional()
            .description('Include word-level subtitle timings in response (overrides timestamps)'),
          diarize: Joi.string().valid('true', 'false').optional()
            .description('Identify speakers and label each timestamp segment'),
          numSpeakers: Joi.string().pattern(/^\d+$/).optional()
            .description('Exact number of speakers (1-20). Overrides min/max.'),
          minSpeakers: Joi.string().pattern(/^\d+$/).optional()
            .description('Lower bound on speaker count (1-20)'),
          maxSpeakers: Joi.string().pattern(/^\d+$/).optional()
            .description('Upper bound on speaker count (1-20)'),
        }),
      },
      description: 'Transcribe an audio file to text',
      tags: ['api', 'transcription'],
    },
    handler: async (request, h) => {
      let tempDir = null;

      try {
        const {
          file,
          engine: engineParam,
          language: languageParam,
          timestamps: timestampsParam,
          wordTimestamps: wordTimestampsParam,
          diarize: diarizeParam,
          numSpeakers: numSpeakersParam,
          minSpeakers: minSpeakersParam,
          maxSpeakers: maxSpeakersParam,
        } = request.payload;
        const engine = engineParam || 'parakeet';
        if (engine === 'parakeet' && !config.transcription.enabled) {
          throw Boom.serviceUnavailable('Parakeet transcription is disabled');
        }
        if (engine === 'qwen3' && !config.qwenAsr.enabled) {
          throw Boom.serviceUnavailable('Qwen3-ASR is disabled');
        }
        const timestamps = timestampsParam === 'true';
        const wordTimestamps = wordTimestampsParam === 'true';
        // Default diarize=true when the server can actually do it. Avoids noisy
        // `diarization: {available: false}` on responses from servers that never
        // opted into diarization, preserving backward compat for those clients.
        const diarizeAvailable = config.diarization.enabled;
        const diarizeRequested = diarizeParam == null
          ? diarizeAvailable
          : diarizeParam === 'true';

        const parseSpeakerCount = (raw) => {
          if (raw == null) return undefined;
          const n = parseInt(raw, 10);
          if (!Number.isFinite(n) || n < 1 || n > 20) return undefined;
          return n;
        };
        const numSpeakers = parseSpeakerCount(numSpeakersParam);
        const minSpeakers = parseSpeakerCount(minSpeakersParam);
        const maxSpeakers = parseSpeakerCount(maxSpeakersParam);

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

        const wantDiarize = diarizeRequested && config.diarization.enabled;
        let diarizationDisabledReason = null;
        if (diarizeRequested && !config.diarization.enabled) {
          diarizationDisabledReason = 'Diarization is disabled on this server';
        }

        const selectedService = engine === 'qwen3' ? qwenAsrService : transcriptionService;
        const [transcribeOutcome, diarizeOutcome] = await Promise.allSettled([
          selectedService.transcribe(tempFilePath, {
            timestamps,
            wordTimestamps,
            ...(engine === 'qwen3' ? { language: languageParam || 'auto' } : {}),
          }),
          wantDiarize
            ? diarizationService.diarize(tempFilePath, { numSpeakers, minSpeakers, maxSpeakers })
            : Promise.resolve(null),
        ]);

        if (transcribeOutcome.status === 'rejected') {
          throw transcribeOutcome.reason;
        }
        const result = transcribeOutcome.value;

        let diarization = null;
        let speakerTurns = null;
        if (diarizeRequested) {
          if (diarizationDisabledReason) {
            diarization = { available: false, error: diarizationDisabledReason };
          } else if (diarizeOutcome.status === 'rejected') {
            console.error('Diarization failed:', diarizeOutcome.reason);
            diarization = {
              available: false,
              error: diarizeOutcome.reason?.message || 'Diarization failed',
            };
          } else if (diarizeOutcome.value) {
            speakerTurns = diarizeOutcome.value.turns;
            diarization = {
              available: true,
              numSpeakers: diarizeOutcome.value.numSpeakers,
            };
          }
        }

        // When timestamps requested, only return timestamps for programmatic use
        if ((timestamps || wordTimestamps) && result.timestamps) {
          const tagged = speakerTurns ? mergeSpeakers(result.timestamps, speakerTurns) : result.timestamps;
          const response = { success: true, timestamps: tagged };
          if (engine === 'qwen3') {
            response.engine = engine;
            response.language = result.language;
            response.model = result.model;
            response.timestampLevel = result.timestampLevel;
          }
          if (diarization) {
            response.diarization = diarization;
            if (speakerTurns) response.speakers = summarizeSpeakers(tagged);
          }
          return response;
        }

        const response = {
          success: true,
          transcript: result.text,
          filename: sanitizeEchoFilename(filename),
        };
        if (engine === 'qwen3') {
          response.engine = engine;
          response.language = result.language;
          response.languages = result.languages;
          response.model = result.model;
        }
        if (diarization) {
          response.diarization = diarization;
          if (speakerTurns) {
            // Provide turn-level info even when no per-segment timestamps were requested.
            response.speakers = summarizeSpeakers(
              speakerTurns.map((t) => ({ start: t.start, end: t.end, speaker: t.speaker })),
            );
          }
        }
        return response;
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
