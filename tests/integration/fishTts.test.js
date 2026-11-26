import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const fishMocks = vi.hoisted(() => ({
  generate: vi.fn(),
  generateVoiceClone: vi.fn(),
  generateWithReference: vi.fn(),
  createVoiceClone: vi.fn(),
  deleteVoiceClone: vi.fn(),
  renameVoiceClone: vi.fn(),
  listVoiceClones: vi.fn(),
}));
const drama3Mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  generateVoiceClone: vi.fn(),
  generateWithReference: vi.fn(),
  listVoiceClones: vi.fn(),
}));
const sttMocks = vi.hoisted(() => ({
  parakeetTranscribe: vi.fn(),
  nemotronTranscribe: vi.fn(),
}));
const configState = vi.hoisted(() => ({
  transcriptionEnabled: false,
  nemotronEnabled: false,
}));
const processMocks = vi.hoisted(() => ({ ffprobeDuration: '5.0\n', ffprobeError: null, ffmpegError: null }));

const createFakeWavBuffer = () => {
  const buffer = Buffer.alloc(44);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(44100, 24);
  buffer.writeUInt32LE(88200, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(0, 40);
  return buffer;
};

vi.mock('node:child_process', () => ({
  execFile: vi.fn((command, args, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    if (String(command).includes('ffprobe')) {
      if (processMocks.ffprobeError) {
        cb?.(processMocks.ffprobeError, '', processMocks.ffprobeError.stderr || '');
        return;
      }
      cb?.(null, processMocks.ffprobeDuration, '');
      return;
    }
    if (processMocks.ffmpegError) {
      cb?.(processMocks.ffmpegError, '', processMocks.ffmpegError.stderr || '');
      return;
    }
    const outputPath = args[args.length - 1];
    writeFileSync(outputPath, createFakeWavBuffer());
    cb?.(null, '', '');
  }),
  spawn: vi.fn(),
}));

vi.mock('../../src/config/index.js', () => ({
  config: {
    server: { port: 3000, host: '127.0.0.1', corsOrigins: [] },
    auth: {
      enabled: false,
      apiKey: null,
      excludePaths: ['/health', '/auth/status'],
      dangerouslyAllowImports: false,
      dangerouslyAllowVoiceCloning: true,
    },
    tts: {
      enabled: false, modelId: 'test-model', defaultVoice: 'af_heart', defaultSpeed: 1,
      timeout: 60000, daemonStartupTimeout: 60000, preWarmDaemon: false,
    },
    transcription: {
      get enabled() { return configState.transcriptionEnabled; },
      timeout: 300000, daemonStartupTimeout: 120000, preWarmDaemon: false,
    },
    nemotron: {
      get enabled() { return configState.nemotronEnabled; },
    },
    qwenAsr: { enabled: false },
    diarization: { enabled: false },
    pocketTts: {
      enabled: false, defaultVoice: 'alba', timeout: 60000, daemonStartupTimeout: 60000,
      preWarmDaemon: false, voiceClonesDir: './pocket_voice_clones',
    },
    qwenTts: {
      enabled: false, modelVariant: 'base-0.6b', baseModelVariant: 'base-0.6b',
      customVoiceModelVariant: 'custom-voice', defaultVoice: 'Ryan', defaultLanguage: 'English',
      timeout: 300000, timeoutPerChar: 120, timeoutMax: 1800000, daemonStartupTimeout: 180000,
      preWarmDaemon: false, voiceClonesDir: './voice_clones',
    },
    mossTts: {
      enabled: false, modelId: 'mlx-community/MOSS-TTS-Nano-100M',
      pythonPath: './.venv-moss-tts/bin/python3', defaultVoice: null,
      timeout: 300000, timeoutPerChar: 120, timeoutMax: 1800000,
      daemonStartupTimeout: 300000, preWarmDaemon: false, voicesDir: './moss_voice_clones',
    },
    fishTts: {
      enabled: true, modelId: 'fish-audio-s2-pro-8bit-mlx',
      pythonPath: './.venv-fish-tts/bin/python3', serverDir: './vendor/fish-s2-mlx',
      modelPath: './checkpoints/fish-audio-s2-pro-8bit-mlx-normalized',
      defaultVoice: 'default', voiceClonesDir: './fish_voice_clones',
      maxTokens: 1024, timeout: 300000, timeoutPerChar: 400, timeoutMax: 900000,
      daemonStartupTimeout: 240000, preWarmDaemon: false,
    },
    drama3Tts: {
      enabled: true, modelId: 'fish-drama-3',
      pythonPath: './.venv-drama3/bin/python3', modelPath: './checkpoints/drama-3', experts: 'q8',
      voiceClonesDir: './fish_voice_clones', maxNewTokens: 0,
      timeout: 300000, timeoutPerChar: 400, timeoutMax: 900000,
      daemonStartupTimeout: 600000, preWarmDaemon: false,
    },
    upload: { maxFileSizeBytes: 100 * 1024 * 1024, transcribeMaxBytes: 25 * 1024 * 1024 },
  },
}));

vi.mock('../../src/services/fishTts.js', () => ({
  fishTtsService: {
    generate: fishMocks.generate,
    generateVoiceClone: fishMocks.generateVoiceClone,
    generateWithReference: fishMocks.generateWithReference,
    createVoiceClone: fishMocks.createVoiceClone,
    deleteVoiceClone: fishMocks.deleteVoiceClone,
    renameVoiceClone: fishMocks.renameVoiceClone,
    listVoiceClones: fishMocks.listVoiceClones,
    isReady: vi.fn().mockReturnValue(true),
    isEnabled: vi.fn().mockReturnValue(true),
    listVoices: vi.fn().mockReturnValue(['default']),
    getModelInfo: vi.fn().mockReturnValue({
      model: 'fish-audio-s2-pro-8bit-mlx',
      backend: 'fish-s2-pro-mlx',
      voices: ['default'],
      features: ['tts', 'emotion_tags', 'voice_cloning'],
      sampleRate: 44100,
      streaming: false,
    }),
  },
}));

vi.mock('../../src/services/drama3Tts.js', () => ({
  drama3TtsService: {
    generate: drama3Mocks.generate,
    generateVoiceClone: drama3Mocks.generateVoiceClone,
    generateWithReference: drama3Mocks.generateWithReference,
    listVoiceClones: drama3Mocks.listVoiceClones,
    isReady: vi.fn().mockReturnValue(false),
    getModelInfo: vi.fn().mockReturnValue({
      model: 'fish-drama-3',
      backend: 'fish-drama3-mlx',
      voices: ['default'],
      features: ['tts', 'direction_tags', 'speaker_tags', 'voice_cloning'],
      sampleRate: 44100,
      streaming: false,
    }),
  },
}));

vi.mock('../../src/services/transcription.js', () => ({
  transcriptionService: {
    transcribe: sttMocks.parakeetTranscribe,
    isReady: vi.fn().mockReturnValue(false),
  },
}));

vi.mock('../../src/services/nemotron.js', () => ({
  nemotronService: {
    transcribe: sttMocks.nemotronTranscribe,
    isReady: vi.fn().mockReturnValue(false),
  },
}));

import { initServer } from '../../src/server.js';

describe('Fish S2 Pro routes', () => {
  let server;

  beforeAll(async () => {
    fishMocks.generate.mockImplementation(async (text, options) => {
      writeFileSync(options.outputPath, createFakeWavBuffer());
      return { outputPath: options.outputPath, duration: 1.5, rtf: 1.6, model: 'fish-audio-s2-pro-8bit-mlx' };
    });
    fishMocks.generateVoiceClone.mockImplementation(async (text, options) => {
      writeFileSync(options.outputPath, createFakeWavBuffer());
      return { outputPath: options.outputPath, duration: 1.5, cloneId: options.cloneId };
    });
    fishMocks.createVoiceClone.mockResolvedValue({ cloneId: 'demo_clone' });
    fishMocks.deleteVoiceClone.mockResolvedValue({ cloneId: 'demo_clone' });
    fishMocks.renameVoiceClone.mockResolvedValue({ oldCloneId: 'demo_clone', newCloneId: 'renamed' });
    fishMocks.listVoiceClones.mockResolvedValue({ voices: ['default'], clones: ['demo_clone'] });
    server = await initServer();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('reports capabilities without streaming claims', async () => {
    const response = await server.inject({ method: 'GET', url: '/fish-tts/status' });
    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.payload);
    expect(payload.model).toBe('fish-audio-s2-pro-8bit-mlx');
    expect(payload.features).toContain('voice_cloning');
    expect(payload.streaming).toBe(false);
    expect(payload.emotionTags).toContain('[whispers]');
  });

  it('lists voices and saved clones', async () => {
    const response = await server.inject({ method: 'GET', url: '/fish-tts/voices' });
    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.payload);
    expect(payload.voices).toEqual(['default']);
    expect(payload.clones).toEqual(['demo_clone']);
  });

  it('generates a base64 WAV from inline-tagged text', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/fish-tts',
      payload: { text: '[happy] Hello from Fish S2.', format: 'buffer' },
    });
    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.payload);
    expect(payload.success).toBe(true);
    expect(Buffer.from(payload.audio, 'base64').subarray(0, 4).toString()).toBe('RIFF');
  });

  it('supports query-string Opus output', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/fish-tts?format=opus',
      payload: { text: 'Opus test.' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('audio/opus');
  });

  it('creates a voice clone from multipart audio + transcript', async () => {
    const wav = createFakeWavBuffer();
    const boundary = '----fish-test-boundary';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="reference.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
      wav,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="transcript"\r\n\r\nThe quick brown fox.\r\n--${boundary}\r\nContent-Disposition: form-data; name="cloneId"\r\n\r\ndemo_clone\r\n--${boundary}--\r\n`),
    ]);
    const response = await server.inject({
      method: 'POST',
      url: '/fish-tts/voices/clone',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toMatchObject({ success: true, cloneId: 'demo_clone' });
    expect(fishMocks.createVoiceClone).toHaveBeenCalledWith(
      expect.stringMatching(/\.wav$/), 'The quick brown fox.', 'demo_clone',
    );
  });

  it('requires a transcript when creating a clone', async () => {
    const wav = createFakeWavBuffer();
    const boundary = '----fish-no-transcript';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="reference.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
      wav,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await server.inject({
      method: 'POST',
      url: '/fish-tts/voices/clone',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects reference audio longer than 30 seconds before model work', async () => {
    processMocks.ffprobeDuration = '31.5\n';
    const callsBefore = fishMocks.createVoiceClone.mock.calls.length;
    const wav = createFakeWavBuffer();
    const boundary = '----fish-duration';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="long.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
      wav,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="transcript"\r\n\r\nToo long.\r\n--${boundary}--\r\n`),
    ]);
    const response = await server.inject({
      method: 'POST',
      url: '/fish-tts/voices/clone',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    processMocks.ffprobeDuration = '5.0\n';
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).message).toContain('between 1 and 30 seconds');
    expect(fishMocks.createVoiceClone.mock.calls).toHaveLength(callsBefore);
  });

  it('generates speech from a saved clone', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/fish-tts/voices/clone/demo_clone/generate',
      payload: { text: '[whispers] cloned voice.' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('audio/wav');
    expect(fishMocks.generateVoiceClone).toHaveBeenCalledWith(
      '[whispers] cloned voice.', expect.objectContaining({ cloneId: 'demo_clone' }),
    );
  });
});

describe('Fish Drama 3 routes', () => {
  let server;

  beforeAll(async () => {
    drama3Mocks.generate.mockImplementation(async (text, options) => {
      if (text.includes('<|speaker:16|>')) {
        throw new Error('invalid input: text: speaker tags must be <|speaker:0|> to <|speaker:15|>');
      }
      writeFileSync(options.outputPath, createFakeWavBuffer());
      return { outputPath: options.outputPath, duration: 2.0, rtf: 1.1, model: 'fish-drama-3' };
    });
    drama3Mocks.generateVoiceClone.mockImplementation(async (text, options) => {
      writeFileSync(options.outputPath, createFakeWavBuffer());
      return { outputPath: options.outputPath, duration: 2.0, cloneId: options.cloneId };
    });
    drama3Mocks.generateWithReference.mockImplementation(async (text, options) => {
      writeFileSync(options.outputPath, createFakeWavBuffer());
      return {
        outputPath: options.outputPath,
        duration: 2.0,
        rtf: 0.75,
        model: 'drama-3-nvfp4-pruned',
        finishReason: 'stop',
      };
    });
    drama3Mocks.listVoiceClones.mockResolvedValue({ voices: ['default'], clones: ['demo_clone'] });
    server = await initServer();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('reports Drama 3 capabilities and licence terms', async () => {
    const response = await server.inject({ method: 'GET', url: '/drama3-tts/status' });
    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.payload);
    expect(payload.model).toBe('fish-drama-3');
    expect(payload.features).toContain('speaker_tags');
    expect(payload.speakerTags).toContain('<|speaker:15|>');
    expect(payload.note).toContain('Community License');
  });

  it('generates multi-speaker text with directions', async () => {
    const text = '<|speaker:0|> [nervous] Did you hear that? <|speaker:1|> <whisper>Quiet.</whisper>';
    const response = await server.inject({ method: 'POST', url: '/drama3-tts', payload: { text } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('audio/wav');
    expect(response.headers['content-disposition']).toContain('fish-drama3-output.wav');
    expect(drama3Mocks.generate).toHaveBeenCalledWith(text, expect.objectContaining({}));
    expect(fishMocks.generate).not.toHaveBeenCalledWith(text, expect.anything());
  });

  it('answers text the model cannot prompt with 400', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/drama3-tts',
      payload: { text: '<|speaker:16|> one too many' },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).message).toContain('speaker tags');
  });

  it('generates with a clone from the shared Fish clone store', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/drama3-tts/voices/clone/demo_clone/generate',
      payload: { text: '[warmly] Same voice, new model.', format: 'buffer' },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload).success).toBe(true);
    expect(drama3Mocks.generateVoiceClone).toHaveBeenCalledWith(
      '[warmly] Same voice, new model.', expect.objectContaining({ cloneId: 'demo_clone' }),
    );
  });

  it('lists the shared clones', async () => {
    const response = await server.inject({ method: 'GET', url: '/drama3-tts/voices' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload).clones).toEqual(['demo_clone']);
  });

  it('exposes complete and capped TensorFold replies in binary headers and JSON', async () => {
    for (const finishReason of ['stop', 'length', 'silence']) {
      for (const format of ['wav', 'opus', 'buffer']) {
        drama3Mocks.generateVoiceClone.mockImplementationOnce(async (text, options) => {
          writeFileSync(options.outputPath, createFakeWavBuffer());
          return { outputPath: options.outputPath, duration: 2, rtf: 0.8,
            model: 'drama-3-nvfp4-pruned', finishReason };
        });
        const response = await server.inject({
          method: 'POST', url: '/drama3-tts/voices/clone/demo_clone/generate',
          payload: { text: 'Keep this take for review.', format },
        });
        expect(response.statusCode).toBe(200);
        if (format === 'buffer') {
          expect(JSON.parse(response.payload)).toMatchObject({
            finishReason, complete: finishReason === 'stop', rtf: 0.8,
          });
        } else expect(response.headers['x-finish-reason']).toBe(finishReason);
      }
    }
  });

  it('returns an explicit 400 for TensorFold sampling overrides', async () => {
    drama3Mocks.generateVoiceClone.mockRejectedValueOnce(
      new Error('invalid input: TensorFold uses a fixed temperature of 1.0'),
    );
    const response = await server.inject({
      method: 'POST', url: '/drama3-tts/voices/clone/demo_clone/generate',
      payload: { text: 'Hello.', temperature: 0.7 },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).message).toContain('fixed temperature');
  });

  it('reports TensorFold capabilities without advertising multiple speakers or sampling controls', async () => {
    const { drama3TtsService } = await import('../../src/services/drama3Tts.js');
    drama3TtsService.getModelInfo.mockReturnValueOnce({
      model: 'drama-3-nvfp4-pruned', backend: 'fish-drama3-tensorfold', voices: ['default'],
      features: ['tts', 'direction_tags', 'voice_cloning'], sampleRate: 44100,
    });
    const response = await server.inject({ method: 'GET', url: '/drama3-tts/status' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toMatchObject({
      backend: 'fish-drama3-tensorfold', speakerTags: '<|speaker:0|>',
      perRequestMaxTokens: false, sampling: { temperature: 1, configurable: false },
    });
    expect(JSON.parse(response.payload).features).not.toContain('speaker_tags');
  });

  it('supports mp3 and flac output format conversions alongside opus and wav', async () => {
    for (const [format, mime] of [['mp3', 'audio/mpeg'], ['flac', 'audio/flac']]) {
      const response = await server.inject({
        method: 'POST',
        url: '/drama3-tts',
        payload: { text: '[warmly] Testing audio output formats.', format },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe(mime);
      expect(response.headers['content-disposition']).toContain(`fish-drama3-output.${format}`);
    }
  });

  it('generates speech with stateless POST /drama3-tts/generate-with-reference and explicit transcript', async () => {
    const wav = createFakeWavBuffer();
    const boundary = '----drama3-ephemeral';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ref.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
      wav,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\n[sighs] Ephemeral clone line.\r\n--${boundary}\r\nContent-Disposition: form-data; name="referenceText"\r\n\r\nSpoken reference words.\r\n--${boundary}\r\nContent-Disposition: form-data; name="format"\r\n\r\nmp3\r\n--${boundary}--\r\n`),
    ]);

    const response = await server.inject({
      method: 'POST',
      url: '/drama3-tts/generate-with-reference',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('audio/mpeg');
    expect(response.headers['x-finish-reason']).toBe('stop');
    expect(drama3Mocks.generateWithReference).toHaveBeenCalledWith(
      '[sighs] Ephemeral clone line.',
      expect.objectContaining({
        referenceAudioPath: expect.stringMatching(/\.wav$/),
        referenceText: 'Spoken reference words.',
      }),
    );
  });

  it('auto-transcribes reference audio via Parakeet when transcript is omitted on /drama3-tts/generate-with-reference', async () => {
    configState.transcriptionEnabled = true;
    sttMocks.parakeetTranscribe.mockResolvedValueOnce({
      text: 'Auto transcribed reference phrase.',
      rawOutput: '',
    });

    const wav = createFakeWavBuffer();
    const boundary = '----drama3-autostt';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ref.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
      wav,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\nDeliver this line.\r\n--${boundary}--\r\n`),
    ]);

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/drama3-tts/generate-with-reference',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });
      expect(response.statusCode).toBe(200);
      expect(sttMocks.parakeetTranscribe).toHaveBeenCalledWith(
        expect.stringMatching(/\.wav$/),
        expect.objectContaining({ timestamps: false, wordTimestamps: false }),
      );
      expect(drama3Mocks.generateWithReference).toHaveBeenLastCalledWith(
        'Deliver this line.',
        expect.objectContaining({ referenceText: 'Auto transcribed reference phrase.' }),
      );
    } finally {
      configState.transcriptionEnabled = false;
    }
  });

  it('returns 400 on /drama3-tts/generate-with-reference when transcript is omitted and no STT engine is enabled or speech is empty', async () => {
    configState.transcriptionEnabled = false;
    configState.nemotronEnabled = false;

    const wav = createFakeWavBuffer();
    const boundary = '----drama3-nostt';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ref.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
      wav,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\nNo STT engine.\r\n--${boundary}--\r\n`),
    ]);

    const noEngineRes = await server.inject({
      method: 'POST',
      url: '/drama3-tts/generate-with-reference',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(noEngineRes.statusCode).toBe(400);
    expect(JSON.parse(noEngineRes.payload).message).toMatch(/no transcription engine is enabled/i);

    configState.nemotronEnabled = true;
    sttMocks.nemotronTranscribe.mockResolvedValueOnce({ text: '<spk:0>   ' });
    try {
      const emptyRes = await server.inject({
        method: 'POST',
        url: '/drama3-tts/generate-with-reference',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });
      expect(emptyRes.statusCode).toBe(400);
      expect(JSON.parse(emptyRes.payload).message).toMatch(/no speech detected/i);
    } finally {
      configState.nemotronEnabled = false;
    }
  });

  it('returns generic 400 without /tmp stderr leaks on decodeReference failure and disables in-process worker in compose.yaml api service', async () => {
    const wav = createFakeWavBuffer();
    const boundary = '----drama3-baddecode';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ref.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
      wav,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\nDecode error check.\r\n--${boundary}\r\nContent-Disposition: form-data; name="referenceText"\r\n\r\nRef words.\r\n--${boundary}--\r\n`),
    ]);

    const ffmpegErr = new Error('ffmpeg exited 1');
    ffmpegErr.stderr = '/tmp/drama3-tts-ref-12345/secret.wav: Invalid data found when processing input';
    processMocks.ffmpegError = ffmpegErr;
    try {
      const res = await server.inject({
        method: 'POST',
        url: '/drama3-tts/generate-with-reference',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });
      expect(res.statusCode).toBe(400);
      const parsed = JSON.parse(res.payload);
      expect(parsed.message).toBe('Reference audio could not be decoded');
      expect(res.payload).not.toContain('/tmp/');
    } finally {
      processMocks.ffmpegError = null;
    }

    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
    const composeYaml = readFileSync(join(repoRoot, 'docker/nvidia/compose.yaml'), 'utf-8');
    expect(composeYaml).toMatch(/api:[\s\S]*environment:\s*\n\s*SOGNI_NETWORK_WORKER:\s*"false"/);
  });
});
