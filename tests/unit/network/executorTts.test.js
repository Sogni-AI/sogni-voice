import { describe, it, expect, vi } from 'vitest';
import { SpeechExecutor } from '../../../src/network/executor.js';
import { config } from '../../../src/config/index.js';

const MODELS = [
  { id: 'kokoro-82m', task: 'tts', maxConcurrent: 2, engine: 'kokoro' },
  { id: 'qwen3-tts-preset', task: 'tts', maxConcurrent: 1, engine: 'qwen-preset' },
];

const job = (overrides = {}) => ({
  jobID: 'job-tts-1',
  projectID: 'proj-1',
  jobType: 'speech',
  task: 'tts',
  modelID: 'kokoro-82m',
  params: { text: 'Hello from Sogni.', voice: 'am_puck', speed: 1.1 },
  input: null,
  output: { uploadUrl: 'https://bucket.s3.test/speech/out/job-tts-1.wav?sig=1' },
  timeoutMs: 60000,
  ...overrides,
});

const setup = (overrides = {}) => {
  const ttsService = {
    generate: vi.fn(async (text, options) => ({
      outputPath: options.outputPath,
      duration: 1.8,
      voice: options.voice,
      speed: options.speed,
    })),
  };
  const qwenTtsService = {
    generate: vi.fn(async (text, options) => ({
      outputPath: options.outputPath,
      duration: 2.1,
      voice: options.voice,
      language: options.language,
    })),
  };
  const artifacts = {
    downloadToFile: vi.fn(),
    uploadFile: vi.fn(async () => ({ uploadedKey: 'speech/out/job-tts-1.wav', bytes: 44100 })),
  };
  const tempFiles = {
    createTempDir: vi.fn(async () => '/tmp/sogni-speech-job-xyz'),
    cleanup: vi.fn(async () => {}),
  };
  let clock = 5000;
  const executor = new SpeechExecutor({
    speechModels: MODELS,
    maxConcurrentJobs: 2,
    transcriptionService: { transcribe: vi.fn() },
    ttsService,
    qwenTtsService,
    tempFiles,
    artifacts,
    now: () => {
      clock += 400;
      return clock;
    },
    ...overrides,
  });
  return { executor, ttsService, qwenTtsService, artifacts, tempFiles };
};

describe('SpeechExecutor TTS', () => {
  it('synthesizes with Kokoro, uploads, and returns uploadedKey plus meta', async () => {
    const { executor, ttsService, artifacts } = setup();
    const request = job();
    executor.accept(request);

    const result = await executor.execute(request);

    expect(ttsService.generate).toHaveBeenCalledWith('Hello from Sogni.', {
      voice: 'am_puck',
      speed: 1.1,
      outputPath: '/tmp/sogni-speech-job-xyz/output.wav',
    });
    expect(artifacts.uploadFile).toHaveBeenCalledWith(
      'https://bucket.s3.test/speech/out/job-tts-1.wav?sig=1',
      '/tmp/sogni-speech-job-xyz/output.wav',
    );
    expect(result).toEqual({
      jobID: 'job-tts-1',
      uploadedKey: 'speech/out/job-tts-1.wav',
      meta: { charCount: 17, durationMs: 400 },
    });
  });

  it('falls back to configured defaults for voice and speed', async () => {
    const { executor, ttsService } = setup();
    const request = job({ params: { text: 'Plain text.' } });
    executor.accept(request);

    await executor.execute(request);

    // Compared against config rather than literals: the developer's .env may
    // override TTS_DEFAULT_VOICE / TTS_DEFAULT_SPEED.
    const [, options] = ttsService.generate.mock.calls[0];
    expect(options.voice).toBe(config.tts.defaultVoice);
    expect(options.speed).toBe(config.tts.defaultSpeed);
  });

  // The HTTP route rejects an out-of-range speed at the edge
  // (Joi .min(0.5).max(2.0), src/routes/tts.js:35); a broker job reaches the daemon
  // with no such gate, so the executor has to apply the same range itself.
  it('rejects a speed outside the 0.5-2.0 range before synthesizing', async () => {
    const { executor, ttsService } = setup();
    const request = job({ params: { text: 'Too fast.', speed: 3 } });
    executor.accept(request);

    await expect(executor.execute(request)).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'speed must be between 0.5 and 2.0',
    });
    expect(ttsService.generate).not.toHaveBeenCalled();
    expect(executor.activeRequests).toBe(0);
  });

  it('passes an in-range speed through to the engine', async () => {
    const { executor, ttsService } = setup();
    const request = job({ params: { text: 'Just right.', speed: 1.5 } });
    executor.accept(request);

    await executor.execute(request);

    const [, options] = ttsService.generate.mock.calls[0];
    expect(options.speed).toBe(1.5);
  });

  it('routes qwen3-tts-preset to the Qwen base service', async () => {
    const { executor, qwenTtsService, ttsService } = setup();
    const request = job({
      jobID: 'job-tts-q',
      modelID: 'qwen3-tts-preset',
      params: { text: 'Qwen speaking.', voice: 'Ryan', language: 'English' },
    });
    executor.accept(request);

    await executor.execute(request);

    expect(ttsService.generate).not.toHaveBeenCalled();
    expect(qwenTtsService.generate).toHaveBeenCalledWith('Qwen speaking.', {
      voice: 'Ryan',
      language: 'English',
      outputPath: '/tmp/sogni-speech-job-xyz/output.wav',
    });
  });

  it('fails a Qwen job when the service is not configured', async () => {
    const { executor } = setup({ qwenTtsService: null });
    const request = job({ jobID: 'job-tts-q2', modelID: 'qwen3-tts-preset' });
    executor.accept(request);

    await expect(executor.execute(request)).rejects.toMatchObject({
      code: 'tts_failed',
      message: 'Qwen preset TTS engine is not configured',
    });
  });

  it('rejects a TTS job with empty text', async () => {
    const { executor } = setup();
    const request = job({ params: { text: '   ' } });
    executor.accept(request);

    await expect(executor.execute(request)).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'TTS jobRequest requires params.text',
    });
  });

  it('rejects a TTS job with no upload url', async () => {
    const { executor } = setup();
    const request = job({ output: null });
    executor.accept(request);

    await expect(executor.execute(request)).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'TTS jobRequest requires output.uploadUrl',
    });
  });

  it('maps a synthesis failure to tts_failed', async () => {
    const { executor, ttsService } = setup();
    const request = job();
    executor.accept(request);
    ttsService.generate.mockRejectedValueOnce(new Error('TTS generation timed out'));

    await expect(executor.execute(request)).rejects.toMatchObject({
      code: 'tts_failed',
      message: 'TTS generation timed out',
    });
    expect(executor.activeRequests).toBe(0);
  });

  it('maps an upload failure to upload_failed', async () => {
    const { executor, artifacts } = setup();
    const request = job();
    executor.accept(request);
    artifacts.uploadFile.mockRejectedValueOnce(
      new Error('Upload failed after 3 attempts: Upload failed with HTTP 503'),
    );

    await expect(executor.execute(request)).rejects.toMatchObject({ code: 'upload_failed' });
  });

  // An adapter can resolve successfully having written a header-only file. Settling
  // that as a result would hand the broker a billable uploadedKey pointing at silence.
  it('fails the job when synthesis produced an empty file', async () => {
    const { executor, artifacts } = setup();
    const request = job();
    executor.accept(request);
    artifacts.uploadFile.mockResolvedValueOnce({
      uploadedKey: 'speech/out/job-tts-1.wav',
      bytes: 0,
    });

    await expect(executor.execute(request)).rejects.toMatchObject({
      code: 'tts_failed',
      message: 'Synthesis produced empty audio',
    });
    expect(executor.activeRequests).toBe(0);
  });

  it('skips the upload when the job was aborted during synthesis', async () => {
    const { executor, ttsService, artifacts } = setup();
    const request = job();
    executor.accept(request);
    ttsService.generate.mockImplementationOnce(async (text, options) => {
      executor.abort('job-tts-1');
      return { outputPath: options.outputPath, duration: 1 };
    });

    await expect(executor.execute(request)).rejects.toMatchObject({ code: 'aborted' });
    expect(artifacts.uploadFile).not.toHaveBeenCalled();
    expect(executor.activeRequests).toBe(0);
  });
});
