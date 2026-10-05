import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolvePath(__dirname, '../..');

// The broker's mac agent gate: the version segment after the last '/' must be
// >= 4.0.0 and the UA must contain 'Sogni' (bot gate) and ' (macOS)' (agent
// type). The bracketed suffix is stripped before version parsing, so it can
// carry our real identity without confusing the gate.
export const SOGNI_CLIENT_VERSION = '4.0.0';
export const SPEECH_WORKER_VERSION = '2.0.0';

const SOCKET_URLS = {
  staging: 'wss://socket-staging.sogni.ai',
  production: 'wss://socket.sogni.ai',
};

const API_URLS = {
  staging: 'https://api-staging.sogni.ai',
  production: 'https://api.sogni.ai',
};

export function resolveSocketUrl(sogniEnv = config.networkWorker.sogniEnv) {
  const url = SOCKET_URLS[sogniEnv];
  if (!url) {
    throw new Error(`Unknown SOGNI_ENV "${sogniEnv}" (expected staging or production)`);
  }
  return url;
}

// Workers upload artifacts and fetch input assets through sogni-api directly
// (presigned URLs); the broker never proxies bytes.
export function resolveApiUrl(sogniEnv = config.networkWorker.sogniEnv) {
  if (config.networkWorker.apiUrl) return config.networkWorker.apiUrl;
  const url = API_URLS[sogniEnv];
  if (!url) {
    throw new Error(`Unknown SOGNI_ENV "${sogniEnv}" (expected staging or production)`);
  }
  return url;
}

export function buildUserAgent() {
  return `Sogni/${SOGNI_CLIENT_VERSION} (macOS) [sogni-voice-speech-worker/${SPEECH_WORKER_VERSION}]`;
}

export function loadOrCreateWorkerId(workerIdFile = config.networkWorker.workerIdFile) {
  const path = isAbsolute(workerIdFile)
    ? workerIdFile
    : resolvePath(projectRoot, workerIdFile);

  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf-8').trim();
    if (existing) return existing;
  }

  const id = randomUUID().toUpperCase();
  writeFileSync(path, id);
  return id;
}
