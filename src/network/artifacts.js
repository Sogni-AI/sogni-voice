import { createWriteStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// An error response still carries a body, and an undrained body pins its socket
// until GC. Every non-2xx path has to release the stream before throwing.
async function drainBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Already closed or errored; there is nothing left to release.
  }
}

const isAbort = (error, signal) => Boolean(signal?.aborted) || error?.name === 'AbortError';

export async function downloadToFile(url, destPath, options = {}) {
  const { fetchImpl = fetch, signal } = options;

  const response = await fetchImpl(url, { method: 'GET', signal });
  if (!response.ok) {
    await drainBody(response);
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
        await drainBody(response);
        throw new Error(`Upload failed with HTTP ${response.status}`);
      }
      return { uploadedKey: uploadKeyFromUrl(uploadUrl), bytes: body.length };
    } catch (error) {
      lastError = error;
      // An abort is a decision, not a transient fault. Unwind at once and let the
      // original error through, so a caller that cancelled the job can tell its
      // own timeout apart from a flaky network.
      if (isAbort(error, signal)) throw error;
      if (attempt < retries) await sleep(retryDelayMs * attempt);
    }
  }

  throw new Error(`Upload failed after ${retries} attempts: ${lastError.message}`, {
    cause: lastError,
  });
}
