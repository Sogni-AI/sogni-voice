import { config } from '../config/index.js';
import { transcriptionService } from '../services/transcription.js';
import { ttsService } from '../services/tts.js';
import { qwenTtsBaseService } from '../services/qwenTts.js';
import { buildSpeechModels, buildWorkerInfo } from './capabilities.js';
import { buildUserAgent, loadOrCreateWorkerId, resolveSocketUrl } from './config.js';
import { JobError, SpeechExecutor } from './executor.js';
import { SogniSocketClient } from './socketClient.js';

// A broker that streams an unrecognized frame type at us — a protocol addition we
// have not shipped support for yet — would otherwise write one log line per frame
// forever. One line per type is all the diagnostic anyone needs; the cap bounds
// the set itself against a peer emitting unbounded distinct types.
const UNKNOWN_FRAME_TYPE_LOG_LIMIT = 50;

export class SpeechWorkerSupervisor {
  constructor({
    client,
    executor,
    speechModels,
    maxConcurrentJobs,
    capacityIntervalMs = config.networkWorker.capacityIntervalMs,
    progressIntervalMs = 30000,
    drainTimeoutMs = config.networkWorker.drainTimeoutMs,
    logger = console,
  }) {
    this.client = client;
    this.executor = executor;
    this.speechModels = speechModels;
    this.maxConcurrentJobs = maxConcurrentJobs;
    this.capacityIntervalMs = capacityIntervalMs;
    this.progressIntervalMs = progressIntervalMs;
    this.drainTimeoutMs = drainTimeoutMs;
    this.logger = logger;
    this.capacityTimer = null;
    this.inFlight = new Set();
    this.loggedUnknownFrameTypes = new Set();
  }

  start() {
    this.client.on('open', () => {
      this.sendWorkerInfo();
      this.startCapacityLoop();
    });
    this.client.on('frame', (type, data) => this.handleFrame(type, data));
    this.client.on('close', () => this.stopCapacityLoop());
    this.client.connect();
  }

  // The client's safeEmit only catches a listener's *synchronous* throw, so every
  // async path started here owns its own rejection handling.
  handleFrame(type, data) {
    switch (type) {
      case 'authenticated':
        this.logger.log('[speech-worker] Broker authenticated the worker');
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
      case 'jobError':
      case 'jobCancel':
        this.handleAbort(data);
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
    const workerInfo = buildWorkerInfo({
      speechModels: this.speechModels,
      maxConcurrentJobs: this.maxConcurrentJobs,
    });
    this.client.send('workerInfo', workerInfo);
    const advertised = workerInfo.speechModels.map((model) => `${model.id}/${model.task}`);
    this.logger.log(`[speech-worker] Registered: ${advertised.join(', ') || 'no models'}`);
  }

  sendCapacityUpdate() {
    this.client.send('speechCapacityUpdate', { activeRequests: this.executor.activeRequests });
  }

  startCapacityLoop() {
    this.stopCapacityLoop();
    this.capacityTimer = setInterval(() => this.sendCapacityUpdate(), this.capacityIntervalMs);
    if (typeof this.capacityTimer.unref === 'function') this.capacityTimer.unref();
  }

  stopCapacityLoop() {
    if (this.capacityTimer) {
      clearInterval(this.capacityTimer);
      this.capacityTimer = null;
    }
  }

  // A dataless broker frame decodes to null, so every field read is optional.
  handleAbort(data) {
    const jobID = data?.jobID;
    if (!jobID) return;
    if (this.executor.abort(jobID)) {
      this.logger.log(`[speech-worker] Aborted job ${jobID} at broker request`);
    }
  }

  async handleJobRequest(job) {
    try {
      this.executor.accept(job);
    } catch (error) {
      this.sendJobError(job?.jobID, error);
      return;
    }

    this.client.send('jobState', { jobID: job.jobID, state: 'accepted' });
    this.client.send('jobState', { jobID: job.jobID, state: 'started' });

    // Liveness keepalive: the broker refreshes the job's lastActivityTime on
    // every jobProgress frame and reaps (and refunds) jobs that go silent, so
    // a long synthesis MUST pulse even though the daemons report no progress.
    const startedAt = Date.now();
    const progressTimer = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const progress = Math.min(0.95, elapsed / (job.timeoutMs || 600000));
      this.client.send('jobProgress', { jobID: job.jobID, progress });
    }, this.progressIntervalMs);
    if (typeof progressTimer.unref === 'function') progressTimer.unref();

    try {
      const result = await this.executor.execute(job);
      this.client.send('jobResult', result);
      this.logger.log(
        `[speech-worker] Completed job ${job.jobID} in ${result?.meta?.durationMs}ms`,
      );
    } catch (error) {
      // The broker initiated the abort, so it needs no failure frame back.
      if (error instanceof JobError && error.code === 'aborted') {
        this.logger.log(`[speech-worker] Job ${job.jobID} stopped after abort`);
        return;
      }
      this.sendJobError(job.jobID, error);
    } finally {
      clearInterval(progressTimer);
    }
  }

  sendJobError(jobID, error) {
    const code = error instanceof JobError ? error.code : 'internal_error';
    const message = error?.message || String(error);
    this.client.send('jobError', { jobID: jobID || 'unknown', code, message });
    this.logger.error(`[speech-worker] Job ${jobID} failed (${code}): ${message}`);

    // The frame carries only the adapter's message string. When the executor mapped
    // an underlying failure, its stack is the one worth having in the log — a daemon
    // crash otherwise reads as a bare "exited with code 1" with no trace of where.
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
    this.stopCapacityLoop();
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
    maxConcurrentJobs: networkConfig.maxConcurrentJobs,
    transcriptionService,
    ttsService,
    qwenTtsService: config.qwenTts.enabled ? qwenTtsBaseService : null,
  });

  const client = overrides.client || new SogniSocketClient({
    url: resolveSocketUrl(networkConfig.sogniEnv),
    apiKey: networkConfig.apiKey,
    workerId: loadOrCreateWorkerId(networkConfig.workerIdFile),
    userAgent: buildUserAgent(),
    reconnectInitialDelayMs: networkConfig.reconnectInitialDelayMs,
    reconnectMaxDelayMs: networkConfig.reconnectMaxDelayMs,
  });

  return new SpeechWorkerSupervisor({
    client,
    executor,
    speechModels,
    maxConcurrentJobs: networkConfig.maxConcurrentJobs,
    capacityIntervalMs: networkConfig.capacityIntervalMs,
    drainTimeoutMs: networkConfig.drainTimeoutMs,
  });
}
