import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';
import { createVoiceBackend } from './backends.js';
import { buildWorkerInfo } from './capabilities.js';
import {
  buildUserAgent,
  clampMediaWorkerConcurrency,
  COMFY_WORKER_VERSION,
  hardwareRatingForNetwork,
  isRunningInDocker,
  loadOrCreateWorkerId,
  parseModelAllowlist,
  probeHardwareInfo,
  resolveBackendMode,
  resolveSogniHosts,
  resolveWorkerCredentials,
  resolveWorkerNetwork,
  resolveWorkerType,
  workerImageIdentity,
} from './config.js';
import {
  ensureCompleteTimings,
  estimateJobEtaSeconds,
  JobError,
  VoiceSupernetExecutor,
} from './executor.js';
import { SogniSocketClient } from './socketClient.js';

export const READINESS_REFRESH_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_ETA_INTERVAL_MS = 1_000;
const UNKNOWN_FRAME_TYPE_LOG_LIMIT = 50;

export class VoiceWorkerSupervisor {
  constructor({
    client,
    executor,
    workerModels,
    hardwareRating = 70,
    hardwareInfo,
    image = workerImageIdentity(),
    readinessSessionId = randomUUID(),
    etaIntervalMs = DEFAULT_ETA_INTERVAL_MS,
    readinessRefreshIntervalMs = READINESS_REFRESH_INTERVAL_MS,
    drainTimeoutMs = config.networkWorker?.drainTimeoutMs || 120_000,
    logger = console,
  }) {
    this.client = client;
    this.executor = executor;
    this.workerModels = workerModels || [];
    this.hardwareRating = hardwareRating;
    this.hardwareInfo = hardwareInfo;
    this.image = image;
    this.readinessSessionId = readinessSessionId;
    this.etaIntervalMs = etaIntervalMs;
    this.readinessRefreshIntervalMs = readinessRefreshIntervalMs;
    this.drainTimeoutMs = drainTimeoutMs;
    this.logger = logger;

    this.readinessHolds = new Map();
    this.nextHoldId = 1;
    this.advertisedReady = false;
    this.pendingCleanupEvidence = false;
    this.readinessRefreshTimer = null;
    this.inFlight = new Set();
    this.loggedUnknownFrameTypes = new Set();
  }

  start() {
    // CRITICAL: NEVER send workerInfo or readyToAcceptJobs on 'open'!
    // Wait strictly for the broker's 'authenticated' frame.
    this.client.on('open', () => {
      this.advertisedReady = false;
      this.startReadinessRefreshLoop();
    });
    this.client.on('frame', (type, data) => this.handleFrame(type, data));
    this.client.on('close', () => {
      this.advertisedReady = false;
      this.stopReadinessRefreshLoop();
    });
    return this.client.start();
  }

  startReadinessRefreshLoop() {
    this.stopReadinessRefreshLoop();
    this.readinessRefreshTimer = setInterval(() => {
      if (this.readinessHolds.size > 0 && !this.advertisedReady) {
        this.sendReadyToAcceptJobs(false, 'readiness hold refresh');
      }
    }, this.readinessRefreshIntervalMs);
    if (typeof this.readinessRefreshTimer.unref === 'function') {
      this.readinessRefreshTimer.unref();
    }
  }

  stopReadinessRefreshLoop() {
    if (this.readinessRefreshTimer) {
      clearInterval(this.readinessRefreshTimer);
      this.readinessRefreshTimer = null;
    }
  }

  holdReadiness(reason = 'worker readiness held') {
    const holdId = this.nextHoldId++;
    this.readinessHolds.set(holdId, reason);
    this.sendReadyToAcceptJobs(false, reason);

    let released = false;
    return (releaseReason = 'worker readiness hold released') => {
      if (released) return;
      released = true;
      this.readinessHolds.delete(holdId);
      if (
        this.readinessHolds.size === 0
        && !this.executor.draining
        && this.executor.activeRequests < this.executor.maxConcurrentJobs
      ) {
        this.sendReadyToAcceptJobs(true, releaseReason);
      }
    };
  }

  sendWorkerInfo() {
    const workerInfo = buildWorkerInfo({
      workerModels: this.workerModels,
      loadedModelID: this.executor.loadedModelID,
      hardwareRating: this.hardwareRating,
      hardwareInfo: this.hardwareInfo,
      image: this.image,
      readinessSessionId: this.readinessSessionId,
      heldJobs: this.executor.getHeldJobs(),
    });
    this.client.send('workerInfo', workerInfo);
    this.logger.log(
      `[voice-worker] Advertised models (${this.hardwareInfo?.gpuBrand || 'GPU'}, rating=${this.hardwareRating}): ${workerInfo.workerModels.join(', ')}`,
    );
  }

  sendReadyToAcceptJobs(ready, reason = '', evidence = {}) {
    const holdReason = this.readinessHolds.size > 0
      ? [...this.readinessHolds.values()].join(', ')
      : null;
    const atCapacity = this.executor.activeRequests >= this.executor.maxConcurrentJobs;
    const effectiveReady = Boolean(
      ready
      && !this.executor.draining
      && this.readinessHolds.size === 0
      && !atCapacity,
    );

    if (!effectiveReady && evidence.postDisconnectCleanupComplete === true) {
      this.pendingCleanupEvidence = true;
    }

    const includeCleanupEvidence = effectiveReady && (
      evidence.postDisconnectCleanupComplete === true
      || this.pendingCleanupEvidence
    );
    if (effectiveReady) {
      this.pendingCleanupEvidence = false;
    }

    this.advertisedReady = effectiveReady;
    this.client.send('readyToAcceptJobs', {
      ready: effectiveReady,
      reason: effectiveReady
        ? (reason || '')
        : (holdReason
          || (this.executor.draining ? 'draining' : '')
          || (atCapacity ? 'job in progress' : '')
          || reason
          || 'worker readiness held'),
      ...(includeCleanupEvidence
        ? {
            postDisconnectCleanupComplete: true,
            readinessSessionId: this.readinessSessionId,
          }
        : {}),
    });
  }

  handleFrame(type, data) {
    switch (type) {
      case 'authenticated': {
        this.logger.log('[voice-worker] Authenticated with Sogni socket');
        this.sendWorkerInfo();
        if (this.executor.activeRequests >= this.executor.maxConcurrentJobs) {
          this.sendReadyToAcceptJobs(false, 'job in progress', {
            postDisconnectCleanupComplete: true,
          });
        } else {
          this.sendReadyToAcceptJobs(true, 'authenticated', {
            postDisconnectCleanupComplete: true,
          });
        }
        break;
      }
      case 'jobRequest': {
        const running = this.handleJobRequest(data)
          .catch((error) => {
            this.logger.error(`[voice-worker] Job dispatch crashed: ${error?.message || error}`);
          })
          .finally(() => this.inFlight.delete(running));
        this.inFlight.add(running);
        break;
      }
      case 'jobCancel':
      case 'jobError': {
        this.handleCancel(data);
        break;
      }
      case 'jobReclaim': {
        const released = Array.isArray(data?.released) ? data.released : [];
        for (const jobID of released) {
          if (typeof jobID === 'string') {
            this.executor.abort(jobID);
          }
        }
        break;
      }
      case 'modelDownloadSuggest':
      case 'config':
      case 'runtimeUpdateAvailable':
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
      `[voice-worker] Ignoring unhandled frame type "${type}" (further occurrences suppressed)`,
    );
  }

  handleCancel(data) {
    const jobID = data?.jobID;
    if (!jobID || typeof jobID !== 'string') return;
    if (this.executor.abort(jobID)) {
      this.logger.log(`[voice-worker] Cancelled in-flight job ${jobID}`);
    }
  }

  async handleJobRequest(job) {
    if (!job || typeof job.jobID !== 'string' || !job.jobID) {
      this.logger.warn?.('[voice-worker] Ignoring malformed jobRequest without jobID');
      return;
    }

    let accepted;
    try {
      accepted = this.executor.accept(job);
    } catch (error) {
      // Sogni socket expects jobStarted before jobResult/jobError for any assigned job.
      this.client.send('jobState', {
        type: 'jobStarted',
        jobID: job.jobID,
        ...(job.imageId ? { imgID: job.imageId } : {}),
      });
      this._sendFailureSequence(job, error, ensureCompleteTimings());
      return;
    }

    const { model } = accepted;
    this.advertisedReady = false;
    this.client.send('jobState', {
      type: 'jobStarted',
      jobID: job.jobID,
      ...(job.imageId ? { imgID: job.imageId } : {}),
    });

    const startedAt = Date.now();
    const etaTimer = setInterval(() => {
      const elapsedSec = (Date.now() - startedAt) / 1000;
      const etaSeconds = estimateJobEtaSeconds(job, model, elapsedSec);
      this.client.send('jobETA', { jobID: job.jobID, etaSeconds });
    }, this.etaIntervalMs);
    if (typeof etaTimer.unref === 'function') etaTimer.unref();

    try {
      const result = await this.executor.execute(job);
      clearInterval(etaTimer);

      // Exact 3-frame completion sequence required by sogni-socket:
      // 1. jobResult -> 2. jobState(jobCompleted) -> 3. readyToAcceptJobs(true)
      this.client.send('jobResult', result);
      this.client.send('jobState', { type: 'jobCompleted', jobID: job.jobID });
      this.sendReadyToAcceptJobs(true, `job ${job.jobID} completed`);

      this.logger.log(
        `[voice-worker] Completed ${job.workflowId} job ${job.jobID} in ${((Date.now() - startedAt) / 1000).toFixed(2)}s`,
      );
    } catch (error) {
      clearInterval(etaTimer);
      const timings = error?.timings || this.executor.getTimings(job.jobID);
      if (error instanceof JobError && error.code === 'aborted') {
        this._sendCancelSequence(job, timings);
        return;
      }
      this._sendFailureSequence(job, error, timings);
    }
  }

  _sendCancelSequence(job, timings) {
    this.client.send('jobResult', {
      jobID: job.jobID,
      ...(job.imageId ? { imgID: job.imageId } : {}),
      performedStepCount: 0,
      lastSeed: job.clientParams?.seed ?? 0,
      userCanceled: true,
      triggeredNSFWFilter: false,
      timings: ensureCompleteTimings(timings),
    });
    this.client.send('jobError', {
      jobID: job.jobID,
      imgID: job.imageId || null,
      error: 'artistCanceled',
      error_message: 'Job cancelled',
      isFromWorker: true,
    });
    this.sendReadyToAcceptJobs(true, `job ${job.jobID} cancelled`);
  }

  _sendFailureSequence(job, error, timings) {
    const rawCode = error instanceof JobError ? error.code : 'genfailure';
    const errorCode = ['invalidInput', 'imgUploadFailure', 'sensitiveContent'].includes(rawCode)
      ? rawCode
      : 'genfailure';
    const message = error?.message || String(error);

    this.client.send('jobResult', {
      jobID: job.jobID,
      ...(job.imageId ? { imgID: job.imageId } : {}),
      performedStepCount: 0,
      lastSeed: job.clientParams?.seed ?? 0,
      userCanceled: false,
      triggeredNSFWFilter: false,
      timings: ensureCompleteTimings(timings),
    });
    this.client.send('jobError', {
      jobID: job.jobID,
      imgID: job.imageId || null,
      error: errorCode,
      error_message: message,
      isFromWorker: true,
    });
    this.sendReadyToAcceptJobs(true, `job ${job.jobID} failed`);

    this.logger.error(`[voice-worker] Job ${job.jobID} failed (${errorCode}): ${message}`);
    if (error?.cause) {
      this.logger.error(`[voice-worker] Job ${job.jobID} caused by:`, error.cause);
    }
  }

  async shutdown() {
    this.executor.startDrain();
    this.stopReadinessRefreshLoop();
    if (this.advertisedReady) {
      this.sendReadyToAcceptJobs(false, 'worker shutting down');
    }
    this.logger.log(`[voice-worker] Draining ${this.inFlight.size} in-flight job(s)`);

    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.logger.error(`[voice-worker] Drain timed out after ${this.drainTimeoutMs}ms`);
          resolve();
        }, this.drainTimeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);

    this.client.close();
  }
}

export async function createSupervisor(overrides = {}) {
  const hosts = overrides.hosts || resolveSogniHosts({
    sogniEnv: overrides.sogniEnv || config.networkWorker?.sogniEnv,
  });
  const credentials = overrides.credentials || resolveWorkerCredentials();
  if (!credentials.apiKey) {
    throw new Error(
      'SOGNI_API_KEY (or API_KEY / SOGNI_WORKER_API_KEY) is required to start the Sogni Supernet worker',
    );
  }

  const backendMode = overrides.backendMode || resolveBackendMode(
    config.networkWorker?.backendMode || process.env.SOGNI_VOICE_BACKEND_MODE,
    {
      defaultMode: overrides.defaultBackendMode || 'local',
      apiUrl: config.networkWorker?.voiceApiUrl || process.env.SOGNI_VOICE_API_URL,
    },
  );
  const allowlist = overrides.allowlist ?? parseModelAllowlist();

  let executorRef = overrides.executor || null;
  const backend = overrides.backend || createVoiceBackend({
    mode: backendMode,
    cfg: config,
    apiUrl: overrides.voiceApiUrl || config.networkWorker?.voiceApiUrl || process.env.SOGNI_VOICE_API_URL || 'http://127.0.0.1:3000',
    apiKey: overrides.voiceApiKey ?? config.networkWorker?.voiceApiKey ?? process.env.SOGNI_VOICE_API_KEY ?? config.auth?.apiKey ?? '',
    allowlist,
    ownsDaemons: overrides.ownsDaemons ?? (backendMode === 'local'),
    getActiveRequests: () => (executorRef ? executorRef.activeRequests : 0),
    logger: overrides.logger || console,
  });

  const workerModels = overrides.workerModels || await backend.discoverModels();
  if (!workerModels || workerModels.length === 0) {
    throw new Error(
      `No enabled Sogni voice models discovered in "${backend.mode}" mode; enable Drama 3, Parakeet, or Nemotron before starting the worker.`,
    );
  }

  const hardwareInfo = overrides.hardwareInfo || await probeHardwareInfo();
  const workerNetwork = overrides.workerNetwork || resolveWorkerNetwork(config.networkWorker?.workerNetwork);
  const hardwareRating = overrides.hardwareRating ?? hardwareRatingForNetwork(workerNetwork);
  const workerId = overrides.workerId || loadOrCreateWorkerId(config.networkWorker?.workerIdFile);
  const workerVersion = COMFY_WORKER_VERSION;

  const executor = executorRef || new VoiceSupernetExecutor({
    workerModels,
    backend,
    apiUrl: hosts.api,
    sogniEnv: hosts.env,
    rejectUnauthorized: hosts.env === 'local' ? false : undefined,
    maxConcurrentJobs: clampMediaWorkerConcurrency(
      overrides.maxConcurrentJobs || config.networkWorker?.maxConcurrentJobs || 1,
    ),
  });
  executorRef = executor;

  const validateKeyFlag = overrides.validateClientKey
    ?? config.networkWorker?.validateClientKey
    ?? true;

  const client = overrides.client || new SogniSocketClient({
    url: hosts.socket,
    socketApiUrl: hosts.socketApi,
    origin: hosts.socket,
    sogniEnv: hosts.env,
    apiKey: credentials.apiKey,
    nftTokenId: credentials.nftTokenId,
    workerId,
    workerType: resolveWorkerType(config.networkWorker?.workerType),
    runningInDocker: isRunningInDocker(),
    userAgent: buildUserAgent({ workerVersion }),
    validateClientKey: validateKeyFlag,
    reconnectInitialDelayMs: config.networkWorker?.reconnectInitialDelayMs || 2_000,
    reconnectMaxDelayMs: config.networkWorker?.reconnectMaxDelayMs || 30_000,
    logger: overrides.logger || console,
  });

  const supervisor = new VoiceWorkerSupervisor({
    client,
    executor,
    workerModels,
    hardwareRating,
    hardwareInfo,
    image: workerImageIdentity(),
    drainTimeoutMs: config.networkWorker?.drainTimeoutMs || 120_000,
    logger: overrides.logger || console,
  });

  return { supervisor, backend, client, executor, workerModels, hardwareInfo, hosts };
}

export async function startVoiceSupernetWorker(options = {}) {
  const bundle = await createSupervisor(options);
  if (options.preWarm ?? config.networkWorker?.preWarm ?? true) {
    await bundle.backend.preWarm(bundle.workerModels);
  }
  await bundle.supervisor.start();
  return bundle;
}
