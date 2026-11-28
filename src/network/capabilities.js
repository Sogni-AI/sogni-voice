import { config } from '../config/index.js';
import { COMFY_WORKER_VERSION, workerImageIdentity } from './config.js';

/**
 * Canonical Sogni Supernet voice model catalog.
 * Model IDs include version and quantization/precision per sogni-socket rules.
 */
export const VOICE_SUPERNET_MODELS = [
  {
    id: 'fish_drama_3_nvfp4',
    selector: 'drama3',
    task: 'tts',
    engine: 'drama3',
    maxConcurrent: 1,
  },
  {
    id: 'parakeet_tdt_0.6b_v3_bf16',
    selector: 'parakeet',
    task: 'stt',
    engine: 'parakeet',
    maxConcurrent: 1,
  },
  {
    id: 'nemotron_3.5_transcribe_30b_a4b_nvfp4',
    selector: 'nemotron',
    task: 'stt',
    engine: 'nemotron',
    maxConcurrent: 1,
  },
];

const LOCAL_ENGINE_ENABLED = {
  drama3: (cfg) => Boolean(cfg?.drama3Tts?.enabled),
  parakeet: (cfg) => Boolean(cfg?.transcription?.enabled),
  nemotron: (cfg) => Boolean(cfg?.nemotron?.enabled),
};

export function buildLocalWorkerModels(cfg = config, { allowlist = null } = {}) {
  return VOICE_SUPERNET_MODELS
    .filter((model) => LOCAL_ENGINE_ENABLED[model.engine]?.(cfg))
    .filter((model) => !allowlist || allowlist.has(model.id) || allowlist.has(model.selector))
    .map((model) => ({ ...model }));
}

export function filterModelsByAllowlist(models, allowlist = null) {
  if (!allowlist) return models.map((model) => ({ ...model }));
  return models
    .filter((model) => allowlist.has(model.id) || allowlist.has(model.selector))
    .map((model) => ({ ...model }));
}

export function findWorkerModel(models, workflowId) {
  if (!Array.isArray(models) || typeof workflowId !== 'string') return null;
  return models.find((entry) => (typeof entry === 'string' ? entry === workflowId : entry.id === workflowId)) || null;
}

/**
 * Build the exact Sogni media-worker `workerInfo` payload expected by
 * `sogni-socket` `handleWorkerSocketInfo` on `'authenticated'`.
 */
export function buildWorkerInfo({
  workerModels,
  loadedModelID = null,
  hardwareRating = 70,
  hardwareInfo,
  image = workerImageIdentity(COMFY_WORKER_VERSION),
  readinessSessionId,
  heldJobs = [],
}) {
  const modelIds = (workerModels || []).map((entry) => (typeof entry === 'string' ? entry : entry.id));
  const resolvedLoaded = loadedModelID && modelIds.includes(loadedModelID) ? loadedModelID : null;

  return {
    workerModels: modelIds,
    loadedModelID: resolvedLoaded,
    hardwareRating,
    hardwareInfo: {
      cpuBrand: hardwareInfo?.cpuBrand || 'ARM64 CPU',
      gpuBrand: hardwareInfo?.gpuBrand || 'NVIDIA GB10',
      vram: hardwareInfo?.vram ?? 64,
      ram: hardwareInfo?.ram ?? 64,
      ...(hardwareInfo?.hasANE !== undefined ? { hasANE: hardwareInfo.hasANE } : {}),
      ...(hardwareInfo?.numberOfPhysicalCores !== undefined
        ? { numberOfPhysicalCores: hardwareInfo.numberOfPhysicalCores }
        : {}),
      ...(hardwareInfo?.numberOfLogicalCores !== undefined
        ? { numberOfLogicalCores: hardwareInfo.numberOfLogicalCores }
        : {}),
      ...(hardwareInfo?.cpuFrequency !== undefined ? { cpuFrequency: hardwareInfo.cpuFrequency } : {}),
      ...(hardwareInfo?.hostname ? { hostname: hardwareInfo.hostname } : {}),
      ...(hardwareInfo?.useragent ? { useragent: hardwareInfo.useragent } : {}),
      ...(hardwareInfo?.nvidiaDriverVersion !== undefined
        ? { nvidiaDriverVersion: hardwareInfo.nvidiaDriverVersion }
        : {}),
      supportedControlnets: hardwareInfo?.supportedControlnets || {},
    },
    image,
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
    readinessSessionId,
    jobHoldProtocol: 1,
    heldJobs,
  };
}
