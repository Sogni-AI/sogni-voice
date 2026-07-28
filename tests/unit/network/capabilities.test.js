import { describe, it, expect } from 'vitest';
import {
  buildSpeechModels,
  buildWorkerInfo,
  findSpeechModel,
} from '../../../src/network/capabilities.js';

const cfg = (overrides = {}) => ({
  transcription: { enabled: true },
  tts: { enabled: true },
  qwenTts: { enabled: false },
  ...overrides,
});

describe('capabilities', () => {
  it('advertises Parakeet and Kokoro when both are enabled', () => {
    expect(buildSpeechModels(cfg())).toEqual([
      { id: 'parakeet-tdt', task: 'stt', maxConcurrent: 1, engine: 'parakeet' },
      { id: 'kokoro-82m', task: 'tts', maxConcurrent: 2, engine: 'kokoro' },
    ]);
  });

  it('adds the Qwen preset model only when its env flag is on', () => {
    const models = buildSpeechModels(cfg({ qwenTts: { enabled: true } }));
    expect(models.map((model) => model.id))
      .toEqual(['parakeet-tdt', 'kokoro-82m', 'qwen3-tts-preset']);
  });

  it('omits disabled engines', () => {
    const models = buildSpeechModels(cfg({ transcription: { enabled: false } }));
    expect(models.map((model) => model.id)).toEqual(['kokoro-82m']);
  });

  it('returns an empty list when nothing is enabled', () => {
    const models = buildSpeechModels({
      transcription: { enabled: false },
      tts: { enabled: false },
      qwenTts: { enabled: false },
    });
    expect(models).toEqual([]);
  });

  it('builds the frozen workerInfo payload without internal engine keys', () => {
    expect(buildWorkerInfo({ speechModels: buildSpeechModels(cfg()), maxConcurrentJobs: 2 }))
      .toEqual({
        speechModels: [
          { id: 'parakeet-tdt', task: 'stt', maxConcurrent: 1 },
          { id: 'kokoro-82m', task: 'tts', maxConcurrent: 2 },
        ],
        loadedModelIDs: [],
        maxConcurrentJobs: 2,
      });
  });

  it('matches a model by id and task, and rejects a task mismatch', () => {
    const models = buildSpeechModels(cfg());
    expect(findSpeechModel(models, 'kokoro-82m', 'tts').engine).toBe('kokoro');
    expect(findSpeechModel(models, 'kokoro-82m', 'stt')).toBeNull();
    expect(findSpeechModel(models, 'whisper-large', 'stt')).toBeNull();
  });
});
