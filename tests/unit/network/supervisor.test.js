import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { VoiceWorkerSupervisor } from '../../../src/network/supervisor.js';
import { JobError, ensureCompleteTimings } from '../../../src/network/executor.js';
import { VOICE_SUPERNET_MODELS } from '../../../src/network/capabilities.js';
import { waitFor } from '../../utils/mockSogniSocket.js';

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.start = vi.fn(async () => {});
    this.close = vi.fn();
  }

  send(type, data) {
    this.sent.push({ type, data });
    return true;
  }

  sentTypes() {
    return this.sent.map((frame) => frame.type);
  }
}

const drama3Job = (jobID = 'job-1') => ({
  jobID,
  imageId: 'img-1',
  workflowId: 'fish_drama_3_nvfp4',
  outputFormat: 'mp3',
  clientParams: { seed: 42, tags: '[warmly] Welcome to Sogni Voice.' },
  assets: [],
});

describe('VoiceWorkerSupervisor', () => {
  let client;
  let executor;
  let supervisor;
  const sessionId = '11111111-2222-4333-8444-555555555555';

  beforeEach(() => {
    client = new FakeClient();
    executor = {
      activeRequests: 0,
      maxConcurrentJobs: 1,
      draining: false,
      loadedModelID: null,
      getHeldJobs: vi.fn(() => []),
      getTimings: vi.fn(() => ensureCompleteTimings()),
      accept: vi.fn((job) => ({
        model: VOICE_SUPERNET_MODELS.find((m) => m.id === job.workflowId),
      })),
      execute: vi.fn(async (job) => ({
        jobID: job.jobID,
        imgID: job.imageId,
        performedStepCount: 1,
        lastSeed: 42,
        userCanceled: false,
        triggeredNSFWFilter: false,
        timings: ensureCompleteTimings({ inference: 1.25, assetUpload: 0.1 }),
        sha256: 'a'.repeat(64),
      })),
      abort: vi.fn(() => true),
      startDrain: vi.fn(function () { this.draining = true; }),
    };

    supervisor = new VoiceWorkerSupervisor({
      client,
      executor,
      workerModels: VOICE_SUPERNET_MODELS,
      hardwareRating: 70,
      hardwareInfo: {
        cpuBrand: 'ARM Cortex-X925',
        gpuBrand: 'NVIDIA GB10',
        vram: 120,
        ram: 120,
      },
      image: 'comfy/1.0.260',
      readinessSessionId: sessionId,
      etaIntervalMs: 15,
      readinessRefreshIntervalMs: 25,
      drainTimeoutMs: 2000,
      logger: silentLogger,
    });
  });

  it('NEVER sends workerInfo or readyToAcceptJobs on open — ONLY on authenticated', async () => {
    await supervisor.start();
    client.emit('open');
    expect(client.sent).toEqual([]);

    client.emit('frame', 'authenticated', { ok: true });
    expect(client.sentTypes()).toEqual(['workerInfo', 'readyToAcceptJobs']);
    expect(client.sent[0].data).toMatchObject({
      workerModels: [
        'fish_drama_3_nvfp4',
        'parakeet_tdt_0.6b_v3_bf16',
        'nemotron_3.5_transcribe_30b_a4b_nvfp4',
      ],
      hardwareRating: 70,
      hardwareInfo: expect.objectContaining({
        gpuBrand: 'NVIDIA GB10',
        vram: 120,
        ram: 120,
      }),
      inputPreparationProtocol: 1,
      postDisconnectCleanupReadinessProtocol: 1,
      readinessSessionId: sessionId,
      jobHoldProtocol: 1,
      heldJobs: [],
    });
    expect(client.sent[1].data).toEqual({
      ready: true,
      reason: 'authenticated',
      postDisconnectCleanupComplete: true,
      readinessSessionId: sessionId,
    });
    supervisor.stopReadinessRefreshLoop();
  });

  it('refreshes readyToAcceptJobs(false) on cadence while a readiness hold is active and carries cleanup evidence on release', async () => {
    await supervisor.start();
    client.emit('open');

    const release = supervisor.holdReadiness('paused for maintenance');
    client.emit('frame', 'authenticated', { ok: true });

    expect(client.sent.filter((f) => f.type === 'readyToAcceptJobs').pop().data).toEqual({
      ready: false,
      reason: 'paused for maintenance',
    });

    const beforeRefreshCount = client.sent.filter((f) => f.type === 'readyToAcceptJobs').length;
    await waitFor(() => client.sent.filter((f) => f.type === 'readyToAcceptJobs').length > beforeRefreshCount);

    release('maintenance complete');
    supervisor.stopReadinessRefreshLoop();

    expect(client.sent.filter((f) => f.type === 'readyToAcceptJobs').pop().data).toEqual({
      ready: true,
      reason: 'maintenance complete',
      postDisconnectCleanupComplete: true,
      readinessSessionId: sessionId,
    });
  });

  it('emits jobStarted, 1s jobETA heartbeats, then jobResult -> jobCompleted -> readyToAcceptJobs(true)', async () => {
    await supervisor.start();
    let finishJob;
    executor.execute.mockImplementationOnce((job) => new Promise((resolve) => {
      finishJob = () => resolve({
        jobID: job.jobID,
        imgID: job.imageId,
        performedStepCount: 1,
        lastSeed: 42,
        userCanceled: false,
        triggeredNSFWFilter: false,
        timings: ensureCompleteTimings({ inference: 0.8 }),
        sha256: 'b'.repeat(64),
      });
    }));

    const runPromise = supervisor.handleJobRequest(drama3Job('job-eta'));
    await waitFor(() => client.sentTypes().includes('jobETA'));

    expect(client.sent[0]).toEqual({
      type: 'jobState',
      data: { type: 'jobStarted', jobID: 'job-eta', imgID: 'img-1' },
    });
    const etaFrame = client.sent.find((f) => f.type === 'jobETA');
    expect(etaFrame.data.jobID).toBe('job-eta');
    expect(etaFrame.data.etaSeconds).toBeGreaterThanOrEqual(1);

    finishJob();
    await runPromise;

    const tail = client.sent.filter((f) => f.type !== 'jobETA').slice(1);
    expect(tail.map((f) => f.type)).toEqual(['jobResult', 'jobState', 'readyToAcceptJobs']);
    expect(tail[0].data).toMatchObject({
      jobID: 'job-eta',
      imgID: 'img-1',
      performedStepCount: 1,
      lastSeed: 42,
      userCanceled: false,
      triggeredNSFWFilter: false,
      sha256: 'b'.repeat(64),
    });
    expect(tail[1].data).toEqual({ type: 'jobCompleted', jobID: 'job-eta', imgID: 'img-1' });
    expect(tail[2].data).toEqual({ ready: true, reason: 'job job-eta completed' });
  });

  it('mints a consistent uppercase UUID imgID when sogni-socket omits imageId on jobRequest', async () => {
    await supervisor.start();
    executor.execute.mockImplementationOnce(async (job) => ({
      jobID: job.jobID,
      imgID: job.imageId,
      performedStepCount: 1,
      lastSeed: 0,
      userCanceled: false,
      triggeredNSFWFilter: false,
      timings: ensureCompleteTimings({ inference: 0.5 }),
      sha256: 'c'.repeat(64),
    }));

    await supervisor.handleJobRequest({
      jobID: 'proj-no-img-id',
      workflowId: 'fish_drama_3_nvfp4',
      clientParams: { positivePrompt: 'Hello world' },
    });

    const startedFrame = client.sent.find((f) => f.type === 'jobState' && f.data.type === 'jobStarted');
    const resultFrame = client.sent.find((f) => f.type === 'jobResult');
    const completedFrame = client.sent.find((f) => f.type === 'jobState' && f.data.type === 'jobCompleted');
    expect(startedFrame.data.imgID).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
    expect(executor.accept.mock.calls[0][0].imageId).toBe(startedFrame.data.imgID);
    expect(resultFrame.data.imgID).toBe(startedFrame.data.imgID);
    expect(completedFrame.data.imgID).toBe(startedFrame.data.imgID);
  });

  it('sends empty jobResult + jobError(isFromWorker: true) + readyToAcceptJobs(true) on failure', async () => {
    await supervisor.start();
    executor.execute.mockRejectedValueOnce(new JobError('invalidInput', 'Reference audio must be at most 30 seconds long, got 45.0s'));

    await supervisor.handleJobRequest(drama3Job('job-bad'));

    expect(client.sentTypes()).toEqual(['jobState', 'jobResult', 'jobError', 'readyToAcceptJobs']);
    expect(client.sent[1].data).toMatchObject({
      jobID: 'job-bad',
      imgID: 'img-1',
      performedStepCount: 0,
      userCanceled: false,
    });
    expect(client.sent[2].data).toEqual({
      jobID: 'job-bad',
      imgID: 'img-1',
      error: 'invalidInput',
      error_message: 'Reference audio must be at most 30 seconds long, got 45.0s',
      isFromWorker: true,
    });
    expect(client.sent[3].data).toEqual({ ready: true, reason: 'job job-bad failed' });
  });

  it('sends userCanceled jobResult + artistCanceled jobError + readyToAcceptJobs(true) on cancellation with captured timings', async () => {
    await supervisor.start();
    const cancelErr = new JobError('aborted', 'Job cancelled');
    cancelErr.timings = ensureCompleteTimings({ assetDownload: 0.42, inference: 1.15 });
    executor.execute.mockRejectedValueOnce(cancelErr);

    await supervisor.handleJobRequest(drama3Job('job-cancel'));

    expect(client.sentTypes()).toEqual(['jobState', 'jobResult', 'jobError', 'readyToAcceptJobs']);
    expect(client.sent[1].data).toMatchObject({
      jobID: 'job-cancel',
      userCanceled: true,
      performedStepCount: 0,
      timings: expect.objectContaining({ assetDownload: 0.42, inference: 1.15 }),
    });
    expect(client.sent[2].data).toEqual({
      jobID: 'job-cancel',
      imgID: 'img-1',
      error: 'artistCanceled',
      error_message: 'Job cancelled',
      isFromWorker: true,
    });
    expect(client.sent[3].data).toEqual({ ready: true, reason: 'job job-cancel cancelled' });
  });

  it('never advertises readyToAcceptJobs(true) while activeRequests >= maxConcurrentJobs', async () => {
    await supervisor.start();
    executor.activeRequests = 1;
    executor.maxConcurrentJobs = 1;

    supervisor.sendReadyToAcceptJobs(true, 'attempted ready while busy');
    expect(client.sent.pop().data).toEqual({
      ready: false,
      reason: 'job in progress',
    });

    const release = supervisor.holdReadiness('temporary hold');
    client.sent.length = 0;
    release('hold lifted while job still running');
    expect(client.sent).toEqual([]);
  });

  it('aborts released jobs on jobReclaim and inbound jobCancel / jobError', async () => {
    await supervisor.start();
    client.emit('frame', 'jobCancel', { jobID: 'j-1' });
    client.emit('frame', 'jobError', { jobID: 'j-2', error: 'artistCanceled' });
    client.emit('frame', 'jobReclaim', { reclaimed: ['j-3'], released: ['j-4'] });

    expect(executor.abort.mock.calls.map(([id]) => id)).toEqual(['j-1', 'j-2', 'j-4']);
  });
});
