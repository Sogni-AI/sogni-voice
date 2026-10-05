import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';
import { transcriptionService } from '../services/transcription.js';
import { ttsService } from '../services/tts.js';
import { qwenTtsCustomVoiceService } from '../services/qwenTts.js';
import { buildSpeechModels, buildWorkerInfo } from './capabilities.js';
import { buildUserAgent, loadOrCreateWorkerId, resolveApiUrl, resolveSocketUrl } from './config.js';
import { JobError, SpeechExecutor, WORKER_ERROR_CODES } from './executor.js';
import { SogniSocketClient } from './socketClient.js';

// A broker that streams an unrecognized frame type at us would otherwise write
// one log line per frame forever. One line per type is all the diagnostic
// anyone needs; the cap bounds the set itself.
const UNKNOWN_FRAME_TYPE_LOG_LIMIT = 50;

// The audio reaper allows 120s between updates once a job is started; pulsing
// well inside that keeps a long synthesis alive and observable.
const PROGRESS_PULSE_INTERVAL_MS = 25000;

export class SpeechWorkerSupervisor {
  constructor({
    client,
    executor,
    speechModels,
    drainTimeoutMs = config.networkWorker.drainTimeoutMs,
    progressIntervalMs = PROGRESS_PULSE_INTERVAL_MS,
    logger = console,
  }) {
    this.client = client;
    this.executor = executor;
    this.speechModels = speechModels;
    this.drainTimeoutMs = drainTimeoutMs;
    this.progressIntervalMs = progressIntervalMs;
    this.logger = logger;
    this.inFlight = new Set();
    // jobID -> imgID for jobs currently running; lets an inbound cancellation
    // echo the jobError with the imgID the broker expects.
    this.runningJobs = new Map();
    this.loggedUnknownFrameTypes = new Set();
  }

  start() {
    this.client.on('frame', (type, data) => this.handleFrame(type, data));
    this.client.connect();
  }

  // The client's safeEmit only catches a listener's *synchronous* throw, so every
  // async path started here owns its own rejection handling.
  handleFrame(type, data) {
    switch (type) {
      // The broker ignores everything sent before 'authenticated'; workerInfo
      // goes out only in response to it (once per (re)connection).
      case 'authenticated':
        this.logger.log(`[speech-worker] Authenticated as ${data?.username || data?.address || 'unknown'}`);
        this.sendWorkerInfo();
        break;
      case 'jobRequest': {
        const running = this.handleJobRequest(data)
          .catch((error) => {
            this.logger.error(`[speech-worker] Job dispatch crashed: ${error?.message || error}`);
          })
          .finally(() => this.inFlight.delete(running));
        this.inFlight.add(running);
        break;
      }
      // There is no dedicated cancel message for render workers: cancellation
      // arrives as a jobError with isFromWorker: false.
      case 'jobError':
        this.handleCancellation(data);
        break;
      case 'modelDownloadSuggest':
      case 'pong':
      case 'socketEventSubscriptionsUpdated':
        break;
      default:
        this.logUnknownFrame(type);
    }
  }

  logUnknownFrame(type) {
    if (this.loggedUnknownFrameTypes.has(type)) return;
    if (this.loggedUnknownFrameTypes.size >= UNKNOWN_FRAME_TYPE_LOG_LIMIT) return;

    this.loggedUnknownFrameTypes.add(type);
    this.logger.log(
      `[speech-worker] Ignoring frame type ${type} (further occurrences not logged)`,
    );
  }

  sendWorkerInfo() {
    const workerInfo = buildWorkerInfo({ speechModels: this.speechModels });
    this.client.send('workerInfo', workerInfo);
    this.logger.log(
      `[speech-worker] Registered as fast worker (rating ${workerInfo.hardwareRating}): ${workerInfo.workerModels.join(', ')}`,
    );
  }

  // A dataless broker frame decodes to null, so every field read is optional.
  handleCancellation(data) {
    const jobID = data?.jobID;
    if (!jobID) return;

    const imgID = this.runningJobs.get(jobID);
    if (!this.executor.abort(jobID)) return;

    this.logger.log(`[speech-worker] Cancelling job ${jobID} at broker request (${data?.error || 'no reason'})`);
    // The broker waits for the worker to echo a jobError back to settle the
    // cancellation, then readyToAcceptJobs clears the 30s cancel cooldown.
    this.client.send('jobError', {
      jobID,
      imgID: imgID || randomUUID().toUpperCase(),
      isFromWorker: true,
      error: WORKER_ERROR_CODES.cancelled,
      error_message: 'Job cancelled at broker request',
    });
    this.client.send('readyToAcceptJobs', { ready: true });
  }

  async handleJobRequest(job) {
    // The worker mints the asset id: it is the upload key and the id the artist
    // downloads by. Uppercase UUID by broker convention.
    const imgID = randomUUID().toUpperCase();

    try {
      this.executor.accept(job);
    } catch (error) {
      this.sendJobError(job?.jobID, imgID, error);
      return;
    }

    this.runningJobs.set(job.jobID, imgID);

    // jobStarted latches imgID broker-side and starts the 120s inter-update
    // budget. A jobState without `type` earns a 24h shadowban, so these frames
    // are built inline and never from spread payloads.
    this.client.send('jobState', { type: 'jobStarted', jobID: job.jobID, imgID });

    const progressTimer = setInterval(() => {
      this.client.send('jobProgress', { jobID: job.jobID, imgID, step: 0, stepCount: 1 });
    }, this.progressIntervalMs);
    if (typeof progressTimer.unref === 'function') progressTimer.unref();

    try {
      const result = await this.executor.execute(job, { imgID });
      // Ordering is load-bearing: jobResult must reach the broker before
      // jobCompleted or the worker is shadowbanned for 24h.
      this.client.send('jobResult', {
        jobID: job.jobID,
        imgID,
        lastSeed: result.lastSeed,
        userCanceled: false,
        triggeredNSFWFilter: false,
        performedStepCount: result.performedStepCount,
        timings: result.timings,
      });
      this.client.send('jobState', { type: 'jobCompleted', jobID: job.jobID, imgID });
      this.logger.log(
        `[speech-worker] Completed job ${job.jobID} in ${result.timings?.total?.toFixed(2)}s`,
      );
    } catch (error) {
      // The broker initiated the abort and already got its jobError echo.
      if (error instanceof JobError && error.code === 'aborted') {
        this.logger.log(`[speech-worker] Job ${job.jobID} stopped after cancellation`);
        return;
      }
      this.sendJobError(job.jobID, imgID, error);
    } finally {
      clearInterval(progressTimer);
      this.runningJobs.delete(job.jobID);
    }
  }

  sendJobError(jobID, imgID, error) {
    const code = error instanceof JobError ? error.code : 'internal_error';
    const message = error?.message || String(error);
    this.client.send('jobError', {
      jobID: jobID || 'unknown',
      imgID,
      isFromWorker: true,
      error: code,
      error_message: message,
    });
    this.logger.error(`[speech-worker] Job ${jobID} failed (${code}): ${message}`);

    // The frame carries only the mapped message string. When the executor mapped
    // an underlying failure, its stack is the one worth having in the log.
    if (error?.cause) {
      this.logger.error(`[speech-worker] Job ${jobID} caused by:`, error.cause);
    }
  }

  // Gated on inFlight, not executor idleness: execute() frees its concurrency slot
  // in a finally that runs before its promise resolves, so an idle executor can
  // still have a jobResult unwritten. An inFlight entry settles only once the
  // terminal frame is on the wire.
  async shutdown() {
    this.executor.startDrain();
    this.logger.log(`[speech-worker] Draining ${this.inFlight.size} in-flight job(s)`);

    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.logger.error(`[speech-worker] Drain timed out after ${this.drainTimeoutMs}ms`);
          resolve();
        }, this.drainTimeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);

    this.client.close();
  }
}

export function createSupervisor(overrides = {}) {
  const networkConfig = config.networkWorker;
  const speechModels = overrides.speechModels || buildSpeechModels();

  const executor = overrides.executor || new SpeechExecutor({
    speechModels,
    apiUrl: resolveApiUrl(networkConfig.sogniEnv),
    maxConcurrentJobs: networkConfig.maxConcurrentJobs,
    transcriptionService,
    ttsService,
    // PRESET synthesis must use the CustomVoice daemon; the Base daemon only
    // resolves voice-clone IDs (staging canary finding, 2026-07-30).
    qwenTtsService: config.qwenTts.enabled ? qwenTtsCustomVoiceService : null,
  });

  const client = overrides.client || new SogniSocketClient({
    url: resolveSocketUrl(networkConfig.sogniEnv),
    apiKey: networkConfig.apiKey,
    nftTokenId: networkConfig.nftTokenId,
    workerId: loadOrCreateWorkerId(networkConfig.workerIdFile),
    userAgent: buildUserAgent(),
    reconnectInitialDelayMs: networkConfig.reconnectInitialDelayMs,
    reconnectMaxDelayMs: networkConfig.reconnectMaxDelayMs,
  });

  return new SpeechWorkerSupervisor({
    client,
    executor,
    speechModels,
    drainTimeoutMs: networkConfig.drainTimeoutMs,
  });
}
