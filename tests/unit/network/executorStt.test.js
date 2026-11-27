import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VOICE_SUPERNET_MODELS } from '../../../src/network/capabilities.js';
import { VoiceSupernetExecutor } from '../../../src/network/executor.js';

describe('VoiceSupernetExecutor STT (Parakeet & Nemotron)', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'sogni-exec-stt-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const makeSetup = (overrides = {}) => {
    const uploadedPayloads = [];
    const backend = {
      transcribe: vi.fn(async ({ engine }) => (
        engine === 'nemotron'
          ? {
              text: '<spk:0> Welcome aboard. <spk:1> Thank you.',
              finishReason: 'stop',
              complete: true,
              timestamps: [
                { text: 'Welcome', start: 0.1, end: 0.5, speaker: 'S01' },
                { text: 'aboard.', start: 0.5, end: 1.0, speaker: 'S01' },
                { text: 'Thank', start: 1.2, end: 1.5, speaker: 'S02' },
                { text: 'you.', start: 1.5, end: 1.9, speaker: 'S02' },
              ],
            }
          : {
              text: 'Parakeet clean transcript.',
              timestamps: [{ start: 0.0, end: 2.1, text: 'Parakeet clean transcript.' }],
            }
      )),
      synthesizeDrama3: vi.fn(),
    };

    const artifacts = {
      downloadReferenceAudio: vi.fn(async (_job, dir) => ({
        path: join(dir, 'input.wav'),
        bytes: 4096,
        detectedFormat: 'wav',
      })),
      validateAndProbeAudio: vi.fn(async () => ({ duration: 10.5, formatName: 'wav' })),
      transcodeAndVerifySttAudio: vi.fn(async (_inPath, outPath) => ({
        path: outPath,
        duration: 10.5,
      })),
      transcodeReferenceWav: vi.fn(),
      uploadJobArtifact: vi.fn(async (req) => {
        uploadedPayloads.push(req);
        return {
          uploadUrl: 'https://r2.sogni.test/complete.json',
          uploadedKey: 'complete.json',
          bytes: req.buffer.length,
          sha256: 'c'.repeat(64),
        };
      }),
    };

    let clock = 1000;
    const executor = new VoiceSupernetExecutor({
      workerModels: VOICE_SUPERNET_MODELS,
      backend,
      apiUrl: 'https://api.sogni.test',
      tempFiles: {
        createTempDir: vi.fn(async () => tempDir),
        cleanup: vi.fn(async () => {}),
      },
      artifacts,
      now: () => {
        clock += 200;
        return clock;
      },
      ...overrides,
    });

    return { executor, backend, artifacts, uploadedPayloads };
  };

  it('transcribes Parakeet audio and uploads canonical application/json artifact', async () => {
    const { executor, backend, artifacts, uploadedPayloads } = makeSetup();
    const job = {
      jobID: 'stt-parakeet-1',
      imageId: 'img-p1',
      workflowId: 'parakeet_tdt_0.6b_v3_bf16',
      outputFormat: 'json',
      clientParams: { seed: 7, duration: 12, timestamps: 'sentence' },
      assets: [{ type: 'audio', jobField: 'audio', signedDownloadType: 'referenceAudio' }],
    };

    executor.accept(job);
    const result = await executor.execute(job);

    expect(artifacts.downloadReferenceAudio).toHaveBeenCalledTimes(1);
    expect(backend.transcribe).toHaveBeenCalledWith(expect.objectContaining({
      engine: 'parakeet',
      timestamps: true,
      wordTimestamps: false,
      diarize: false,
    }));

    expect(uploadedPayloads).toHaveLength(1);
    expect(uploadedPayloads[0].contentType).toBe('application/json');
    const transcriptJson = JSON.parse(uploadedPayloads[0].buffer.toString('utf-8'));
    expect(transcriptJson).toEqual({
      version: 1,
      model: 'parakeet_tdt_0.6b_v3_bf16',
      text: 'Parakeet clean transcript.',
      duration: 10.5,
      language: 'auto',
      diarized: false,
      timestampGranularity: 'sentence',
      segments: [{ id: 0, start: 0, end: 2.1, text: 'Parakeet clean transcript.' }],
      complete: true,
      finishReason: 'stop',
    });
    expect(transcriptJson).not.toHaveProperty('words');
    expect(result).toMatchObject({
      jobID: 'stt-parakeet-1',
      imgID: 'img-p1',
      performedStepCount: 1,
      lastSeed: 7,
      sha256: 'c'.repeat(64),
    });
  });

  it('transcribes Nemotron with diarization, hotwords, and prompt hint, stripping <spk:N> from text', async () => {
    const { executor, backend, uploadedPayloads } = makeSetup();
    const job = {
      jobID: 'stt-nemotron-1',
      imageId: 'img-n1',
      workflowId: 'nemotron_3.5_transcribe_30b_a4b_nvfp4',
      outputFormat: 'json',
      clientParams: {
        duration: 15,
        timestamps: 'word',
        diarize: true,
        hotwords: 'Sogni, TensorFold, GB10',
        tags: 'Technical podcast interview',
      },
      assets: [{ type: 'audio', jobField: 'audio', url: 'https://s3.test/interview.mp3' }],
    };

    executor.accept(job);
    await executor.execute(job);

    expect(backend.transcribe).toHaveBeenCalledWith(expect.objectContaining({
      engine: 'nemotron',
      timestamps: true,
      wordTimestamps: true,
      diarize: true,
      hotwords: 'Sogni, TensorFold, GB10',
      prompt: 'Technical podcast interview',
    }));

    const transcriptJson = JSON.parse(uploadedPayloads[0].buffer.toString('utf-8'));
    expect(transcriptJson.text).toBe('Welcome aboard. Thank you.');
    expect(transcriptJson.rawText).toBe('<spk:0> Welcome aboard. <spk:1> Thank you.');
    expect(transcriptJson.diarized).toBe(true);
    expect(transcriptJson.segments).toEqual([
      { id: 0, start: 0.1, end: 1, text: 'Welcome aboard.', speaker: 'S01' },
      { id: 1, start: 1.2, end: 1.9, text: 'Thank you.', speaker: 'S02' },
    ]);
    expect(transcriptJson.words[0]).toEqual({
      word: 'Welcome',
      start: 0.1,
      end: 0.5,
      speaker: 'S01',
    });
  });

  it('synthesizes a 2s 16kHz PCM WAV test clip for isTest === true without downloading any asset', async () => {
    const { executor, artifacts, uploadedPayloads } = makeSetup();
    const job = {
      jobID: 'stt-test-1',
      imageId: 'img-test',
      workflowId: 'parakeet_tdt_0.6b_v3_bf16',
      isTest: true,
      clientParams: {},
      assets: [],
    };

    executor.accept(job);
    await executor.execute(job);

    expect(artifacts.downloadReferenceAudio).not.toHaveBeenCalled();
    expect(artifacts.validateAndProbeAudio).not.toHaveBeenCalled();
    const transcriptJson = JSON.parse(uploadedPayloads[0].buffer.toString('utf-8'));
    expect(transcriptJson.duration).toBe(2);
  });

  it('enforces tight Math.ceil(declaredDuration * 1.02 + 1.5) STT worker tolerance while keeping 256 MiB maxBytes', async () => {
    const { executor, artifacts, backend } = makeSetup();
    // 1s declared -> allowedMaxDuration = Math.ceil(1 * 1.02 + 1.5) = 3s (closes 6x short-clip exploit)
    artifacts.transcodeAndVerifySttAudio.mockResolvedValueOnce({
      path: '/tmp/short-exploit.flac',
      duration: 3.4,
    });
    const shortExploitJob = {
      jobID: 'stt-short-exploit',
      imageId: 'img-short',
      workflowId: 'parakeet_tdt_0.6b_v3_bf16',
      clientParams: { duration: 1 },
      assets: [{ type: 'audio', jobField: 'audio', url: 'https://s3.test/short6s.mp3' }],
    };
    executor.accept(shortExploitJob);
    await expect(executor.execute(shortExploitJob)).rejects.toMatchObject({
      code: 'invalidInput',
      message: 'Audio duration 3.4s exceeds declared duration 1s',
    });
    expect(artifacts.downloadReferenceAudio).toHaveBeenLastCalledWith(
      shortExploitJob,
      tempDir,
      expect.objectContaining({ maxBytes: 256 * 1024 * 1024 }),
    );
    expect(artifacts.transcodeAndVerifySttAudio).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ allowedMaxDuration: 3, declaredDuration: 1 }),
    );
    expect(backend.transcribe).not.toHaveBeenCalled();

    // Omitted duration defaults to 60s -> allowedMaxDuration = Math.ceil(60 * 1.02 + 1.5) = 63s
    artifacts.transcodeAndVerifySttAudio.mockResolvedValueOnce({
      path: '/tmp/clean-omitted.flac',
      duration: 63.5,
    });
    const omittedJob = {
      jobID: 'stt-omitted-overrun',
      imageId: 'img-omitted',
      workflowId: 'parakeet_tdt_0.6b_v3_bf16',
      clientParams: {},
      assets: [{ type: 'audio', jobField: 'audio', url: 'https://s3.test/long2.mp3' }],
    };
    executor.accept(omittedJob);
    await expect(executor.execute(omittedJob)).rejects.toMatchObject({
      code: 'invalidInput',
      message: 'Audio duration 63.5s exceeds declared duration 60s',
    });
    expect(artifacts.transcodeAndVerifySttAudio).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ allowedMaxDuration: 63, declaredDuration: 60 }),
    );

    // HTTP 404 / 0-byte download maps to invalidInput rather than genfailure
    const dl404 = new Error('Input download failed with HTTP 404');
    dl404.invalidInput = true;
    artifacts.downloadReferenceAudio.mockRejectedValueOnce(dl404);
    const missingJob = {
      jobID: 'stt-404',
      imageId: 'img-404',
      workflowId: 'parakeet_tdt_0.6b_v3_bf16',
      clientParams: { duration: 30 },
      assets: [{ type: 'audio', jobField: 'audio', url: 'https://s3.test/missing.mp3' }],
    };
    executor.accept(missingJob);
    await expect(executor.execute(missingJob)).rejects.toMatchObject({
      code: 'invalidInput',
      message: expect.stringMatching(/HTTP 404/),
    });
  });
});
