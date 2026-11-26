import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSyntheticTestWavBuffer } from '../../../src/utils/audioFormat.js';
import {
  HttpVoiceBackend,
  LocalVoiceBackend,
  SerialQueue,
  buildCanonicalTranscript,
  stripSpeakerTags,
} from '../../../src/network/backends.js';

describe('backends & canonical transcript builder', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'sogni-backends-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('buildCanonicalTranscript', () => {
    it('strips <spk:N> tags from text while preserving rawText and S01/S02 speaker labels on segments and words', () => {
      const canonical = buildCanonicalTranscript({
        workflowId: 'nemotron_3.5_transcribe_30b_a4b_nvfp4',
        rawResult: {
          text: '<spk:0> Hello there. <spk:1> General Kenobi!',
          finishReason: 'stop',
          complete: true,
          timestamps: [
            { text: 'Hello', start: 0.12, end: 0.64, speaker: 'S01' },
            { text: 'there.', start: 0.65, end: 1.48, speaker: 'S01' },
            { text: 'General', start: 1.80, end: 2.30, speaker: 'S02' },
            { text: 'Kenobi!', start: 2.31, end: 3.10, speaker: 'S02' },
          ],
        },
        audioSeconds: 3.25,
        requestedTimestamps: 'word',
        diarize: true,
      });

      expect(canonical).toEqual({
        version: 1,
        model: 'nemotron_3.5_transcribe_30b_a4b_nvfp4',
        text: 'Hello there. General Kenobi!',
        rawText: '<spk:0> Hello there. <spk:1> General Kenobi!',
        duration: 3.25,
        language: 'auto',
        diarized: true,
        timestampGranularity: 'word',
        segments: [
          { id: 0, start: 0.12, end: 1.48, text: 'Hello there.', speaker: 'S01' },
          { id: 1, start: 1.8, end: 3.1, text: 'General Kenobi!', speaker: 'S02' },
        ],
        words: [
          { word: 'Hello', start: 0.12, end: 0.64, speaker: 'S01' },
          { word: 'there.', start: 0.65, end: 1.48, speaker: 'S01' },
          { word: 'General', start: 1.8, end: 2.3, speaker: 'S02' },
          { word: 'Kenobi!', start: 2.31, end: 3.1, speaker: 'S02' },
        ],
        complete: true,
        finishReason: 'stop',
      });
    });

    it('omits rawText and speaker labels on non-diarized Parakeet sentence transcripts', () => {
      const canonical = buildCanonicalTranscript({
        workflowId: 'parakeet_tdt_0.6b_v3_bf16',
        rawResult: {
          text: 'Fast transcription on DGX Spark.',
          timestamps: [{ start: 0.1, end: 2.4, text: 'Fast transcription on DGX Spark.' }],
        },
        audioSeconds: 2.5,
        requestedTimestamps: 'sentence',
        diarize: false,
      });

      expect(canonical).toEqual({
        version: 1,
        model: 'parakeet_tdt_0.6b_v3_bf16',
        text: 'Fast transcription on DGX Spark.',
        duration: 2.5,
        language: 'auto',
        diarized: false,
        timestampGranularity: 'sentence',
        segments: [{ id: 0, start: 0.1, end: 2.4, text: 'Fast transcription on DGX Spark.' }],
        words: [],
        complete: true,
        finishReason: 'stop',
      });
      expect(canonical).not.toHaveProperty('rawText');
    });

    it('cleans speaker tags cleanly via stripSpeakerTags', () => {
      expect(stripSpeakerTags('  <spk:0> First speaker.  <spk:1>   Second speaker. '))
        .toBe('First speaker. Second speaker.');
    });
  });

  describe('LocalVoiceBackend', () => {
    it('serializes concurrent Parakeet transcribe calls 1-at-a-time and auto-transcribes Drama 3 reference audio', async () => {
      const order = [];
      let inFlight = 0;
      let maxObservedConcurrency = 0;

      const transcriptionService = {
        transcribe: vi.fn(async (path) => {
          inFlight += 1;
          maxObservedConcurrency = Math.max(maxObservedConcurrency, inFlight);
          order.push(`start:${path}`);
          await new Promise((r) => setTimeout(r, 20));
          order.push(`end:${path}`);
          inFlight -= 1;
          return { text: 'Spoken reference words.', rawOutput: '' };
        }),
      };

      const drama3Service = {
        generate: vi.fn(),
        generateWithReference: vi.fn(async (_text, options) => {
          await writeFile(options.outputPath, createSyntheticTestWavBuffer({ durationSeconds: 1 }));
          return { outputPath: options.outputPath, duration: 1.0, finishReason: 'stop' };
        }),
      };

      const execFileImpl = vi.fn(async (_cmd, args) => {
        const target = args[args.length - 1];
        await writeFile(target, Buffer.from('mp3-encoded-bytes'));
        return { stdout: '', stderr: '' };
      });

      const backend = new LocalVoiceBackend({
        cfg: {
          drama3Tts: { enabled: true },
          transcription: { enabled: true },
          nemotron: { enabled: false },
        },
        drama3Service,
        transcriptionService,
        execFileImpl,
      });

      const [r1, r2] = await Promise.all([
        backend.transcribe({ engine: 'parakeet', audioPath: '/tmp/a.wav' }),
        backend.transcribe({ engine: 'parakeet', audioPath: '/tmp/b.wav' }),
      ]);
      expect(maxObservedConcurrency).toBe(1);
      expect(order).toEqual(['start:/tmp/a.wav', 'end:/tmp/a.wav', 'start:/tmp/b.wav', 'end:/tmp/b.wav']);
      expect(r1.text).toBe('Spoken reference words.');
      expect(r2.text).toBe('Spoken reference words.');

      const refPath = join(tempDir, 'ref.wav');
      await writeFile(refPath, createSyntheticTestWavBuffer({ durationSeconds: 2 }));

      const synth = await backend.synthesizeDrama3({
        text: '[warmly] Cloned without explicit transcript.',
        referenceWavPath: refPath,
        referenceText: '',
        outputFormat: 'mp3',
        tempDir,
      });

      expect(synth.contentType).toBe('audio/mpeg');
      expect(synth.buffer.toString()).toBe('mp3-encoded-bytes');
      expect(drama3Service.generateWithReference).toHaveBeenCalledWith(
        '[warmly] Cloned without explicit transcript.',
        expect.objectContaining({
          referenceAudioPath: refPath,
          referenceText: 'Spoken reference words.',
        }),
      );
      const passedOpts = drama3Service.generateWithReference.mock.calls[0][1];
      expect(passedOpts).not.toHaveProperty('temperature');
      expect(passedOpts).not.toHaveProperty('maxTokens');
    });

    it('runs SerialQueue tasks strictly sequentially even after a rejected task', async () => {
      const queue = new SerialQueue();
      const events = [];
      await expect(queue.run(async () => {
        events.push('first');
        throw new Error('boom');
      })).rejects.toThrow('boom');
      await expect(queue.run(async () => {
        events.push('second');
        return 42;
      })).resolves.toBe(42);
      expect(events).toEqual(['first', 'second']);
    });
  });

  describe('HttpVoiceBackend (sidecar mode)', () => {
    it('discovers enabled models from /transcription/models and /drama3-tts/status and sweeps stale __ephemeral_ clones when idle', async () => {
      const deletedClones = [];
      const fetchImpl = vi.fn(async (url, init = {}) => {
        expect(init.redirect).toBe('error');
        if (url.endsWith('/transcription/models')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              models: [
                { id: 'parakeet', enabled: true, timestamps: ['sentence', 'word'] },
                { id: 'nemotron', enabled: true, timestamps: ['sentence', 'word'] },
              ],
            }),
          };
        }
        if (url.endsWith('/drama3-tts/status')) {
          return { ok: true, status: 200, json: async () => ({ model: 'drama-3-nvfp4-pruned' }) };
        }
        if (url.endsWith('/drama3-tts/voices')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              voices: ['default'],
              clones: ['Marvin', '__ephemeral_deadbeef1234'],
            }),
          };
        }
        if (init.method === 'DELETE' && url.includes('/drama3-tts/voices/clone/')) {
          deletedClones.push(url);
          return { ok: true, status: 200 };
        }
        throw new Error(`Unexpected URL ${url}`);
      });

      const backend = new HttpVoiceBackend({
        apiUrl: 'http://192.0.2.10:3000/',
        apiKey: 'secret-key',
        fetchImpl,
      });

      const models = await backend.discoverModels();
      expect(models.map((m) => m.id)).toEqual([
        'fish_drama_3_nvfp4',
        'parakeet_tdt_0.6b_v3_bf16',
        'nemotron_3.5_transcribe_30b_a4b_nvfp4',
      ]);
      expect(fetchImpl).toHaveBeenCalledWith(
        'http://192.0.2.10:3000/transcription/models',
        expect.objectContaining({
          redirect: 'error',
          headers: expect.objectContaining({ 'X-API-Key': 'secret-key' }),
        }),
      );
      expect(deletedClones).toEqual([
        'http://192.0.2.10:3000/drama3-tts/voices/clone/__ephemeral_deadbeef1234',
      ]);
    });

    it('uses stateless /drama3-tts/generate-with-reference when supported', async () => {
      const wav = createSyntheticTestWavBuffer({ durationSeconds: 1 });
      const refPath = join(tempDir, 'ref.wav');
      await writeFile(refPath, wav);

      const calls = [];
      const fetchImpl = vi.fn(async (url, init) => {
        calls.push({ url, method: init.method, body: init.body });
        if (url.endsWith('/transcribe')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ success: true, transcript: 'Auto Parakeet text.' }),
          };
        }
        if (url.endsWith('/drama3-tts/generate-with-reference')) {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ 'x-finish-reason': 'stop' }),
            arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength),
          };
        }
        throw new Error(`Unexpected URL ${url}`);
      });

      const backend = new HttpVoiceBackend({
        apiUrl: 'http://127.0.0.1:3000',
        apiKey: 'k',
        fetchImpl,
      });
      backend.capabilities.parakeetEnabled = true;

      const result = await backend.synthesizeDrama3({
        text: '[laughs] Stateless HTTP clone.',
        referenceWavPath: refPath,
        referenceText: '',
        outputFormat: 'wav',
        tempDir,
      });

      expect(result.contentType).toBe('audio/wav');
      expect(calls.map((c) => c.url)).toEqual([
        'http://127.0.0.1:3000/transcribe',
        'http://127.0.0.1:3000/drama3-tts/generate-with-reference',
      ]);
    });

    it('falls back to ephemeral __ephemeral_<uuid> clone create -> generate -> finally delete ONLY on 404', async () => {
      const wav = createSyntheticTestWavBuffer({ durationSeconds: 1 });
      const refPath = join(tempDir, 'ref.wav');
      await writeFile(refPath, wav);

      const calls = [];
      const fetchImpl = vi.fn(async (url, init) => {
        calls.push({ url, method: init.method });
        if (url.endsWith('/drama3-tts/generate-with-reference')) {
          return {
            ok: false,
            status: 404,
            text: async () => JSON.stringify({ statusCode: 404, error: 'Not Found', message: 'Not Found' }),
          };
        }
        if (url.endsWith('/drama3-tts/voices/clone') && init.method === 'POST') {
          return { ok: true, status: 200, json: async () => ({ success: true }) };
        }
        if (/\/drama3-tts\/voices\/clone\/__ephemeral_[a-f0-9]+\/generate$/.test(url)) {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ 'x-finish-reason': 'stop' }),
            arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength),
          };
        }
        if (/\/drama3-tts\/voices\/clone\/__ephemeral_[a-f0-9]+$/.test(url) && init.method === 'DELETE') {
          return { ok: true, status: 200, json: async () => ({ success: true }) };
        }
        throw new Error(`Unexpected request ${init.method} ${url}`);
      });

      const backend = new HttpVoiceBackend({
        apiUrl: 'http://127.0.0.1:3000',
        apiKey: 'k',
        fetchImpl,
      });

      const out = await backend.synthesizeDrama3({
        text: 'Zero downtime on dgx-spark-01.',
        referenceWavPath: refPath,
        referenceText: 'Provided transcript.',
        outputFormat: 'wav',
        tempDir,
      });

      expect(out.contentType).toBe('audio/wav');
      expect(calls).toHaveLength(4);
      expect(calls[0]).toEqual({ url: 'http://127.0.0.1:3000/drama3-tts/generate-with-reference', method: 'POST' });
      expect(calls[1]).toEqual({ url: 'http://127.0.0.1:3000/drama3-tts/voices/clone', method: 'POST' });
      expect(calls[2].url).toMatch(/\/drama3-tts\/voices\/clone\/__ephemeral_[a-f0-9]+\/generate$/);
      expect(calls[3].method).toBe('DELETE');
      expect(calls[3].url).toMatch(/\/drama3-tts\/voices\/clone\/__ephemeral_[a-f0-9]+$/);
    });

    it('still deletes ephemeral clone in finally when fallback synthesis fails', async () => {
      const wav = createSyntheticTestWavBuffer({ durationSeconds: 1 });
      const refPath = join(tempDir, 'ref.wav');
      await writeFile(refPath, wav);

      const deletedUrls = [];
      const fetchImpl = vi.fn(async (url, init) => {
        if (url.endsWith('/drama3-tts/generate-with-reference')) {
          return { ok: false, status: 404, text: async () => 'Not Found' };
        }
        if (url.endsWith('/drama3-tts/voices/clone') && init.method === 'POST') {
          return { ok: true, status: 200, json: async () => ({ success: true }) };
        }
        if (url.endsWith('/generate')) {
          return { ok: false, status: 500, text: async () => 'TensorFold error' };
        }
        if (init.method === 'DELETE') {
          deletedUrls.push(url);
          return { ok: true, status: 200 };
        }
        throw new Error(`Unexpected ${url}`);
      });

      const backend = new HttpVoiceBackend({
        apiUrl: 'http://127.0.0.1:3000',
        fetchImpl,
      });

      await expect(backend.synthesizeDrama3({
        text: 'Will fail synthesis.',
        referenceWavPath: refPath,
        referenceText: 'Transcript.',
        outputFormat: 'wav',
        tempDir,
      })).rejects.toThrow(/TensorFold error/);

      expect(deletedUrls).toHaveLength(1);
      expect(deletedUrls[0]).toMatch(/__ephemeral_[a-f0-9]+$/);
    });

    it('retries DELETE up to 3 attempts when ephemeral clone cleanup transiently fails', async () => {
      const wav = createSyntheticTestWavBuffer({ durationSeconds: 1 });
      const refPath = join(tempDir, 'ref-retry.wav');
      await writeFile(refPath, wav);

      let deleteCalls = 0;
      const fetchImpl = vi.fn(async (url, init) => {
        if (url.endsWith('/drama3-tts/generate-with-reference')) {
          return { ok: false, status: 404, text: async () => 'Not Found' };
        }
        if (url.endsWith('/drama3-tts/voices/clone') && init.method === 'POST') {
          return { ok: true, status: 200, json: async () => ({ success: true }) };
        }
        if (url.endsWith('/generate')) {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ 'x-finish-reason': 'stop' }),
            arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength),
          };
        }
        if (init.method === 'DELETE') {
          deleteCalls += 1;
          if (deleteCalls < 3) throw new Error('ECONNRESET');
          return { ok: true, status: 200 };
        }
        throw new Error(`Unexpected ${url}`);
      });

      const backend = new HttpVoiceBackend({ apiUrl: 'http://127.0.0.1:3000', fetchImpl });
      await backend.synthesizeDrama3({
        text: 'Cleanup retry test.',
        referenceWavPath: refPath,
        referenceText: 'Transcript.',
        outputFormat: 'wav',
        tempDir,
      });
      expect(deleteCalls).toBe(3);
    });
  });
});
