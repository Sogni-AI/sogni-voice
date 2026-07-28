import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  downloadToFile,
  uploadFile,
  uploadKeyFromUrl,
} from '../../../src/network/artifacts.js';

const webBody = (text) => Readable.toWeb(Readable.from(text ? [Buffer.from(text, 'utf-8')] : []));

describe('artifacts', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'sogni-artifacts-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('downloadToFile', () => {
    it('streams a presigned GET to disk', async () => {
      const destPath = join(tempDir, 'input.wav');
      const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: webBody('RIFFaudio') }));

      const result = await downloadToFile('https://s3.test/in/clip.wav', destPath, { fetchImpl });

      expect(fetchImpl).toHaveBeenCalledWith(
        'https://s3.test/in/clip.wav',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(result).toEqual({ path: destPath, bytes: 9 });
      expect(await readFile(destPath, 'utf-8')).toBe('RIFFaudio');
    });

    it('throws on a non-2xx response', async () => {
      const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, body: null }));
      await expect(
        downloadToFile('https://s3.test/in/clip.wav', join(tempDir, 'x.wav'), { fetchImpl }),
      ).rejects.toThrow('Input download failed with HTTP 403');
    });

    it('rejects an empty download', async () => {
      const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: webBody('') }));
      await expect(
        downloadToFile('https://s3.test/in/clip.wav', join(tempDir, 'empty.wav'), { fetchImpl }),
      ).rejects.toThrow('Input download produced an empty file');
    });
  });

  describe('uploadKeyFromUrl', () => {
    it('strips the origin and query string', () => {
      expect(uploadKeyFromUrl('https://bucket.s3.test/speech/out/job-1.wav?X-Amz-Signature=abc'))
        .toBe('speech/out/job-1.wav');
    });
  });

  describe('uploadFile', () => {
    it('PUTs the file and returns the object key', async () => {
      const filePath = join(tempDir, 'out.wav');
      await writeFile(filePath, 'kokoro-bytes');
      const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));

      const result = await uploadFile(
        'https://bucket.s3.test/speech/out/job-1.wav?sig=1',
        filePath,
        { fetchImpl },
      );

      expect(result).toEqual({ uploadedKey: 'speech/out/job-1.wav', bytes: 12 });
      const [, init] = fetchImpl.mock.calls[0];
      expect(init.method).toBe('PUT');
      expect(init.headers['content-type']).toBe('audio/wav');
      expect(init.headers['content-length']).toBe('12');
      expect(init.body.toString('utf-8')).toBe('kokoro-bytes');
    });

    it('retries up to three times and succeeds on the third', async () => {
      const filePath = join(tempDir, 'out.wav');
      await writeFile(filePath, 'abc');
      const fetchImpl = vi.fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({ ok: true, status: 200 });

      const result = await uploadFile('https://bucket.s3.test/out/a.wav', filePath, {
        fetchImpl,
        retryDelayMs: 1,
      });

      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(result.uploadedKey).toBe('out/a.wav');
    });

    it('gives up after three failures', async () => {
      const filePath = join(tempDir, 'out.wav');
      await writeFile(filePath, 'abc');
      const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }));

      await expect(
        uploadFile('https://bucket.s3.test/out/a.wav', filePath, { fetchImpl, retryDelayMs: 1 }),
      ).rejects.toThrow('Upload failed after 3 attempts: Upload failed with HTTP 503');
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    });
  });
});
