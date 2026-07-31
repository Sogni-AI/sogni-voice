import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { SogniSocketClient } from '../../../src/network/socketClient.js';
import { SPEECH_MODEL_CATALOG, buildWorkerInfo, detectHardwareInfo } from '../../../src/network/capabilities.js';
import { buildUserAgent } from '../../../src/network/config.js';
import { requestMediaDownloadUrl, requestMediaUploadUrl } from '../../../src/network/apiClient.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACT = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/standard-worker-contract.v2.json'), 'utf-8'),
);

// This suite exists because the broker lives in another repo: every assertion
// here is a field name or value the sogni-socket standard lane actually reads.
// If one of these fails, the wire is broken no matter what the unit tests say.
describe('standard worker wire contract v2', () => {
  it('sends exactly the contract upgrade headers', () => {
    const client = new SogniSocketClient({
      url: 'ws://test',
      apiKey: 'k',
      nftTokenId: '1',
      workerId: 'W',
      userAgent: buildUserAgent(),
    });
    const headers = client.buildHeaders();

    for (const required of CONTRACT.upgradeHeaders.required) {
      expect(headers[required], `missing header ${required}`).toBeTruthy();
    }
    for (const forbidden of CONTRACT.upgradeHeaders.forbidden) {
      expect(headers[forbidden], `forbidden header ${forbidden}`).toBeUndefined();
    }
    expect(headers['client-type']).toBe(CONTRACT.upgradeHeaders.clientType);
    expect(headers['user-agent']).toBe(CONTRACT.upgradeHeaders.userAgent);
  });

  it('advertises only ids the broker catalog defines', () => {
    expect(SPEECH_MODEL_CATALOG.map((m) => m.id)).toEqual(CONTRACT.workerInfo.catalogIds);
  });

  it('registers with every contract-required workerInfo field and passes the fast gates', () => {
    const info = buildWorkerInfo({
      speechModels: SPEECH_MODEL_CATALOG,
      hardwareRating: 70,
      hardwareInfo: detectHardwareInfo({
        osImpl: {
          cpus: () => [{ model: 'Apple M2 Ultra' }],
          totalmem: () => 192 * 1024 ** 3,
        },
      }),
    });

    for (const field of CONTRACT.workerInfo.requiredFields) {
      expect(info[field], `workerInfo.${field}`).toBeDefined();
    }
    for (const field of CONTRACT.workerInfo.hardwareInfoRequired) {
      expect(info.hardwareInfo[field], `hardwareInfo.${field}`).toBeTruthy();
    }
    const gates = CONTRACT.workerInfo.fastNetworkGates;
    expect(info.hardwareRating).toBeGreaterThanOrEqual(gates.hardwareRating);
    expect(info.hardwareInfo.ram).toBeGreaterThanOrEqual(gates.ram);
    expect(info.hardwareInfo.vram).toBeGreaterThanOrEqual(gates.vram);
    expect(info.workerModels.every((id) => typeof id === 'string')).toBe(true);
  });

  it('builds the media upload URL with exactly the whitelisted params', async () => {
    let requested;
    const fetchImpl = vi.fn(async (url) => {
      requested = new URL(url);
      return { ok: true, json: async () => ({ status: 'success', data: { uploadUrl: 'https://r2/put' } }) };
    });
    await requestMediaUploadUrl({
      apiUrl: 'https://api-staging.sogni.ai',
      jobId: 'JOB',
      imgId: 'IMG',
      contentType: 'audio/mpeg',
      fetchImpl,
    });

    expect(requested.pathname).toBe(CONTRACT.mediaApi.uploadUrlPath);
    // forbidNonWhitelisted is on server-side: extra params are a 400.
    expect([...requested.searchParams.keys()].sort()).toEqual([...CONTRACT.mediaApi.uploadUrlParams].sort());
    expect(requested.searchParams.get('type')).toBe(CONTRACT.mediaApi.uploadType);
    expect(requested.searchParams.get('id')).toBe('IMG');
  });

  it('builds the media download URL with exactly the whitelisted params', async () => {
    let requested;
    const fetchImpl = vi.fn(async (url) => {
      requested = new URL(url);
      return { ok: true, json: async () => ({ status: 'success', data: { downloadUrl: 'https://r2/get' } }) };
    });
    await requestMediaDownloadUrl({
      apiUrl: 'https://api-staging.sogni.ai',
      jobId: 'JOB',
      fetchImpl,
    });

    expect(requested.pathname).toBe(CONTRACT.mediaApi.downloadUrlPath);
    expect([...requested.searchParams.keys()].sort()).toEqual([...CONTRACT.mediaApi.downloadUrlParams].sort());
    expect(requested.searchParams.get('type')).toBe(CONTRACT.mediaApi.inputType);
  });
});
