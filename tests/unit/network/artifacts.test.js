import http from 'node:http';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createSyntheticTestWavBuffer } from '../../../src/utils/audioFormat.js';
import {
  downloadReferenceAudio,
  downloadToFile,
  fetchMediaDownloadUrl,
  fetchMediaUploadUrl,
  requestJsonWithBody,
  transcodeAndVerifySttAudio,
  transcodeReferenceWav,
  uploadBufferToSignedUrl,
  uploadFile,
  uploadJobArtifact,
  uploadKeyFromUrl,
  validateAndProbeAudio,
  validateArtifactTransferUrl,
} from '../../../src/network/artifacts.js';

const webBody = (buf) => Readable.toWeb(
  Readable.from(buf ? [Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf-8')] : []),
);

describe('artifacts & media URL client', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'sogni-artifacts-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('requestJsonWithBody (GET with JSON body over node:http)', () => {
    it('sends an actual HTTP GET request carrying a JSON body and parses nested data', async () => {
      const received = [];
      const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          received.push({ method: req.method, url: req.url, headers: req.headers, body });
          if (req.url === '/v1/media/downloadUrl') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: { downloadUrl: 'https://r2.sogni.test/in/ref.wav?sig=1' } }));
          } else if (req.url === '/v1/media/uploadUrl') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ uploadUrl: 'https://r2.sogni.test/out/complete.json?sig=2' }));
          } else {
            res.writeHead(404);
            res.end('not found');
          }
        });
      });

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const apiUrl = `http://127.0.0.1:${server.address().port}`;

      try {
        const downloadUrl = await fetchMediaDownloadUrl({
          apiUrl,
          jobId: 'job-123',
          id: 'asset-456',
          type: 'referenceAudio',
          contentType: 'audio/wav',
        });
        expect(downloadUrl).toBe('https://r2.sogni.test/in/ref.wav?sig=1');

        const uploadUrl = await fetchMediaUploadUrl({
          apiUrl,
          jobId: 'job-123',
          id: 'img-789',
          type: 'complete',
          contentType: 'application/json',
        });
        expect(uploadUrl).toBe('https://r2.sogni.test/out/complete.json?sig=2');

        expect(received).toHaveLength(2);
        expect(received[0]).toMatchObject({
          method: 'GET',
          url: '/v1/media/downloadUrl',
          body: {
            type: 'referenceAudio',
            jobId: 'job-123',
            id: 'asset-456',
            contentType: 'audio/wav',
          },
        });
        expect(received[1]).toMatchObject({
          method: 'GET',
          url: '/v1/media/uploadUrl',
          body: {
            type: 'complete',
            jobId: 'job-123',
            id: 'img-789',
            contentType: 'application/json',
          },
        });
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('rejects on non-2xx status from signed URL endpoint', async () => {
      const server = http.createServer((_req, res) => {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('forbidden');
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const apiUrl = `http://127.0.0.1:${server.address().port}`;
      try {
        await expect(
          requestJsonWithBody(`${apiUrl}/v1/media/uploadUrl`, { method: 'GET', body: { jobId: 'x' } }),
        ).rejects.toThrow(/HTTP 403/);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  describe('downloadReferenceAudio & uploadJobArtifact', () => {
    it('uses asset.url directly when present without calling /v1/media/downloadUrl', async () => {
      const wav = createSyntheticTestWavBuffer({ durationSeconds: 1 });
      const requestJsonImpl = vi.fn();
      const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: webBody(wav) }));

      const downloaded = await downloadReferenceAudio({
        jobID: 'job-direct',
        assets: [{
          type: 'audio',
          jobField: 'audio',
          signedDownloadType: 'referenceAudio',
          url: 'https://cdn.sogni.test/direct.wav',
        }],
      }, tempDir, { apiUrl: 'https://api.sogni.test', fetchImpl, requestJsonImpl });

      expect(requestJsonImpl).not.toHaveBeenCalled();
      expect(downloaded.detectedFormat).toBe('wav');
      expect(downloaded.bytes).toBe(wav.length);
    });

    it('falls back to GET /v1/media/downloadUrl when asset.url is absent', async () => {
      const wav = createSyntheticTestWavBuffer({ durationSeconds: 1 });
      const requestJsonImpl = vi.fn(async () => ({
        data: { downloadUrl: 'https://cdn.sogni.test/signed.wav' },
      }));
      const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: webBody(wav) }));

      const downloaded = await downloadReferenceAudio({
        jobID: 'job-signed',
        assets: [{
          type: 'audio',
          jobField: 'audio',
          signedDownloadType: 'referenceAudio',
          metadata: { assetId: 'proj-1', contentType: 'audio/wav' },
        }],
      }, tempDir, { apiUrl: 'https://api.sogni.test', fetchImpl, requestJsonImpl });

      expect(requestJsonImpl).toHaveBeenCalledWith(
        'https://api.sogni.test/v1/media/downloadUrl',
        expect.objectContaining({
          method: 'GET',
          body: {
            type: 'referenceAudio',
            jobId: 'job-signed',
            id: 'proj-1',
            contentType: 'audio/wav',
          },
        }),
      );
      expect(downloaded.detectedFormat).toBe('wav');
    });

    it('fetches uploadUrl via GET-with-JSON-body and PUTs artifact with SHA-256', async () => {
      const requestJsonImpl = vi.fn(async () => ({
        data: { uploadUrl: 'https://r2.sogni.test/complete/img-1.mp3?sig=ok' },
      }));
      const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
      const payload = Buffer.from('mp3-audio-bytes', 'utf-8');

      const uploaded = await uploadJobArtifact({
        apiUrl: 'https://api.sogni.test',
        jobId: 'job-up',
        imageId: 'img-1',
        buffer: payload,
        contentType: 'audio/mpeg',
        requestJsonImpl,
        fetchImpl,
      });

      expect(requestJsonImpl).toHaveBeenCalledWith(
        'https://api.sogni.test/v1/media/uploadUrl',
        expect.objectContaining({
          method: 'GET',
          body: {
            type: 'complete',
            jobId: 'job-up',
            id: 'img-1',
            contentType: 'audio/mpeg',
          },
        }),
      );
      expect(fetchImpl).toHaveBeenCalledWith(
        'https://r2.sogni.test/complete/img-1.mp3?sig=ok',
        expect.objectContaining({
          method: 'PUT',
          headers: {
            'content-type': 'audio/mpeg',
            'content-length': String(payload.length),
          },
        }),
      );
      expect(uploaded.uploadedKey).toBe('complete/img-1.mp3');
      expect(uploaded.sha256).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('validateAndProbeAudio', () => {
    it('rejects disguised #EXTM3U playlists before invoking ffprobe', async () => {
      const m3uPath = join(tempDir, 'disguised.wav');
      await writeFile(m3uPath, '#EXTM3U\n#EXTINF:10,\nfile:///etc/passwd\n');
      const execFileImpl = vi.fn();

      await expect(validateAndProbeAudio(m3uPath, { execFileImpl })).rejects.toMatchObject({
        invalidInput: true,
        message: expect.stringMatching(/not a playlist/),
      });
      expect(execFileImpl).not.toHaveBeenCalled();
    });

    it('rejects containers rejected by ffprobe format_whitelist as invalidInput', async () => {
      const badPath = join(tempDir, 'concat.bin');
      await writeFile(badPath, 'binary-header');
      const execFileImpl = vi.fn(async () => {
        const err = new Error('ffprobe failed');
        err.stderr = "Format not on whitelist 'mov,matroska,webm'";
        throw err;
      });

      await expect(validateAndProbeAudio(badPath, { execFileImpl })).rejects.toMatchObject({
        invalidInput: true,
        message: expect.stringMatching(/not a playlist/),
      });
    });

    it('probes audio stream presence and duration in seconds', async () => {
      const wavPath = join(tempDir, 'valid.wav');
      await writeFile(wavPath, createSyntheticTestWavBuffer({ durationSeconds: 2 }));
      const execFileImpl = vi.fn(async () => ({
        stdout: JSON.stringify({
          streams: [{ codec_type: 'audio', duration: '2.000000' }],
          format: { format_name: 'wav', duration: '2.000000' },
        }),
      }));

      const probed = await validateAndProbeAudio(wavPath, { execFileImpl });
      expect(probed).toEqual({ duration: 2, formatName: 'wav' });
    });
  });

  describe('downloadToFile, uploadKeyFromUrl & uploadFile', () => {
    it('streams a presigned GET to disk and rejects empty downloads', async () => {
      const destPath = join(tempDir, 'input.wav');
      const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: webBody('RIFFaudio') }));
      const result = await downloadToFile('https://s3.test/in/clip.wav', destPath, { fetchImpl });
      expect(result).toEqual({ path: destPath, bytes: 9 });
      expect(await readFile(destPath, 'utf-8')).toBe('RIFFaudio');

      const emptyFetch = vi.fn(async () => ({ ok: true, status: 200, body: webBody('') }));
      await expect(
        downloadToFile('https://s3.test/in/clip.wav', join(tempDir, 'empty.wav'), { fetchImpl: emptyFetch }),
      ).rejects.toMatchObject({
        invalidInput: true,
        message: 'Input download produced an empty file',
      });
    });

    it('enforces streaming maxBytes cap, HTTPS/SSRF rules, redirect hop validation, and 404 invalidInput', async () => {
      for (const blockedUrl of [
        'http://s3.test/insecure.wav',
        'https://127.0.0.1/local.wav',
        'https://localhost/local.wav',
        'https://10.0.0.5/private.wav',
        'https://172.16.5.4/private.wav',
        'https://192.168.1.9/private.wav',
        'https://100.64.10.20/cgnat.wav',
        'https://169.254.169.254/latest/meta-data/',
        'https://[::1]/loopback.wav',
        'https://[::ffff:127.0.0.1]/mapped.wav',
      ]) {
        expect(() => validateArtifactTransferUrl(blockedUrl, { sogniEnv: 'production' })).toThrow();
      }
      expect(validateArtifactTransferUrl('http://127.0.0.1:9000/local.wav', { sogniEnv: 'local' }).hostname)
        .toBe('127.0.0.1');
      expect(() => validateArtifactTransferUrl('http://169.254.169.254/latest', { sogniEnv: 'local' }))
        .toThrow();

      // Redirect hop to IMDS must be rejected before contacting the redirect target
      const redirectFetch = vi.fn(async () => ({
        ok: false,
        status: 302,
        headers: new Headers({ location: 'https://169.254.169.254/latest/meta-data/' }),
        body: webBody(''),
      }));
      await expect(
        downloadToFile('https://s3.test/in/clip.wav', join(tempDir, 'redir.wav'), { fetchImpl: redirectFetch }),
      ).rejects.toMatchObject({
        invalidInput: true,
        message: expect.stringMatching(/not permitted/),
      });
      expect(redirectFetch).toHaveBeenCalledTimes(1);

      // Oversized streaming response without Content-Length aborts mid-stream
      const bigFetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: webBody(Buffer.alloc(2048, 0x41)),
      }));
      await expect(
        downloadToFile('https://s3.test/in/huge.wav', join(tempDir, 'huge.wav'), {
          fetchImpl: bigFetch,
          maxBytes: 1024,
        }),
      ).rejects.toMatchObject({
        invalidInput: true,
        message: expect.stringMatching(/exceeded maximum allowed 1024 bytes/),
      });

      // HTTP 404 maps to invalidInput without retrying
      const notFoundFetch = vi.fn(async () => ({ ok: false, status: 404, body: webBody('') }));
      await expect(
        downloadToFile('https://s3.test/in/missing.wav', join(tempDir, '404.wav'), {
          fetchImpl: notFoundFetch,
          retries: 3,
        }),
      ).rejects.toMatchObject({
        invalidInput: true,
        message: 'Input download failed with HTTP 404',
      });
      expect(notFoundFetch).toHaveBeenCalledTimes(1);

      // uploadBufferToSignedUrl enforces redirect: 'error'
      const putFetch = vi.fn(async () => ({ ok: true, status: 200 }));
      await uploadBufferToSignedUrl('https://r2.sogni.test/out/file.mp3', Buffer.from('ok'), {
        fetchImpl: putFetch,
      });
      expect(putFetch).toHaveBeenCalledWith(
        'https://r2.sogni.test/out/file.mp3',
        expect.objectContaining({ method: 'PUT', redirect: 'error' }),
      );
    });

    it('verifies decoded PCM/FLAC sample counts in transcodeReferenceWav and transcodeAndVerifySttAudio', async () => {
      const refIn = join(tempDir, 'forged-ref.wav');
      const refOut = join(tempDir, 'decoded-ref.wav');
      await writeFile(refIn, createSyntheticTestWavBuffer({ durationSeconds: 2, sampleRate: 44100 }));

      // Simulate forged header where decoded WAV turns out to be 30.8s (> 30.5s ceiling)
      const overlongExec = vi.fn(async (_cmd, args) => {
        expect(args).toContain('-t');
        expect(args).toContain('31');
        expect(args).toContain('--');
        const out = args[args.length - 1];
        await writeFile(out, createSyntheticTestWavBuffer({ durationSeconds: 30.8, sampleRate: 44100 }));
        return { stdout: '', stderr: '' };
      });
      await expect(
        transcodeReferenceWav(refIn, refOut, { execFileImpl: overlongExec }),
      ).rejects.toMatchObject({
        invalidInput: true,
        message: expect.stringMatching(/at most 30 seconds/),
      });

      // Build a real 42-byte FLAC header claiming 80 seconds (80 * 16000 = 1,280,000 samples)
      // when caller declared duration=60 (allowedMaxDuration = 74s)
      const sttOut = join(tempDir, 'decoded-stt.flac');
      const buildFlacHeader = (sampleRate, totalSamples) => {
        const buf = Buffer.alloc(42, 0);
        buf.write('fLaC', 0, 'ascii');
        buf[4] = 0x80; // last metadata block + type 0 (STREAMINFO)
        buf.writeUIntBE(34, 5, 3);
        const hi32 = ((sampleRate << 12) | (0 << 9) | (15 << 4) | Number((BigInt(totalSamples) >> 32n) & 0x0fn)) >>> 0;
        const lo32 = Number(BigInt(totalSamples) & 0xffffffffn) >>> 0;
        buf.writeUInt32BE(hi32, 18);
        buf.writeUInt32BE(lo32, 22);
        return buf;
      };

      const sttExec = vi.fn(async (_cmd, args) => {
        expect(args).toContain('-protocol_whitelist');
        expect(args).toContain('flac');
        expect(args).toContain('76'); // Math.ceil(74) + 2
        const out = args[args.length - 1];
        await writeFile(out, buildFlacHeader(16000, 80 * 16000));
        return { stdout: '', stderr: '' };
      });

      await expect(
        transcodeAndVerifySttAudio(refIn, sttOut, {
          allowedMaxDuration: 74,
          declaredDuration: 60,
          maxModelSeconds: 7200,
          workflowId: 'parakeet_tdt_0.6b_v3_bf16',
          execFileImpl: sttExec,
        }),
      ).rejects.toMatchObject({
        invalidInput: true,
        message: 'Audio duration 80.0s exceeds declared duration 60s',
      });
    });

    it('uploads a file with retries and extracts uploadedKey', async () => {
      expect(uploadKeyFromUrl('https://bucket.s3.test/speech/out/job-1.wav?X-Amz-Signature=abc'))
        .toBe('speech/out/job-1.wav');

      const filePath = join(tempDir, 'out.wav');
      await writeFile(filePath, 'audio-bytes');
      const fetchImpl = vi.fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce({ ok: true, status: 200 });

      const result = await uploadFile('https://bucket.s3.test/out/a.wav', filePath, {
        fetchImpl,
        retryDelayMs: 1,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(result.uploadedKey).toBe('out/a.wav');
      expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    });
  });
});
