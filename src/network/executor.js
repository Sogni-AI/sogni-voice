import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config/index.js';
import { createSyntheticTestWavBuffer } from '../utils/audioFormat.js';
import { tempFileManager } from '../utils/tempFile.js';
import {
  downloadReferenceAudio,
  findReferenceAudioAsset,
  MAX_ARTIFACT_DOWNLOAD_BYTES,
  MAX_REFERENCE_AUDIO_DOWNLOAD_BYTES,
  transcodeAndVerifySttAudio,
  transcodeReferenceWav,
  uploadJobArtifact,
  validateAndProbeAudio,
} from './artifacts.js';
import { buildCanonicalTranscript } from './backends.js';
import { findWorkerModel } from './capabilities.js';
import { MAX_MEDIA_WORKER_CONCURRENT_JOBS } from './config.js';

export class JobError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = 'JobError';
    this.code = code;
  }
}

export const MAX_TIMER_DELAY_MS = 2147483647;
export const DRAMA3_MAX_TEXT_CHARS = 5000;
export const DRAMA3_MAX_REFERENCE_TEXT_CHARS = 2000;
const ALLOWED_DRAMA3_FORMATS = new Set(['mp3', 'wav', 'flac']);
const RESERVED_DRAMA3_CONTROL_TOKEN_RE = /<\|[\w:-]+\|>|<\|(?:im_start|im_end|voice|text|interleave|semantic:|endoftext)/i;
const MAX_RECENT_JOB_TIMINGS = 64;

export function ensureCompleteTimings(partial = {}) {
  const round = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0);
  return {
    assetDownload: round(partial.assetDownload),
    modelInit: round(partial.modelInit),
    modelUnload: round(partial.modelUnload),
    modelLoad: round(partial.modelLoad),
    inference: round(partial.inference),
    safeContent: round(partial.safeContent),
    assetUpload: round(partial.assetUpload),
    other: round(partial.other),
  };
}

export function computeJobTimeout(
  job,
  fallbackMs = config.networkWorker?.defaultJobTimeoutMs || 600_000,
) {
  const requested = Number(job?.timeoutMs);
  if (Number.isFinite(requested) && requested > 0) {
    return Math.min(requested, MAX_TIMER_DELAY_MS);
  }

  if (job?.workflowId === 'fish_drama_3_nvfp4') {
    const text = String(job?.clientParams?.tags || job?.clientParams?.positivePrompt || '');
    const scaled = Math.max(fallbackMs, 180_000 + text.length * 250);
    return Math.min(900_000, scaled);
  }

  const rawDeclared = Number(job?.clientParams?.duration);
  const declaredDuration = Number.isFinite(rawDeclared) && rawDeclared > 0 ? rawDeclared : 60;
  const sttScaled = Math.max(fallbackMs, 120_000 + declaredDuration * 500);
  return Math.min(3_600_000, sttScaled);
}

export function estimateJobEtaSeconds(job, model, elapsedSeconds = 0) {
  let expectedTotalSeconds = 15;
  if (model?.engine === 'drama3') {
    const chars = String(job?.clientParams?.tags || job?.clientParams?.positivePrompt || '').length || 60;
    expectedTotalSeconds = Math.max(6, Math.ceil(4 + chars * 0.06));
  } else if (model?.engine === 'parakeet') {
    const rawDur = Number(job?.clientParams?.duration);
    const dur = Number.isFinite(rawDur) && rawDur > 0 ? rawDur : 60;
    expectedTotalSeconds = Math.max(3, Math.ceil(2 + dur * 0.04));
  } else if (model?.engine === 'nemotron') {
    const rawDur = Number(job?.clientParams?.duration);
    const dur = Number.isFinite(rawDur) && rawDur > 0 ? rawDur : 60;
    expectedTotalSeconds = Math.max(5, Math.ceil(4 + dur * 0.12));
  }
  return Math.max(1, Math.ceil(expectedTotalSeconds - elapsedSeconds));
}

export function withTimeout(promise, timeoutMs, label, onTimeout = null) {
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new JobError('genfailure', `${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const isAbortError = (error, signal) => (
  Boolean(signal?.aborted)
  || error?.name === 'AbortError'
  || error?.code === 'aborted'
);

export class VoiceSupernetExecutor {
  constructor({
    workerModels,
    backend,
    apiUrl = 'https://api.sogni.ai',
    sogniEnv = config.networkWorker?.sogniEnv || 'staging',
    rejectUnauthorized = undefined,
    maxConcurrentJobs = 1,
    tempFiles = tempFileManager,
    artifacts = {
      downloadReferenceAudio,
      validateAndProbeAudio,
      transcodeAndVerifySttAudio,
      transcodeReferenceWav,
      uploadJobArtifact,
    },
    now = () => Date.now(),
  }) {
    this.workerModels = workerModels || [];
    this.backend = backend;
    this.apiUrl = apiUrl;
    this.sogniEnv = sogniEnv;
    this.rejectUnauthorized = rejectUnauthorized;
    // Sogni socket tracks a single activeWorkerJob per media worker socket: clamp to 1.
    this.maxConcurrentJobs = Math.min(
      MAX_MEDIA_WORKER_CONCURRENT_JOBS,
      Math.max(1, Number(maxConcurrentJobs) || 1),
    );
    this.tempFiles = tempFiles;
    this.artifacts = artifacts;
    this.now = now;
    this.draining = false;
    this.loadedModelID = null;
    this.activeJobs = new Map();
    this.recentTimings = new Map();
  }

  get activeRequests() {
    return this.activeJobs.size;
  }

  setWorkerModels(models) {
    this.workerModels = [...models];
  }

  getHeldJobs() {
    const current = this.now();
    return [...this.activeJobs.values()].map((entry) => ({
      jobID: entry.job.jobID,
      ...(entry.job.imageId ? { imgID: entry.job.imageId } : {}),
      phase: entry.phase,
      step: entry.phase === 'finished' ? 1 : 0,
      stepCount: 1,
      heldForMs: Math.max(0, current - entry.startedAt),
    }));
  }

  accept(job) {
    if (this.draining) {
      throw new JobError('draining', 'Worker is draining and not accepting new jobs');
    }
    if (!job || typeof job.jobID !== 'string' || job.jobID.trim().length === 0) {
      throw new JobError('invalidInput', 'jobRequest is missing jobID');
    }
    if (typeof job.workflowId !== 'string' || job.workflowId.trim().length === 0) {
      throw new JobError('invalidInput', 'jobRequest is missing workflowId');
    }
    if (this.activeJobs.has(job.jobID)) {
      throw new JobError('invalidInput', `Job ${job.jobID} is already running`);
    }

    const model = findWorkerModel(this.workerModels, job.workflowId);
    if (!model) {
      throw new JobError(
        'genfailure',
        `Workflow "${job.workflowId}" is not enabled on this worker`,
      );
    }

    if (this.activeJobs.size >= this.maxConcurrentJobs) {
      throw new JobError(
        'capacity_exceeded',
        `Worker is at capacity (${this.maxConcurrentJobs} concurrent job(s))`,
      );
    }

    const entry = {
      job,
      model,
      controller: new AbortController(),
      aborted: false,
      phase: 'setup',
      startedAt: this.now(),
      timings: {},
    };
    this.activeJobs.set(job.jobID, entry);
    return { model, entry };
  }

  _rememberTimings(jobID, timings) {
    this.recentTimings.delete(jobID);
    this.recentTimings.set(jobID, ensureCompleteTimings(timings));
    while (this.recentTimings.size > MAX_RECENT_JOB_TIMINGS) {
      const oldestKey = this.recentTimings.keys().next().value;
      this.recentTimings.delete(oldestKey);
    }
  }

  getTimings(jobID) {
    const active = this.activeJobs.get(jobID);
    if (active) return ensureCompleteTimings(active.timings);
    const remembered = this.recentTimings.get(jobID);
    return ensureCompleteTimings(remembered);
  }

  async execute(job) {
    const entry = this.activeJobs.get(job.jobID);
    if (!entry) {
      throw new JobError('invalidInput', `Job ${job.jobID} was not accepted`);
    }

    const timeoutMs = computeJobTimeout(job);
    let tempDir = null;

    try {
      tempDir = await this.tempFiles.createTempDir('sogni-voice-job-');
      const runWork = entry.model.task === 'stt'
        ? this._executeStt(job, entry, tempDir)
        : this._executeDrama3(job, entry, tempDir);

      const result = await withTimeout(
        runWork,
        timeoutMs,
        `Job ${job.jobID}`,
        () => entry.controller.abort(),
      );

      if (entry.aborted) {
        throw new JobError('aborted', `Job ${job.jobID} was cancelled`);
      }

      this._rememberTimings(job.jobID, entry.timings);
      return result;
    } catch (error) {
      const capturedTimings = ensureCompleteTimings(entry.timings);
      this._rememberTimings(job.jobID, capturedTimings);

      let mappedError;
      if (entry.aborted || isAbortError(error, entry.controller.signal)) {
        if (entry.aborted) {
          mappedError = new JobError('aborted', `Job ${job.jobID} was cancelled`, { cause: error });
        }
      }
      if (!mappedError) {
        if (error instanceof JobError) {
          mappedError = error;
        } else if (error?.invalidInput) {
          mappedError = new JobError('invalidInput', error.message, { cause: error });
        } else {
          mappedError = new JobError('genfailure', error?.message || String(error), { cause: error });
        }
      }
      mappedError.timings = capturedTimings;
      throw mappedError;
    } finally {
      if (tempDir) await this.tempFiles.cleanup(tempDir);
      this._release(job.jobID, entry);
    }
  }

  async _executeDrama3(job, entry, tempDir) {
    const { signal } = entry.controller;
    const outputFormat = String(job.outputFormat || 'mp3').toLowerCase();
    if (!ALLOWED_DRAMA3_FORMATS.has(outputFormat)) {
      throw new JobError(
        'invalidInput',
        `Unsupported Drama 3 outputFormat "${job.outputFormat}" (expected mp3, wav, or flac)`,
      );
    }

    const isTest = job.isTest === true;
    const rawText = isTest
      ? (job.clientParams?.tags || job.clientParams?.positivePrompt || 'This is a short voice test.')
      : (typeof job.clientParams?.tags === 'string' && job.clientParams.tags.length > 0
          ? job.clientParams.tags
          : (typeof job.clientParams?.positivePrompt === 'string' ? job.clientParams.positivePrompt : ''));

    const trimmedText = String(rawText).trim();
    if (!trimmedText) {
      throw new JobError('invalidInput', 'Drama 3 job requires non-empty text');
    }
    if (trimmedText.length > DRAMA3_MAX_TEXT_CHARS) {
      throw new JobError(
        'invalidInput',
        `Speech scripts are limited to ${DRAMA3_MAX_TEXT_CHARS} characters; this one is ${trimmedText.length}`,
      );
    }
    if (RESERVED_DRAMA3_CONTROL_TOKEN_RE.test(trimmedText)) {
      throw new JobError('invalidInput', 'Speech prompt contains reserved control tokens');
    }

    const rawReferenceText = isTest ? '' : String(job.clientParams?.referenceText || '').trim();
    if (rawReferenceText.length > DRAMA3_MAX_REFERENCE_TEXT_CHARS) {
      throw new JobError(
        'invalidInput',
        `referenceText is limited to ${DRAMA3_MAX_REFERENCE_TEXT_CHARS} characters; this one is ${rawReferenceText.length}`,
      );
    }
    if (rawReferenceText && RESERVED_DRAMA3_CONTROL_TOKEN_RE.test(rawReferenceText)) {
      throw new JobError('invalidInput', 'referenceText contains reserved control tokens');
    }

    let referenceWavPath = null;
    if (!isTest && findReferenceAudioAsset(job)) {
      const dlStart = this.now();
      let downloaded;
      try {
        downloaded = await this.artifacts.downloadReferenceAudio(job, tempDir, {
          apiUrl: this.apiUrl,
          sogniEnv: this.sogniEnv,
          rejectUnauthorized: this.rejectUnauthorized,
          maxBytes: MAX_REFERENCE_AUDIO_DOWNLOAD_BYTES,
          signal,
        });
      } catch (error) {
        entry.timings.assetDownload = (this.now() - dlStart) / 1000;
        if (isAbortError(error, signal)) throw error;
        const code = error?.invalidInput ? 'invalidInput' : 'genfailure';
        throw new JobError(code, `Failed to download referenceAudio: ${error.message}`, {
          cause: error,
        });
      }
      entry.timings.assetDownload = (this.now() - dlStart) / 1000;

      const setupStart = this.now();
      const probed = await this.artifacts.validateAndProbeAudio(downloaded.path, {
        maxProbeSeconds: 32,
        signal,
      });
      if (probed.duration < 1) {
        throw new JobError(
          'invalidInput',
          `Reference audio must be at least 1 seconds long, got ${probed.duration.toFixed(1)}s`,
        );
      }
      if (probed.duration > 30) {
        throw new JobError(
          'invalidInput',
          `Reference audio must be at most 30 seconds long, got ${probed.duration.toFixed(1)}s`,
        );
      }

      referenceWavPath = await this.artifacts.transcodeReferenceWav(
        downloaded.path,
        join(tempDir, 'reference-44k.wav'),
        { signal },
      );
      entry.timings.other = (entry.timings.other || 0) + (this.now() - setupStart) / 1000;
    }

    if (entry.aborted) throw new JobError('aborted', `Job ${job.jobID} was cancelled`);

    entry.phase = 'running';
    this.loadedModelID = entry.model.id;
    const inferStart = this.now();
    try {
      const synthesized = await this.backend.synthesizeDrama3({
        text: trimmedText,
        referenceWavPath,
        referenceText: rawReferenceText,
        outputFormat,
        tempDir,
        signal,
      });
      entry.timings.inference = (this.now() - inferStart) / 1000;

      if (entry.aborted) throw new JobError('aborted', `Job ${job.jobID} was cancelled`);

      entry.phase = 'finished';
      const uploadStart = this.now();
      let uploaded;
      try {
        uploaded = await this.artifacts.uploadJobArtifact({
          apiUrl: this.apiUrl,
          sogniEnv: this.sogniEnv,
          jobId: job.jobID,
          imageId: job.imageId,
          buffer: synthesized.buffer,
          contentType: synthesized.contentType,
          artifactType: 'complete',
          rejectUnauthorized: this.rejectUnauthorized,
          signal,
        });
      } catch (error) {
        entry.timings.assetUpload = (this.now() - uploadStart) / 1000;
        if (isAbortError(error, signal)) throw error;
        throw new JobError('imgUploadFailure', error.message, { cause: error });
      }
      entry.timings.assetUpload = (this.now() - uploadStart) / 1000;

      return {
        jobID: job.jobID,
        imgID: job.imageId,
        performedStepCount: 1,
        lastSeed: job.clientParams?.seed ?? 0,
        userCanceled: false,
        triggeredNSFWFilter: false,
        timings: ensureCompleteTimings(entry.timings),
        sha256: uploaded.sha256,
      };
    } catch (error) {
      if (entry.timings.inference === undefined) {
        entry.timings.inference = (this.now() - inferStart) / 1000;
      }
      throw error;
    }
  }

  async _executeStt(job, entry, tempDir) {
    const { signal } = entry.controller;
    const isTest = job.isTest === true;
    let audioPath;
    let actualDuration;

    if (isTest) {
      audioPath = join(tempDir, 'test-tone.wav');
      await writeFile(audioPath, createSyntheticTestWavBuffer({ durationSeconds: 2, sampleRate: 16000 }));
      actualDuration = 2.0;
    } else {
      const dlStart = this.now();
      let downloaded;
      try {
        downloaded = await this.artifacts.downloadReferenceAudio(job, tempDir, {
          apiUrl: this.apiUrl,
          sogniEnv: this.sogniEnv,
          rejectUnauthorized: this.rejectUnauthorized,
          maxBytes: MAX_ARTIFACT_DOWNLOAD_BYTES,
          signal,
        });
      } catch (error) {
        entry.timings.assetDownload = (this.now() - dlStart) / 1000;
        if (isAbortError(error, signal)) throw error;
        const code = error?.invalidInput ? 'invalidInput' : 'genfailure';
        throw new JobError(code, `Failed to download referenceAudio: ${error.message}`, {
          cause: error,
        });
      }
      if (!downloaded) {
        throw new JobError('invalidInput', `${job.workflowId} requires referenceAudio input`);
      }
      entry.timings.assetDownload = (this.now() - dlStart) / 1000;

      const rawDeclared = Number(job.clientParams?.duration);
      const declaredDuration = Number.isFinite(rawDeclared) && rawDeclared > 0 ? rawDeclared : 60;
      const maxAllowedSeconds = entry.model.engine === 'nemotron' ? 3600 : 7200;
      const allowedMaxDuration = Math.min(maxAllowedSeconds, Math.ceil(declaredDuration * 1.02 + 1.5));

      const probeStart = this.now();
      if (typeof this.artifacts.transcodeAndVerifySttAudio === 'function') {
        const verified = await this.artifacts.transcodeAndVerifySttAudio(
          downloaded.path,
          join(tempDir, 'stt-clean-16k.flac'),
          {
            allowedMaxDuration,
            declaredDuration,
            maxModelSeconds: maxAllowedSeconds,
            workflowId: job.workflowId,
            signal,
          },
        );
        audioPath = verified.path;
        actualDuration = verified.duration;
      } else {
        const probed = await this.artifacts.validateAndProbeAudio(downloaded.path, {
          maxProbeSeconds: 7202,
          signal,
        });
        actualDuration = probed.duration;
        audioPath = downloaded.path;
      }
      entry.timings.other = (entry.timings.other || 0) + (this.now() - probeStart) / 1000;

      if (!Number.isFinite(actualDuration) || actualDuration <= 0) {
        throw new JobError('invalidInput', 'Uploaded audio file has zero or unreadable duration.');
      }

      if (actualDuration > maxAllowedSeconds) {
        throw new JobError(
          'invalidInput',
          `Audio duration ${actualDuration.toFixed(1)}s exceeds maximum ${maxAllowedSeconds}s for ${job.workflowId}`,
        );
      }

      if (actualDuration > allowedMaxDuration) {
        throw new JobError(
          'invalidInput',
          `Audio duration ${actualDuration.toFixed(1)}s exceeds declared duration ${declaredDuration}s`,
        );
      }
    }

    if (entry.aborted) throw new JobError('aborted', `Job ${job.jobID} was cancelled`);

    const clientParams = job.clientParams || {};
    const requestedTimestamps = typeof clientParams.timestamps === 'string'
      ? clientParams.timestamps
      : 'sentence';
    if (!['none', 'sentence', 'word'].includes(requestedTimestamps)) {
      throw new JobError(
        'invalidInput',
        `Unsupported timestamps granularity "${requestedTimestamps}" (expected none, sentence, or word)`,
      );
    }

    const isNemotron = entry.model.engine === 'nemotron';
    const diarize = isNemotron ? Boolean(clientParams.diarize) : false;
    const hotwords = isNemotron && typeof clientParams.hotwords === 'string' && clientParams.hotwords.trim()
      ? clientParams.hotwords.trim().slice(0, 1000)
      : undefined;
    const rawPromptHint = isNemotron
      ? (clientParams.tags || clientParams.positivePrompt || '')
      : '';
    const prompt = typeof rawPromptHint === 'string' && rawPromptHint.trim()
      ? rawPromptHint.trim().slice(0, 2000)
      : undefined;

    entry.phase = 'running';
    this.loadedModelID = entry.model.id;
    const inferStart = this.now();
    let rawResult;
    try {
      rawResult = await this.backend.transcribe({
        engine: entry.model.engine,
        audioPath,
        tempDir,
        durationSeconds: actualDuration,
        timestamps: requestedTimestamps !== 'none',
        wordTimestamps: requestedTimestamps === 'word',
        diarize,
        hotwords,
        prompt,
        signal,
      });
      entry.timings.inference = (this.now() - inferStart) / 1000;
    } catch (error) {
      entry.timings.inference = (this.now() - inferStart) / 1000;
      throw error;
    }

    if (entry.aborted) throw new JobError('aborted', `Job ${job.jobID} was cancelled`);

    const canonical = buildCanonicalTranscript({
      workflowId: job.workflowId,
      rawResult,
      audioSeconds: actualDuration,
      requestedTimestamps,
      diarize,
    });
    const artifactBuffer = Buffer.from(JSON.stringify(canonical), 'utf-8');

    entry.phase = 'finished';
    const uploadStart = this.now();
    let uploaded;
    try {
      uploaded = await this.artifacts.uploadJobArtifact({
        apiUrl: this.apiUrl,
        sogniEnv: this.sogniEnv,
        jobId: job.jobID,
        imageId: job.imageId,
        buffer: artifactBuffer,
        contentType: 'application/json',
        artifactType: 'complete',
        rejectUnauthorized: this.rejectUnauthorized,
        signal,
      });
    } catch (error) {
      entry.timings.assetUpload = (this.now() - uploadStart) / 1000;
      if (isAbortError(error, signal)) throw error;
      throw new JobError('imgUploadFailure', error.message, { cause: error });
    }
    entry.timings.assetUpload = (this.now() - uploadStart) / 1000;

    return {
      jobID: job.jobID,
      imgID: job.imageId,
      performedStepCount: 1,
      lastSeed: clientParams.seed ?? 0,
      userCanceled: false,
      triggeredNSFWFilter: false,
      timings: ensureCompleteTimings(entry.timings),
      sha256: uploaded.sha256,
    };
  }

  _release(jobID, expectedEntry = null) {
    const entry = this.activeJobs.get(jobID);
    if (!entry) return;
    if (expectedEntry && entry !== expectedEntry) return;
    this.activeJobs.delete(jobID);
  }

  abort(jobID) {
    const entry = this.activeJobs.get(jobID);
    if (!entry) return false;
    entry.aborted = true;
    entry.controller.abort();
    return true;
  }

  startDrain() {
    this.draining = true;
  }
}
