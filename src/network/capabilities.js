import os from 'node:os';
import { config } from '../config/index.js';

// Standard catalog model ids (sogni-socket data/modelTiers.json). `task` and
// `engine` are internal routing metadata for the executor; the wire carries
// only the id strings in workerModels.
export const SPEECH_MODEL_CATALOG = [
  { id: 'kokoro_82m', task: 'tts', engine: 'kokoro' },
  { id: 'parakeet_tdt_0.6b_v3', task: 'stt', engine: 'parakeet' },
  { id: 'qwen3_tts_1.7b', task: 'tts', engine: 'qwen-preset' },
];

const ENGINE_ENABLED = {
  parakeet: (cfg) => Boolean(cfg.transcription?.enabled),
  kokoro: (cfg) => Boolean(cfg.tts?.enabled),
  'qwen-preset': (cfg) => Boolean(cfg.qwenTts?.enabled),
};

export function buildSpeechModels(cfg = config) {
  return SPEECH_MODEL_CATALOG
    .filter((model) => ENGINE_ENABLED[model.engine](cfg))
    .map((model) => ({ ...model }));
}

// Audio models are fast-network-only, and the fast gates require
// hardwareRating >= 70, ram >= 31GB, a non-blocklisted gpuBrand, and
// vram >= 16GB. Apple Silicon has unified memory, so vram is reported as
// total RAM — the same memory the models actually run in.
export function detectHardwareInfo({ osImpl = os } = {}) {
  const cpuBrand = osImpl.cpus()[0]?.model?.trim() || 'Apple Silicon';
  const ramGb = Math.round(osImpl.totalmem() / 1024 ** 3);
  return {
    cpuBrand,
    gpuBrand: cpuBrand,
    ram: ramGb,
    vram: ramGb,
    hasANE: cpuBrand.includes('Apple'),
    numberOfPhysicalCores: osImpl.cpus().length,
    numberOfLogicalCores: osImpl.cpus().length,
  };
}

export function buildWorkerInfo({
  speechModels,
  hardwareRating = config.networkWorker.hardwareRating,
  hardwareInfo = detectHardwareInfo(),
}) {
  return {
    hardwareRating,
    hardwareInfo,
    workerModels: speechModels.map((model) => model.id),
    loadedModelID: speechModels[0]?.id,
  };
}

export function findSpeechModel(speechModels, modelID) {
  return speechModels.find((model) => model.id === modelID) || null;
}
