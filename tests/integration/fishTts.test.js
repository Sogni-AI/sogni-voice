import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { writeFileSync } from 'node:fs';

const fishMocks = vi.hoisted(() => ({
  generate: vi.fn(),
  generateVoiceClone: vi.fn(),
  createVoiceClone: vi.fn(),
  deleteVoiceClone: vi.fn(),
  renameVoiceClone: vi.fn(),
  listVoiceClones: vi.fn(),
}));
const drama3Mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  generateVoiceClone: vi.fn(),
  listVoiceClones: vi.fn(),
}));
const processMocks = vi.hoisted(() => ({ ffprobeDuration: '5.0\n' }));

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
      cb?.(null, processMocks.ffprobeDuration, '');
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
      enabled: false, timeout: 300000, daemonStartupTimeout: 120000, preWarmDaemon: false,
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
});
