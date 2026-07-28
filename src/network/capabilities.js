import { config } from '../config/index.js';

// `engine` is internal routing metadata for the executor and is stripped before
// the catalog goes on the wire.
export const SPEECH_MODEL_CATALOG = [
  { id: 'parakeet-tdt', task: 'stt', maxConcurrent: 1, engine: 'parakeet' },
  { id: 'kokoro-82m', task: 'tts', maxConcurrent: 2, engine: 'kokoro' },
  { id: 'qwen3-tts-preset', task: 'tts', maxConcurrent: 1, engine: 'qwen-preset' },
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

export function buildWorkerInfo({ speechModels, maxConcurrentJobs }) {
  return {
    speechModels: speechModels.map(({ id, task, maxConcurrent }) => ({ id, task, maxConcurrent })),
    loadedModelIDs: [],
    maxConcurrentJobs,
  };
}

export function findSpeechModel(speechModels, modelID, task) {
  return speechModels.find((model) => model.id === modelID && model.task === task) || null;
}
