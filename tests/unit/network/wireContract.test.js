import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VOICE_SUPERNET_MODELS } from '../../../src/network/capabilities.js';
import { VoiceSupernetExecutor } from '../../../src/network/executor.js';
import { VoiceWorkerSupervisor } from '../../../src/network/supervisor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/speech-wire-contract.v1.json'), 'utf8'),
);

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.start = vi.fn(async () => {});
    this.close = vi.fn();
  }

  send(type, data) {
    this.sent.push({ type, data });
    return true;
  }
}

describe(`Sogni media-worker wire contract v${contract.version}`, () => {
  it('advertises only canonical model IDs in the contract', () => {
    for (const model of VOICE_SUPERNET_MODELS) {
      expect(contract.modelIds[model.task]).toContain(model.id);
    }
  });

  it('emits only sogni-socket media-worker frame types and jobState values', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'sogni-contract-'));
    const client = new FakeClient();
    const executor = new VoiceSupernetExecutor({
      workerModels: VOICE_SUPERNET_MODELS,
      backend: {
        transcribe: vi.fn(async () => ({
          text: 'Contract transcript.',
          timestamps: [{ start: 0, end: 1.5, text: 'Contract transcript.' }],
        })),
        synthesizeDrama3: vi.fn(),
      },
      apiUrl: 'https://api.sogni.test',
      tempFiles: {
        createTempDir: vi.fn(async () => tempDir),
        cleanup: vi.fn(async (dir) => rm(dir, { recursive: true, force: true })),
      },
      artifacts: {
        downloadReferenceAudio: vi.fn(),
        validateAndProbeAudio: vi.fn(),
        transcodeReferenceWav: vi.fn(),
        uploadJobArtifact: vi.fn(async (req) => ({
          uploadUrl: 'https://r2.sogni.test/out.json',
          uploadedKey: 'out.json',
          bytes: req.buffer.length,
          sha256: 'e'.repeat(64),
        })),
      },
    });

    const supervisor = new VoiceWorkerSupervisor({
      client,
      executor,
      workerModels: VOICE_SUPERNET_MODELS,
      hardwareRating: 70,
      hardwareInfo: { cpuBrand: 'ARM', gpuBrand: 'NVIDIA GB10', vram: 120, ram: 120 },
      logger: silentLogger,
    });

    await supervisor.start();
    client.emit('frame', 'authenticated', { ok: true });
    await supervisor.handleJobRequest({
      jobID: 'contract-1',
      imageId: 'img-contract-1',
      workflowId: 'parakeet_tdt_0.6b_v3_bf16',
      isTest: true,
      clientParams: { seed: 0 },
      assets: [],
    });

    for (const frame of client.sent) {
      expect(contract.frames).toContain(frame.type);
    }

    const jobStates = client.sent.filter((f) => f.type === 'jobState');
    expect(jobStates.map((f) => f.data[contract.jobStateField])).toEqual(contract.jobStateValues);
  });
});
