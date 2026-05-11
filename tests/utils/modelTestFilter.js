import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const toBool = (value, defaultValue) => {
  if (value == null) return defaultValue;
  const normalizedValue = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalizedValue)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalizedValue)) return false;
  return defaultValue;
};

const allModelsFlagSet = () =>
  process.env.VITEST_ALL_MODELS === '1' || process.argv.includes('--all');

const modelDefs = [
  {
    key: 'transcription',
    name: 'Transcription',
    envVar: 'TRANSCRIPTION_ENABLED',
    defaultEnabled: true,
    testFiles: ['tests/unit/services/transcription.test.js'],
  },
  {
    key: 'tts',
    name: 'TTS',
    envVar: 'TTS_ENABLED',
    defaultEnabled: true,
    testFiles: ['tests/unit/services/tts.test.js'],
  },
  {
    key: 'qwenTts',
    name: 'Qwen TTS',
    envVar: 'QWEN_TTS_ENABLED',
    defaultEnabled: false,
    testFiles: ['tests/unit/services/qwenTts.test.js'],
  },
  {
    key: 'pocketTts',
    name: 'Pocket TTS',
    envVar: 'POCKET_TTS_ENABLED',
    defaultEnabled: false,
    testFiles: ['tests/unit/services/pocketTts.test.js'],
  },
];

const existingTestFiles = (files) =>
  files.filter((file) => fs.existsSync(path.resolve(process.cwd(), file)));

export const resolveModelTestFilters = (options = {}) => {
  const runAll = options.all ?? allModelsFlagSet();

  const disabledModels = modelDefs
    .map((model) => {
      const enabled = toBool(process.env[model.envVar], model.defaultEnabled);
      return { ...model, enabled, testFiles: existingTestFiles(model.testFiles) };
    })
    .filter((model) => !model.enabled && model.testFiles.length > 0);

  const excluded = runAll
    ? []
    : disabledModels.flatMap((model) => model.testFiles);

  const warning =
    !runAll && disabledModels.length > 0
      ? `WARNING: Skipping unit tests for disabled models based on .env: ${disabledModels
          .map((model) => model.name)
          .join(', ')}. Use --all to run all unit tests.`
      : null;

  return { excluded, warning, runAll };
};
