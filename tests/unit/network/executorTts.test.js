import { describe, it, expect, vi } from 'vitest';
import { SpeechExecutor } from '../../../src/network/executor.js';
import { config } from '../../../src/config/index.js';

const MODELS = [
  { id: 'kokoro_82m', task: 'tts', engine: 'kokoro' },
  { id: 'qwen3_tts_1.7b', task: 'tts', engine: 'qwen-preset' },
];

// The standard jobRequest payload: keyFrames[0] carries everything, including
// the model id. Text rides positivePrompt.
const job = (kfOverrides = {}, topOverrides = {}) => ({
  jobID: 'A0000000-0000-4000-8000-000000000001',
  jobType: 'audio',
  numberOfImages: 1,
  outputFormat: 'mp3',
  keyFrames: [{
    modelID: 'kokoro_82m',
    positivePrompt: 'Hello from Sogni.',
    voice: 'am_puck',
    speed: 1.1,
    duration: 2,
    steps: 1,
    seed: -1,
    outputFormat: 'mp3',
    ...kfOverrides,
  }],
  ...topOverrides,
});

const IMG_ID = 'B0000000-0000-4000-8000-000000000002';

const setup = (overrides = {}) => {
  const ttsService = {
    generate: vi.fn(async (text, options) => ({ outputPath: options.outputPath })),
  };
  const qwenTtsService = {
    generate: vi.fn(async (text, options) => ({ outputPath: options.outputPath })),
  };
  const artifacts = {
    downloadToFile: vi.fn(),
    uploadFile: vi.fn(async () => ({ uploadedKey: 'video/2026-07-31/A.../complete-B....mp3', bytes: 44100 })),
  };
  const api = {
    requestMediaUploadUrl: vi.fn(async () => 'https://r2.test/presigned-put?sig=1'),
    requestMediaDownloadUrl: vi.fn(),
  };
  const tools = {
    transcodeWavToMp3: vi.fn(async (input, output) => output),
    probeDurationSeconds: vi.fn(),
    synthesizeTestClip: vi.fn(),
  };
  const tempFiles = {
    createTempDir: vi.fn(async () => '/tmp/sogni-speech-job-xyz'),
    cleanup: vi.fn(async () => {}),
  };
  let clock = 5000;
  const executor = new SpeechExecutor({
    speechModels: MODELS,
    apiUrl: 'https://api-staging.sogni.ai',
    maxConcurrentJobs: 1,
    transcriptionService: { transcribe: vi.fn() },
    ttsService,
    qwenTtsService,
    tempFiles,
    artifacts,
    api,
    tools,
    writeArtifact: vi.fn(async () => {}),
    now: () => {
      clock += 400;
      return clock;
    },
    ...overrides,
  });
  return { executor, ttsService, qwenTtsService, artifacts, api, tools, tempFiles };
};

const run = async (harness, theJob) => {
  harness.executor.accept(theJob);
  return harness.executor.execute(theJob, { imgID: IMG_ID });
};

describe('SpeechExecutor TTS (standard contract)', () => {
  it('synthesizes, transcodes to mp3, and uploads through the media lane', async () => {
    const harness = setup();
    const result = await run(harness, job());

    expect(harness.ttsService.generate).toHaveBeenCalledWith('Hello from Sogni.', {
      voice: 'am_puck',
      speed: 1.1,
      outputPath: '/tmp/sogni-speech-job-xyz/output.wav',
    });
    expect(harness.tools.transcodeWavToMp3).toHaveBeenCalledWith(
      '/tmp/sogni-speech-job-xyz/output.wav',
      '/tmp/sogni-speech-job-xyz/output.mp3',
    );
    expect(harness.api.requestMediaUploadUrl).toHaveBeenCalledWith({
      apiUrl: 'https://api-staging.sogni.ai',
      jobId: 'A0000000-0000-4000-8000-000000000001',
      imgId: IMG_ID,
      contentType: 'audio/mpeg',
    });
    expect(harness.artifacts.uploadFile).toHaveBeenCalledWith(
      'https://r2.test/presigned-put?sig=1',
      '/tmp/sogni-speech-job-xyz/output.mp3',
      { contentType: 'audio/mpeg' },
    );
    expect(result.performedStepCount).toBe(1);
    expect(result.timings.inference).toBeGreaterThan(0);
    expect(result.timings.assetUpload).toBeGreaterThan(0);
  });

  it('reports lastSeed 0 for the random seed sentinel and echoes real seeds', async () => {
    const harness = setup();
    const random = await run(harness, job({ seed: -1 }));
    expect(random.lastSeed).toBe(0);

    const harness2 = setup();
    const pinned = await run(harness2, job({ seed: 42 }));
    expect(pinned.lastSeed).toBe(42);
  });

  it('routes qwen3_tts_1.7b to the qwen preset engine with language', async () => {
    const harness = setup();
    await run(harness, job({ modelID: 'qwen3_tts_1.7b', voice: 'Ryan', language: 'english', speed: undefined }));

    expect(harness.qwenTtsService.generate).toHaveBeenCalledWith('Hello from Sogni.', {
      voice: 'Ryan',
      language: 'english',
      outputPath: '/tmp/sogni-speech-job-xyz/output.wav',
    });
    expect(harness.ttsService.generate).not.toHaveBeenCalled();
  });

  it('applies engine defaults when voice/language are absent', async () => {
    const harness = setup();
    await run(harness, job({ voice: undefined, speed: undefined }));
    expect(harness.ttsService.generate).toHaveBeenCalledWith('Hello from Sogni.', {
      voice: config.tts.defaultVoice,
      speed: config.tts.defaultSpeed,
      outputPath: '/tmp/sogni-speech-job-xyz/output.wav',
    });
  });

  it('rejects empty text before synthesis', async () => {
    const harness = setup();
    const bad = job({ positivePrompt: '   ' });
    harness.executor.accept(bad);
    await expect(harness.executor.execute(bad, { imgID: IMG_ID })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(harness.ttsService.generate).not.toHaveBeenCalled();
  });

  it('rejects out-of-range speed as contract drift, before synthesis', async () => {
    const harness = setup();
    const bad = job({ speed: 4 });
    harness.executor.accept(bad);
    await expect(harness.executor.execute(bad, { imgID: IMG_ID })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(harness.ttsService.generate).not.toHaveBeenCalled();
  });

  it('maps synthesis failure to tts_failed with the cause preserved', async () => {
    const harness = setup();
    harness.ttsService.generate.mockRejectedValueOnce(new Error('daemon exited'));
    const theJob = job();
    harness.executor.accept(theJob);
    const failure = await harness.executor.execute(theJob, { imgID: IMG_ID }).catch((e) => e);
    expect(failure.code).toBe('tts_failed');
    expect(failure.cause?.message).toBe('daemon exited');
  });

  it('maps upload failure to the broker imgUploadFailure code', async () => {
    const harness = setup();
    harness.artifacts.uploadFile.mockRejectedValueOnce(new Error('HTTP 503'));
    const theJob = job();
    harness.executor.accept(theJob);
    await expect(harness.executor.execute(theJob, { imgID: IMG_ID })).rejects.toMatchObject({
      code: 'imgUploadFailure',
    });
  });

  it('fails rather than settle an empty artifact', async () => {
    const harness = setup();
    harness.artifacts.uploadFile.mockResolvedValueOnce({ uploadedKey: 'k', bytes: 0 });
    const theJob = job();
    harness.executor.accept(theJob);
    await expect(harness.executor.execute(theJob, { imgID: IMG_ID })).rejects.toMatchObject({
      code: 'imgUploadFailure',
    });
  });

  it('cleans up the temp dir on success and failure alike', async () => {
    const harness = setup();
    await run(harness, job());
    expect(harness.tempFiles.cleanup).toHaveBeenCalledWith('/tmp/sogni-speech-job-xyz');

    const harness2 = setup();
    harness2.ttsService.generate.mockRejectedValueOnce(new Error('boom'));
    const theJob = job();
    harness2.executor.accept(theJob);
    await harness2.executor.execute(theJob, { imgID: IMG_ID }).catch(() => {});
    expect(harness2.tempFiles.cleanup).toHaveBeenCalledWith('/tmp/sogni-speech-job-xyz');
  });
});
