import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SogniSocketClient } from '../../../src/network/socketClient.js';
import { SpeechExecutor } from '../../../src/network/executor.js';
import { SpeechWorkerSupervisor } from '../../../src/network/supervisor.js';
import { startMockSogniSocket, waitFor } from '../../utils/mockSogniSocket.js';

const MODELS = [
  { id: 'kokoro_82m', task: 'tts', engine: 'kokoro' },
  { id: 'parakeet_tdt_0.6b_v3', task: 'stt', engine: 'parakeet' },
];

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

// End-to-end over a real WebSocket: real client, real supervisor, real
// executor; only the ML daemons, sogni-api, and ffmpeg are faked.
describe('speech worker end to end (standard contract)', () => {
  let server;
  let supervisor;
  let client;
  let executor;
  let transcriptionService;
  let ttsService;
  let artifacts;
  let api;
  let tools;

  beforeEach(async () => {
    server = await startMockSogniSocket();

    transcriptionService = {
      transcribe: vi.fn(async () => ({
        text: 'network transcript',
        timestamps: [{ start: 0, end: 3.5, text: 'network transcript' }],
      })),
    };
    ttsService = {
      generate: vi.fn(async (text, options) => ({ outputPath: options.outputPath })),
    };
    artifacts = {
      downloadToFile: vi.fn(async (url, destPath) => ({ path: destPath, bytes: 2048 })),
      uploadFile: vi.fn(async () => ({ uploadedKey: 'video/2026-07-31/x/complete-y.mp3', bytes: 4096 })),
    };
    api = {
      requestMediaUploadUrl: vi.fn(async () => 'https://r2.test/put?sig=1'),
      requestMediaDownloadUrl: vi.fn(async () => 'https://r2.test/get?sig=2'),
    };
    tools = {
      transcodeWavToMp3: vi.fn(async (input, output) => output),
      probeDurationSeconds: vi.fn(async () => 3.6),
      synthesizeTestClip: vi.fn(async (path) => path),
    };

    executor = new SpeechExecutor({
      speechModels: MODELS,
      apiUrl: 'https://api-staging.sogni.ai',
      maxConcurrentJobs: 1,
      transcriptionService,
      ttsService,
      tempFiles: {
        createTempDir: vi.fn(async () => '/tmp/sogni-e2e'),
        cleanup: vi.fn(async () => {}),
      },
      artifacts,
      api,
      tools,
      writeArtifact: vi.fn(async () => {}),
    });

    client = new SogniSocketClient({
      url: server.url,
      apiKey: 'e2e-key',
      nftTokenId: '777',
      workerId: 'E2E-WORKER',
      userAgent: 'Sogni/4.0.0 (macOS) [sogni-voice-speech-worker/2.0.0]',
      reconnectInitialDelayMs: 50,
      reconnectMaxDelayMs: 100,
      logger: silentLogger,
    });

    supervisor = new SpeechWorkerSupervisor({
      client,
      executor,
      speechModels: MODELS,
      drainTimeoutMs: 3000,
      progressIntervalMs: 60000,
      logger: silentLogger,
    });
  });

  afterEach(async () => {
    client.close();
    await server.close();
  });

  const framesOfType = (type) => server.received.filter((frame) => frame.type === type);

  const ttsJob = () => ({
    jobID: 'E2E00000-0000-4000-8000-000000000001',
    jobType: 'audio',
    numberOfImages: 1,
    outputFormat: 'mp3',
    keyFrames: [{
      modelID: 'kokoro_82m',
      positivePrompt: 'Hello from the network.',
      voice: 'af_heart',
      speed: 1,
      duration: 2,
      steps: 1,
      seed: -1,
      outputFormat: 'mp3',
    }],
  });

  it('authenticates, registers, and completes a TTS job through the full frame sequence', async () => {
    supervisor.start();
    await waitFor(() => server.sockets.length === 1);

    // Standard auth headers on the upgrade.
    expect(server.headers['api-key']).toBe('e2e-key');
    expect(server.headers['nft-token-id']).toBe('777');
    expect(server.headers['client-type']).toBe('worker');
    expect(server.headers['worker-subtype']).toBeUndefined();

    // Registration waits for the authenticated frame.
    expect(framesOfType('workerInfo')).toHaveLength(0);
    server.send('authenticated', { username: 'universal' });
    await waitFor(() => framesOfType('workerInfo').length === 1);
    const [info] = framesOfType('workerInfo');
    expect(info.data.workerModels).toEqual(['kokoro_82m', 'parakeet_tdt_0.6b_v3']);
    expect(info.data.hardwareRating).toBeGreaterThanOrEqual(70);

    server.send('jobRequest', ttsJob());
    await waitFor(() => framesOfType('jobState').length === 2);

    const states = framesOfType('jobState');
    expect(states[0].data.type).toBe('jobStarted');
    expect(states[1].data.type).toBe('jobCompleted');
    const [result] = framesOfType('jobResult');
    expect(result.data).toMatchObject({
      jobID: 'E2E00000-0000-4000-8000-000000000001',
      imgID: states[0].data.imgID,
      userCanceled: false,
      performedStepCount: 1,
    });

    // jobResult hit the wire before jobCompleted.
    const order = server.received.map((f) => f.type);
    expect(order.indexOf('jobResult')).toBeLessThan(order.lastIndexOf('jobState'));

    // The artifact went through the media lane as mp3.
    expect(api.requestMediaUploadUrl).toHaveBeenCalledWith(expect.objectContaining({
      contentType: 'audio/mpeg',
      jobId: 'E2E00000-0000-4000-8000-000000000001',
    }));
    expect(ttsService.generate).toHaveBeenCalledWith('Hello from the network.', expect.objectContaining({
      voice: 'af_heart',
    }));
  });

  it('completes an STT job: redeems the input, uploads the JSON transcript', async () => {
    supervisor.start();
    await waitFor(() => server.sockets.length === 1);
    server.send('authenticated', {});
    await waitFor(() => framesOfType('workerInfo').length === 1);

    server.send('jobRequest', {
      jobID: 'E2E00000-0000-4000-8000-000000000002',
      jobType: 'audio',
      outputFormat: 'json',
      keyFrames: [{
        modelID: 'parakeet_tdt_0.6b_v3',
        positivePrompt: '',
        hasReferenceAudio: true,
        duration: 5,
        timestamps: 'sentence',
        steps: 1,
        seed: -1,
        outputFormat: 'json',
      }],
    });
    await waitFor(() => framesOfType('jobState').length === 2);

    expect(api.requestMediaDownloadUrl).toHaveBeenCalledWith(expect.objectContaining({
      type: 'referenceAudio',
      jobId: 'E2E00000-0000-4000-8000-000000000002',
    }));
    expect(transcriptionService.transcribe).toHaveBeenCalled();
    expect(api.requestMediaUploadUrl).toHaveBeenCalledWith(expect.objectContaining({
      contentType: 'application/json',
    }));
    expect(framesOfType('jobResult')).toHaveLength(1);
  });

  it('echoes a cancellation and signals readiness again', async () => {
    let releaseGenerate;
    ttsService.generate.mockImplementationOnce(() => new Promise((resolve) => {
      releaseGenerate = resolve;
    }));

    supervisor.start();
    await waitFor(() => server.sockets.length === 1);
    server.send('authenticated', {});
    await waitFor(() => framesOfType('workerInfo').length === 1);

    server.send('jobRequest', ttsJob());
    await waitFor(() => framesOfType('jobState').length === 1);

    server.send('jobError', {
      jobID: 'E2E00000-0000-4000-8000-000000000001',
      isFromWorker: false,
      error: 'artistCanceled',
    });
    await waitFor(() => framesOfType('jobError').length === 1);

    expect(framesOfType('jobError')[0].data).toMatchObject({
      isFromWorker: true,
      error: 'workerCancelled',
    });
    expect(framesOfType('readyToAcceptJobs')[0].data).toEqual({ ready: true });

    releaseGenerate({});
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(framesOfType('jobResult')).toHaveLength(0);
  });

  it('reconnects after a broker restart and re-registers on the new socket', async () => {
    supervisor.start();
    await waitFor(() => server.sockets.length === 1);
    server.send('authenticated', {});
    await waitFor(() => framesOfType('workerInfo').length === 1);

    server.closeClients(1012, 'restarting');
    await waitFor(() => server.sockets.length === 2);
    server.send('authenticated', {});
    await waitFor(() => framesOfType('workerInfo').length >= 2);
  });
});
