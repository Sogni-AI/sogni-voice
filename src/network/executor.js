import { writeFile } from 'node:fs/promises';
import { config } from '../config/index.js';
import { tempFileManager } from '../utils/tempFile.js';
import { requestMediaDownloadUrl, requestMediaUploadUrl } from './apiClient.js';
import { downloadToFile, uploadFile } from './artifacts.js';
import { probeDurationSeconds, synthesizeTestClip, transcodeWavToMp3 } from './audioTools.js';
import { findSpeechModel } from './capabilities.js';

// `options` is the standard Error options bag, so `{ cause }` on a mapped error
// keeps the underlying adapter/daemon stack reachable.
export class JobError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = 'JobError';
    this.code = code;
  }
}

// Broker jobError codes the artist-facing path knows how to classify. Anything
// else is relayed as-is but rendered generically to the artist.
export const WORKER_ERROR_CODES = {
  modelInit: 'modelInitFailure',
  upload: 'imgUploadFailure',
  download: 'imgDownloadFailure',
  cancelled: 'workerCancelled',
};

// setTimeout stores its delay in a signed 32-bit int and silently reruns anything
// larger as 1ms, so an oversized deadline would fire the timeout race instantly.
export const MAX_TIMER_DELAY_MS = 2147483647;

// STT declared-vs-decoded enforcement: the declared keyFrame duration is the
// billed quantity and the socket cannot measure the uploaded audio, so the
// worker refuses to transcribe audio that materially outruns its bill. Slack
// covers honest container-metadata drift, not under-declaration.
export const STT_DURATION_SLACK_RATIO = 1.15;
export const STT_DURATION_SLACK_FLOOR_SEC = 5;

// The wall-clock budget scales with the workload the tier billed: text length
// for TTS (mirrors computeGenerationTimeout in src/services/qwenTts.js), the
// declared input duration for STT (Parakeet runs >120x realtime, so even the
// 0.5x factor is generous).
export function computeJobTimeout(job, fallbackMs = config.networkWorker.defaultJobTimeoutMs) {
  const kf = job?.keyFrames?.[0] || {};
  const text = typeof kf.positivePrompt === 'string' ? kf.positivePrompt : '';
  const declaredSec = Number(kf.duration) || 0;
  const scaled = fallbackMs + text.length * 40 + declaredSec * 500;
  return Math.min(900000, Math.max(fallbackMs, Math.min(scaled, MAX_TIMER_DELAY_MS)));
}

// The service adapters take no per-call timeout, so the deadline is enforced here.
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

const OUTPUT_CONTENT_TYPES = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  json: 'application/json',
};

export class SpeechExecutor {
  constructor({
    speechModels,
    apiUrl,
    maxConcurrentJobs = config.networkWorker.maxConcurrentJobs,
    transcriptionService,
    ttsService,
    qwenTtsService = null,
    tempFiles = tempFileManager,
    artifacts = { downloadToFile, uploadFile },
    api = { requestMediaDownloadUrl, requestMediaUploadUrl },
    tools = { probeDurationSeconds, synthesizeTestClip, transcodeWavToMp3 },
    writeArtifact = writeFile,
    now = () => Date.now(),
  }) {
    this.speechModels = speechModels;
    this.apiUrl = apiUrl;
    this.maxConcurrentJobs = maxConcurrentJobs;
    this.transcriptionService = transcriptionService;
    this.ttsService = ttsService;
    this.qwenTtsService = qwenTtsService;
    this.tempFiles = tempFiles;
    this.artifacts = artifacts;
    this.api = api;
    this.tools = tools;
    this.writeArtifact = writeArtifact;
    this.now = now;
    this.draining = false;
    this.activeJobs = new Map();
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
    if (job.jobType !== 'audio') {
      throw new JobError('invalid_request', `Unsupported jobType "${job.jobType}"`);
    }
    const kf = job.keyFrames?.[0];
    if (!kf) {
      throw new JobError('invalid_request', 'jobRequest is missing keyFrames[0]');
    }

    const model = findSpeechModel(this.speechModels, kf.modelID);
    if (!model) {
      throw new JobError('unsupported_model', `No enabled engine for modelID "${kf.modelID}"`);
    }
    if (this.activeJobs.has(job.jobID)) {
      throw new JobError('invalid_request', `Job ${job.jobID} is already running`);
    }
    // The broker assigns one job per render worker; more than one in flight
    // means broker or worker state has diverged, so refuse rather than queue.
    if (this.activeJobs.size >= this.maxConcurrentJobs) {
      throw new JobError('capacity_exceeded', `Worker is at capacity (${this.maxConcurrentJobs} concurrent jobs)`);
    }

    this.activeJobs.set(job.jobID, { model, aborted: false });
    return model;
  }

  // `entry` is captured once and never re-read from activeJobs: abort() deletes
  // the map entry, so a by-ID lookup later in the run would miss the abort flag.
  async execute(job, { imgID }) {
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
        ? this._runStt(job, entry, tempDir, imgID)
        : this._runTts(job, entry, tempDir, imgID);

      const outcome = await withTimeout(work, timeoutMs, `Job ${job.jobID}`);
      if (entry.aborted) {
        throw new JobError('aborted', `Job ${job.jobID} was aborted`);
      }

      const seed = Number(job.keyFrames[0].seed);
      return {
        lastSeed: Number.isFinite(seed) && seed >= 0 ? seed : 0,
        performedStepCount: 1,
        timings: { ...outcome.timings, total: (this.now() - startedAt) / 1000 },
      };
    } finally {
      this._release(job.jobID, entry);
      if (tempDir) await this.tempFiles.cleanup(tempDir);
    }
  }

  async _upload(job, imgID, filePath, contentType) {
    let uploadUrl;
    try {
      uploadUrl = await this.api.requestMediaUploadUrl({
        apiUrl: this.apiUrl,
        jobId: job.jobID,
        imgId: imgID,
        contentType,
      });
      const uploaded = await this.artifacts.uploadFile(uploadUrl, filePath, { contentType });
      if (uploaded.bytes === 0) {
        throw new Error('artifact file was empty');
      }
      return uploaded;
    } catch (error) {
      throw new JobError(WORKER_ERROR_CODES.upload, error.message, { cause: error });
    }
  }

  async _runStt(job, entry, tempDir, imgID) {
    const kf = job.keyFrames[0];
    const timings = {};
    let inputPath;
    let decodedSeconds;

    if (kf.hasReferenceAudio) {
      const downloadStart = this.now();
      inputPath = `${tempDir}/input-audio`;
      try {
        const downloadUrl = await this.api.requestMediaDownloadUrl({
          apiUrl: this.apiUrl,
          jobId: job.jobID,
          type: 'referenceAudio',
        });
        await this.artifacts.downloadToFile(downloadUrl, inputPath);
      } catch (error) {
        throw new JobError(WORKER_ERROR_CODES.download, error.message, { cause: error });
      }
      timings.assetDownload = (this.now() - downloadStart) / 1000;

      decodedSeconds = await this.tools.probeDurationSeconds(inputPath);
      // Billing enforcement: the declared duration is what the artist was
      // billed. Audio that outruns it (plus honest-metadata slack) is refused
      // BEFORE transcription so no work settles against an under-declared bill.
      const declared = Number(kf.duration) > 0 ? Number(kf.duration) : 60;
      const allowance = Math.max(declared * STT_DURATION_SLACK_RATIO, declared + STT_DURATION_SLACK_FLOOR_SEC);
      if (decodedSeconds > allowance) {
        throw new JobError(
          'input_longer_than_declared',
          `Input audio is ${decodedSeconds.toFixed(1)}s but the billed duration is ${declared}s`,
        );
      }
    } else {
      // Only test jobs pass server validation without an uploaded asset; prove
      // the full pipeline (transcribe + upload) against a generated clip.
      inputPath = `${tempDir}/test-clip.wav`;
      await this.tools.synthesizeTestClip(inputPath);
      decodedSeconds = 2;
    }

    if (entry.aborted) throw new JobError('aborted', `Job ${job.jobID} was aborted`);

    const granularity = kf.timestamps || 'sentence';
    const inferenceStart = this.now();
    let result;
    try {
      result = await this.transcriptionService.transcribe(inputPath, {
        timestamps: granularity !== 'none',
        wordTimestamps: granularity === 'word',
      });
    } catch (error) {
      throw new JobError('stt_failed', error.message, { cause: error });
    }
    timings.inference = (this.now() - inferenceStart) / 1000;

    if (entry.aborted) throw new JobError('aborted', `Job ${job.jobID} was aborted`);

    // The JSON transcript artifact (#51: text + segments/timestamps).
    const transcript = {
      text: typeof result?.text === 'string' ? result.text : '',
      segments: Array.isArray(result?.timestamps) ? result.timestamps : [],
      ...(Array.isArray(result?.wordTimestamps) ? { words: result.wordTimestamps } : {}),
      durationSeconds: Number(decodedSeconds.toFixed(3)),
      model: entry.model.id,
    };
    const artifactPath = `${tempDir}/transcript.json`;
    await this.writeArtifact(artifactPath, JSON.stringify(transcript));

    const uploadStart = this.now();
    await this._upload(job, imgID, artifactPath, OUTPUT_CONTENT_TYPES.json);
    timings.assetUpload = (this.now() - uploadStart) / 1000;

    return { timings };
  }

  async _runTts(job, entry, tempDir, imgID) {
    const kf = job.keyFrames[0];
    // Synthesized verbatim, not trimmed: the broker derived the bill from this
    // exact text, so trimming would bill characters that were never spoken.
    const text = typeof kf.positivePrompt === 'string' ? kf.positivePrompt : '';
    if (!text.trim()) {
      throw new JobError('invalid_request', 'TTS jobRequest requires keyFrames[0].positivePrompt');
    }

    // The broker clamps speed to the tier range before dispatch; this re-guard
    // only catches a broker/worker contract drift, not routine input.
    let speed = config.tts.defaultSpeed;
    const hasSpeed = kf.speed !== undefined && kf.speed !== null && kf.speed !== '';
    if (entry.model.engine === 'kokoro' && hasSpeed) {
      speed = Number(kf.speed);
      if (!Number.isFinite(speed) || speed < 0.5 || speed > 2.0) {
        throw new JobError('invalid_request', 'speed must be between 0.5 and 2.0');
      }
    }

    const timings = {};
    const wavPath = `${tempDir}/output.wav`;
    const inferenceStart = this.now();
    try {
      if (entry.model.engine === 'kokoro') {
        await this.ttsService.generate(text, {
          voice: kf.voice || config.tts.defaultVoice,
          speed,
          outputPath: wavPath,
        });
      } else {
        if (!this.qwenTtsService) {
          throw new Error('Qwen preset TTS engine is not configured');
        }
        await this.qwenTtsService.generate(text, {
          voice: kf.voice || config.qwenTts.defaultVoice,
          language: kf.language || config.qwenTts.defaultLanguage,
          outputPath: wavPath,
        });
      }
    } catch (error) {
      throw new JobError('tts_failed', error.message, { cause: error });
    }
    timings.inference = (this.now() - inferenceStart) / 1000;

    if (entry.aborted) throw new JobError('aborted', `Job ${job.jobID} was aborted`);

    // The catalog stamps audio jobs mp3; wav is honored if a future tier asks.
    const format = OUTPUT_CONTENT_TYPES[kf.outputFormat || job.outputFormat] ? (kf.outputFormat || job.outputFormat) : 'mp3';
    let artifactPath = wavPath;
    if (format === 'mp3') {
      artifactPath = `${tempDir}/output.mp3`;
      try {
        await this.tools.transcodeWavToMp3(wavPath, artifactPath);
      } catch (error) {
        throw new JobError('tts_failed', error.message, { cause: error });
      }
    }

    const uploadStart = this.now();
    await this._upload(job, imgID, artifactPath, OUTPUT_CONTENT_TYPES[format]);
    timings.assetUpload = (this.now() - uploadStart) / 1000;

    return { timings };
  }

  // `expectedEntry` guards against a stale release: abort() frees the slot while
  // the uncancellable adapter call is still running, so the broker can re-issue
  // the same jobID before that first run settles.
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
    this._release(jobID, entry);
    return true;
  }

  startDrain() {
    this.draining = true;
  }
}
