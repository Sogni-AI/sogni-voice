import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolvePath(__dirname, '../..');

export const SOGNI_PROTOCOL_VERSION = '3.0.118';
export const SPEECH_WORKER_VERSION = '1.0.0';

const SOCKET_URLS = {
  staging: 'wss://socket-staging.sogni.ai',
  production: 'wss://socket.sogni.ai',
};

export function resolveSocketUrl(sogniEnv = config.networkWorker.sogniEnv) {
  const url = SOCKET_URLS[sogniEnv];
  if (!url) {
    throw new Error(`Unknown SOGNI_ENV "${sogniEnv}" (expected staging or production)`);
  }
  return url;
}

export function buildUserAgent() {
  return `Sogni/${SOGNI_PROTOCOL_VERSION} (Darwin) | Speech:MLX | speech-worker/${SPEECH_WORKER_VERSION}`;
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
