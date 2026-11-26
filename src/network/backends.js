import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, open, readFile, stat } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config/index.js';
import { drama3TtsService as defaultDrama3Service } from '../services/drama3Tts.js';
import { nemotronService as defaultNemotronService } from '../services/nemotron.js';
import { transcriptionService as defaultTranscriptionService } from '../services/transcription.js';
import { convertWavFile } from '../utils/audioFormat.js';
import { sniffAudioFormat } from '../utils/audioValidation.js';
import { preWarmDaemon } from '../utils/preWarm.js';
import { MEDIA_DEMUXERS } from './artifacts.js';
import {
  buildLocalWorkerModels,
  filterModelsByAllowlist,
  VOICE_SUPERNET_MODELS,
} from './capabilities.js';

const execFileAsync = promisify(execFile);
const SPEAKER_TAG_GLOBAL_RE = /\s*<spk:\d+>\s*/gi;
const SPEAKER_TAG_DETECT_RE = /<spk:\d+>/i;
const SENTENCE_TERMINATOR_RE = /[.!?。！？…]["'”’)\]]*$/;
const HTTP_UPLOAD_RECOMPRESS_THRESHOLD_BYTES = 24 * 1024 * 1024;

const MIME_BY_EXT = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  webm: 'audio/webm',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
};

/**
 * Simple FIFO async mutex for services like `TranscriptionService` that multiplex
 * requests over stdin/stdout without an internal `DaemonRequestQueue`.
 */
export class SerialQueue {
  constructor() {
    this._tail = Promise.resolve();
  }

  run(fn) {
    const result = this._tail.then(() => fn());
    this._tail = result.catch(() => {});
    return result;
  }
}

export function stripSpeakerTags(value) {
  return String(value || '')
    .replace(SPEAKER_TAG_GLOBAL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeSpeakerLabel(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const str = String(raw).trim();
  if (/^S\d{2,}$/.test(str)) return str;
  const match = /(\d+)/.exec(str);
  if (!match) return str;
  return `S${String(Number.parseInt(match[1], 10) + 1).padStart(2, '0')}`;
}

const roundTimestamp = (value) => (
  typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(3)) : 0
);

export function groupWordsIntoSentences(words) {
  const sentences = [];
  let current = null;

  for (const item of words) {
    const wordText = stripSpeakerTags(item.word ?? item.text ?? '');
    if (!wordText) continue;
    const speaker = normalizeSpeakerLabel(item.speaker);
    const start = roundTimestamp(item.start);
    const end = roundTimestamp(item.end);

    if (!current || current.speaker !== speaker) {
      current = {
        start,
        end,
        text: wordText,
        ...(speaker ? { speaker } : {}),
      };
      sentences.push(current);
    } else {
      current.text = `${current.text} ${wordText}`;
      current.end = Math.max(current.end, end);
    }

    if (SENTENCE_TERMINATOR_RE.test(wordText)) {
      current = null;
    }
  }

  return sentences.map((seg, index) => ({ id: index, ...seg }));
}

/**
 * Normalize Parakeet or Nemotron raw daemon / HTTP output into the canonical
 * Sogni STT JSON artifact schema (`application/json`, version 1).
 */
export function buildCanonicalTranscript({
  workflowId,
  rawResult,
  audioSeconds = 0,
  requestedTimestamps = 'sentence',
  diarize = false,
}) {
  const granularity = ['none', 'sentence', 'word'].includes(requestedTimestamps)
    ? requestedTimestamps
    : 'sentence';

  const rawItems = Array.isArray(rawResult?.timestamps) ? rawResult.timestamps : [];
  const rawSpeakerTurns = Array.isArray(rawResult?.segments) ? rawResult.segments : [];

  let rawText = typeof rawResult?.text === 'string'
    ? rawResult.text
    : typeof rawResult?.transcript === 'string'
      ? rawResult.transcript
      : '';

  if (!rawText && rawItems.length > 0) {
    rawText = rawItems.map((entry) => String(entry?.word ?? entry?.text ?? '').trim()).filter(Boolean).join(' ');
  }

  const cleanText = stripSpeakerTags(rawText);
  const hasRawSpeakerTags = SPEAKER_TAG_DETECT_RE.test(rawText);

  let words = [];
  let segments = [];

  if (granularity === 'word' && rawItems.length > 0) {
    words = rawItems
      .map((entry) => {
        const word = stripSpeakerTags(entry?.word ?? entry?.text ?? '');
        if (!word) return null;
        const speaker = diarize ? normalizeSpeakerLabel(entry?.speaker) : undefined;
        return {
          word,
          start: roundTimestamp(entry?.start),
          end: roundTimestamp(entry?.end),
          ...(speaker ? { speaker } : {}),
        };
      })
      .filter(Boolean);
    segments = groupWordsIntoSentences(words);
  } else if (granularity === 'sentence' && rawItems.length > 0) {
    segments = rawItems
      .map((entry) => {
        const text = stripSpeakerTags(entry?.text ?? entry?.word ?? '');
        if (!text) return null;
        const speaker = diarize ? normalizeSpeakerLabel(entry?.speaker) : undefined;
        return {
          start: roundTimestamp(entry?.start),
          end: roundTimestamp(entry?.end),
          text,
          ...(speaker ? { speaker } : {}),
        };
      })
      .filter(Boolean)
      .map((seg, index) => ({ id: index, ...seg }));
  } else if (diarize && rawSpeakerTurns.length > 0) {
    segments = rawSpeakerTurns
      .map((turn) => {
        const text = stripSpeakerTags(turn?.text ?? '');
        if (!text) return null;
        const speaker = normalizeSpeakerLabel(turn?.speaker);
        return {
          start: typeof turn?.start === 'number' ? roundTimestamp(turn.start) : 0,
          end: typeof turn?.end === 'number' ? roundTimestamp(turn.end) : roundTimestamp(audioSeconds),
          text,
          ...(speaker ? { speaker } : {}),
        };
      })
      .filter(Boolean)
      .map((seg, index) => ({ id: index, ...seg }));
  }

  let resolvedDuration = Number(audioSeconds) || Number(rawResult?.metrics?.audioSeconds) || 0;
  if (!(resolvedDuration > 0) && segments.length > 0) {
    resolvedDuration = segments[segments.length - 1].end || 0;
  }

  const finishReason = rawResult?.finishReason || rawResult?.finish_reason || 'stop';
  const complete = rawResult?.complete !== undefined
    ? Boolean(rawResult.complete)
    : finishReason === 'stop';
  const diarized = Boolean(diarize && segments.length > 0);

  return {
    version: 1,
    model: workflowId,
    text: cleanText,
    ...(diarize || hasRawSpeakerTags ? { rawText } : {}),
    duration: roundTimestamp(resolvedDuration),
    language: rawResult?.language || 'auto',
    diarized,
    timestampGranularity: granularity,
    segments,
    words,
    complete,
    finishReason,
  };
}

const tagInvalidInput = (message, cause) => {
  const err = new Error(message, cause ? { cause } : undefined);
  err.invalidInput = true;
  return err;
};

export class LocalVoiceBackend {
  constructor({
    cfg = config,
    drama3Service = defaultDrama3Service,
    transcriptionService = defaultTranscriptionService,
    nemotronService = defaultNemotronService,
    allowlist = null,
    ownsDaemons = true,
    execFileImpl = execFileAsync,
    logger = console,
  } = {}) {
    this.mode = 'local';
    this.cfg = cfg;
    this.drama3Service = drama3Service;
    this.transcriptionService = transcriptionService;
    this.nemotronService = nemotronService;
    this.allowlist = allowlist;
    this.ownsDaemons = ownsDaemons;
    this.execFileImpl = execFileImpl;
    this.logger = logger;
    this.parakeetQueue = new SerialQueue();
  }

  async discoverModels() {
    return buildLocalWorkerModels(this.cfg, { allowlist: this.allowlist });
  }

  async preWarm(models) {
    const engines = new Set((models || []).map((m) => m.engine));
    const tasks = [];
    if (engines.has('parakeet') && this.transcriptionService?.initialize) {
      tasks.push(preWarmDaemon(
        'Parakeet transcription daemon',
        () => this.transcriptionService.initialize(),
        { retryAfterMs: 20_000 },
      ));
    }
    if (engines.has('nemotron') && this.nemotronService?.initialize) {
      tasks.push(preWarmDaemon('Nemotron daemon', () => this.nemotronService.initialize()));
    }
    if (engines.has('drama3') && this.drama3Service?.initialize) {
      tasks.push(preWarmDaemon('Fish Drama 3 TTS daemon', () => this.drama3Service.initialize()));
    }
    await Promise.all(tasks);
  }

  async transcribe({
    engine,
    audioPath,
    timestamps = true,
    wordTimestamps = false,
    diarize = false,
    hotwords = undefined,
    prompt = undefined,
    signal = undefined,
  }) {
    if (engine === 'parakeet') {
      if (signal?.aborted) {
        const abortErr = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      return this.parakeetQueue.run(() => {
        if (signal?.aborted) {
          const abortErr = new Error('The operation was aborted');
          abortErr.name = 'AbortError';
          throw abortErr;
        }
        return this.transcriptionService.transcribe(audioPath, {
          timestamps: Boolean(timestamps || wordTimestamps),
          wordTimestamps: Boolean(wordTimestamps),
          signal,
        });
      });
    }

    if (engine === 'nemotron') {
      const mlxBackend = this.cfg?.nemotron?.backend === 'mlx';
      try {
        return await this.nemotronService.transcribe(audioPath, {
          timestamps: mlxBackend ? false : Boolean(timestamps || wordTimestamps),
          wordTimestamps: mlxBackend ? false : Boolean(wordTimestamps),
          diarize: Boolean(diarize),
          hotwords,
          prompt,
          signal,
        });
      } catch (error) {
        if (error?.output?.statusCode === 400 || /^invalid input:/i.test(error?.message || '')) {
          throw tagInvalidInput(error.message, error);
        }
        throw error;
      }
    }

    throw new Error(`Unsupported local STT engine: "${engine}"`);
  }

  async transcribeReferenceAudio(wavPath, { signal } = {}) {
    let rawResult;
    if (this.cfg?.transcription?.enabled && this.transcriptionService) {
      rawResult = await this.transcribe({
        engine: 'parakeet',
        audioPath: wavPath,
        timestamps: false,
        wordTimestamps: false,
        signal,
      });
    } else if (this.cfg?.nemotron?.enabled && this.nemotronService) {
      rawResult = await this.transcribe({
        engine: 'nemotron',
        audioPath: wavPath,
        timestamps: false,
        wordTimestamps: false,
        diarize: false,
        signal,
      });
    } else {
      throw tagInvalidInput(
        'referenceText is required when no local transcription engine is enabled',
      );
    }

    const transcript = stripSpeakerTags(rawResult?.text);
    if (!transcript) {
      throw tagInvalidInput(
        'Could not auto-transcribe reference audio: no speech detected. Provide referenceText explicitly.',
      );
    }
    return transcript;
  }

  async synthesizeDrama3({
    text,
    referenceWavPath = null,
    referenceText = '',
    outputFormat = 'mp3',
    tempDir,
    signal = undefined,
  }) {
    const wavPath = join(tempDir, 'drama3-output.wav');
    let synthesisResult;

    try {
      if (referenceWavPath) {
        let resolvedText = String(referenceText || '').trim();
        if (!resolvedText) {
          resolvedText = await this.transcribeReferenceAudio(referenceWavPath, { signal });
        }
        // Drama 3 uses engine-configured generation defaults.
        synthesisResult = await this.drama3Service.generateWithReference(text, {
          referenceAudioPath: referenceWavPath,
          referenceText: resolvedText,
          outputPath: wavPath,
          signal,
        });
      } else {
        synthesisResult = await this.drama3Service.generate(text, {
          outputPath: wavPath,
          signal,
        });
      }
    } catch (error) {
      if (/^invalid input:/i.test(error?.message || '')) {
        throw tagInvalidInput(error.message, error);
      }
      throw error;
    }

    const converted = await convertWavFile(wavPath, outputFormat, {
      outputPath: outputFormat === 'wav' ? wavPath : join(tempDir, `drama3-output.${outputFormat}`),
      signal,
      execFileImpl: this.execFileImpl,
    });
    const buffer = await readFile(converted.outputPath);
    if (buffer.length === 0) {
      throw new Error('Drama 3 synthesis produced empty audio');
    }

    return {
      buffer,
      contentType: converted.contentType,
      extension: converted.extension,
      duration: synthesisResult?.duration ?? null,
      finishReason: synthesisResult?.finishReason || 'stop',
    };
  }

  async shutdown() {
    if (!this.ownsDaemons) return;
    await Promise.allSettled([
      this.transcriptionService?.shutdown?.(),
      this.nemotronService?.shutdown?.(),
      this.drama3Service?.shutdown?.(),
    ]);
  }
}

export class HttpVoiceBackend {
  constructor({
    apiUrl = process.env.SOGNI_VOICE_API_URL || 'http://127.0.0.1:3000',
    apiKey = process.env.SOGNI_VOICE_API_KEY || config.auth?.apiKey || '',
    allowlist = null,
    fetchImpl = fetch,
    execFileImpl = execFileAsync,
    getActiveRequests = () => 0,
    logger = console,
  } = {}) {
    this.mode = 'http';
    this.apiUrl = String(apiUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    this.apiKey = String(apiKey || '').trim();
    this.allowlist = allowlist;
    this.fetchImpl = fetchImpl;
    this.execFileImpl = execFileImpl;
    this.getActiveRequests = getActiveRequests;
    this.logger = logger;
    this.capabilities = {
      parakeetEnabled: false,
      nemotronEnabled: false,
      nemotronSupportsTimestamps: true,
      drama3Enabled: false,
    };
  }

  _authHeaders(extra = {}) {
    return {
      ...(this.apiKey ? { 'X-API-Key': this.apiKey } : {}),
      ...extra,
    };
  }

  async discoverModels() {
    const discovered = [];

    const sttRes = await this.fetchImpl(`${this.apiUrl}/transcription/models`, {
      method: 'GET',
      redirect: 'error',
      headers: this._authHeaders({ Accept: 'application/json' }),
    });
    if (!sttRes.ok) {
      throw new Error(
        `Failed to query ${this.apiUrl}/transcription/models: HTTP ${sttRes.status}`,
      );
    }
    const sttPayload = await sttRes.json();
    const sttModels = Array.isArray(sttPayload?.models) ? sttPayload.models : [];

    const parakeetEntry = sttModels.find((m) => m?.id === 'parakeet' && m?.enabled);
    const nemotronEntry = sttModels.find((m) => m?.id === 'nemotron' && m?.enabled);

    this.capabilities.parakeetEnabled = Boolean(parakeetEntry);
    this.capabilities.nemotronEnabled = Boolean(nemotronEntry);
    if (nemotronEntry) {
      this.capabilities.nemotronSupportsTimestamps = (
        Array.isArray(nemotronEntry.timestamps) && nemotronEntry.timestamps.length > 0
      );
    }

    const drama3Res = await this.fetchImpl(`${this.apiUrl}/drama3-tts/status`, {
      method: 'GET',
      redirect: 'error',
      headers: this._authHeaders({ Accept: 'application/json' }),
    });
    if (drama3Res.ok) {
      this.capabilities.drama3Enabled = true;
    } else if (drama3Res.status !== 404) {
      throw new Error(
        `Failed to query ${this.apiUrl}/drama3-tts/status: HTTP ${drama3Res.status}`,
      );
    } else {
      this.capabilities.drama3Enabled = false;
    }

    if (this.capabilities.drama3Enabled && Number(this.getActiveRequests?.() ?? 0) === 0) {
      await this.sweepStaleEphemeralClones();
    }

    if (this.capabilities.drama3Enabled) {
      discovered.push(VOICE_SUPERNET_MODELS.find((m) => m.id === 'fish_drama_3_nvfp4'));
    }
    if (this.capabilities.parakeetEnabled) {
      discovered.push(VOICE_SUPERNET_MODELS.find((m) => m.id === 'parakeet_tdt_0.6b_v3_bf16'));
    }
    if (this.capabilities.nemotronEnabled) {
      discovered.push(
        VOICE_SUPERNET_MODELS.find((m) => m.id === 'nemotron_3.5_transcribe_30b_a4b_nvfp4'),
      );
    }

    return filterModelsByAllowlist(discovered.filter(Boolean), this.allowlist);
  }

  async sweepStaleEphemeralClones() {
    if (Number(this.getActiveRequests?.() ?? 0) > 0) return 0;
    try {
      const voicesRes = await this.fetchImpl(`${this.apiUrl}/drama3-tts/voices`, {
        method: 'GET',
        redirect: 'error',
        headers: this._authHeaders({ Accept: 'application/json' }),
      });
      if (!voicesRes?.ok) return 0;
      const body = await voicesRes.json().catch(() => ({}));
      const clones = Array.isArray(body?.clones) ? body.clones : [];
      const staleIds = clones.filter(
        (id) => typeof id === 'string' && /^__ephemeral_[A-Za-z0-9_-]{1,88}$/.test(id),
      );
      let swept = 0;
      for (const cloneId of staleIds) {
        if (Number(this.getActiveRequests?.() ?? 0) > 0) break;
        try {
          const delRes = await this.fetchImpl(
            `${this.apiUrl}/drama3-tts/voices/clone/${encodeURIComponent(cloneId)}`,
            {
              method: 'DELETE',
              redirect: 'error',
              headers: this._authHeaders(),
            },
          );
          if (delRes?.ok) swept += 1;
        } catch {
          // Best-effort cleanup.
        }
      }
      return swept;
    } catch {
      return 0;
    }
  }

  async preWarm() {
    // Resident GPU daemons are already warm inside the target sogni-voice API service.
  }

  async _prepareSttUpload(audioPath, tempDir, signal) {
    const fh = await open(audioPath, 'r');
    let detected = null;
    try {
      const headBytes = Buffer.alloc(16);
      await fh.read(headBytes, 0, 16, 0);
      detected = sniffAudioFormat(headBytes);
    } finally {
      await fh.close();
    }

    const { size } = await stat(audioPath);
    if (detected && size <= HTTP_UPLOAD_RECOMPRESS_THRESHOLD_BYTES) {
      const normalizedPath = audioPath.endsWith(`.${detected}`)
        ? audioPath
        : join(tempDir, `stt-upload.${detected}`);
      if (normalizedPath !== audioPath) {
        await copyFile(audioPath, normalizedPath);
      }
      return {
        path: normalizedPath,
        filename: `input.${detected}`,
        mimeType: MIME_BY_EXT[detected] || 'application/octet-stream',
      };
    }

    // Large uncompressed WAVs (>24 MB) or exotic containers are re-encoded to compact
    // 16kHz mono Opus-in-Ogg so `/transcribe`'s default 25 MB multipart ceiling is respected.
    const oggPath = resolvePath(join(tempDir, 'stt-upload.ogg'));
    await this.execFileImpl(
      'ffmpeg',
      [
        '-nostdin', '-y', '-loglevel', 'error',
        '-protocol_whitelist', 'file,pipe',
        '-format_whitelist', MEDIA_DEMUXERS,
        '-i', resolvePath(audioPath),
        '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '32k',
        '--',
        oggPath,
      ],
      { timeout: 180_000, signal },
    );
    return {
      path: oggPath,
      filename: 'input.ogg',
      mimeType: 'audio/ogg',
    };
  }

  async transcribe({
    engine,
    audioPath,
    tempDir,
    timestamps = true,
    wordTimestamps = false,
    diarize = false,
    hotwords = undefined,
    prompt = undefined,
    signal = undefined,
  }) {
    const upload = await this._prepareSttUpload(audioPath, tempDir, signal);
    const fileBuffer = await readFile(upload.path);
    const form = new FormData();
    form.append('file', new Blob([fileBuffer], { type: upload.mimeType }), upload.filename);
    form.append('engine', engine);

    const allowTimestamps = engine !== 'nemotron' || this.capabilities.nemotronSupportsTimestamps;
    const wantWord = Boolean(allowTimestamps && wordTimestamps);
    const wantSentence = Boolean(allowTimestamps && (timestamps || wordTimestamps));

    form.append('timestamps', wantSentence ? 'true' : 'false');
    form.append('wordTimestamps', wantWord ? 'true' : 'false');

    if (engine === 'nemotron') {
      // Explicitly pass 'true' or 'false': omitting `diarize` on `/transcribe` defaults to true!
      form.append('diarize', diarize ? 'true' : 'false');
      if (hotwords) form.append('hotwords', hotwords);
      if (prompt) form.append('prompt', prompt);
    } else {
      form.append('diarize', 'false');
    }

    const response = await this.fetchImpl(`${this.apiUrl}/transcribe`, {
      method: 'POST',
      redirect: 'error',
      headers: this._authHeaders({ Accept: 'application/json' }),
      body: form,
      signal,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload?.message || payload?.error || `HTTP ${response.status}`;
      if (response.status === 400 || response.status === 415) {
        throw tagInvalidInput(message);
      }
      throw new Error(`HTTP /transcribe (${engine}) failed with ${response.status}: ${message}`);
    }

    const timestampsArray = Array.isArray(payload.timestamps) ? payload.timestamps : undefined;
    const reconstructedText = typeof payload.transcript === 'string'
      ? payload.transcript
      : Array.isArray(timestampsArray)
        ? timestampsArray.map((item) => String(item?.text ?? item?.word ?? '').trim()).filter(Boolean).join(' ')
        : '';

    return {
      text: reconstructedText,
      timestamps: timestampsArray,
      segments: payload.segments,
      finishReason: payload.finishReason || 'stop',
      complete: payload.complete !== undefined ? payload.complete : true,
      metrics: payload.metrics,
    };
  }

  async transcribeReferenceAudio(wavPath, { tempDir, signal } = {}) {
    const engine = this.capabilities.parakeetEnabled
      ? 'parakeet'
      : this.capabilities.nemotronEnabled
        ? 'nemotron'
        : 'parakeet';

    const result = await this.transcribe({
      engine,
      audioPath: wavPath,
      tempDir,
      timestamps: false,
      wordTimestamps: false,
      diarize: false,
      signal,
    });

    const transcript = stripSpeakerTags(result?.text);
    if (!transcript) {
      throw tagInvalidInput(
        'Could not auto-transcribe reference audio: no speech detected. Provide referenceText explicitly.',
      );
    }
    return transcript;
  }

  async _parseErrorMessage(response, fallback) {
    try {
      const text = await response.text();
      if (!text) return fallback;
      try {
        const parsed = JSON.parse(text);
        return parsed.message || parsed.error || text;
      } catch {
        return text.slice(0, 300);
      }
    } catch {
      return fallback;
    }
  }

  async _generateViaEphemeralCloneFallback({ text, refWavBuffer, referenceText, signal }) {
    const cloneId = `__ephemeral_${randomUUID().replaceAll('-', '')}`;
    let created = false;
    try {
      const createForm = new FormData();
      createForm.append('audio', new Blob([refWavBuffer], { type: 'audio/wav' }), 'reference.wav');
      createForm.append('transcript', referenceText);
      createForm.append('cloneId', cloneId);

      const createRes = await this.fetchImpl(`${this.apiUrl}/drama3-tts/voices/clone`, {
        method: 'POST',
        redirect: 'error',
        headers: this._authHeaders(),
        body: createForm,
        signal,
      });
      if (!createRes.ok) {
        const msg = await this._parseErrorMessage(createRes, `HTTP ${createRes.status}`);
        if (createRes.status === 400 || createRes.status === 415) throw tagInvalidInput(msg);
        throw new Error(`Drama 3 ephemeral clone create failed (${createRes.status}): ${msg}`);
      }
      created = true;

      const genRes = await this.fetchImpl(
        `${this.apiUrl}/drama3-tts/voices/clone/${encodeURIComponent(cloneId)}/generate`,
        {
          method: 'POST',
          redirect: 'error',
          headers: this._authHeaders({ 'Content-Type': 'application/json' }),
          // Drama 3 uses engine-configured generation defaults.
          body: JSON.stringify({ text, format: 'wav' }),
          signal,
        },
      );
      if (!genRes.ok) {
        const msg = await this._parseErrorMessage(genRes, `HTTP ${genRes.status}`);
        if (genRes.status === 400) throw tagInvalidInput(msg);
        throw new Error(`Drama 3 ephemeral clone synthesis failed (${genRes.status}): ${msg}`);
      }

      const wavBytes = Buffer.from(await genRes.arrayBuffer());
      const finishReason = genRes.headers?.get?.('x-finish-reason') || 'stop';
      return { wavBytes, finishReason };
    } finally {
      if (created) {
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            const delRes = await this.fetchImpl(
              `${this.apiUrl}/drama3-tts/voices/clone/${encodeURIComponent(cloneId)}`,
              {
                method: 'DELETE',
                redirect: 'error',
                headers: this._authHeaders(),
              },
            );
            if (delRes?.ok || delRes?.status === 404) break;
            throw new Error(`HTTP ${delRes?.status || 'unknown'}`);
          } catch (cleanupError) {
            if (attempt < 3) {
              await new Promise((r) => setTimeout(r, 100 * attempt));
            } else {
              this.logger.warn?.(
                `[voice-worker] Failed to delete ephemeral clone ${cloneId}: ${cleanupError.message}`,
              );
            }
          }
        }
      }
    }
  }

  async synthesizeDrama3({
    text,
    referenceWavPath = null,
    referenceText = '',
    outputFormat = 'mp3',
    tempDir,
    signal = undefined,
  }) {
    let wavBytes;
    let finishReason = 'stop';

    if (!referenceWavPath) {
      const response = await this.fetchImpl(`${this.apiUrl}/drama3-tts`, {
        method: 'POST',
        redirect: 'error',
        headers: this._authHeaders({ 'Content-Type': 'application/json' }),
        // Request WAV from the server and transcode locally so un-restarted containers
        // (which only accept wav/opus/buffer) serve mp3/flac jobs seamlessly.
        body: JSON.stringify({ text, format: 'wav' }),
        signal,
      });
      if (!response.ok) {
        const msg = await this._parseErrorMessage(response, `HTTP ${response.status}`);
        if (response.status === 400) throw tagInvalidInput(msg);
        throw new Error(`HTTP /drama3-tts failed (${response.status}): ${msg}`);
      }
      wavBytes = Buffer.from(await response.arrayBuffer());
      finishReason = response.headers?.get?.('x-finish-reason') || 'stop';
    } else {
      let resolvedReferenceText = String(referenceText || '').trim();
      if (!resolvedReferenceText) {
        resolvedReferenceText = await this.transcribeReferenceAudio(referenceWavPath, {
          tempDir,
          signal,
        });
      }

      const refWavBuffer = await readFile(referenceWavPath);
      const form = new FormData();
      form.append('file', new Blob([refWavBuffer], { type: 'audio/wav' }), 'reference.wav');
      form.append('text', text);
      form.append('referenceText', resolvedReferenceText);
      form.append('format', 'wav');

      const response = await this.fetchImpl(`${this.apiUrl}/drama3-tts/generate-with-reference`, {
        method: 'POST',
        redirect: 'error',
        headers: this._authHeaders(),
        body: form,
        signal,
      });

      if (response.ok) {
        wavBytes = Buffer.from(await response.arrayBuffer());
        finishReason = response.headers?.get?.('x-finish-reason') || 'stop';
      } else if (response.status === 404) {
        const msg = await this._parseErrorMessage(response, 'Not Found');
        if (/not enabled/i.test(msg)) {
          throw new Error(`Drama 3 TTS is not enabled on ${this.apiUrl}: ${msg}`);
        }
        // Target server predates /drama3-tts/generate-with-reference: use zero-downtime
        // ephemeral clone fallback and delete in `finally`.
        const fallback = await this._generateViaEphemeralCloneFallback({
          text,
          refWavBuffer,
          referenceText: resolvedReferenceText,
          signal,
        });
        wavBytes = fallback.wavBytes;
        finishReason = fallback.finishReason;
      } else {
        const msg = await this._parseErrorMessage(response, `HTTP ${response.status}`);
        if (response.status === 400 || response.status === 415) throw tagInvalidInput(msg);
        throw new Error(`HTTP /drama3-tts/generate-with-reference failed (${response.status}): ${msg}`);
      }
    }

    if (!wavBytes || wavBytes.length === 0) {
      throw new Error('Drama 3 HTTP synthesis returned empty audio');
    }

    if (outputFormat === 'wav') {
      return {
        buffer: wavBytes,
        contentType: 'audio/wav',
        extension: 'wav',
        duration: null,
        finishReason,
      };
    }

    const wavPath = join(tempDir, 'drama3-http.wav');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(wavPath, wavBytes);
    const converted = await convertWavFile(wavPath, outputFormat, {
      outputPath: join(tempDir, `drama3-http.${outputFormat}`),
      signal,
      execFileImpl: this.execFileImpl,
    });
    const convertedBytes = await readFile(converted.outputPath);
    return {
      buffer: convertedBytes,
      contentType: converted.contentType,
      extension: converted.extension,
      duration: null,
      finishReason,
    };
  }

  async shutdown() {
    // Stateless HTTP sidecar holds no child processes.
  }
}

export function createVoiceBackend({
  mode = 'local',
  cfg = config,
  apiUrl = process.env.SOGNI_VOICE_API_URL || 'http://127.0.0.1:3000',
  apiKey = process.env.SOGNI_VOICE_API_KEY || config.auth?.apiKey || '',
  allowlist = null,
  ownsDaemons = true,
  fetchImpl = fetch,
  execFileImpl = execFileAsync,
  getActiveRequests = () => 0,
  logger = console,
} = {}) {
  if (mode === 'http') {
    return new HttpVoiceBackend({
      apiUrl,
      apiKey,
      allowlist,
      fetchImpl,
      execFileImpl,
      getActiveRequests,
      logger,
    });
  }
  return new LocalVoiceBackend({
    cfg,
    allowlist,
    ownsDaemons,
    execFileImpl,
    logger,
  });
}
