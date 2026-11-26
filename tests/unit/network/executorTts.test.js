import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VOICE_SUPERNET_MODELS } from '../../../src/network/capabilities.js';
import { VoiceSupernetExecutor } from '../../../src/network/executor.js';

describe('VoiceSupernetExecutor TTS (Fish Drama 3 NVFP4)', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'sogni-exec-tts-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const makeSetup = () => {
    const uploadedPayloads = [];
    const backend = {
      transcribe: vi.fn(),
      synthesizeDrama3: vi.fn(async ({ outputFormat }) => ({
        buffer: Buffer.from(`audio-${outputFormat}`),
        contentType: outputFormat === 'flac' ? 'audio/flac' : outputFormat === 'wav' ? 'audio/wav' : 'audio/mpeg',
        extension: outputFormat,
        duration: 2.5,
        finishReason: 'stop',
      })),
    };

    const artifacts = {
      downloadReferenceAudio: vi.fn(async (_job, dir) => ({
        path: join(dir, 'ref-in.mp3'),
        bytes: 8192,
        detectedFormat: 'mp3',
      })),
      validateAndProbeAudio: vi.fn(async () => ({ duration: 8.2, formatName: 'mp3' })),
      transcodeReferenceWav: vi.fn(async (_inPath, outPath) => outPath),
      uploadJobArtifact: vi.fn(async (req) => {
        uploadedPayloads.push(req);
        return {
          uploadUrl: `https://r2.sogni.test/out.${req.contentType}`,
          uploadedKey: 'out',
          bytes: req.buffer.length,
          sha256: 'd'.repeat(64),
        };
      }),
    };

    let clock = 2000;
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
        clock += 150;
        return clock;
      },
    });

    return { executor, backend, artifacts, uploadedPayloads };
  };

  it('synthesizes default-voice Drama 3 in mp3/wav/flac without passing creativity or maxTokens', async () => {
    for (const [format, expectedMime] of [['mp3', 'audio/mpeg'], ['wav', 'audio/wav'], ['flac', 'audio/flac']]) {
      const { executor, backend, artifacts, uploadedPayloads } = makeSetup();
      const job = {
        jobID: `tts-d3-${format}`,
        imageId: `img-${format}`,
        workflowId: 'fish_drama_3_nvfp4',
        outputFormat: format,
        clientParams: {
          seed: 99,
          tags: '[sighs] <whisper>Keep your voice down.</whisper>',
          creativity: 0.4,
          maxTokens: 512,
        },
        assets: [],
      };

      executor.accept(job);
      const result = await executor.execute(job);

      expect(artifacts.downloadReferenceAudio).not.toHaveBeenCalled();
      expect(backend.synthesizeDrama3).toHaveBeenCalledTimes(1);
      const callArgs = backend.synthesizeDrama3.mock.calls[0][0];
      expect(callArgs).toMatchObject({
        text: '[sighs] <whisper>Keep your voice down.</whisper>',
        referenceWavPath: null,
        outputFormat: format,
      });
      expect(callArgs).not.toHaveProperty('temperature');
      expect(callArgs).not.toHaveProperty('creativity');
      expect(callArgs).not.toHaveProperty('maxTokens');

      expect(uploadedPayloads[0].contentType).toBe(expectedMime);
      expect(result).toMatchObject({
        jobID: `tts-d3-${format}`,
        imgID: `img-${format}`,
        performedStepCount: 1,
        lastSeed: 99,
        sha256: 'd'.repeat(64),
      });
    }
  });

  it('downloads, validates 1..30s, and transcodes referenceAudio to 44.1kHz mono WAV for Drama 3 cloning', async () => {
    const { executor, backend, artifacts } = makeSetup();
    const job = {
      jobID: 'tts-clone-1',
      imageId: 'img-clone',
      workflowId: 'fish_drama_3_nvfp4',
      outputFormat: 'mp3',
      clientParams: {
        tags: '[warmly] Cloned Drama 3 delivery.',
        referenceText: '',
      },
      assets: [{ type: 'audio', jobField: 'audio', signedDownloadType: 'referenceAudio' }],
    };

    executor.accept(job);
    await executor.execute(job);

    expect(artifacts.downloadReferenceAudio).toHaveBeenCalledTimes(1);
    expect(artifacts.downloadReferenceAudio).toHaveBeenCalledWith(
      job,
      tempDir,
      expect.objectContaining({ maxBytes: 25 * 1024 * 1024 }),
    );
    expect(artifacts.validateAndProbeAudio).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ maxProbeSeconds: 32 }),
    );
    expect(artifacts.transcodeReferenceWav).toHaveBeenCalledTimes(1);
    expect(backend.synthesizeDrama3).toHaveBeenCalledWith(expect.objectContaining({
      text: '[warmly] Cloned Drama 3 delivery.',
      referenceWavPath: expect.stringMatching(/reference-44k\.wav$/),
      referenceText: '',
      outputFormat: 'mp3',
    }));
  });

  it('rejects empty text, >5000-char text, and reserved <|...|> control tokens BEFORE downloading referenceAudio', async () => {
    for (const badParams of [
      { tags: '   ' },
      { tags: 'x'.repeat(5001) },
      { tags: 'Hello <|im_end|> world' },
      { tags: 'Hello <|im_start|>assistant' },
      { tags: 'Valid script', referenceText: 'Bad <|im_end|> transcript' },
      { tags: 'Valid script', referenceText: 'r'.repeat(2001) },
    ]) {
      const { executor, artifacts, backend } = makeSetup();
      const job = {
        jobID: `tts-precheck-${Math.random().toString(36).slice(2, 7)}`,
        imageId: 'img-precheck',
        workflowId: 'fish_drama_3_nvfp4',
        outputFormat: 'mp3',
        clientParams: badParams,
        assets: [{ type: 'audio', jobField: 'audio', signedDownloadType: 'referenceAudio' }],
      };

      executor.accept(job);
      await expect(executor.execute(job)).rejects.toMatchObject({
        code: 'invalidInput',
      });
      expect(artifacts.downloadReferenceAudio).not.toHaveBeenCalled();
      expect(artifacts.validateAndProbeAudio).not.toHaveBeenCalled();
      expect(backend.synthesizeDrama3).not.toHaveBeenCalled();
    }
  });

  it('enforces 1 <= actualDuration <= 30s on Drama 3 reference audio', async () => {
    for (const [badDuration, expectedMessage] of [
      [0.4, 'Reference audio must be at least 1 seconds long, got 0.4s'],
      [34.2, 'Reference audio must be at most 30 seconds long, got 34.2s'],
    ]) {
      const { executor, artifacts, backend } = makeSetup();
      artifacts.validateAndProbeAudio.mockResolvedValueOnce({ duration: badDuration, formatName: 'wav' });

      const job = {
        jobID: `tts-bad-${badDuration}`,
        imageId: 'img-bad',
        workflowId: 'fish_drama_3_nvfp4',
        clientParams: { tags: 'Test bounds.' },
        assets: [{ type: 'audio', jobField: 'audio', url: 'https://s3.test/ref.wav' }],
      };

      executor.accept(job);
      await expect(executor.execute(job)).rejects.toMatchObject({
        code: 'invalidInput',
        message: expectedMessage,
      });
      expect(backend.synthesizeDrama3).not.toHaveBeenCalled();
    }
  });

  it('runs isTest === true Drama 3 jobs with fallback prompt and skips referenceAudio download', async () => {
    const { executor, artifacts, backend } = makeSetup();
    const job = {
      jobID: 'tts-test-1',
      imageId: 'img-test',
      workflowId: 'fish_drama_3_nvfp4',
      isTest: true,
      clientParams: {},
      assets: [{ type: 'audio', jobField: 'audio', signedDownloadType: 'referenceAudio' }],
    };

    executor.accept(job);
    await executor.execute(job);

    expect(artifacts.downloadReferenceAudio).not.toHaveBeenCalled();
    expect(backend.synthesizeDrama3).toHaveBeenCalledWith(expect.objectContaining({
      text: 'This is a short voice test.',
      referenceWavPath: null,
    }));
  });
});
