import { describe, it, expect } from 'vitest';
import {
  VOICE_SUPERNET_MODELS,
  buildLocalWorkerModels,
  buildWorkerInfo,
  findWorkerModel,
} from '../../../src/network/capabilities.js';

const cfg = (overrides = {}) => ({
  drama3Tts: { enabled: true },
  transcription: { enabled: true },
  nemotron: { enabled: true },
  ...overrides,
});

describe('Voice Supernet capabilities', () => {
  it('defines the three canonical Sogni voice model IDs', () => {
    expect(VOICE_SUPERNET_MODELS.map((m) => m.id)).toEqual([
      'fish_drama_3_nvfp4',
      'parakeet_tdt_0.6b_v3_bf16',
      'nemotron_3.5_transcribe_30b_a4b_nvfp4',
    ]);
  });

  it('advertises enabled local engines in canonical order', () => {
    const models = buildLocalWorkerModels(cfg({ nemotron: { enabled: false } }));
    expect(models.map((m) => m.id)).toEqual([
      'fish_drama_3_nvfp4',
      'parakeet_tdt_0.6b_v3_bf16',
    ]);
  });

  it('filters local models by an optional allowlist of IDs or short selectors', () => {
    const models = buildLocalWorkerModels(cfg(), {
      allowlist: new Set(['drama3', 'nemotron_3.5_transcribe_30b_a4b_nvfp4']),
    });
    expect(models.map((m) => m.id)).toEqual([
      'fish_drama_3_nvfp4',
      'nemotron_3.5_transcribe_30b_a4b_nvfp4',
    ]);
  });

  it('returns an empty list when no voice engine is enabled', () => {
    expect(buildLocalWorkerModels({
      drama3Tts: { enabled: false },
      transcription: { enabled: false },
      nemotron: { enabled: false },
    })).toEqual([]);
  });

  it('builds exact sogni-socket workerInfo payload with GB10 hardware and protocols', () => {
    const models = buildLocalWorkerModels(cfg());
    const info = buildWorkerInfo({
      workerModels: models,
      loadedModelID: 'fish_drama_3_nvfp4',
      hardwareRating: 70,
      hardwareInfo: {
        cpuBrand: 'ARM Cortex-X925',
        gpuBrand: 'NVIDIA GB10',
        vram: 120,
        ram: 120,
      },
      image: 'comfy/1.0.260',
      readinessSessionId: '11111111-2222-4333-8444-555555555555',
      heldJobs: [],
    });

    expect(info).toEqual({
      workerModels: [
        'fish_drama_3_nvfp4',
        'parakeet_tdt_0.6b_v3_bf16',
        'nemotron_3.5_transcribe_30b_a4b_nvfp4',
      ],
      loadedModelID: 'fish_drama_3_nvfp4',
      hardwareRating: 70,
      hardwareInfo: {
        cpuBrand: 'ARM Cortex-X925',
        gpuBrand: 'NVIDIA GB10',
        vram: 120,
        ram: 120,
        supportedControlnets: {},
      },
      image: 'comfy/1.0.260',
      cooldownEveryXJobsCount: 0,
      cooldownEveryXJobsSec: 0,
      cooldownRenderSec: 0,
      cooldownRestSec: 0,
      installedModelFiles: [],
      loadedLoras: [],
      excludedLoraIds: [],
      modelDownloadsEnabled: false,
      loraDownloadsEnabled: false,
      hostsSpicyModels: true,
      inputPreparationProtocol: 1,
      postDisconnectCleanupReadinessProtocol: 1,
      readinessSessionId: '11111111-2222-4333-8444-555555555555',
      jobHoldProtocol: 1,
      heldJobs: [],
    });
  });

  it('clears loadedModelID when it is not in workerModels', () => {
    const info = buildWorkerInfo({
      workerModels: ['parakeet_tdt_0.6b_v3_bf16'],
      loadedModelID: 'fish_drama_3_nvfp4',
      hardwareRating: 70,
      hardwareInfo: { cpuBrand: 'CPU', gpuBrand: 'NVIDIA GB10', vram: 120, ram: 120 },
      image: 'comfy/1.0.260',
      readinessSessionId: '11111111-2222-4333-8444-555555555555',
    });
    expect(info.loadedModelID).toBeNull();
  });

  it('finds a model by canonical workflowId', () => {
    const models = buildLocalWorkerModels(cfg());
    expect(findWorkerModel(models, 'fish_drama_3_nvfp4')?.engine).toBe('drama3');
    expect(findWorkerModel(models, 'unknown_model')).toBeNull();
  });
});
