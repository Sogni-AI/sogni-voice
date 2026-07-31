import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { SpeechWorkerSupervisor } from '../../../src/network/supervisor.js';
import { JobError } from '../../../src/network/executor.js';

const MODELS = [
  { id: 'kokoro_82m', task: 'tts', engine: 'kokoro' },
];

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.connected = false;
    this.closed = false;
  }

  connect() { this.connected = true; }
  close() { this.closed = true; }

  send(type, data) {
    this.sent.push({ type, data });
    return true;
  }

  framesOf(type) { return this.sent.filter((f) => f.type === type); }
}

const job = (overrides = {}) => ({
  jobID: 'A0000000-0000-4000-8000-000000000031',
  jobType: 'audio',
  keyFrames: [{ modelID: 'kokoro_82m', positivePrompt: 'Hi.', duration: 1, steps: 1, seed: -1 }],
  ...overrides,
});

const RESULT = {
  lastSeed: 0,
  performedStepCount: 1,
  timings: { inference: 0.4, assetUpload: 0.1, total: 0.6 },
};

const setup = ({ executor: executorOverrides = {}, ...rest } = {}) => {
  const client = new FakeClient();
  const executor = {
    accept: vi.fn(() => MODELS[0]),
    execute: vi.fn(async () => ({ ...RESULT })),
    abort: vi.fn(() => true),
    startDrain: vi.fn(),
    activeRequests: 0,
    ...executorOverrides,
  };
  const logger = { log: vi.fn(), error: vi.fn() };
  const supervisor = new SpeechWorkerSupervisor({
    client,
    executor,
    speechModels: MODELS,
    drainTimeoutMs: 500,
    progressIntervalMs: 60000,
    logger,
    ...rest,
  });
  supervisor.start();
  return { client, executor, logger, supervisor };
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

const UUID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

describe('SpeechWorkerSupervisor (standard contract)', () => {
  it('connects on start and registers only after authenticated', () => {
    const { client } = setup();
    expect(client.connected).toBe(true);
    expect(client.framesOf('workerInfo')).toHaveLength(0);

    client.emit('frame', 'authenticated', { username: 'universal' });
    const infos = client.framesOf('workerInfo');
    expect(infos).toHaveLength(1);
    expect(infos[0].data.workerModels).toEqual(['kokoro_82m']);
    expect(infos[0].data.hardwareRating).toBeGreaterThanOrEqual(70);
    expect(infos[0].data.hardwareInfo.cpuBrand).toBeTruthy();
  });

  it('re-registers on every authenticated frame (reconnects)', () => {
    const { client } = setup();
    client.emit('frame', 'authenticated', {});
    client.emit('frame', 'authenticated', {});
    expect(client.framesOf('workerInfo')).toHaveLength(2);
  });

  it('runs the happy path in the load-bearing order: jobStarted, jobResult, jobCompleted', async () => {
    const { client, executor } = setup();
    client.emit('frame', 'jobRequest', job());
    await flush();

    const types = client.sent.map((f) => f.type);
    expect(types).toEqual(['jobState', 'jobResult', 'jobState']);

    const [started] = client.framesOf('jobState');
    expect(started.data.type).toBe('jobStarted');
    expect(started.data.jobID).toBe('A0000000-0000-4000-8000-000000000031');
    expect(started.data.imgID).toMatch(UUID_RE);

    const [result] = client.framesOf('jobResult');
    expect(result.data).toMatchObject({
      jobID: 'A0000000-0000-4000-8000-000000000031',
      imgID: started.data.imgID,
      lastSeed: 0,
      userCanceled: false,
      triggeredNSFWFilter: false,
      performedStepCount: 1,
    });
    expect(result.data.timings).toMatchObject({ inference: 0.4 });

    const completed = client.framesOf('jobState')[1];
    expect(completed.data).toMatchObject({ type: 'jobCompleted', imgID: started.data.imgID });

    // jobResult must be on the wire before jobCompleted (24h shadowban otherwise).
    expect(client.sent.indexOf(result)).toBeLessThan(client.sent.indexOf(completed));

    expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({
      jobID: 'A0000000-0000-4000-8000-000000000031',
    }), { imgID: started.data.imgID });
  });

  it('sends a jobError with the mapped code when execution fails, and no jobCompleted', async () => {
    const { client } = setup({
      executor: {
        execute: vi.fn(async () => {
          throw new JobError('imgUploadFailure', 'HTTP 503');
        }),
      },
    });
    client.emit('frame', 'jobRequest', job());
    await flush();

    const errors = client.framesOf('jobError');
    expect(errors).toHaveLength(1);
    expect(errors[0].data).toMatchObject({
      jobID: 'A0000000-0000-4000-8000-000000000031',
      isFromWorker: true,
      error: 'imgUploadFailure',
      error_message: 'HTTP 503',
    });
    expect(errors[0].data.imgID).toMatch(UUID_RE);
    expect(client.sent.filter((f) => f.type === 'jobState' && f.data.type === 'jobCompleted')).toHaveLength(0);
  });

  it('rejects unacceptable jobs with a jobError and never starts them', async () => {
    const { client } = setup({
      executor: {
        accept: vi.fn(() => {
          throw new JobError('unsupported_model', 'No enabled engine for modelID "x"');
        }),
      },
    });
    client.emit('frame', 'jobRequest', job());
    await flush();

    expect(client.framesOf('jobState')).toHaveLength(0);
    expect(client.framesOf('jobError')[0].data.error).toBe('unsupported_model');
  });

  // Cancellation arrives as an inbound jobError (isFromWorker: false); the
  // broker waits for the worker's echo, then readyToAcceptJobs clears the
  // 30s cancel cooldown.
  it('handles inbound cancellation: abort, echo jobError, readyToAcceptJobs', async () => {
    let releaseExecute;
    const gate = new Promise((resolve) => { releaseExecute = resolve; });
    const { client, executor } = setup({
      executor: {
        execute: vi.fn(async () => {
          await gate;
          throw new JobError('aborted', 'aborted');
        }),
      },
    });
    client.emit('frame', 'jobRequest', job());
    await flush();
    const startedImgID = client.framesOf('jobState')[0].data.imgID;

    client.emit('frame', 'jobError', {
      jobID: 'A0000000-0000-4000-8000-000000000031',
      isFromWorker: false,
      error: 'artistCanceled',
    });

    expect(executor.abort).toHaveBeenCalledWith('A0000000-0000-4000-8000-000000000031');
    const echo = client.framesOf('jobError')[0];
    expect(echo.data).toMatchObject({
      jobID: 'A0000000-0000-4000-8000-000000000031',
      imgID: startedImgID,
      isFromWorker: true,
      error: 'workerCancelled',
    });
    expect(client.framesOf('readyToAcceptJobs')[0].data).toEqual({ ready: true });

    // The aborted execution produces no further frames.
    releaseExecute();
    await flush();
    expect(client.framesOf('jobError')).toHaveLength(1);
    expect(client.framesOf('jobResult')).toHaveLength(0);
  });

  it('ignores a cancellation for a job it is not running', () => {
    const { client, executor } = setup({ executor: { abort: vi.fn(() => false) } });
    client.emit('frame', 'jobError', { jobID: 'nope', isFromWorker: false });
    expect(executor.abort).toHaveBeenCalledWith('nope');
    expect(client.framesOf('jobError')).toHaveLength(0);
    expect(client.framesOf('readyToAcceptJobs')).toHaveLength(0);
  });

  it('silently accepts expected broker frames and logs unknown types once', () => {
    const { client, logger } = setup();
    client.emit('frame', 'modelDownloadSuggest', { modelID: 'x' });
    client.emit('frame', 'pong', null);
    client.emit('frame', 'socketEventSubscriptionsUpdated', {});
    expect(logger.log).not.toHaveBeenCalled();

    client.emit('frame', 'mysteryFrame', {});
    client.emit('frame', 'mysteryFrame', {});
    const unknownLogs = logger.log.mock.calls.filter(([line]) => line.includes('mysteryFrame'));
    expect(unknownLogs).toHaveLength(1);
  });

  it('handles a dataless cancellation frame without throwing', () => {
    const { client } = setup();
    expect(() => client.emit('frame', 'jobError', null)).not.toThrow();
  });

  it('shutdown drains in-flight jobs before closing the socket', async () => {
    let releaseExecute;
    const gate = new Promise((resolve) => { releaseExecute = resolve; });
    const { client, executor, supervisor } = setup({
      executor: { execute: vi.fn(async () => { await gate; return { ...RESULT }; }) },
    });
    client.emit('frame', 'jobRequest', job());
    await flush();

    const shutdown = supervisor.shutdown();
    expect(executor.startDrain).toHaveBeenCalled();
    expect(client.closed).toBe(false);

    releaseExecute();
    await shutdown;
    expect(client.closed).toBe(true);
    // The drained job still completed its full frame sequence.
    expect(client.framesOf('jobResult')).toHaveLength(1);
  });

  it('shutdown gives up after the drain timeout', async () => {
    const { client, supervisor } = setup({
      executor: { execute: vi.fn(() => new Promise(() => {})) },
    });
    client.emit('frame', 'jobRequest', job());
    await flush();

    await supervisor.shutdown();
    expect(client.closed).toBe(true);
  });

  it('keeps running when a job dispatch crashes unexpectedly', async () => {
    const { client, logger } = setup({
      executor: { accept: vi.fn(() => { throw new TypeError('boom'); }) },
    });
    client.emit('frame', 'jobRequest', job());
    await flush();
    // Mapped to internal_error, not an unhandled rejection.
    expect(client.framesOf('jobError')[0].data.error).toBe('internal_error');
    expect(logger.error).toHaveBeenCalled();
  });
});
