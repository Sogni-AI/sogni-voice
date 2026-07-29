import { describe, it, expect, vi } from 'vitest';
import {
  JobError,
  SpeechExecutor,
  computeJobTimeout,
  deriveAudioSeconds,
  extensionFromUrl,
  withTimeout,
} from '../../../src/network/executor.js';

const MODELS = [
  { id: 'parakeet-tdt', task: 'stt', maxConcurrent: 1, engine: 'parakeet' },
  { id: 'kokoro-82m', task: 'tts', maxConcurrent: 2, engine: 'kokoro' },
];

const sttJob = (jobID = 'job-1') => ({
  jobID,
  projectID: 'proj-1',
  jobType: 'speech',
  task: 'stt',
  modelID: 'parakeet-tdt',
  params: {},
  input: { url: 'https://s3.test/in/clip.wav' },
  output: null,
  timeoutMs: 60000,
});

const ttsJob = (jobID = 'job-t') => ({
  jobID,
  projectID: 'proj-1',
  jobType: 'speech',
  task: 'tts',
  modelID: 'kokoro-82m',
  params: { text: 'hello' },
  input: null,
  output: { uploadUrl: 'https://s3.test/out/a.wav' },
  timeoutMs: 60000,
});

const makeExecutor = (overrides = {}) => new SpeechExecutor({
  speechModels: MODELS,
  maxConcurrentJobs: 2,
  transcriptionService: { transcribe: vi.fn() },
  ttsService: { generate: vi.fn() },
  tempFiles: { createTempDir: vi.fn(async () => '/tmp/job'), cleanup: vi.fn(async () => {}) },
  artifacts: { downloadToFile: vi.fn(), uploadFile: vi.fn() },
  ...overrides,
});

// `toThrow` compares messages, not error codes, so assert on the code directly.
const expectJobError = (fn, code, message = null) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(JobError);
    expect(error.code).toBe(code);
    if (message) expect(error.message).toBe(message);
    return;
  }
  throw new Error(`Expected a JobError with code "${code}" but nothing was thrown`);
};

describe('helpers', () => {
  it('prefers the broker timeout when present', () => {
    expect(computeJobTimeout({ timeoutMs: 45000 })).toBe(45000);
  });

  it('scales the fallback timeout by TTS text length', () => {
    expect(computeJobTimeout({ params: { text: 'x'.repeat(1000) } }, 10000)).toBe(50000);
  });

  it('never returns less than the fallback', () => {
    expect(computeJobTimeout({ timeoutMs: 0, params: {} }, 10000)).toBe(10000);
  });

  // Unclamped, setTimeout would rerun this delay as 1ms and fail the job instantly.
  it('clamps an oversized broker timeout to the setTimeout ceiling', () => {
    expect(computeJobTimeout({ timeoutMs: 10_000_000_000 })).toBe(2147483647);
    expect(computeJobTimeout({ timeoutMs: 2147483648 })).toBe(2147483647);
    expect(computeJobTimeout({ timeoutMs: 2147483647 })).toBe(2147483647);
  });

  it('rejects with a timeout JobError once the deadline passes', async () => {
    const never = new Promise(() => {});
    await expect(withTimeout(never, 10, 'Job job-1')).rejects.toMatchObject({
      code: 'timeout',
      message: 'Job job-1 exceeded 10ms',
    });
  });

  it('passes through a value that resolves in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 500, 'Job job-1')).resolves.toBe('ok');
  });

  it('reads the file extension out of a presigned URL', () => {
    expect(extensionFromUrl('https://s3.test/in/clip.MP3?sig=1')).toBe('mp3');
    expect(extensionFromUrl('https://s3.test/in/clip')).toBe('wav');
    expect(extensionFromUrl('not-a-url')).toBe('wav');
  });

  it('derives audioSeconds from the last sentence timestamp', () => {
    expect(deriveAudioSeconds({ timestamps: [{ start: 0, end: 1.5 }, { start: 1.5, end: 4.25 }] }))
      .toBe(4.25);
    expect(deriveAudioSeconds({ text: 'no timestamps' })).toBeNull();
    expect(deriveAudioSeconds({ timestamps: [] })).toBeNull();
  });
});

describe('SpeechExecutor governor', () => {
  it('accepts a job and counts it as active', () => {
    const executor = makeExecutor();
    expect(executor.accept(sttJob()).engine).toBe('parakeet');
    expect(executor.activeRequests).toBe(1);
  });

  it('rejects a non-speech jobType', () => {
    const executor = makeExecutor();
    expectJobError(
      () => executor.accept({ ...sttJob(), jobType: 'image' }),
      'invalid_request',
      'Unsupported jobType "image"',
    );
  });

  it('rejects a job with no jobID', () => {
    const executor = makeExecutor();
    expectJobError(
      () => executor.accept({ ...sttJob(), jobID: '' }),
      'invalid_request',
      'jobRequest is missing jobID',
    );
  });

  it('rejects a model we do not advertise', () => {
    const executor = makeExecutor();
    expectJobError(
      () => executor.accept({ ...sttJob(), modelID: 'whisper-large' }),
      'unsupported_model',
      'No enabled engine for modelID "whisper-large" task "stt"',
    );
  });

  it('rejects a duplicate jobID', () => {
    const executor = makeExecutor();
    executor.accept(sttJob('dup'));
    expectJobError(
      () => executor.accept(sttJob('dup')),
      'invalid_request',
      'Job dup is already running',
    );
  });

  it('rejects beyond maxConcurrentJobs instead of queueing', () => {
    const executor = makeExecutor({ maxConcurrentJobs: 1 });
    executor.accept(ttsJob('t1'));
    expectJobError(
      () => executor.accept(ttsJob('t2')),
      'capacity_exceeded',
      'Worker is at capacity (1 concurrent jobs)',
    );
  });

  it('enforces the per-model concurrency cap', () => {
    const executor = makeExecutor({ maxConcurrentJobs: 4 });
    executor.accept(sttJob('s1'));
    expectJobError(
      () => executor.accept(sttJob('s2')),
      'capacity_exceeded',
      'Model parakeet-tdt is at capacity (1 concurrent jobs)',
    );
  });

  it('frees the slot when a job is aborted', () => {
    const executor = makeExecutor();
    executor.accept(sttJob('s1'));
    expect(executor.abort('s1')).toBe(true);
    expect(executor.activeRequests).toBe(0);
    expect(() => executor.accept(sttJob('s2'))).not.toThrow();
  });

  it('ignores an abort for an unknown jobID', () => {
    expect(makeExecutor().abort('never-seen')).toBe(false);
  });

  // Aborting frees the slot while the uncancellable adapter call keeps running, so
  // the broker can re-issue the same jobID before that first run settles. When it
  // finally does, its release must not evict the replacement job's slot.
  it('ignores a stale release from a run whose jobID was aborted and re-accepted', () => {
    const executor = makeExecutor({ maxConcurrentJobs: 4 });
    executor.accept(sttJob('j1'));
    const originalEntry = executor.activeJobs.get('j1');

    executor.abort('j1');
    executor.accept(sttJob('j1'));
    const replacementEntry = executor.activeJobs.get('j1');
    expect(replacementEntry).not.toBe(originalEntry);

    executor._release('j1', originalEntry);

    expect(executor.activeRequests).toBe(1);
    expect(executor.modelCounts.get('parakeet-tdt')).toBe(1);
    expectJobError(
      () => executor.accept(sttJob('j2')),
      'capacity_exceeded',
      'Model parakeet-tdt is at capacity (1 concurrent jobs)',
    );
  });

  it('still releases when the caller passes the entry that is actually current', () => {
    const executor = makeExecutor();
    executor.accept(sttJob('j1'));
    const entry = executor.activeJobs.get('j1');

    executor._release('j1', entry);

    expect(executor.activeRequests).toBe(0);
    expect(executor.modelCounts.has('parakeet-tdt')).toBe(false);
  });

  it('refuses new jobs while draining', () => {
    const executor = makeExecutor();
    executor.startDrain();
    expectJobError(
      () => executor.accept(sttJob()),
      'draining',
      'Worker is draining and not accepting new jobs',
    );
  });
});
