import { config } from '../config/index.js';
import { tempFileManager } from '../utils/tempFile.js';
import { downloadToFile, uploadFile } from './artifacts.js';
import { findSpeechModel } from './capabilities.js';

export class JobError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobError';
    this.code = code;
  }
}

// Mirrors computeGenerationTimeout() in src/services/qwenTts.js:17 — long TTS
// input costs wall time roughly linearly in characters. Used only when the
// broker omits timeoutMs.
export function computeJobTimeout(job, fallbackMs = config.networkWorker.defaultJobTimeoutMs) {
  const requested = Number(job?.timeoutMs);
  if (Number.isFinite(requested) && requested > 0) return requested;

  const text = typeof job?.params?.text === 'string' ? job.params.text : '';
  const scaled = fallbackMs + text.length * 40;
  return Math.min(900000, Math.max(fallbackMs, scaled));
}

// The service adapters take no per-call timeout (src/services/transcription.js:190,
// src/services/tts.js:193), so the broker's deadline is enforced out here.
export function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new JobError('timeout', `${label} exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function extensionFromUrl(url, fallback = 'wav') {
  try {
    const name = new URL(url).pathname.split('/').pop() || '';
    const dot = name.lastIndexOf('.');
    if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1).toLowerCase();
  } catch {
    return fallback;
  }
  return fallback;
}

// Batch Parakeet returns text plus optional segments and no duration
// (scripts/parakeet_daemon.py:140), so billable audio length comes from the end
// of the last sentence segment.
export function deriveAudioSeconds(result) {
  const segments = Array.isArray(result?.timestamps) ? result.timestamps : [];
  if (segments.length === 0) return null;

  const last = segments[segments.length - 1];
  return typeof last?.end === 'number' ? Number(last.end.toFixed(3)) : null;
}

export class SpeechExecutor {
  constructor({
    speechModels,
    maxConcurrentJobs = config.networkWorker.maxConcurrentJobs,
    transcriptionService,
    ttsService,
    qwenTtsService = null,
    tempFiles = tempFileManager,
    artifacts = { downloadToFile, uploadFile },
    now = () => Date.now(),
  }) {
    this.speechModels = speechModels;
    this.maxConcurrentJobs = maxConcurrentJobs;
    this.transcriptionService = transcriptionService;
    this.ttsService = ttsService;
    this.qwenTtsService = qwenTtsService;
    this.tempFiles = tempFiles;
    this.artifacts = artifacts;
    this.now = now;
    this.draining = false;
    this.activeJobs = new Map();
    this.modelCounts = new Map();
  }

  get activeRequests() {
    return this.activeJobs.size;
  }

  accept(job) {
    if (this.draining) {
      throw new JobError('draining', 'Worker is draining and not accepting new jobs');
    }
    if (!job || typeof job.jobID !== 'string' || job.jobID.length === 0) {
      throw new JobError('invalid_request', 'jobRequest is missing jobID');
    }
    if (job.jobType !== 'speech') {
      throw new JobError('invalid_request', `Unsupported jobType "${job.jobType}"`);
    }
    if (this.activeJobs.has(job.jobID)) {
      throw new JobError('invalid_request', `Job ${job.jobID} is already running`);
    }

    const model = findSpeechModel(this.speechModels, job.modelID, job.task);
    if (!model) {
      throw new JobError(
        'unsupported_model',
        `No enabled engine for modelID "${job.modelID}" task "${job.task}"`,
      );
    }
    if (this.activeJobs.size >= this.maxConcurrentJobs) {
      throw new JobError(
        'capacity_exceeded',
        `Worker is at capacity (${this.maxConcurrentJobs} concurrent jobs)`,
      );
    }

    const modelCount = this.modelCounts.get(model.id) || 0;
    if (modelCount >= model.maxConcurrent) {
      throw new JobError(
        'capacity_exceeded',
        `Model ${model.id} is at capacity (${model.maxConcurrent} concurrent jobs)`,
      );
    }

    this.activeJobs.set(job.jobID, { model, aborted: false });
    this.modelCounts.set(model.id, modelCount + 1);
    return model;
  }

  // `entry` is captured once here and never re-read from activeJobs: abort() deletes
  // the map entry, so a by-ID lookup later in the run would miss the abort flag and
  // report a cancelled job as a success.
  async execute(job) {
    const entry = this.activeJobs.get(job.jobID);
    if (!entry) {
      throw new JobError('invalid_request', `Job ${job.jobID} was not accepted`);
    }

    const startedAt = this.now();
    const timeoutMs = computeJobTimeout(job);
    let tempDir = null;

    try {
      tempDir = await this.tempFiles.createTempDir('sogni-speech-job-');

      const work = entry.model.task === 'stt'
        ? this._runStt(job, entry, tempDir)
        : this._runTts(job, entry, tempDir);

      const outcome = await withTimeout(work, timeoutMs, `Job ${job.jobID}`);
      if (entry.aborted) {
        throw new JobError('aborted', `Job ${job.jobID} was aborted`);
      }

      return {
        jobID: job.jobID,
        ...outcome.payload,
        meta: { ...outcome.meta, durationMs: this.now() - startedAt },
      };
    } finally {
      this._release(job.jobID, entry);
      if (tempDir) await this.tempFiles.cleanup(tempDir);
    }
  }

  async _runStt(job, entry, tempDir) {
    if (!job.input || typeof job.input.url !== 'string') {
      throw new JobError('invalid_request', 'STT jobRequest requires input.url');
    }

    const inputPath = `${tempDir}/input.${extensionFromUrl(job.input.url)}`;
    // A failed download can still leave a zero-byte file at inputPath, so the daemon
    // is only handed the path once downloadToFile has resolved.
    try {
      await this.artifacts.downloadToFile(job.input.url, inputPath);
    } catch (error) {
      throw new JobError('input_download_failed', error.message);
    }

    if (entry.aborted) throw new JobError('aborted', `Job ${job.jobID} was aborted`);

    let result;
    try {
      result = await this.transcriptionService.transcribe(inputPath, { timestamps: true });
    } catch (error) {
      throw new JobError('stt_failed', error.message);
    }

    return {
      payload: { transcript: result },
      meta: { audioSeconds: deriveAudioSeconds(result) },
    };
  }

  // `expectedEntry` guards against a stale release: abort() frees the slot while the
  // uncancellable adapter call is still running, so the broker can re-issue the same
  // jobID before that first run settles. Releasing by ID alone would then evict the
  // replacement job and let the worker over-admit past the model's maxConcurrent.
  _release(jobID, expectedEntry = null) {
    const entry = this.activeJobs.get(jobID);
    if (!entry) return;
    if (expectedEntry && entry !== expectedEntry) return;

    this.activeJobs.delete(jobID);
    const remaining = (this.modelCounts.get(entry.model.id) || 1) - 1;
    if (remaining <= 0) this.modelCounts.delete(entry.model.id);
    else this.modelCounts.set(entry.model.id, remaining);
  }

  abort(jobID) {
    const entry = this.activeJobs.get(jobID);
    if (!entry) return false;

    entry.aborted = true;
    this._release(jobID, entry);
    return true;
  }

  startDrain() {
    this.draining = true;
  }
}
