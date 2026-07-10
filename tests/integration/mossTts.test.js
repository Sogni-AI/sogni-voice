import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { writeFileSync } from 'node:fs';

const mossMocks = vi.hoisted(() => ({
  generate: vi.fn(),
  createVoice: vi.fn(),
  deleteVoice: vi.fn(),
  renameVoice: vi.fn(),
  listVoices: vi.fn(),
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
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(48000, 24);
  buffer.writeUInt32LE(192000, 28);
  buffer.writeUInt16LE(4, 32);
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
      enabled: false,
      modelId: 'test-model',
      defaultVoice: 'af_heart',
      defaultSpeed: 1,
      timeout: 60000,
      daemonStartupTimeout: 60000,
      preWarmDaemon: false,
    },
    transcription: {
      enabled: false,
      timeout: 300000,
      daemonStartupTimeout: 120000,
      preWarmDaemon: false,
    },
    qwenAsr: { enabled: false },
    diarization: { enabled: false },
    pocketTts: {
      enabled: false,
      defaultVoice: 'alba',
      timeout: 60000,
      daemonStartupTimeout: 60000,
      preWarmDaemon: false,
      voiceClonesDir: './pocket_voice_clones',
    },
    qwenTts: {
      enabled: false,
      modelVariant: 'base-0.6b',
      baseModelVariant: 'base-0.6b',
      customVoiceModelVariant: 'custom-voice',
      defaultVoice: 'Ryan',
      defaultLanguage: 'English',
      timeout: 300000,
      timeoutPerChar: 120,
      timeoutMax: 1800000,
      daemonStartupTimeout: 180000,
      preWarmDaemon: false,
      voiceClonesDir: './voice_clones',
    },
    mossTts: {
      enabled: true,
      modelId: 'mlx-community/MOSS-TTS-Nano-100M',
      pythonPath: './.venv-moss-tts/bin/python3',
      defaultVoice: null,
      timeout: 300000,
      timeoutPerChar: 120,
      timeoutMax: 1800000,
      daemonStartupTimeout: 300000,
      preWarmDaemon: false,
      voicesDir: './moss_voice_clones',
    },
    upload: {
      maxFileSizeBytes: 100 * 1024 * 1024,
      transcribeMaxBytes: 25 * 1024 * 1024,
    },
  },
}));

vi.mock('../../src/services/mossTts.js', () => ({
  mossTtsService: {
    generate: mossMocks.generate,
    createVoice: mossMocks.createVoice,
    deleteVoice: mossMocks.deleteVoice,
    renameVoice: mossMocks.renameVoice,
    listVoices: mossMocks.listVoices,
    getModelInfo: vi.fn().mockReturnValue({
      model: 'mlx-community/MOSS-TTS-Nano-100M',
      features: ['multilingual_tts', 'voice_cloning'],
      streaming: false,
      sampleRate: 48000,
      languages: [{ code: 'en', name: 'English' }, { code: 'es', name: 'Spanish' }],
    }),
  },
}));

import { initServer } from '../../src/server.js';

describe('MOSS-TTS-Nano routes', () => {
  let server;

  beforeAll(async () => {
    mossMocks.generate.mockImplementation(async (text, options) => {
      writeFileSync(options.outputPath, createFakeWavBuffer());
      return {
        outputPath: options.outputPath,
        voiceId: options.voiceId,
        duration: 1.5,
        sampleRate: 48000,
        channels: 2,
        processingSeconds: 1.0,
        realTimeFactor: 1.5,
        model: 'mlx-community/MOSS-TTS-Nano-100M',
      };
    });
    mossMocks.createVoice.mockResolvedValue({ voiceId: 'demo_voice', duration: 5 });
    mossMocks.deleteVoice.mockResolvedValue({ voiceId: 'demo_voice' });
    mossMocks.renameVoice.mockResolvedValue({ oldVoiceId: 'demo_voice', voiceId: 'renamed' });
    mossMocks.listVoices.mockResolvedValue(['demo_voice']);
    server = await initServer();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('reports capabilities and saved reference voices without streaming claims', async () => {
    const response = await server.inject({ method: 'GET', url: '/moss-tts/voices' });
    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.payload);
    expect(payload.voices).toEqual(['demo_voice']);
    expect(payload.features).toContain('voice_cloning');
    expect(payload.streaming).toBe(false);
    expect(payload.sampleRate).toBe(48000);
    expect(payload.languages).toHaveLength(2);
  });

  it('generates a base64 WAV with model metrics', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/moss-tts',
      payload: { text: 'Hello from MOSS.', voice: 'demo_voice', format: 'buffer' },
    });
    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.payload);
    expect(payload.success).toBe(true);
    expect(payload.voice).toBe('demo_voice');
    expect(payload.sampleRate).toBe(48000);
    expect(Buffer.from(payload.audio, 'base64').subarray(0, 4).toString()).toBe('RIFF');
  });

  it('supports query-string Opus output', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/moss-tts?format=opus',
      payload: { text: 'Opus test.', voice: 'demo_voice' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('audio/opus');
  });

  it('requires a saved reference voice', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/moss-tts',
      payload: { text: 'No voice selected.' },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).message).toContain('reference voice is required');
  });

  it('normalizes and creates a reference voice from multipart audio', async () => {
    const wav = createFakeWavBuffer();
    const boundary = '----moss-test-boundary';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="reference.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
      wav,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="voiceId"\r\n\r\ndemo_voice\r\n--${boundary}--\r\n`),
    ]);
    const response = await server.inject({
      method: 'POST',
      url: '/moss-tts/voices/clone',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toMatchObject({ success: true, voiceId: 'demo_voice' });
    expect(mossMocks.createVoice).toHaveBeenCalledWith(expect.stringMatching(/\.wav$/), 'demo_voice');
  });

  it('rejects reference audio longer than 30 seconds before model work', async () => {
    processMocks.ffprobeDuration = '31.5\n';
    const callsBefore = mossMocks.createVoice.mock.calls.length;
    const wav = createFakeWavBuffer();
    const boundary = '----moss-duration-boundary';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="long.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
      wav,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await server.inject({
      method: 'POST',
      url: '/moss-tts/voices/clone',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    processMocks.ffprobeDuration = '5.0\n';
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).message).toContain('between 1 and 30 seconds');
    expect(mossMocks.createVoice.mock.calls).toHaveLength(callsBefore);
  });
});
