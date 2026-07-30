import { describe, it, expect, vi } from 'vitest';
import { SpeechExecutor } from '../../../src/network/executor.js';

const MODELS = [{ id: 'parakeet-tdt-0.6b-v3', task: 'stt', maxConcurrent: 1, engine: 'parakeet' }];

const job = (overrides = {}) => ({
  jobID: 'job-stt-1',
  projectID: 'proj-1',
  jobType: 'speech',
  task: 'stt',
  modelID: 'parakeet-tdt-0.6b-v3',
  params: {},
  input: { url: 'https://s3.test/in/clip.mp3?sig=1' },
  output: null,
  timeoutMs: 60000,
  ...overrides,
});

const setup = (overrides = {}) => {
  const transcriptionService = {
    transcribe: vi.fn(async () => ({
      text: 'hello world',
      rawOutput: '',
      timestamps: [{ start: 0, end: 2.5, text: 'hello world' }],
    })),
  };
  const tempFiles = {
    createTempDir: vi.fn(async () => '/tmp/sogni-speech-job-abc'),
    cleanup: vi.fn(async () => {}),
  };
  const artifacts = {
    downloadToFile: vi.fn(async (url, destPath) => ({ path: destPath, bytes: 1024 })),
    uploadFile: vi.fn(),
  };
  let clock = 1000;
  const executor = new SpeechExecutor({
    speechModels: MODELS,
    maxConcurrentJobs: 2,
    transcriptionService,
    ttsService: { generate: vi.fn() },
    tempFiles,
    artifacts,
    now: () => {
      clock += 250;
      return clock;
    },
    ...overrides,
  });
  return { executor, transcriptionService, tempFiles, artifacts };
};

describe('SpeechExecutor STT', () => {
  it('downloads the input, transcribes it, and returns transcript plus meta', async () => {
    const { executor, transcriptionService, artifacts, tempFiles } = setup();
    const request = job();
    executor.accept(request);

    const result = await executor.execute(request);

    expect(artifacts.downloadToFile)
      .toHaveBeenCalledWith('https://s3.test/in/clip.mp3?sig=1', '/tmp/sogni-speech-job-abc/input.mp3');
    expect(transcriptionService.transcribe)
      .toHaveBeenCalledWith('/tmp/sogni-speech-job-abc/input.mp3', { timestamps: true });
    expect(result).toEqual({
      jobID: 'job-stt-1',
      transcript: 'hello world',
      transcriptDetails: {
        text: 'hello world',
        rawOutput: '',
        timestamps: [{ start: 0, end: 2.5, text: 'hello world' }],
      },
      meta: { audioSeconds: 2.5, durationMs: 250 },
    });
    expect(tempFiles.cleanup).toHaveBeenCalledWith('/tmp/sogni-speech-job-abc');
  });

  it('frees the concurrency slot after a successful job', async () => {
    const { executor } = setup();
    const request = job();
    executor.accept(request);
    await executor.execute(request);
    expect(executor.activeRequests).toBe(0);
  });

  it('reports a null audioSeconds when the daemon returns no timestamps', async () => {
    const { executor, transcriptionService } = setup();
    const request = job();
    executor.accept(request);
    transcriptionService.transcribe.mockResolvedValueOnce({ text: 'hi', rawOutput: '' });

    const result = await executor.execute(request);
    expect(result.meta.audioSeconds).toBeNull();
  });

  // The broker stores transcript as a string column, so a daemon result without a
  // text field still has to leave the wire field a string.
  it('keeps transcript a string when the daemon returns no text', async () => {
    const { executor, transcriptionService } = setup();
    const request = job();
    executor.accept(request);
    transcriptionService.transcribe.mockResolvedValueOnce({ rawOutput: '' });

    const result = await executor.execute(request);
    expect(result.transcript).toBe('');
    expect(result.transcriptDetails).toEqual({ rawOutput: '' });
  });

  it('maps a download failure to input_download_failed', async () => {
    const { executor, artifacts } = setup();
    const request = job();
    executor.accept(request);
    artifacts.downloadToFile.mockRejectedValueOnce(new Error('Input download failed with HTTP 403'));

    await expect(executor.execute(request)).rejects.toMatchObject({
      code: 'input_download_failed',
      message: 'Input download failed with HTTP 403',
    });
    expect(executor.activeRequests).toBe(0);
  });

  // A failed download can still leave a zero-byte file behind, so the daemon must
  // never be handed a path from a download that threw.
  it('never transcribes when the download failed', async () => {
    const { executor, transcriptionService, artifacts } = setup();
    const request = job();
    executor.accept(request);
    artifacts.downloadToFile.mockRejectedValueOnce(new Error('Input download produced an empty file'));

    await expect(executor.execute(request)).rejects.toMatchObject({ code: 'input_download_failed' });
    expect(transcriptionService.transcribe).not.toHaveBeenCalled();
  });

  it('maps a daemon failure to stt_failed', async () => {
    const { executor, transcriptionService } = setup();
    const request = job();
    executor.accept(request);
    transcriptionService.transcribe.mockRejectedValueOnce(new Error('Transcription timed out'));

    await expect(executor.execute(request)).rejects.toMatchObject({
      code: 'stt_failed',
      message: 'Transcription timed out',
    });
  });

  // The wire message is only the adapter's message string; without the cause, a
  // daemon crash arrives with this file's stack instead of the one that matters.
  it('keeps the original error as the cause of a mapped JobError', async () => {
    const { executor, transcriptionService, artifacts } = setup();
    const daemonCrash = new Error('Transcription daemon exited with code 1');

    const sttRequest = job();
    executor.accept(sttRequest);
    transcriptionService.transcribe.mockRejectedValueOnce(daemonCrash);
    await expect(executor.execute(sttRequest)).rejects.toHaveProperty('cause', daemonCrash);

    const downloadFailure = new Error('Input download failed with HTTP 403');
    const downloadRequest = job({ jobID: 'job-stt-2' });
    executor.accept(downloadRequest);
    artifacts.downloadToFile.mockRejectedValueOnce(downloadFailure);
    await expect(executor.execute(downloadRequest))
      .rejects.toHaveProperty('cause', downloadFailure);
  });

  it('rejects an STT job with no input url', async () => {
    const { executor } = setup();
    const request = job({ input: null });
    executor.accept(request);

    await expect(executor.execute(request)).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'STT jobRequest requires input.url',
    });
  });

  it('enforces the broker timeout even though transcribe() ignores it', async () => {
    const { executor, transcriptionService } = setup();
    const request = job({ timeoutMs: 20 });
    executor.accept(request);
    transcriptionService.transcribe.mockImplementationOnce(() => new Promise(() => {}));

    await expect(executor.execute(request)).rejects.toMatchObject({ code: 'timeout' });
    expect(executor.activeRequests).toBe(0);
  });

  it('throws aborted when the broker cancelled mid-flight', async () => {
    const { executor, transcriptionService } = setup();
    const request = job();
    executor.accept(request);
    transcriptionService.transcribe.mockImplementationOnce(async () => {
      executor.abort('job-stt-1');
      return { text: 'discarded', rawOutput: '' };
    });

    await expect(executor.execute(request)).rejects.toMatchObject({ code: 'aborted' });
  });

  it('rejects execute for a job that was never accepted', async () => {
    const { executor } = setup();
    await expect(executor.execute(job({ jobID: 'ghost' }))).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'Job ghost was not accepted',
    });
  });

  // abort() frees the slot while the uncancellable daemon call keeps running, so the
  // broker can re-issue the same jobID before that first run settles. The abandoned
  // run must recognise its own abort and must not release the replacement's slot,
  // which is only possible if execute() holds the entry it captured at the start.
  it('does not evict a re-accepted job when the abandoned run finally settles', async () => {
    const { executor, transcriptionService } = setup();
    const request = job();
    executor.accept(request);

    let finishTranscribe;
    transcriptionService.transcribe.mockImplementationOnce(
      () => new Promise((resolve) => {
        finishTranscribe = () => resolve({ text: 'discarded', rawOutput: '' });
      }),
    );

    const abandoned = executor.execute(request);
    await vi.waitFor(() => expect(transcriptionService.transcribe).toHaveBeenCalled());

    executor.abort('job-stt-1');
    executor.accept(job());
    const replacement = executor.activeJobs.get('job-stt-1');

    finishTranscribe();
    await expect(abandoned).rejects.toMatchObject({ code: 'aborted' });

    expect(executor.activeJobs.get('job-stt-1')).toBe(replacement);
    expect(executor.activeRequests).toBe(1);
    expect(executor.modelCounts.get('parakeet-tdt-0.6b-v3')).toBe(1);
  });
});
