import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { SpeechWorkerSupervisor } from '../../../src/network/supervisor.js';
import { JobError } from '../../../src/network/executor.js';
import { waitFor } from '../../utils/mockSogniSocket.js';

const MODELS = [
  { id: 'parakeet-tdt-0.6b-v3', task: 'stt', maxConcurrent: 1, engine: 'parakeet' },
  { id: 'kokoro-82m', task: 'tts', maxConcurrent: 2, engine: 'kokoro' },
];

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.connect = vi.fn();
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

const sttJob = (jobID = 'job-1') => ({
  jobID,
  projectID: 'proj-1',
  jobType: 'speech',
  task: 'stt',
  modelID: 'parakeet-tdt-0.6b-v3',
  params: {},
  input: { url: 'https://s3.test/in/clip.wav' },
  output: null,
  timeoutMs: 60000,
});

describe('SpeechWorkerSupervisor', () => {
  let client;
  let executor;
  let supervisor;

  beforeEach(() => {
    client = new FakeClient();
    executor = {
      activeRequests: 0,
      accept: vi.fn(),
      execute: vi.fn(async (job) => ({
        jobID: job.jobID,
        transcript: 'hi',
        transcriptDetails: { text: 'hi', rawOutput: '' },
        meta: { audioSeconds: 1.2, durationMs: 900 },
      })),
      abort: vi.fn(() => true),
      startDrain: vi.fn(),
    };
    supervisor = new SpeechWorkerSupervisor({
      client,
      executor,
      speechModels: MODELS,
      maxConcurrentJobs: 2,
      capacityIntervalMs: 20,
      drainTimeoutMs: 2000,
      logger: silentLogger,
    });
  });

  it('connects and registers workerInfo on open', () => {
    supervisor.start();
    expect(client.connect).toHaveBeenCalled();

    client.emit('open');
    expect(client.sent[0]).toEqual({
      type: 'workerInfo',
      data: {
        speechModels: [
          { id: 'parakeet-tdt-0.6b-v3', task: 'stt', maxConcurrent: 1 },
          { id: 'kokoro-82m', task: 'tts', maxConcurrent: 2 },
        ],
        loadedModelIDs: [],
        maxConcurrentJobs: 2,
      },
    });
    supervisor.stopCapacityLoop();
  });

  it('re-registers when the broker sends authenticated', () => {
    supervisor.start();
    client.emit('frame', 'authenticated', { ok: true });
    expect(client.sentTypes()).toEqual(['workerInfo']);
  });

  // A broker that streams an unrecognized type would otherwise write a log line
  // per frame for as long as it keeps sending them.
  it('logs an unknown frame type once, however many arrive', () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const quiet = new SpeechWorkerSupervisor({
      client,
      executor,
      speechModels: MODELS,
      maxConcurrentJobs: 2,
      logger,
    });
    quiet.start();

    client.emit('frame', 'speechModelDownload', { modelID: 'x' });
    client.emit('frame', 'speechModelDownload', { modelID: 'x' });
    client.emit('frame', 'speechModelDownload', { modelID: 'y' });

    const ignored = logger.log.mock.calls
      .filter(([line]) => line.includes('Ignoring frame type speechModelDownload'));
    expect(ignored).toHaveLength(1);

    // A different unknown type still gets its own line.
    client.emit('frame', 'someOtherFrame', {});
    expect(logger.log.mock.calls
      .filter(([line]) => line.includes('Ignoring frame type someOtherFrame'))).toHaveLength(1);
  });

  it('emits capacity updates on the configured interval', async () => {
    supervisor.start();
    client.emit('open');
    executor.activeRequests = 1;

    await new Promise((resolve) => setTimeout(resolve, 70));
    supervisor.stopCapacityLoop();

    const capacity = client.sent.filter((frame) => frame.type === 'speechCapacityUpdate');
    expect(capacity.length).toBeGreaterThanOrEqual(2);
    expect(capacity[0].data).toEqual({ activeRequests: 1 });
  });

  it('runs a job and emits accepted, started, then jobResult', async () => {
    supervisor.start();
    await supervisor.handleJobRequest(sttJob());

    expect(client.sentTypes()).toEqual(['jobState', 'jobState', 'jobResult']);
    expect(client.sent[0].data).toEqual({ jobID: 'job-1', type: 'accepted' });
    expect(client.sent[1].data).toEqual({ jobID: 'job-1', type: 'started' });
    expect(client.sent[2].data).toEqual({
      jobID: 'job-1',
      transcript: 'hi',
      transcriptDetails: { text: 'hi', rawOutput: '' },
      meta: { audioSeconds: 1.2, durationMs: 900 },
    });
  });

  it('emits jobError without jobState when the job is rejected at accept', async () => {
    executor.accept.mockImplementationOnce(() => {
      throw new JobError('capacity_exceeded', 'Worker is at capacity (2 concurrent jobs)');
    });
    supervisor.start();

    await supervisor.handleJobRequest(sttJob('job-2'));

    expect(client.sentTypes()).toEqual(['jobError']);
    expect(client.sent[0].data).toEqual({
      jobID: 'job-2',
      code: 'capacity_exceeded',
      message: 'Worker is at capacity (2 concurrent jobs)',
    });
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('reports an execution failure as jobError', async () => {
    executor.execute.mockRejectedValueOnce(new JobError('stt_failed', 'daemon died'));
    supervisor.start();

    await supervisor.handleJobRequest(sttJob('job-3'));

    expect(client.sent[2]).toEqual({
      type: 'jobError',
      data: { jobID: 'job-3', code: 'stt_failed', message: 'daemon died' },
    });
  });

  it('labels an unexpected error internal_error', async () => {
    executor.execute.mockRejectedValueOnce(new TypeError('undefined is not a function'));
    supervisor.start();

    await supervisor.handleJobRequest(sttJob('job-4'));

    expect(client.sent[2].data.code).toBe('internal_error');
  });

  it('stays silent after an aborted job', async () => {
    executor.execute.mockRejectedValueOnce(new JobError('aborted', 'Job job-5 was aborted'));
    supervisor.start();

    await supervisor.handleJobRequest(sttJob('job-5'));

    expect(client.sentTypes()).toEqual(['jobState', 'jobState']);
  });

  it('treats an inbound jobError as an abort', () => {
    supervisor.start();
    client.emit('frame', 'jobError', { jobID: 'job-6', code: 'cancelled', message: 'user cancel' });
    expect(executor.abort).toHaveBeenCalledWith('job-6');
  });

  it('also handles a defensive jobCancel', () => {
    supervisor.start();
    client.emit('frame', 'jobCancel', { jobID: 'job-7' });
    expect(executor.abort).toHaveBeenCalledWith('job-7');
  });

  it('ignores unknown frame types', () => {
    supervisor.start();
    expect(() => client.emit('frame', 'supportedModels', { models: [] })).not.toThrow();
    expect(client.sent).toEqual([]);
  });

  it('tolerates dataless broker frames', () => {
    supervisor.start();
    expect(() => client.emit('frame', 'jobCancel', null)).not.toThrow();
    expect(executor.abort).not.toHaveBeenCalled();
  });

  it('sends the last jobResult before closing the socket on shutdown', async () => {
    supervisor.start();
    client.emit('open');

    let releaseJob;
    executor.execute.mockImplementationOnce(() => new Promise((resolve) => {
      releaseJob = () => resolve({
        jobID: 'job-8',
        transcript: 'late',
        transcriptDetails: { text: 'late', rawOutput: '' },
        meta: { audioSeconds: 1, durationMs: 5 },
      });
    }));

    client.emit('frame', 'jobRequest', sttJob('job-8'));
    await waitFor(() => client.sentTypes().includes('jobState'));

    const draining = supervisor.shutdown();
    expect(executor.startDrain).toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();

    releaseJob();
    await draining;

    const meaningful = client.sentTypes().filter((type) => type !== 'speechCapacityUpdate');
    expect(meaningful).toEqual(['workerInfo', 'jobState', 'jobState', 'jobResult']);
    expect(client.close).toHaveBeenCalled();
    expect(supervisor.capacityTimer).toBeNull();
    expect(supervisor.inFlight.size).toBe(0);
  });

  it('emits jobProgress keepalives while a job is in flight and stops after the terminal frame', async () => {
    supervisor.progressIntervalMs = 10;
    supervisor.start();
    let releaseJob;
    executor.execute.mockImplementationOnce(() => new Promise((resolve) => {
      releaseJob = () => resolve({
        jobID: 'job-9',
        transcript: 'slow',
        transcriptDetails: { text: 'slow', rawOutput: '' },
        meta: { audioSeconds: 1, durationMs: 5 },
      });
    }));

    client.emit('frame', 'jobRequest', sttJob('job-9'));
    await waitFor(() => client.sentTypes().includes('jobProgress'));

    const pulse = client.sent.find((frame) => frame.type === 'jobProgress');
    expect(pulse.data.jobID).toBe('job-9');
    expect(pulse.data.progress).toBeGreaterThanOrEqual(0);
    expect(pulse.data.progress).toBeLessThanOrEqual(0.95);

    releaseJob();
    await waitFor(() => client.sentTypes().includes('jobResult'));
    const framesAtCompletion = client.sent.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    const framesAfterWait = client.sent
      .slice(framesAtCompletion)
      .filter((frame) => frame.type === 'jobProgress');
    expect(framesAfterWait).toEqual([]); // timer cleared with the job
  });
});
