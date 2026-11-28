import http from 'node:http';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createSyntheticTestWavBuffer } from '../../../src/utils/audioFormat.js';
import { HttpVoiceBackend } from '../../../src/network/backends.js';
import { VoiceSupernetExecutor } from '../../../src/network/executor.js';
import { SogniSocketClient } from '../../../src/network/socketClient.js';
import { VoiceWorkerSupervisor } from '../../../src/network/supervisor.js';
import { startMockSogniSocket, waitFor } from '../../utils/mockSogniSocket.js';

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

describe('Sogni Voice Supernet Worker end-to-end (WebSocket + HTTP sidecar + GET-with-body media API)', () => {
  let wsServer;
  let mediaAndVoiceServer;
  let apiUrl;
  let uploadedArtifacts;
  let mediaRequests;
  let supervisor;
  let client;
  let tempRoot;

  beforeEach(async () => {
    tempRoot = await mkdtemp(`${tmpdir()}/sogni-e2e-`);
    uploadedArtifacts = new Map();
    mediaRequests = [];
    wsServer = await startMockSogniSocket();

    const sampleWav = createSyntheticTestWavBuffer({ durationSeconds: 2, sampleRate: 44100 });

    mediaAndVoiceServer = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks);
        const port = mediaAndVoiceServer.address().port;
        const base = `http://127.0.0.1:${port}`;

        if (req.url === '/v1/client/key' && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.url === '/v1/media/downloadUrl' && req.method === 'GET') {
          const parsed = JSON.parse(rawBody.toString('utf-8'));
          mediaRequests.push({ endpoint: req.url, method: req.method, body: parsed });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: { downloadUrl: `${base}/r2/in/${parsed.id}.wav` } }));
          return;
        }
        if (req.url?.startsWith('/r2/in/') && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': sampleWav.length });
          res.end(sampleWav);
          return;
        }
        if (req.url === '/v1/media/uploadUrl' && req.method === 'GET') {
          const parsed = JSON.parse(rawBody.toString('utf-8'));
          mediaRequests.push({ endpoint: req.url, method: req.method, body: parsed });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: { uploadUrl: `${base}/r2/out/${parsed.id}` } }));
          return;
        }
        if (req.url?.startsWith('/r2/out/') && req.method === 'PUT') {
          const id = req.url.split('/').pop();
          uploadedArtifacts.set(id, {
            contentType: req.headers['content-type'],
            buffer: rawBody,
          });
          res.writeHead(200);
          res.end();
          return;
        }
        if (req.url === '/transcription/models' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            models: [
              { id: 'parakeet', enabled: true, timestamps: ['sentence', 'word'] },
              { id: 'nemotron', enabled: true, timestamps: ['sentence', 'word'] },
            ],
          }));
          return;
        }
        if (req.url === '/drama3-tts/status' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ model: 'drama-3-nvfp4-pruned', ready: true }));
          return;
        }
        if (req.url === '/transcribe' && req.method === 'POST') {
          const bodyStr = rawBody.toString('utf-8');
          const isNemotron = bodyStr.includes('nemotron');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          if (isNemotron) {
            res.end(JSON.stringify({
              success: true,
              transcript: '<spk:0> Hello Spark. <spk:1> Ready for Supernet.',
              finishReason: 'stop',
              complete: true,
              timestamps: [
                { text: 'Hello Spark.', start: 0.1, end: 1.0, speaker: 'S01' },
                { text: 'Ready for Supernet.', start: 1.1, end: 2.0, speaker: 'S02' },
              ],
            }));
          } else {
            res.end(JSON.stringify({
              success: true,
              transcript: 'Reference voice transcript.',
              timestamps: [{ text: 'Reference voice transcript.', start: 0.0, end: 1.8 }],
            }));
          }
          return;
        }
        if (req.url === '/drama3-tts' && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'audio/wav', 'X-Finish-Reason': 'stop' });
          res.end(sampleWav);
          return;
        }
        res.writeHead(404);
        res.end('Not found');
      });
    });

    await new Promise((resolve) => mediaAndVoiceServer.listen(0, '127.0.0.1', resolve));
    apiUrl = `http://127.0.0.1:${mediaAndVoiceServer.address().port}`;

    const backend = new HttpVoiceBackend({
      apiUrl,
      apiKey: 'voice-api-key',
      logger: silentLogger,
    });
    const workerModels = await backend.discoverModels();

    const executor = new VoiceSupernetExecutor({
      workerModels,
      backend,
      apiUrl,
      sogniEnv: 'local',
      artifacts: {
        downloadReferenceAudio: (await import('../../../src/network/artifacts.js')).downloadReferenceAudio,
        validateAndProbeAudio: async () => ({ duration: 2.0, formatName: 'wav' }),
        transcodeAndVerifySttAudio: async (inPath) => ({ path: inPath, duration: 2.0 }),
        transcodeReferenceWav: async (inPath) => inPath,
        uploadJobArtifact: (await import('../../../src/network/artifacts.js')).uploadJobArtifact,
      },
    });

    client = new SogniSocketClient({
      url: wsServer.url,
      socketApiUrl: apiUrl,
      origin: wsServer.url,
      sogniEnv: 'local',
      apiKey: 'supernet-key',
      nftTokenId: '101',
      workerId: 'VOICE-WORKER-01',
      userAgent: 'Sogni/3.0.0129 (linux) | IMG:COMFY | comfy-worker/1.0.260',
      validateClientKey: true,
      logger: silentLogger,
    });

    supervisor = new VoiceWorkerSupervisor({
      client,
      executor,
      workerModels,
      hardwareRating: 70,
      hardwareInfo: {
        cpuBrand: 'ARM Cortex-X925',
        gpuBrand: 'NVIDIA GB10',
        vram: 120,
        ram: 120,
      },
      etaIntervalMs: 50,
      logger: silentLogger,
    });
  });

  afterEach(async () => {
    await supervisor?.shutdown();
    await wsServer?.close();
    await new Promise((resolve) => mediaAndVoiceServer.close(resolve));
    await rm(tempRoot, { recursive: true, force: true });
  });

  const framesOfType = (type) => wsServer.received.filter((f) => f.type === type);

  it('waits for authenticated before registering, then executes Nemotron STT and Drama 3 TTS end-to-end', async () => {
    await supervisor.start();
    await waitFor(() => client.connected);

    // Must NOT have sent workerInfo on 'open' alone!
    expect(wsServer.received).toEqual([]);

    wsServer.send('authenticated', { workerId: 'VOICE-WORKER-01' });
    await waitFor(() => framesOfType('readyToAcceptJobs').length === 1);

    expect(framesOfType('workerInfo')[0].data.workerModels).toEqual([
      'fish_drama_3_nvfp4',
      'parakeet_tdt_0.6b_v3_bf16',
      'nemotron_3.5_transcribe_30b_a4b_nvfp4',
    ]);

    // Dispatch Nemotron diarized STT job requiring GET-with-body downloadUrl & uploadUrl
    wsServer.send('jobRequest', {
      jobID: 'e2e-nemotron-1',
      imageId: 'artifact-nemotron-1',
      workflowId: 'nemotron_3.5_transcribe_30b_a4b_nvfp4',
      outputFormat: 'json',
      clientParams: { seed: 11, duration: 10, timestamps: 'sentence', diarize: true },
      assets: [{
        type: 'audio',
        jobField: 'audio',
        signedDownloadType: 'referenceAudio',
        metadata: { assetId: 'input-nemotron-1', contentType: 'audio/wav' },
      }],
    });

    await waitFor(() => framesOfType('jobResult').length === 1);
    await waitFor(() => framesOfType('readyToAcceptJobs').length === 2);

    const uploadedStt = uploadedArtifacts.get('artifact-nemotron-1');
    expect(uploadedStt.contentType).toBe('application/json');
    const sttPayload = JSON.parse(uploadedStt.buffer.toString('utf-8'));
    expect(sttPayload).toMatchObject({
      version: 1,
      model: 'nemotron_3.5_transcribe_30b_a4b_nvfp4',
      text: 'Hello Spark. Ready for Supernet.',
      rawText: '<spk:0> Hello Spark. <spk:1> Ready for Supernet.',
      diarized: true,
    });
    expect(mediaRequests[0]).toMatchObject({
      endpoint: '/v1/media/downloadUrl',
      method: 'GET',
      body: { type: 'referenceAudio', jobId: 'e2e-nemotron-1', id: 'input-nemotron-1' },
    });
    expect(mediaRequests[1]).toMatchObject({
      endpoint: '/v1/media/uploadUrl',
      method: 'GET',
      body: { type: 'complete', jobId: 'e2e-nemotron-1', id: 'artifact-nemotron-1', contentType: 'application/json' },
    });

    // Dispatch Drama 3 WAV TTS job
    wsServer.send('jobRequest', {
      jobID: 'e2e-drama3-1',
      imageId: 'artifact-drama3-1',
      workflowId: 'fish_drama_3_nvfp4',
      outputFormat: 'wav',
      clientParams: { seed: 22, tags: '[laughs] Hello from Drama 3!' },
      assets: [],
    });

    await waitFor(() => framesOfType('jobResult').length === 2);
    await waitFor(() => framesOfType('readyToAcceptJobs').length === 3);

    const uploadedTts = uploadedArtifacts.get('artifact-drama3-1');
    expect(uploadedTts.contentType).toBe('audio/wav');
    expect(uploadedTts.buffer.subarray(0, 4).toString()).toBe('RIFF');
  });
});
