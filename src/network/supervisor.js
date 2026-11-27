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
  resolveJobImageId,
  VoiceSupernetExecutor,
} from './executor.js';
import { SogniSocketClient } from './socketClient.js';

export const READINESS_REFRESH_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_ETA_INTERVAL_MS = 1_000;
export const DEFAULT_RECLAIM_TIMEOUT_MS = 5_000;
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
    reclaimTimeoutMs = DEFAULT_RECLAIM_TIMEOUT_MS,
    drainTimeoutMs = config.networkWorker?.drainTimeoutMs || 120_000,
    logger = console,
  }) {
    this.client = client;
    this.executor = executor;
    this.workerModels = workerModels || [];
    if (this.workerModels.length > 0 && this.executor && !this.executor.loadedModelID) {
      const firstModel = this.workerModels[0];
      this.executor.loadedModelID = typeof firstModel === 'string' ? firstModel : firstModel?.id || null;
    }
    this.hardwareRating = hardwareRating;
    this.hardwareInfo = hardwareInfo;
    this.image = image;
    this.readinessSessionId = readinessSessionId;
    this.etaIntervalMs = etaIntervalMs;
    this.readinessRefreshIntervalMs = readinessRefreshIntervalMs;
    this.reclaimTimeoutMs = reclaimTimeoutMs;
    this.drainTimeoutMs = drainTimeoutMs;
    this.logger = logger;

    this.readinessHolds = new Map();
    this.nextHoldId = 1;
    this.advertisedReady = false;
    this.pendingCleanupEvidence = false;
    this.readinessRefreshTimer = null;
    this.reclaimDeadlineTimer = null;
    this.awaitingJobReclaim = false;
    this.socketOpen = undefined;
    this.pendingHeldOutcomes = new Map();
    this.silentlyReleasedReasons = new Map();
    this.inFlight = new Set();
    this.loggedUnknownFrameTypes = new Set();
  }

  _isClientConnected() {
    if (typeof this.client?.connected === 'boolean') {
      return this.client.connected;
    }
    return this.socketOpen !== false;
  }

  _hasHeldOrActiveWork() {
    return (
      this.executor.activeRequests >= this.executor.maxConcurrentJobs
      || this.pendingHeldOutcomes.size > 0
      || this.awaitingJobReclaim
    );
  }

  getCombinedHeldJobs() {
    const activeHeld = [...(this.executor.getHeldJobs() || [])];
    const seen = new Set(activeHeld.map((entry) => entry.jobID));
    const current = Date.now();
    for (const outcome of this.pendingHeldOutcomes.values()) {
      if (seen.has(outcome.jobID)) continue;
      seen.add(outcome.jobID);
      activeHeld.push({
        jobID: outcome.jobID,
        ...(outcome.imgID ? { imgID: outcome.imgID } : {}),
        phase: 'finished',
        step: 1,
        stepCount: 1,
        heldForMs: Math.max(0, current - outcome.heldAt),
      });
    }
    return activeHeld;
  }

  _clearReclaimDeadline() {
    if (this.reclaimDeadlineTimer) {
      clearTimeout(this.reclaimDeadlineTimer);
      this.reclaimDeadlineTimer = null;
    }
  }

  _startReclaimDeadline() {
    this._clearReclaimDeadline();
    this.reclaimDeadlineTimer = setTimeout(() => {
      this._onReclaimTimeout();
    }, this.reclaimTimeoutMs);
    if (typeof this.reclaimDeadlineTimer.unref === 'function') {
      this.reclaimDeadlineTimer.unref();
    }
  }

  _onReclaimTimeout() {
    this.reclaimDeadlineTimer = null;
    if (!this.awaitingJobReclaim) return;
    this.awaitingJobReclaim = false;

    this.logger.warn?.(
      `[voice-worker] No jobReclaim received within ${this.reclaimTimeoutMs}ms after authenticated; releasing held job(s)`,
    );
    this.pendingHeldOutcomes.clear();

    const activeHeld = this.executor.getHeldJobs() || [];
    for (const entry of activeHeld) {
      const jobID = typeof entry === 'string' ? entry : entry?.jobID;
      if (!jobID) continue;
      this.silentlyReleasedReasons.set(jobID, 'reclaim timeout');
      const aborted = this.executor.abort(jobID, { silentRelease: true });
      if (!aborted) {
        this.silentlyReleasedReasons.delete(jobID);
      }
    }

    if (this._isClientConnected() && !this._hasHeldOrActiveWork()) {
      this.sendReadyToAcceptJobs(true, 'reclaim timeout');
    }
  }

  start() {
    // CRITICAL: NEVER send workerInfo or readyToAcceptJobs on 'open'!
    // Wait strictly for the broker's 'authenticated' frame.
    this.client.on('open', () => {
      this.socketOpen = true;
      this.advertisedReady = false;
      this.startReadinessRefreshLoop();
    });
    this.client.on('frame', (type, data) => this.handleFrame(type, data));
    this.client.on('close', () => {
      this.socketOpen = false;
      this.advertisedReady = false;
      this.awaitingJobReclaim = false;
      this._clearReclaimDeadline();
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
        && !this._hasHeldOrActiveWork()
      ) {
        this.sendReadyToAcceptJobs(true, releaseReason);
      }
    };
  }

  sendWorkerInfo(heldJobs = this.getCombinedHeldJobs()) {
    const workerInfo = buildWorkerInfo({
      workerModels: this.workerModels,
      loadedModelID: this.executor.loadedModelID,
      hardwareRating: this.hardwareRating,
      hardwareInfo: this.hardwareInfo,
      image: this.image,
      readinessSessionId: this.readinessSessionId,
      heldJobs,
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
    const busyWithActiveJob = this.executor.activeRequests >= this.executor.maxConcurrentJobs;
    const holdingOutcomes = this.pendingHeldOutcomes.size > 0 || this.awaitingJobReclaim;
    const effectiveReady = Boolean(
      ready
      && !this.executor.draining
      && this.readinessHolds.size === 0
      && !busyWithActiveJob
      && !holdingOutcomes,
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
          || (this.awaitingJobReclaim ? (reason || 'awaiting jobReclaim') : '')
          || (busyWithActiveJob ? 'job in progress' : '')
          || (holdingOutcomes ? (reason || 'awaiting jobReclaim') : '')
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
        this._clearReclaimDeadline();
        const heldJobs = this.getCombinedHeldJobs();
        this.awaitingJobReclaim = heldJobs.length > 0;
        this.sendWorkerInfo(heldJobs);
        if (heldJobs.length > 0) {
          this.sendReadyToAcceptJobs(false, 'awaiting jobReclaim', {
            postDisconnectCleanupComplete: true,
          });
          this._startReclaimDeadline();
        } else if (this.executor.activeRequests >= this.executor.maxConcurrentJobs) {
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
        this.handleJobReclaim(data);
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

  handleJobReclaim(data) {
    const wasAwaitingReclaim = this.awaitingJobReclaim;
    this._clearReclaimDeadline();
    this.awaitingJobReclaim = false;

    const reclaimed = Array.isArray(data?.reclaimed) ? data.reclaimed : [];
    const released = Array.isArray(data?.released) ? data.released : [];

    let discardedAny = false;
    for (const jobID of released) {
      if (typeof jobID !== 'string' || !jobID) continue;
      if (this.pendingHeldOutcomes.delete(jobID)) {
        discardedAny = true;
      }
      this.silentlyReleasedReasons.set(jobID, 'held job released');
      const aborted = this.executor.abort(jobID, { silentRelease: true });
      if (!aborted) {
        this.silentlyReleasedReasons.delete(jobID);
      } else {
        discardedAny = true;
      }
    }

    let flushedAny = false;
    let lastFlushedReason = '';
    for (const jobID of reclaimed) {
      if (typeof jobID !== 'string' || !jobID) continue;
      const outcome = this.pendingHeldOutcomes.get(jobID);
      if (!outcome) continue;
      this.pendingHeldOutcomes.delete(jobID);

      if (outcome.kind === 'completed') {
        this._emitCompletionFrames(outcome.job, outcome.result, outcome.startedAt);
        flushedAny = true;
        lastFlushedReason = `job ${outcome.jobID} completed`;
      } else {
        this._emitFailureFrames(outcome.job, outcome.error, outcome.timings);
        flushedAny = true;
        lastFlushedReason = `job ${outcome.jobID} failed`;
      }
    }

    if (
      this._isClientConnected()
      && !this._hasHeldOrActiveWork()
      && (flushedAny || discardedAny || wasAwaitingReclaim)
    ) {
      this.sendReadyToAcceptJobs(
        true,
        flushedAny ? lastFlushedReason : 'held job released',
      );
    }
  }

  handleCancel(data) {
    const jobID = data?.jobID;
    if (!jobID || typeof jobID !== 'string') return;
    this.pendingHeldOutcomes.delete(jobID);
    if (this.executor.abort(jobID)) {
      this.logger.log(`[voice-worker] Cancelled in-flight job ${jobID}`);
    }
  }

  async handleJobRequest(rawJob) {
    if (!rawJob || typeof rawJob.jobID !== 'string' || !rawJob.jobID) {
      this.logger.warn?.('[voice-worker] Ignoring malformed jobRequest without jobID');
      return;
    }

    // sogni-socket leaves `imageId` unset on initial dispatch so each worker
    // mints a fresh per-attempt UUID (`imgID`) and reports that exact ID on
    // `jobStarted`, `/v1/media/uploadUrl`, `jobResult`, and `jobCompleted`.
    const imageId = resolveJobImageId(rawJob);
    const job = rawJob.imageId === imageId ? rawJob : { ...rawJob, imageId };

    let accepted;
    try {
      accepted = this.executor.accept(job);
    } catch (error) {
      // Sogni socket expects jobStarted before jobResult/jobError for any assigned job.
      this.client.send('jobState', {
        type: 'jobStarted',
        jobID: job.jobID,
        imgID: job.imageId,
      });
      this._sendFailureSequence(job, error, ensureCompleteTimings());
      return;
    }

    const { model } = accepted;
    this.advertisedReady = false;
    this.client.send('jobState', {
      type: 'jobStarted',
      jobID: job.jobID,
      imgID: job.imageId,
    });

    const startedAt = Date.now();
    const etaTimer = setInterval(() => {
      if (!this._isClientConnected() || this.awaitingJobReclaim) return;
      const elapsedSec = (Date.now() - startedAt) / 1000;
      const etaSeconds = estimateJobEtaSeconds(job, model, elapsedSec);
      this.client.send('jobETA', { jobID: job.jobID, etaSeconds });
    }, this.etaIntervalMs);
    if (typeof etaTimer.unref === 'function') etaTimer.unref();

    try {
      const result = await this.executor.execute(job);
      clearInterval(etaTimer);

      const silentReleaseReason = this.silentlyReleasedReasons.get(job.jobID);
      if (silentReleaseReason) {
        this.silentlyReleasedReasons.delete(job.jobID);
        if (this._isClientConnected() && !this._hasHeldOrActiveWork() && !this.advertisedReady) {
          this.sendReadyToAcceptJobs(true, silentReleaseReason);
        }
        return;
      }

      if (!this._isClientConnected() || this.awaitingJobReclaim) {
        this.pendingHeldOutcomes.set(job.jobID, {
          jobID: job.jobID,
          imgID: job.imageId,
          kind: 'completed',
          job,
          result,
          startedAt,
          heldAt: Date.now(),
        });
        this.logger.log(
          `[voice-worker] Held completed ${job.workflowId} job ${job.jobID} awaiting jobReclaim`,
        );
        return;
      }

      this._emitCompletionFrames(job, result, startedAt);
      this.sendReadyToAcceptJobs(true, `job ${job.jobID} completed`);
    } catch (error) {
      clearInterval(etaTimer);
      const silentReleaseReason = this.silentlyReleasedReasons.get(job.jobID);
      const wasSilentlyReleased = Boolean(
        silentReleaseReason
        || error?.silentRelease
        || (error instanceof JobError && error.code === 'released'),
      );
      if (wasSilentlyReleased) {
        this.silentlyReleasedReasons.delete(job.jobID);
        if (this._isClientConnected() && !this._hasHeldOrActiveWork() && !this.advertisedReady) {
          this.sendReadyToAcceptJobs(true, silentReleaseReason || 'held job released');
        }
        return;
      }

      const timings = error?.timings || this.executor.getTimings(job.jobID);
      if (error instanceof JobError && error.code === 'aborted') {
        if (this._isClientConnected() && !this.awaitingJobReclaim) {
          this._sendCancelSequence(job, timings);
        }
        return;
      }

      if (!this._isClientConnected() || this.awaitingJobReclaim) {
        this.pendingHeldOutcomes.set(job.jobID, {
          jobID: job.jobID,
          imgID: job.imageId,
          kind: 'failed',
          job,
          error,
          timings,
          startedAt,
          heldAt: Date.now(),
        });
        this.logger.warn?.(
          `[voice-worker] Held failed ${job.workflowId} job ${job.jobID} awaiting jobReclaim`,
        );
        return;
      }

      this._sendFailureSequence(job, error, timings);
    }
  }

  _emitCompletionFrames(job, result, startedAt) {
    // Exact completion frames required by sogni-socket before readyToAcceptJobs(true):
    // 1. jobResult -> 2. jobState(jobCompleted)
    this.client.send('jobResult', result);
    this.client.send('jobState', {
      type: 'jobCompleted',
      jobID: job.jobID,
      imgID: job.imageId,
    });
    this.logger.log(
      `[voice-worker] Completed ${job.workflowId} job ${job.jobID} in ${((Date.now() - startedAt) / 1000).toFixed(2)}s`,
    );
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

  _emitFailureFrames(job, error, timings) {
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

    this.logger.error(`[voice-worker] Job ${job.jobID} failed (${errorCode}): ${message}`);
    if (error?.cause) {
      this.logger.error(`[voice-worker] Job ${job.jobID} caused by:`, error.cause);
    }
  }

  _sendFailureSequence(job, error, timings) {
    this._emitFailureFrames(job, error, timings);
    this.sendReadyToAcceptJobs(true, `job ${job.jobID} failed`);
  }

  async shutdown() {
    this.executor.startDrain();
    this._clearReclaimDeadline();
    this.awaitingJobReclaim = false;
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
  if (!credentials.apiKey && !overrides.checkOnly) {
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

  const defaultVoiceHost = process.env.HOST && process.env.HOST !== '0.0.0.0' && process.env.HOST !== '::'
    ? process.env.HOST
    : '127.0.0.1';
  const defaultVoicePort = process.env.PORT || 3000;

  let executorRef = overrides.executor || null;
  const backend = overrides.backend || createVoiceBackend({
    mode: backendMode,
    cfg: config,
    apiUrl: overrides.voiceApiUrl || config.networkWorker?.voiceApiUrl || process.env.SOGNI_VOICE_API_URL || `http://${defaultVoiceHost}:${defaultVoicePort}`,
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
