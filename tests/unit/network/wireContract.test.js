import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPEECH_MODEL_CATALOG } from '../../../src/network/capabilities.js';
import { SpeechExecutor } from '../../../src/network/executor.js';
import { SpeechWorkerSupervisor } from '../../../src/network/supervisor.js';

// The fixture is a byte-identical copy of the one committed to the socket repo:
// the two sides agree on it, or one of these suites fails. Everything asserted
// here is read from the fixture rather than restated, so a contract change is a
// one-file edit on each side and never a silent divergence.
const __dirname = dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/speech-wire-contract.v1.json'), 'utf8'),
);

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.connect = vi.fn();
    this.close = vi.fn();
  }

  send(type, data) {
    this.sent.push({ type, data });
    return true;
  }
}

const runSttJob = async () => {
  const speechModels = SPEECH_MODEL_CATALOG.filter((model) => model.task === 'stt');
  const executor = new SpeechExecutor({
    speechModels,
    maxConcurrentJobs: 1,
    transcriptionService: {
      transcribe: vi.fn(async () => ({
        text: 'contract transcript',
        rawOutput: '',
        timestamps: [{ start: 0, end: 1.5, text: 'contract transcript' }],
      })),
    },
    ttsService: { generate: vi.fn() },
    tempFiles: {
      createTempDir: vi.fn(async () => '/tmp/sogni-contract'),
      cleanup: vi.fn(async () => {}),
    },
    artifacts: {
      downloadToFile: vi.fn(async (url, destPath) => ({ path: destPath, bytes: 512 })),
      uploadFile: vi.fn(),
    },
  });

  const client = new FakeClient();
  const supervisor = new SpeechWorkerSupervisor({
    client,
    executor,
    speechModels,
    maxConcurrentJobs: 1,
    logger: silentLogger,
  });

  await supervisor.handleJobRequest({
    jobID: 'contract-1',
    projectID: 'proj-contract',
    jobType: 'speech',
    task: 'stt',
    modelID: speechModels[0].id,
    params: {},
    input: { url: 'https://s3.test/in/contract.wav' },
    output: null,
    timeoutMs: 30000,
  });

  return client.sent;
};

describe(`speech wire contract v${contract.version}`, () => {
  it('advertises only model ids the broker prices', () => {
    for (const model of SPEECH_MODEL_CATALOG) {
      expect(contract.modelIds[model.task]).toContain(model.id);
    }
  });

  it('sends only frame types the broker understands', async () => {
    const sent = await runSttJob();
    expect(sent.length).toBeGreaterThan(0);
    for (const frame of sent) {
      expect(contract.frames).toContain(frame.type);
    }
  });

  // The broker reads the state off the contract's field name and reaps a job whose
  // dispatch it never saw acknowledged, so both the key and its values are pinned.
  it('carries the job state on the contract field', async () => {
    const jobStates = (await runSttJob()).filter((frame) => frame.type === 'jobState');

    expect(jobStates.map((frame) => frame.data[contract.jobStateField]))
      .toEqual(contract.jobStateValues);
    for (const frame of jobStates) {
      expect(Object.keys(frame.data).sort()).toEqual(['jobID', contract.jobStateField].sort());
    }
  });

  it('reports the transcript as the contract type', async () => {
    const result = (await runSttJob()).find((frame) => frame.type === 'jobResult');

    expect(typeof result.data.transcript).toBe(contract.transcriptType);
    expect(result.data.transcript).toBe('contract transcript');
  });
});
