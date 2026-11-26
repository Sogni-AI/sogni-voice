import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, readFile, stat, unlink } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { join, resolve as resolvePath } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { sniffAudioFormat } from '../utils/audioValidation.js';

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const MIN_ARTIFACT_UPLOAD_BYTES_PER_SEC = 128 * 1024;
export const MAX_ARTIFACT_UPLOAD_ATTEMPT_MS = 10 * 60_000;
export const MAX_ARTIFACT_DOWNLOAD_BYTES = 256 * 1024 * 1024;
export const MAX_DOWNLOAD_REDIRECTS = 3;

// Allowed single-file demuxers matching ComfyUI/worker/src/assets/mediaContainer.ts.
// Rejects HLS/m3u8, DASH, concat, and external file-reference playlists before decoding.
export const MEDIA_DEMUXERS = [
  'mov', 'matroska', 'webm', 'avi', 'mpeg', 'mpegts', 'flv', 'asf',
  'gif', 'apng', 'wav', 'mp3', 'flac', 'ogg', 'aac', 'aiff',
  'ape', 'wv', 'amr', 'ac3', 'eac3', 'au', 'caf',
].join(',');

export function artifactUploadTimeoutMs(bytes, floorMs = 60_000) {
  const sizeBudgetMs = Math.ceil((bytes / MIN_ARTIFACT_UPLOAD_BYTES_PER_SEC) * 1000);
  return Math.max(floorMs, Math.min(sizeBudgetMs, MAX_ARTIFACT_UPLOAD_ATTEMPT_MS));
}

async function drainBody(response) {
  try {
    await response?.body?.cancel();
  } catch {
    // Stream already closed.
  }
}

const isAbort = (error, signal) => Boolean(signal?.aborted) || error?.name === 'AbortError';

const createAbortError = () => {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
};

const makeInvalidInputError = (message, cause = undefined) => {
  const error = new Error(message, cause ? { cause } : undefined);
  error.invalidInput = true;
  return error;
};

function parseIpv4Octets(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums;
}

function isBlockedIpv4(octets, { allowLocal = false } = {}) {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 unspecified
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / cloud IMDS
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT / Tailscale
  if (a >= 224) return true; // multicast / reserved
  if (!allowLocal) {
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8 RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
  }
  return false;
}

function extractMappedIpv4FromIpv6(normalizedV6) {
  // Handle ::ffff:a.b.c.d or ::ffff:xxxx:yyyy
  const dottedMatch = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(normalizedV6);
  if (dottedMatch) {
    return parseIpv4Octets(dottedMatch[1]);
  }
  const hexMatch = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(normalizedV6);
  if (hexMatch) {
    const hi = Number.parseInt(hexMatch[1], 16);
    const lo = Number.parseInt(hexMatch[2], 16);
    return [(hi >>> 8) & 0xff, hi & 0xff, (lo >>> 8) & 0xff, lo & 0xff];
  }
  return null;
}

function isBlockedHost(rawHostname, { allowLocal = false } = {}) {
  const host = String(rawHostname || '')
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (!host) return true;

  if (!allowLocal && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal'))) {
    return true;
  }

  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    const octets = parseIpv4Octets(host);
    return !octets || isBlockedIpv4(octets, { allowLocal });
  }

  if (ipVersion === 6) {
    if (host === '::') return true;
    if (/^fe[89ab][0-9a-f]:/i.test(host)) return true; // fe80::/10 link-local
    const mappedV4 = extractMappedIpv4FromIpv6(host);
    if (mappedV4) return isBlockedIpv4(mappedV4, { allowLocal });
    if (!allowLocal) {
      if (host === '::1') return true;
      if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true; // fc00::/7 unique-local
    }
    return false;
  }

  // Catch non-canonical numeric IPv4 forms (octal/hex/integer) that URL normalizes or leaves ambiguous.
  if (/^(?:0x[0-9a-f]+|\d+)$/i.test(host)) {
    return true;
  }

  return false;
}

/**
 * Validate a worker presigned downloadUrl or uploadUrl before contacting it.
 * Enforces HTTPS in non-local environments and blocks loopback, RFC1918, CGNAT,
 * and link-local / IMDS SSRF targets.
 */
export function validateArtifactTransferUrl(
  rawUrl,
  {
    sogniEnv = 'staging',
    invalidAsInput = true,
  } = {},
) {
  const fail = (msg) => (invalidAsInput ? makeInvalidInputError(msg) : new Error(msg));
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    throw fail('Malformed artifact transfer URL');
  }

  if (parsed.username || parsed.password) {
    throw fail('Artifact transfer URL must not contain credentials');
  }

  const allowLocal = String(sogniEnv || 'staging').toLowerCase() === 'local';
  if (allowLocal) {
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw fail(`Unsupported artifact URL scheme "${parsed.protocol}"`);
    }
  } else if (parsed.protocol !== 'https:') {
    throw fail(`Artifact transfer URL must use https: (got "${parsed.protocol}")`);
  }

  if (isBlockedHost(parsed.hostname, { allowLocal })) {
    throw fail(`Artifact transfer URL host "${parsed.hostname}" is not permitted`);
  }

  return parsed;
}

/**
 * Perform an HTTP/HTTPS request carrying a JSON body, including `method: 'GET'`.
 * Node's built-in `fetch` (undici) rejects a body on `GET`, whereas Sogni's
 * `/v1/media/downloadUrl` and `/v1/media/uploadUrl` endpoints expect `GET` with
 * a JSON request body (matching `axios.request({ method: 'GET', data })` in `ComfyUI/worker`).
 */
export function requestJsonWithBody(
  url,
  {
    method = 'GET',
    body = {},
    headers = {},
    timeoutMs = 15_000,
    rejectUnauthorized = undefined,
    signal = undefined,
  } = {},
) {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }

  const parsed = new URL(url);
  const transport = parsed.protocol === 'https:' ? https : http;
  const payload = Buffer.from(JSON.stringify(body), 'utf-8');

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve(value);
    };

    const req = transport.request(
      parsed,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(payload.length),
          Accept: 'application/json',
          ...headers,
        },
        ...(parsed.protocol === 'https:' && rejectUnauthorized !== undefined
          ? { rejectUnauthorized }
          : {}),
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const rawText = Buffer.concat(chunks).toString('utf-8');
          const status = res.statusCode || 0;
          if (status < 200 || status >= 300) {
            const err = new Error(
              `Signed URL request ${method} ${parsed.pathname} failed with HTTP ${status}: ${rawText.slice(0, 300)}`,
            );
            err.status = status;
            if (status === 400 || status === 403 || status === 404) {
              err.invalidInput = true;
            }
            finish(err);
            return;
          }
          try {
            const parsedJson = rawText ? JSON.parse(rawText) : {};
            finish(null, parsedJson);
          } catch (error) {
            finish(new Error(`Invalid JSON from ${parsed.pathname}: ${error.message}`));
          }
        });
        res.on('error', (error) => finish(error));
      },
    );

    const onAbort = () => {
      req.destroy(createAbortError());
      finish(createAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Signed URL request timed out after ${timeoutMs}ms`));
    });
    req.on('error', (error) => finish(error));
    req.write(payload);
    req.end();
  });
}

export async function fetchMediaDownloadUrl({
  apiUrl,
  jobId,
  id,
  type = 'referenceAudio',
  contentType = undefined,
  timeoutMs = 15_000,
  rejectUnauthorized = undefined,
  signal = undefined,
  requestJsonImpl = requestJsonWithBody,
}) {
  const response = await requestJsonImpl(`${String(apiUrl).replace(/\/+$/, '')}/v1/media/downloadUrl`, {
    method: 'GET',
    body: {
      type,
      jobId,
      id: id || jobId,
      ...(contentType ? { contentType } : {}),
    },
    timeoutMs,
    rejectUnauthorized,
    signal,
  });
  const data = response?.data || response || {};
  if (!data.downloadUrl) {
    throw new Error('Download URL missing from Sogni media response');
  }
  return data.downloadUrl;
}

export async function fetchMediaUploadUrl({
  apiUrl,
  jobId,
  id,
  type = 'complete',
  contentType,
  timeoutMs = 15_000,
  rejectUnauthorized = undefined,
  signal = undefined,
  requestJsonImpl = requestJsonWithBody,
}) {
  const response = await requestJsonImpl(`${String(apiUrl).replace(/\/+$/, '')}/v1/media/uploadUrl`, {
    method: 'GET',
    body: {
      type,
      jobId,
      id: id || jobId,
      ...(contentType ? { contentType } : {}),
    },
    timeoutMs,
    rejectUnauthorized,
    signal,
  });
  const data = response?.data || response || {};
  if (!data.uploadUrl) {
    throw new Error('Upload URL missing from Sogni media response');
  }
  return data.uploadUrl;
}

export async function downloadToFile(url, destPath, options = {}) {
  const {
    fetchImpl = fetch,
    signal,
    retries = 1,
    retryDelayMs = 1000,
    maxBytes = MAX_ARTIFACT_DOWNLOAD_BYTES,
    sogniEnv = 'staging',
    maxRedirects = MAX_DOWNLOAD_REDIRECTS,
  } = options;

  validateArtifactTransferUrl(url, { sogniEnv, invalidAsInput: true });

  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      let currentUrl = String(url);
      let response = null;

      for (let hop = 0; hop <= maxRedirects; hop += 1) {
        validateArtifactTransferUrl(currentUrl, { sogniEnv, invalidAsInput: true });
        response = await fetchImpl(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          signal,
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers?.get?.('location');
          await drainBody(response);
          if (!location) {
            throw makeInvalidInputError(`Input download redirect HTTP ${response.status} missing Location header`);
          }
          if (hop >= maxRedirects) {
            throw makeInvalidInputError(`Input download exceeded ${maxRedirects} redirects`);
          }
          currentUrl = new URL(location, currentUrl).toString();
          validateArtifactTransferUrl(currentUrl, { sogniEnv, invalidAsInput: true });
          continue;
        }
        break;
      }

      if (!response.ok) {
        await drainBody(response);
        const status = response.status;
        if (status === 400 || status === 403 || status === 404 || status === 410) {
          throw makeInvalidInputError(`Input download failed with HTTP ${status}`);
        }
        throw new Error(`Input download failed with HTTP ${status}`);
      }

      const contentLengthHeader = response.headers?.get?.('content-length');
      const declaredLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : Number.NaN;
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        await drainBody(response);
        throw makeInvalidInputError(
          `Input download size (${declaredLength} bytes) exceeds maximum allowed ${maxBytes} bytes`,
        );
      }

      const sourceStream = response.body && typeof response.body.getReader === 'function'
        ? Readable.fromWeb(response.body)
        : Readable.from(Buffer.from(await response.arrayBuffer()));

      let bytesWritten = 0;
      const limiter = new Transform({
        transform(chunk, _encoding, callback) {
          bytesWritten += chunk.length;
          if (bytesWritten > maxBytes) {
            callback(makeInvalidInputError(
              `Input download exceeded maximum allowed ${maxBytes} bytes`,
            ));
            return;
          }
          callback(null, chunk);
        },
      });

      try {
        await pipeline(sourceStream, limiter, createWriteStream(destPath));
      } catch (streamErr) {
        await unlink(destPath).catch(() => {});
        throw streamErr;
      }

      const { size } = await stat(destPath);
      if (size === 0) {
        await unlink(destPath).catch(() => {});
        throw makeInvalidInputError('Input download produced an empty file');
      }

      return { path: destPath, bytes: size };
    } catch (error) {
      lastError = error;
      if (isAbort(error, signal) || error?.invalidInput) throw error;
      if (attempt < retries) await sleep(retryDelayMs * attempt);
    }
  }

  throw lastError;
}

export function findReferenceAudioAsset(job) {
  const assets = Array.isArray(job?.assets) ? job.assets : [];
  return assets.find((asset) => (
    asset?.jobField === 'audio'
    || asset?.jobField === 'referenceAudio'
    || asset?.signedDownloadType === 'referenceAudio'
    || asset?.type === 'audio'
  )) || null;
}

export async function downloadReferenceAudio(job, destDir, options = {}) {
  const {
    apiUrl,
    sogniEnv = 'staging',
    fetchImpl = fetch,
    requestJsonImpl = requestJsonWithBody,
    rejectUnauthorized = undefined,
    signal = undefined,
    retries = 3,
    retryDelayMs = 1000,
    maxBytes = MAX_ARTIFACT_DOWNLOAD_BYTES,
  } = options;

  const asset = findReferenceAudioAsset(job);
  if (!asset) return null;

  const contentType = asset.metadata?.contentType
    || job?.clientParams?.referenceAudioContentType
    || undefined;
  const downloadUrl = asset.url || await fetchMediaDownloadUrl({
    apiUrl,
    jobId: job.jobID,
    id: asset.metadata?.assetId || job.jobID,
    type: asset.signedDownloadType || 'referenceAudio',
    contentType,
    rejectUnauthorized,
    signal,
    requestJsonImpl,
  });

  const rawPath = join(destDir, 'downloaded-input.bin');
  const downloaded = await downloadToFile(downloadUrl, rawPath, {
    fetchImpl,
    signal,
    retries,
    retryDelayMs,
    maxBytes,
    sogniEnv,
  });

  // Detect true format from magic bytes so downstream tools / multipart uploads get a matching extension.
  const fh = await open(rawPath, 'r');
  let detectedExt = null;
  try {
    const headBytes = Buffer.alloc(16);
    await fh.read(headBytes, 0, 16, 0);
    detectedExt = sniffAudioFormat(headBytes);
  } finally {
    await fh.close();
  }

  return {
    path: downloaded.path,
    bytes: downloaded.bytes,
    detectedFormat: detectedExt,
    contentType,
  };
}

export function uploadKeyFromUrl(uploadUrl) {
  return new URL(uploadUrl).pathname.replace(/^\/+/, '');
}

export async function uploadBufferToSignedUrl(uploadUrl, buffer, options = {}) {
  const {
    fetchImpl = fetch,
    contentType = 'audio/wav',
    retries = 3,
    retryDelayMs = 500,
    sogniEnv = 'staging',
    signal,
  } = options;

  validateArtifactTransferUrl(uploadUrl, { sogniEnv, invalidAsInput: false });

  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(uploadUrl, {
        method: 'PUT',
        redirect: 'error',
        headers: {
          'content-type': contentType,
          'content-length': String(buffer.length),
        },
        body: buffer,
        signal,
      });
      if (!response.ok) {
        await drainBody(response);
        throw new Error(`Upload failed with HTTP ${response.status}`);
      }
      return {
        uploadedKey: uploadKeyFromUrl(uploadUrl),
        bytes: buffer.length,
        sha256: createHash('sha256').update(buffer).digest('hex'),
      };
    } catch (error) {
      lastError = error;
      if (isAbort(error, signal)) throw error;
      if (attempt < retries) await sleep(retryDelayMs * attempt);
    }
  }

  throw new Error(`Upload failed after ${retries} attempts: ${lastError.message}`, {
    cause: lastError,
  });
}

export async function uploadFile(uploadUrl, filePath, options = {}) {
  const body = await readFile(filePath);
  return uploadBufferToSignedUrl(uploadUrl, body, options);
}

export async function uploadJobArtifact({
  apiUrl,
  sogniEnv = 'staging',
  jobId,
  imageId,
  buffer,
  contentType,
  artifactType = 'complete',
  fetchImpl = fetch,
  requestJsonImpl = requestJsonWithBody,
  rejectUnauthorized = undefined,
  retries = 3,
  retryDelayMs = 1000,
  signal = undefined,
}) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const uploadUrl = await fetchMediaUploadUrl({
        apiUrl,
        jobId,
        id: imageId || jobId,
        type: artifactType,
        contentType,
        rejectUnauthorized,
        signal,
        requestJsonImpl,
      });
      const uploaded = await uploadBufferToSignedUrl(uploadUrl, buffer, {
        fetchImpl,
        contentType,
        retries: 1,
        sogniEnv,
        signal,
      });
      return { uploadUrl, ...uploaded };
    } catch (error) {
      lastError = error;
      if (isAbort(error, signal)) throw error;
      if (attempt < retries) await sleep(retryDelayMs * attempt);
    }
  }

  throw new Error(`Artifact upload failed after ${retries} attempts: ${lastError.message}`, {
    cause: lastError,
  });
}

async function rejectDisguisedPlaylistHeader(filePath) {
  const fh = await open(filePath, 'r');
  try {
    const headBuf = Buffer.alloc(64);
    const { bytesRead } = await fh.read(headBuf, 0, headBuf.length, 0);
    const prefix = headBuf.subarray(0, bytesRead).toString('utf-8').trimStart();
    if (/^(?:#EXTM3U|ffconcat\s+version|<MPD\b)/i.test(prefix)) {
      throw makeInvalidInputError(
        'Unsupported input media container: upload a single audio file, not a playlist.',
      );
    }
  } finally {
    await fh.close();
  }
}

async function readFlacExactDurationSeconds(flacPath) {
  const fh = await open(flacPath, 'r');
  try {
    const header = Buffer.alloc(42);
    const { bytesRead } = await fh.read(header, 0, 42, 0);
    if (bytesRead < 42 || header.subarray(0, 4).toString('ascii') !== 'fLaC') {
      return null;
    }
    const blockType = header[4] & 0x7f;
    if (blockType !== 0) return null;
    const sampleRate = header.readUInt32BE(18) >>> 12;
    const totalSamples = (BigInt(header[21] & 0x0f) << 32n) | BigInt(header.readUInt32BE(22));
    if (sampleRate > 0 && totalSamples > 0n) {
      return Number(totalSamples) / sampleRate;
    }
    return null;
  } finally {
    await fh.close();
  }
}

/**
 * Validate media container safety (rejecting HLS/m3u8, concat, and file-ref playlists)
 * and probe the audio duration in seconds.
 */
export async function validateAndProbeAudio(
  filePath,
  {
    execFileImpl = execFileAsync,
    signal = undefined,
  } = {},
) {
  const resolvedInput = resolvePath(filePath);
  await rejectDisguisedPlaylistHeader(resolvedInput);

  let stdout;
  try {
    const result = await execFileImpl(
      'ffprobe',
      [
        '-v', 'error',
        '-protocol_whitelist', 'file,pipe',
        '-format_whitelist', MEDIA_DEMUXERS,
        '-show_entries', 'stream=codec_type,duration:format=duration,format_name',
        '-of', 'json',
        '--',
        resolvedInput,
      ],
      { timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, signal },
    );
    stdout = typeof result === 'string' ? result : result.stdout;
  } catch (error) {
    const stderr = String(error?.stderr || error?.message || '');
    if (
      /Format not on whitelist|Protocol not on whitelist|Not detecting m3u8\/hls|Invalid data found when processing input/i.test(stderr)
    ) {
      throw makeInvalidInputError(
        'Unsupported input media container: upload a single audio file, not a playlist.',
      );
    }
    throw error;
  }

  const parsed = JSON.parse(stdout || '{}');
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const audioStreams = streams.filter((stream) => stream?.codec_type === 'audio');
  if (audioStreams.length === 0) {
    throw makeInvalidInputError(
      'Unsupported input media container: uploaded audio has no audio stream.',
    );
  }

  let duration = Number.parseFloat(parsed.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    for (const stream of audioStreams) {
      const streamDuration = Number.parseFloat(stream?.duration);
      if (Number.isFinite(streamDuration) && streamDuration > 0) {
        duration = streamDuration;
        break;
      }
    }
  }

  // Browser MediaRecorder WebM clips often store duration="N/A" in the header.
  // Decode to temporary 16 kHz mono PCM16 WAV to measure exact sample count.
  if (!Number.isFinite(duration) || duration <= 0) {
    const probeWavPath = resolvePath(`${resolvedInput}.probe.wav`);
    try {
      await execFileImpl(
        'ffmpeg',
        [
          '-nostdin', '-y', '-loglevel', 'error',
          '-protocol_whitelist', 'file,pipe',
          '-format_whitelist', MEDIA_DEMUXERS,
          '-i', resolvedInput,
          '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
          '--',
          probeWavPath,
        ],
        { timeout: 120_000, signal },
      );
      const { size } = await stat(probeWavPath);
      duration = Math.max(0, (size - 44) / (16000 * 2));
    } finally {
      await unlink(probeWavPath).catch(() => {});
    }
  }

  if (!Number.isFinite(duration) || duration <= 0) {
    throw makeInvalidInputError('Uploaded audio file has zero or unreadable duration.');
  }

  return {
    duration,
    formatName: parsed.format?.format_name || null,
  };
}

/**
 * Transcode untrusted STT input once into clean 16 kHz mono lossless FLAC capped at
 * `Math.ceil(allowedMaxDuration) + 2` seconds, then measure exact decoded sample count
 * so forged container header durations can never bypass paid duration limits.
 */
export async function transcodeAndVerifySttAudio(
  inputPath,
  outputFlacPath,
  {
    allowedMaxDuration,
    declaredDuration = 60,
    maxModelSeconds = 7200,
    workflowId = 'stt',
    execFileImpl = execFileAsync,
    signal = undefined,
    timeoutMs = 180_000,
  } = {},
) {
  const resolvedInput = resolvePath(inputPath);
  const resolvedOutput = resolvePath(outputFlacPath);
  await rejectDisguisedPlaylistHeader(resolvedInput);

  const decodeCapSeconds = Math.max(3, Math.ceil(allowedMaxDuration) + 2);
  try {
    await execFileImpl(
      'ffmpeg',
      [
        '-nostdin', '-y', '-loglevel', 'error',
        '-protocol_whitelist', 'file,pipe',
        '-format_whitelist', MEDIA_DEMUXERS,
        '-t', String(decodeCapSeconds),
        '-i', resolvedInput,
        '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'flac',
        '--',
        resolvedOutput,
      ],
      { timeout: timeoutMs, killSignal: 'SIGKILL', signal },
    );
  } catch (error) {
    if (isAbort(error, signal)) throw error;
    const stderr = String(error?.stderr || error?.message || '');
    if (
      /Format not on whitelist|Protocol not on whitelist|Not detecting m3u8\/hls|Invalid data found|Output file does not contain any stream/i.test(stderr)
    ) {
      throw makeInvalidInputError(
        'Unsupported input media container: upload a single valid audio file.',
      );
    }
    throw makeInvalidInputError(
      `Uploaded audio could not be decoded: ${stderr.slice(0, 300) || 'decode error'}`,
    );
  }

  let actualDuration = await readFlacExactDurationSeconds(resolvedOutput).catch(() => null);
  if (actualDuration === null) {
    const probeRes = await execFileImpl(
      'ffprobe',
      [
        '-v', 'error',
        '-protocol_whitelist', 'file,pipe',
        '-show_entries', 'stream=nb_samples,sample_rate,duration:format=duration',
        '-of', 'json',
        '--',
        resolvedOutput,
      ],
      { timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, signal },
    );
    const stdout = typeof probeRes === 'string' ? probeRes : probeRes.stdout;
    const parsed = JSON.parse(stdout || '{}');
    const stream = Array.isArray(parsed.streams) ? parsed.streams[0] : null;
    const nbSamples = Number(stream?.nb_samples);
    const sampleRate = Number(stream?.sample_rate) || 16000;
    if (Number.isFinite(nbSamples) && nbSamples > 0 && sampleRate > 0) {
      actualDuration = nbSamples / sampleRate;
    } else {
      const fallbackDur = Number.parseFloat(stream?.duration ?? parsed.format?.duration);
      if (Number.isFinite(fallbackDur) && fallbackDur > 0) {
        actualDuration = fallbackDur;
      }
    }
  }

  if (!Number.isFinite(actualDuration) || actualDuration <= 0) {
    throw makeInvalidInputError('Uploaded audio file has zero or unreadable duration.');
  }

  if (actualDuration > maxModelSeconds) {
    throw makeInvalidInputError(
      `Audio duration ${actualDuration.toFixed(1)}s exceeds maximum ${maxModelSeconds}s for ${workflowId}`,
    );
  }

  if (actualDuration > allowedMaxDuration) {
    throw makeInvalidInputError(
      `Audio duration ${actualDuration.toFixed(1)}s exceeds declared duration ${declaredDuration}s`,
    );
  }

  return {
    path: resolvedOutput,
    duration: actualDuration,
  };
}

export async function transcodeReferenceWav(
  inputPath,
  outputWavPath,
  {
    execFileImpl = execFileAsync,
    signal = undefined,
    timeoutMs = 120_000,
  } = {},
) {
  const resolvedInput = resolvePath(inputPath);
  const resolvedOutput = resolvePath(outputWavPath);
  try {
    await execFileImpl(
      'ffmpeg',
      [
        '-nostdin', '-y', '-loglevel', 'error',
        '-protocol_whitelist', 'file,pipe',
        '-format_whitelist', MEDIA_DEMUXERS,
        '-t', '31',
        '-i', resolvedInput,
        '-vn', '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le',
        '--',
        resolvedOutput,
      ],
      { timeout: timeoutMs, killSignal: 'SIGKILL', signal },
    );
  } catch (error) {
    if (isAbort(error, signal)) throw error;
    throw makeInvalidInputError(
      `Reference audio could not be decoded: ${error?.stderr || error?.message || error}`,
    );
  }

  const { size } = await stat(resolvedOutput);
  const decodedSeconds = Math.max(0, (size - 44) / (44100 * 2));
  if (decodedSeconds < 1) {
    throw makeInvalidInputError(
      `Reference audio must be at least 1 seconds long, got ${decodedSeconds.toFixed(1)}s`,
    );
  }
  if (decodedSeconds > 30.5) {
    throw makeInvalidInputError(
      `Reference audio must be at most 30 seconds long, got ${decodedSeconds.toFixed(1)}s`,
    );
  }

  return resolvedOutput;
}
