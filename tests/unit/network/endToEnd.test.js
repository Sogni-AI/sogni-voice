import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SogniSocketClient } from '../../../src/network/socketClient.js';
import { SpeechExecutor } from '../../../src/network/executor.js';
import { SpeechWorkerSupervisor } from '../../../src/network/supervisor.js';
import { startMockSogniSocket, waitFor } from '../../utils/mockSogniSocket.js';

const MODELS = [
  { id: 'parakeet-tdt', task: 'stt', maxConcurrent: 1, engine: 'parakeet' },
  { id: 'kokoro-82m', task: 'tts', maxConcurrent: 2, engine: 'kokoro' },
];

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

describe('speech worker end to end', () => {
  let server;
  let supervisor;
  let client;
  let executor;
  let transcriptionService;
  let ttsService;
  let artifacts;

  beforeEach(async () => {
    server = await startMockSogniSocket();

    transcriptionService = {
      transcribe: vi.fn(async () => ({
        text: 'network transcript',
        rawOutput: '',
        timestamps: [{ start: 0, end: 3.5, text: 'network transcript' }],
      })),
    };
    ttsService = {
      generate: vi.fn(async (text, options) => ({ outputPath: options.outputPath, duration: 1 })),
    };
    artifacts = {
      downloadToFile: vi.fn(async (url, destPath) => ({ path: destPath, bytes: 2048 })),
      uploadFile: vi.fn(async () => ({ uploadedKey: 'speech/out/e2e.wav', bytes: 4096 })),
    };

    executor = new SpeechExecutor({
      speechModels: MODELS,
      maxConcurrentJobs: 1,
      transcriptionService,
      ttsService,
      tempFiles: {
        createTempDir: vi.fn(async () => '/tmp/sogni-e2e'),
        cleanup: vi.fn(async () => {}),
      },
      artifacts,
    });

    client = new SogniSocketClient({
      url: server.url,
      apiKey: 'e2e-key',
      workerId: 'E2E-WORKER',
      userAgent: 'Sogni/3.0.118 (Darwin) | Speech:MLX | speech-worker/1.0.0',
      reconnectInitialDelayMs: 50,
      reconnectMaxDelayMs: 100,
      logger: silentLogger,
    });

    supervisor = new SpeechWorkerSupervisor({
      client,
      executor,
      speechModels: MODELS,
      maxConcurrentJobs: 1,
      capacityIntervalMs: 30,
      drainTimeoutMs: 3000,
      logger: silentLogger,
    });
  });

  afterEach(async () => {
    supervisor.stopCapacityLoop();
    client.close();
    await server.close();
  });

  const framesOfType = (type) => server.received.filter((frame) => frame.type === type);

  it('registers, runs an STT job, and reports capacity', async () => {
    supervisor.start();
    await waitFor(() => framesOfType('workerInfo').length === 1);

    expect(framesOfType('workerInfo')[0].data).toEqual({
      speechModels: [
        { id: 'parakeet-tdt', task: 'stt', maxConcurrent: 1 },
        { id: 'kokoro-82m', task: 'tts', maxConcurrent: 2 },
      ],
      loadedModelIDs: [],
      maxConcurrentJobs: 1,
    });

    server.send('jobRequest', {
      jobID: 'e2e-stt',
      projectID: 'proj-e2e',
      jobType: 'speech',
      task: 'stt',
      modelID: 'parakeet-tdt',
      params: {},
      input: { url: 'https://s3.test/in/e2e.wav' },
      output: null,
      timeoutMs: 30000,
    });

    await waitFor(() => framesOfType('jobResult').length === 1);
    const result = framesOfType('jobResult')[0].data;
    expect(result.jobID).toBe('e2e-stt');
    expect(result.transcript.text).toBe('network transcript');
    expect(result.meta.audioSeconds).toBe(3.5);
    expect(typeof result.meta.durationMs).toBe('number');

    expect(framesOfType('jobState').map((frame) => frame.data.state))
      .toEqual(['accepted', 'started']);

    await waitFor(
      () => framesOfType('speechCapacityUpdate').some((frame) => frame.data.activeRequests === 0),
    );
  });

  it('runs a TTS job and reports the uploaded key', async () => {
    supervisor.start();
    await waitFor(() => framesOfType('workerInfo').length === 1);

    server.send('jobRequest', {
      jobID: 'e2e-tts',
      projectID: 'proj-e2e',
      jobType: 'speech',
      task: 'tts',
      modelID: 'kokoro-82m',
      params: { text: 'Twelve chars', voice: 'af_heart' },
      input: null,
      output: { uploadUrl: 'https://bucket.s3.test/speech/out/e2e.wav?sig=1' },
      timeoutMs: 30000,
    });

    await waitFor(() => framesOfType('jobResult').length === 1);
    expect(framesOfType('jobResult')[0].data).toMatchObject({
      jobID: 'e2e-tts',
      uploadedKey: 'speech/out/e2e.wav',
      meta: { charCount: 12 },
    });
    expect(artifacts.uploadFile).toHaveBeenCalledTimes(1);
  });

  it('rejects a second concurrent job with capacity_exceeded', async () => {
    supervisor.start();
    await waitFor(() => framesOfType('workerInfo').length === 1);

    let releaseFirst;
    transcriptionService.transcribe.mockImplementationOnce(
      () => new Promise((resolve) => { releaseFirst = () => resolve({ text: 'slow', rawOutput: '' }); }),
    );

    const request = (jobID) => ({
      jobID,
      projectID: 'proj-e2e',
      jobType: 'speech',
      task: 'stt',
      modelID: 'parakeet-tdt',
      params: {},
      input: { url: 'https://s3.test/in/e2e.wav' },
      output: null,
      timeoutMs: 30000,
    });

    server.send('jobRequest', request('busy-1'));
    await waitFor(() => framesOfType('jobState').length === 2);

    server.send('jobRequest', request('busy-2'));
    await waitFor(() => framesOfType('jobError').length === 1);

    expect(framesOfType('jobError')[0].data).toMatchObject({
      jobID: 'busy-2',
      code: 'capacity_exceeded',
    });

    releaseFirst();
    await waitFor(() => framesOfType('jobResult').length === 1);
  });

  it('drains an in-flight job on shutdown before closing the socket', async () => {
    supervisor.start();
    await waitFor(() => framesOfType('workerInfo').length === 1);

    let releaseJob;
    transcriptionService.transcribe.mockImplementationOnce(
      () => new Promise((resolve) => {
        releaseJob = () => resolve({ text: 'drained', rawOutput: '' });
      }),
    );

    server.send('jobRequest', {
      jobID: 'drain-1',
      projectID: 'proj-e2e',
      jobType: 'speech',
      task: 'stt',
      modelID: 'parakeet-tdt',
      params: {},
      input: { url: 'https://s3.test/in/e2e.wav' },
      output: null,
      timeoutMs: 30000,
    });
    await waitFor(() => framesOfType('jobState').length === 2);

    const draining = supervisor.shutdown();
    expect(executor.draining).toBe(true);

    releaseJob();
    await draining;

    await waitFor(() => framesOfType('jobResult').length === 1);
    expect(framesOfType('jobResult')[0].data.transcript.text).toBe('drained');
  });
});
