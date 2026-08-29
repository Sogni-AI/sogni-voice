import { describe, it, expect } from 'vitest';
import {
  SPEECH_MODEL_CATALOG,
  buildSpeechModels,
  buildWorkerInfo,
  detectHardwareInfo,
  findSpeechModel,
} from '../../../src/network/capabilities.js';

const cfgWith = (overrides = {}) => ({
  transcription: { enabled: true },
  tts: { enabled: true },
  qwenTts: { enabled: false },
  ...overrides,
});

const fakeOs = {
  cpus: () => Array.from({ length: 24 }, () => ({ model: 'Apple M2 Ultra' })),
  totalmem: () => 192 * 1024 ** 3,
};

describe('speech model capabilities', () => {
  // The ids are the standard catalog model ids in sogni-socket
  // data/modelTiers.json — a mismatch means the broker never routes us a job.
  it('advertises the frozen standard catalog model ids', () => {
    expect(SPEECH_MODEL_CATALOG.map((m) => m.id)).toEqual([
      'kokoro_82m',
      'parakeet_tdt_0.6b_v3',
      'qwen3_tts_1.7b',
    ]);
  });

  it('only offers models whose engines are enabled', () => {
    const models = buildSpeechModels(cfgWith());
    expect(models.map((m) => m.id)).toEqual(['kokoro_82m', 'parakeet_tdt_0.6b_v3']);

    const all = buildSpeechModels(cfgWith({ qwenTts: { enabled: true } }));
    expect(all).toHaveLength(3);

    const none = buildSpeechModels({ transcription: {}, tts: {}, qwenTts: {} });
    expect(none).toEqual([]);
  });

  it('reports unified memory as both ram and vram', () => {
    const hw = detectHardwareInfo({ osImpl: fakeOs });
    expect(hw).toEqual({
      cpuBrand: 'Apple M2 Ultra',
      gpuBrand: 'Apple M2 Ultra',
      ram: 192,
      vram: 192,
      hasANE: true,
      numberOfPhysicalCores: 24,
      numberOfLogicalCores: 24,
    });
  });

  // Registration gates that make this shape load-bearing: audio models are
  // fast-network-only, fast requires hardwareRating >= 70, ram >= 31,
  // a truthy non-blocklisted gpuBrand, and vram >= 16.
  it('builds the standard workerInfo registration shape', () => {
    const models = buildSpeechModels(cfgWith({ qwenTts: { enabled: true } }));
    const info = buildWorkerInfo({
      speechModels: models,
      hardwareRating: 70,
      hardwareInfo: detectHardwareInfo({ osImpl: fakeOs }),
    });

    expect(info.hardwareRating).toBeGreaterThanOrEqual(70);
    expect(info.hardwareInfo.ram).toBeGreaterThanOrEqual(31);
    expect(info.hardwareInfo.vram).toBeGreaterThanOrEqual(16);
    expect(info.hardwareInfo.gpuBrand).toBeTruthy();
    expect(info.hardwareInfo.gpuBrand.toLowerCase()).not.toContain('unknown');
    // workerModels entries are plain catalog-id strings, not objects.
    expect(info.workerModels).toEqual(['kokoro_82m', 'parakeet_tdt_0.6b_v3', 'qwen3_tts_1.7b']);
    expect(info.loadedModelID).toBe('kokoro_82m');
  });

  it('finds models by catalog id alone', () => {
    const models = buildSpeechModels(cfgWith());
    expect(findSpeechModel(models, 'parakeet_tdt_0.6b_v3')?.engine).toBe('parakeet');
    expect(findSpeechModel(models, 'qwen3_tts_1.7b')).toBeNull();
    expect(findSpeechModel(models, 'nope')).toBeNull();
  });
});
