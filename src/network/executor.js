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

  _release(jobID) {
    const entry = this.activeJobs.get(jobID);
    if (!entry) return;

    this.activeJobs.delete(jobID);
    const remaining = (this.modelCounts.get(entry.model.id) || 1) - 1;
    if (remaining <= 0) this.modelCounts.delete(entry.model.id);
    else this.modelCounts.set(entry.model.id, remaining);
  }

  abort(jobID) {
    const entry = this.activeJobs.get(jobID);
    if (!entry) return false;

    entry.aborted = true;
    this._release(jobID);
    return true;
  }

  startDrain() {
    this.draining = true;
  }
}
