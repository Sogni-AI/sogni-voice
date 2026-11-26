import { describe, it, expect, vi } from 'vitest';
import { VOICE_SUPERNET_MODELS } from '../../../src/network/capabilities.js';
import {
  JobError,
  VoiceSupernetExecutor,
  computeJobTimeout,
  ensureCompleteTimings,
  estimateJobEtaSeconds,
  withTimeout,
} from '../../../src/network/executor.js';

const sttJob = (jobID = 'job-1') => ({
  jobID,
  imageId: 'img-1',
  workflowId: 'parakeet_tdt_0.6b_v3_bf16',
  clientParams: { duration: 30 },
  assets: [{ type: 'audio', jobField: 'audio', url: 'https://s3.test/in.wav' }],
});

const makeExecutor = (overrides = {}) => new VoiceSupernetExecutor({
  workerModels: VOICE_SUPERNET_MODELS,
  backend: { transcribe: vi.fn(), synthesizeDrama3: vi.fn() },
  maxConcurrentJobs: 1,
  tempFiles: { createTempDir: vi.fn(async () => '/tmp/job'), cleanup: vi.fn(async () => {}) },
  artifacts: {
    downloadReferenceAudio: vi.fn(),
    validateAndProbeAudio: vi.fn(),
    transcodeReferenceWav: vi.fn(),
    uploadJobArtifact: vi.fn(),
  },
  ...overrides,
});

const expectJobError = (fn, code, messagePattern = null) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(JobError);
    expect(error.code).toBe(code);
    if (messagePattern) expect(error.message).toMatch(messagePattern);
    return;
  }
  throw new Error(`Expected JobError(${code}) to be thrown`);
};

describe('VoiceSupernetExecutor helpers & governor', () => {
  it('computes timeouts and clamps oversized values to MAX_TIMER_DELAY_MS', () => {
    expect(computeJobTimeout({ timeoutMs: 45_000 })).toBe(45_000);
    expect(computeJobTimeout({ timeoutMs: 10_000_000_000 })).toBe(2147483647);
    expect(computeJobTimeout({
      workflowId: 'fish_drama_3_nvfp4',
      clientParams: { tags: 'x'.repeat(1000) },
    }, 100_000)).toBe(430_000);
  });

  it('fills complete timing fields and positive ETA estimates', () => {
    expect(ensureCompleteTimings({ inference: 1.2345 })).toEqual({
      assetDownload: 0,
      modelInit: 0,
      modelUnload: 0,
      modelLoad: 0,
      inference: 1.235,
      safeContent: 0,
      assetUpload: 0,
      other: 0,
    });
    expect(estimateJobEtaSeconds(sttJob(), VOICE_SUPERNET_MODELS[1], 1)).toBeGreaterThanOrEqual(1);
  });

  it('invokes onTimeout and rejects when withTimeout expires', async () => {
    const onTimeout = vi.fn();
    await expect(withTimeout(new Promise(() => {}), 10, 'Job j', onTimeout)).rejects.toMatchObject({
      code: 'genfailure',
      message: expect.stringMatching(/timed out/),
    });
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('accepts supported workflows, reports heldJobs, and enforces concurrency', () => {
    let clock = 1000;
    const executor = makeExecutor({ now: () => clock });
    const { model } = executor.accept(sttJob('j-1'));
    expect(model.engine).toBe('parakeet');
    expect(executor.activeRequests).toBe(1);

    clock = 2500;
    expect(executor.getHeldJobs()).toEqual([{
      jobID: 'j-1',
      imgID: 'img-1',
      phase: 'setup',
      step: 0,
      stepCount: 1,
      heldForMs: 1500,
    }]);

    expectJobError(() => executor.accept(sttJob('j-1')), 'invalidInput', /already running/);
    expectJobError(() => executor.accept(sttJob('j-2')), 'capacity_exceeded', /at capacity/);
  });

  it('rejects missing jobID/workflowId, disabled workflows, and draining worker', () => {
    const executor = makeExecutor();
    expectJobError(() => executor.accept({ jobID: '', workflowId: 'fish_drama_3_nvfp4' }), 'invalidInput');
    expectJobError(() => executor.accept({ jobID: 'j', workflowId: '' }), 'invalidInput');
    expectJobError(() => executor.accept({ jobID: 'j', workflowId: 'unknown_workflow' }), 'genfailure');

    executor.startDrain();
    expectJobError(() => executor.accept(sttJob('j-drain')), 'draining');
  });

  it('clamps maxConcurrentJobs to 1 and holds the concurrency slot on abort until execute() settles with real timings', async () => {
    let clock = 1000;
    let releaseBackend;
    const executor = makeExecutor({
      maxConcurrentJobs: 4,
      now: () => {
        clock += 250;
        return clock;
      },
      artifacts: {
        downloadReferenceAudio: vi.fn(async () => ({ path: '/tmp/job/in.wav', bytes: 100 })),
        transcodeAndVerifySttAudio: vi.fn(async () => ({ path: '/tmp/job/clean.flac', duration: 5 })),
        validateAndProbeAudio: vi.fn(),
        transcodeReferenceWav: vi.fn(),
        uploadJobArtifact: vi.fn(),
      },
      backend: {
        transcribe: vi.fn(({ signal }) => new Promise((_resolve, reject) => {
          releaseBackend = () => {
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
          };
          signal?.addEventListener('abort', () => {
            // Simulate backend unwinding slightly after abort signal
          });
        })),
        synthesizeDrama3: vi.fn(),
      },
    });
    expect(executor.maxConcurrentJobs).toBe(1);

    const job = sttJob('j-re');
    executor.accept(job);
    const execPromise = executor.execute(job);

    // Wait a tick so download/transcode completes and transcribe starts
    await new Promise((r) => setTimeout(r, 10));
    expect(executor.abort('j-re')).toBe(true);
    // Slot MUST remain occupied until execute()'s finally block finishes!
    expect(executor.activeRequests).toBe(1);
    expectJobError(() => executor.accept(sttJob('j-2')), 'capacity_exceeded');

    releaseBackend();
    await expect(execPromise).rejects.toMatchObject({
      code: 'aborted',
      timings: expect.objectContaining({
        assetDownload: expect.any(Number),
      }),
    });
    expect(executor.activeRequests).toBe(0);
    expect(executor.getTimings('j-re').assetDownload).toBeGreaterThan(0);
  });
});
