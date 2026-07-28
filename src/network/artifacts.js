import { createWriteStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function downloadToFile(url, destPath, options = {}) {
  const { fetchImpl = fetch, signal } = options;

  const response = await fetchImpl(url, { method: 'GET', signal });
  if (!response.ok) {
    throw new Error(`Input download failed with HTTP ${response.status}`);
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(destPath));

  const { size } = await stat(destPath);
  if (size === 0) {
    throw new Error('Input download produced an empty file');
  }

  return { path: destPath, bytes: size };
}

export function uploadKeyFromUrl(uploadUrl) {
  return new URL(uploadUrl).pathname.replace(/^\/+/, '');
}

export async function uploadFile(uploadUrl, filePath, options = {}) {
  const {
    fetchImpl = fetch,
    contentType = 'audio/wav',
    retries = 3,
    retryDelayMs = 500,
    signal,
  } = options;

  const body = await readFile(filePath);
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(uploadUrl, {
        method: 'PUT',
        headers: {
          'content-type': contentType,
          'content-length': String(body.length),
        },
        body,
        signal,
      });
      if (!response.ok) {
        throw new Error(`Upload failed with HTTP ${response.status}`);
      }
      return { uploadedKey: uploadKeyFromUrl(uploadUrl), bytes: body.length };
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(retryDelayMs * attempt);
    }
  }

  throw new Error(`Upload failed after ${retries} attempts: ${lastError.message}`);
}
