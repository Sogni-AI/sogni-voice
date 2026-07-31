import { describe, it, expect, vi } from 'vitest';
import {
  JobError,
  SpeechExecutor,
  computeJobTimeout,
  withTimeout,
} from '../../../src/network/executor.js';
import { config } from '../../../src/config/index.js';

const MODELS = [
  { id: 'kokoro_82m', task: 'tts', engine: 'kokoro' },
];

const job = (overrides = {}, kfOverrides = {}) => ({
  jobID: 'A0000000-0000-4000-8000-000000000021',
  jobType: 'audio',
  keyFrames: [{
    modelID: 'kokoro_82m',
    positivePrompt: 'Hello.',
    duration: 1,
    steps: 1,
    seed: -1,
    ...kfOverrides,
  }],
  ...overrides,
});

const IMG_ID = 'B0000000-0000-4000-8000-000000000022';

const setup = (overrides = {}) => {
  let resolveGenerate;
  const generateGate = new Promise((resolve) => { resolveGenerate = resolve; });
  const ttsService = {
    generate: vi.fn(async () => generateGate),
  };
  const executor = new SpeechExecutor({
    speechModels: MODELS,
    apiUrl: 'https://api-staging.sogni.ai',
    maxConcurrentJobs: 1,
    transcriptionService: { transcribe: vi.fn() },
    ttsService,
    tempFiles: {
      createTempDir: vi.fn(async () => '/tmp/sogni-speech-gov'),
      cleanup: vi.fn(async () => {}),
    },
    artifacts: {
      downloadToFile: vi.fn(),
      uploadFile: vi.fn(async () => ({ uploadedKey: 'k', bytes: 10 })),
    },
    api: {
      requestMediaUploadUrl: vi.fn(async () => 'https://r2.test/put'),
      requestMediaDownloadUrl: vi.fn(),
    },
    tools: {
      transcodeWavToMp3: vi.fn(async (i, o) => o),
      probeDurationSeconds: vi.fn(),
      synthesizeTestClip: vi.fn(),
    },
    writeArtifact: vi.fn(async () => {}),
    ...overrides,
  });
  return { executor, ttsService, finishGenerate: () => resolveGenerate({}) };
};

describe('SpeechExecutor governor (standard contract)', () => {
  it('rejects jobs without a jobID, with the wrong jobType, or without keyFrames', () => {
    const { executor } = setup();
    expect(() => executor.accept(job({ jobID: undefined }))).toThrow(/jobID/);
    expect(() => executor.accept(job({ jobType: 'speech' }))).toThrow(/jobType/);
    expect(() => executor.accept(job({ keyFrames: [] }))).toThrow(/keyFrames/);
  });

  it('rejects models no enabled engine serves', () => {
    const { executor } = setup();
    expect(() => executor.accept(job({}, { modelID: 'ace_step_1.5_sft' }))).toThrow(/No enabled engine/);
  });

  it('rejects a duplicate jobID while the first is running', () => {
    const { executor } = setup();
    executor.accept(job());
    expect(() => executor.accept(job())).toThrow(/already running/);
  });

  // The broker assigns one job per render worker; a second concurrent request
  // means state divergence, and the worker refuses rather than queues.
  it('refuses work past maxConcurrentJobs', () => {
    const { executor } = setup();
    executor.accept(job());
    expect(() => executor.accept(job({ jobID: 'A0000000-0000-4000-8000-000000000099' })))
      .toThrow(/at capacity/);
  });

  it('refuses new work while draining', () => {
    const { executor } = setup();
    executor.startDrain();
    expect(() => executor.accept(job())).toThrow(/draining/);
  });

  it('frees the slot when a job completes', async () => {
    const harness = setup();
    const first = job();
    harness.executor.accept(first);
    const running = harness.executor.execute(first, { imgID: IMG_ID });
    harness.finishGenerate();
    await running;

    expect(harness.executor.activeRequests).toBe(0);
    expect(() => harness.executor.accept(job({ jobID: 'A0000000-0000-4000-8000-000000000098' })))
      .not.toThrow();
  });

  it('abort marks the entry, frees the slot, and reports the job as aborted', async () => {
    const harness = setup();
    const first = job();
    harness.executor.accept(first);
    const running = harness.executor.execute(first, { imgID: IMG_ID });

    expect(harness.executor.abort(first.jobID)).toBe(true);
    expect(harness.executor.activeRequests).toBe(0);

    harness.finishGenerate();
    await expect(running).rejects.toMatchObject({ code: 'aborted' });
  });

  it('abort of an unknown job is a no-op', () => {
    const { executor } = setup();
    expect(executor.abort('nope')).toBe(false);
  });

  // abort() frees the slot while the uncancellable adapter call is still
  // running, so the broker can re-issue the same jobID. The stale first run's
  // release must not evict the replacement.
  it('a stale release never evicts a re-issued job with the same jobID', async () => {
    const harness = setup();
    const first = job();
    harness.executor.accept(first);
    const firstRun = harness.executor.execute(first, { imgID: IMG_ID });
    harness.executor.abort(first.jobID);

    const replacement = job();
    harness.executor.accept(replacement);
    expect(harness.executor.activeRequests).toBe(1);

    harness.finishGenerate();
    await firstRun.catch(() => {});
    // The stale run's finally must not have released the replacement's slot.
    expect(harness.executor.activeRequests).toBe(1);
  });

  it('execute without accept is rejected', async () => {
    const { executor } = setup();
    await expect(executor.execute(job(), { imgID: IMG_ID })).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
});

describe('computeJobTimeout', () => {
  const base = config.networkWorker.defaultJobTimeoutMs;

  it('adds the workload scale to the fallback floor', () => {
    // 'Hello.' = 6 chars, declared duration 1s
    expect(computeJobTimeout(job())).toBe(base + 6 * 40 + 1 * 500);
  });

  it('scales with TTS text length', () => {
    const long = job({}, { positivePrompt: 'a'.repeat(10000) });
    expect(computeJobTimeout(long)).toBe(Math.min(900000, base + 10000 * 40 + 1 * 500));
  });

  it('scales with declared STT duration and caps at 15 minutes', () => {
    const longAudio = job({}, { positivePrompt: '', duration: 7200 });
    expect(computeJobTimeout(longAudio)).toBe(900000);
  });
});

describe('withTimeout', () => {
  it('rejects with a JobError once the deadline passes', async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise(() => {});
      const raced = withTimeout(never, 5000, 'Job X');
      const outcome = raced.catch((e) => e);
      await vi.advanceTimersByTimeAsync(5001);
      const error = await outcome;
      expect(error).toBeInstanceOf(JobError);
      expect(error.code).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves and clears the timer when work finishes first', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 5000, 'Job Y')).resolves.toBe('ok');
  });
});
