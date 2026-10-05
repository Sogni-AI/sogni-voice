import { describe, it, expect, vi } from 'vitest';
import { SpeechExecutor, STT_DURATION_SLACK_RATIO } from '../../../src/network/executor.js';

const MODELS = [
  { id: 'parakeet_tdt_0.6b_v3', task: 'stt', engine: 'parakeet' },
];

const job = (kfOverrides = {}) => ({
  jobID: 'A0000000-0000-4000-8000-000000000011',
  jobType: 'audio',
  outputFormat: 'json',
  keyFrames: [{
    modelID: 'parakeet_tdt_0.6b_v3',
    positivePrompt: '',
    hasReferenceAudio: true,
    duration: 60,
    timestamps: 'sentence',
    steps: 1,
    seed: -1,
    outputFormat: 'json',
    ...kfOverrides,
  }],
});

const IMG_ID = 'B0000000-0000-4000-8000-000000000012';

const TRANSCRIPT = {
  text: 'hello world',
  timestamps: [{ text: 'hello world', start: 0.0, end: 1.4 }],
};

const setup = (overrides = {}) => {
  const transcriptionService = {
    transcribe: vi.fn(async () => ({ ...TRANSCRIPT })),
  };
  const artifacts = {
    downloadToFile: vi.fn(async (url, dest) => ({ path: dest, bytes: 32000 })),
    uploadFile: vi.fn(async () => ({ uploadedKey: 'video/2026-07-31/A.../complete-B....json', bytes: 512 })),
  };
  const api = {
    requestMediaDownloadUrl: vi.fn(async () => 'https://r2.test/presigned-get?sig=1'),
    requestMediaUploadUrl: vi.fn(async () => 'https://r2.test/presigned-put?sig=2'),
  };
  const tools = {
    probeDurationSeconds: vi.fn(async () => 58.2),
    synthesizeTestClip: vi.fn(async (path) => path),
    transcodeWavToMp3: vi.fn(),
  };
  const tempFiles = {
    createTempDir: vi.fn(async () => '/tmp/sogni-speech-job-stt'),
    cleanup: vi.fn(async () => {}),
  };
  const writeArtifact = vi.fn(async () => {});
  const executor = new SpeechExecutor({
    speechModels: MODELS,
    apiUrl: 'https://api-staging.sogni.ai',
    maxConcurrentJobs: 1,
    transcriptionService,
    ttsService: { generate: vi.fn() },
    tempFiles,
    artifacts,
    api,
    tools,
    writeArtifact,
    ...overrides,
  });
  return { executor, transcriptionService, artifacts, api, tools, tempFiles, writeArtifact };
};

const run = async (harness, theJob) => {
  harness.executor.accept(theJob);
  return harness.executor.execute(theJob, { imgID: IMG_ID });
};

describe('SpeechExecutor STT (standard contract)', () => {
  it('redeems the reference-audio input, transcribes, and uploads the JSON transcript', async () => {
    const harness = setup();
    const result = await run(harness, job());

    expect(harness.api.requestMediaDownloadUrl).toHaveBeenCalledWith({
      apiUrl: 'https://api-staging.sogni.ai',
      jobId: 'A0000000-0000-4000-8000-000000000011',
      type: 'referenceAudio',
    });
    expect(harness.artifacts.downloadToFile).toHaveBeenCalledWith(
      'https://r2.test/presigned-get?sig=1',
      '/tmp/sogni-speech-job-stt/input-audio',
    );
    expect(harness.transcriptionService.transcribe).toHaveBeenCalledWith(
      '/tmp/sogni-speech-job-stt/input-audio',
      { timestamps: true, wordTimestamps: false },
    );

    const [artifactPath, serialized] = harness.writeArtifact.mock.calls[0];
    expect(artifactPath).toBe('/tmp/sogni-speech-job-stt/transcript.json');
    const transcript = JSON.parse(serialized);
    expect(transcript).toMatchObject({
      text: 'hello world',
      segments: [{ text: 'hello world', start: 0, end: 1.4 }],
      durationSeconds: 58.2,
      model: 'parakeet_tdt_0.6b_v3',
    });

    expect(harness.api.requestMediaUploadUrl).toHaveBeenCalledWith({
      apiUrl: 'https://api-staging.sogni.ai',
      jobId: 'A0000000-0000-4000-8000-000000000011',
      imgId: IMG_ID,
      contentType: 'application/json',
    });
    expect(harness.artifacts.uploadFile).toHaveBeenCalledWith(
      'https://r2.test/presigned-put?sig=2',
      '/tmp/sogni-speech-job-stt/transcript.json',
      { contentType: 'application/json' },
    );
    expect(result.performedStepCount).toBe(1);
  });

  // The declared duration is the billed quantity; the socket cannot measure
  // the uploaded audio, so the worker is the enforcement point.
  it('refuses audio that materially outruns the declared (billed) duration', async () => {
    const harness = setup();
    harness.tools.probeDurationSeconds.mockResolvedValueOnce(60 * STT_DURATION_SLACK_RATIO + 1);
    await expect(run(harness, job({ duration: 60 }))).rejects.toMatchObject({
      code: 'input_longer_than_declared',
    });
    expect(harness.transcriptionService.transcribe).not.toHaveBeenCalled();
  });

  it('allows honest metadata drift inside the slack allowance', async () => {
    const harness = setup();
    harness.tools.probeDurationSeconds.mockResolvedValueOnce(64);
    await expect(run(harness, job({ duration: 60 }))).resolves.toBeTruthy();
  });

  it('gives short clips the flat slack floor', async () => {
    const harness = setup();
    // 5s declared: ratio allows 5.75s but the 5s floor allows 10s.
    harness.tools.probeDurationSeconds.mockResolvedValueOnce(9.5);
    await expect(run(harness, job({ duration: 5 }))).resolves.toBeTruthy();
  });

  it('synthesizes a local test clip when no asset was uploaded (test jobs)', async () => {
    const harness = setup();
    await run(harness, job({ hasReferenceAudio: false }));

    expect(harness.tools.synthesizeTestClip).toHaveBeenCalledWith('/tmp/sogni-speech-job-stt/test-clip.wav');
    expect(harness.api.requestMediaDownloadUrl).not.toHaveBeenCalled();
    expect(harness.artifacts.uploadFile).toHaveBeenCalled();
  });

  it('requests word timestamps only for word granularity', async () => {
    const harness = setup();
    await run(harness, job({ timestamps: 'word' }));
    expect(harness.transcriptionService.transcribe).toHaveBeenCalledWith(
      expect.any(String),
      { timestamps: true, wordTimestamps: true },
    );

    const harness2 = setup();
    await run(harness2, job({ timestamps: 'none' }));
    expect(harness2.transcriptionService.transcribe).toHaveBeenCalledWith(
      expect.any(String),
      { timestamps: false, wordTimestamps: false },
    );
  });

  it('maps input download failure to the broker imgDownloadFailure code', async () => {
    const harness = setup();
    harness.artifacts.downloadToFile.mockRejectedValueOnce(new Error('HTTP 404'));
    await expect(run(harness, job())).rejects.toMatchObject({ code: 'imgDownloadFailure' });
    expect(harness.transcriptionService.transcribe).not.toHaveBeenCalled();
  });

  it('maps daemon failure to stt_failed with the cause preserved', async () => {
    const harness = setup();
    harness.transcriptionService.transcribe.mockRejectedValueOnce(new Error('daemon died'));
    const failure = await run(harness, job()).catch((e) => e);
    expect(failure.code).toBe('stt_failed');
    expect(failure.cause?.message).toBe('daemon died');
  });

  it('maps transcript upload failure to imgUploadFailure', async () => {
    const harness = setup();
    harness.artifacts.uploadFile.mockRejectedValueOnce(new Error('HTTP 500'));
    await expect(run(harness, job())).rejects.toMatchObject({ code: 'imgUploadFailure' });
  });

  it('reports an aborted job as aborted even when work finished', async () => {
    const harness = setup();
    const theJob = job();
    harness.executor.accept(theJob);
    harness.transcriptionService.transcribe.mockImplementationOnce(async () => {
      harness.executor.abort(theJob.jobID);
      return { ...TRANSCRIPT };
    });
    await expect(harness.executor.execute(theJob, { imgID: IMG_ID })).rejects.toMatchObject({
      code: 'aborted',
    });
  });
});
