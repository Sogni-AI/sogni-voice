import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Hapi from '@hapi/hapi';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { request as httpRequest } from 'node:http';
import { writeFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock('node:fs/promises', async (original) => ({
  ...await original(),
  // Model weights and saved clones are represented by the fake workers below.
  access: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/config/index.js', () => {
  const defaults = { enabled: true, timeout: 60000, daemonStartupTimeout: 60000, preWarmDaemon: false };
  return { config: {
    auth: { enabled: false, dangerouslyAllowVoiceCloning: true },
    upload: { maxFileSizeBytes: 1000000 },
    tts: { ...defaults, defaultVoice: 'af_heart', defaultSpeed: 1 },
    pocketTts: { ...defaults, defaultVoice: 'alba', voiceClonesDir: './pocket_voice_clones' },
    qwenTts: {
      ...defaults, baseModelVariant: 'base-0.6b', customVoiceModelVariant: 'custom-voice',
      voiceDesignModelVariant: 'voice-design', defaultVoice: 'Ryan', defaultLanguage: 'English',
      voiceClonesDir: './voice_clones',
    },
    fishTts: {
      ...defaults, pythonPath: './python', modelPath: './model', serverDir: './server',
      voiceClonesDir: './fish_voice_clones', modelId: 'fish-test', maxTokens: 100,
    },
    mossTts: { ...defaults, defaultVoice: 'test_voice', voicesDir: './moss_voice_clones' },
  } };
});

const cases = [
  ['/tts', {}],
  ['/tts', { timestamps: true }],
  ['/qwen-tts', {}],
  ['/qwen-tts/custom-voice', { instruct: 'Happy' }],
  ['/qwen-tts/voice-design', { instruct: 'A calm narrator' }],
  ['/qwen-tts/voices/clone/test_clone/generate', {}],
  ['/pocket-tts', {}],
  ['/pocket-tts/voices/clone/test_clone/generate', {}],
  ['/fish-tts', {}],
  ['/fish-tts/voices/clone/test_clone/generate', {}],
  ['/moss-tts', {}],
];

describe('TTS HTTP cancellation with real routes and services', () => {
  let server;
  let workers;
  let clients;
  let services;
  let tempFileManager;
  let entered;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    workers = [];
    clients = [];
    entered = [];
    const { spawn } = await import('node:child_process');
    spawn.mockImplementation(() => {
      const child = new EventEmitter();
      child.requests = [];
      child.stdout = new Readable({ read() {} });
      child.stderr = new Readable({ read() {} });
      child.stdin = new Writable({
        write(chunk, encoding, callback) {
          const request = JSON.parse(chunk.toString());
          if (request.command === 'shutdown') setImmediate(() => child.emit('close', 0));
          else child.requests.push(request);
          callback();
        },
      });
      child.kill = vi.fn(() => {
        setImmediate(() => child.emit('close', null, 'SIGKILL'));
        return true;
      });
      workers.push(child);
      queueMicrotask(() => child.stdout.push(`${JSON.stringify({
        status: 'ready', features: ['tts', 'voice_cloning', 'custom_voice', 'voice_design'],
        voices: ['Ryan'], speakers: ['Ryan'], model: 'test-model', sample_rate: 24000,
      })}\n`));
      return child;
    });

    const routeModules = await Promise.all(['tts', 'qwenTts', 'pocketTts', 'fishTts', 'mossTts']
      .map((name) => import(`../../src/routes/${name}.js`)));
    const serviceModules = await Promise.all(['tts', 'qwenTts', 'pocketTts', 'fishTts', 'mossTts']
      .map((name) => import(`../../src/services/${name}.js`)));
    services = [...new Set(serviceModules.flatMap((module) => Object.entries(module)
      .filter(([name]) => name.endsWith('Service') && name[0] === name[0].toLowerCase())
      .map(([, service]) => service)))];
    ({ tempFileManager } = await import('../../src/utils/tempFile.js'));
    server = Hapi.server({ host: '127.0.0.1', port: 0 });
    server.route(routeModules.flatMap((module) => Object.values(module).flat()));
    server.ext('onPreHandler', (request, h) => {
      entered.push(request.payload?.text);
      return h.continue;
    });
    await server.start();
  });

  afterEach(async () => {
    for (const client of clients) client.destroy();
    await server?.stop({ timeout: 0 });
    await Promise.all(services?.map((service) => service.shutdown()) || []);
    await tempFileManager?.cleanupAll();
  });

  function send(path, payload) {
    let client;
    const result = new Promise((resolve) => {
      client = httpRequest(`${server.info.uri}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, agent: false,
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
      });
      client.on('error', (error) => resolve({ error }));
      client.end(JSON.stringify(payload));
    });
    clients.push(client);
    return { client, result };
  }

  async function complete(worker) {
    const request = worker.requests.at(-1);
    await writeFile(request.output_path, Buffer.from('fake WAV from test worker'));
    worker.stdout.push(`${JSON.stringify({
      id: request.id, success: true, output_path: request.output_path, duration: 1,
      sample_rate: 24000, channels: 1, voice_id: 'test_voice', timestamps: [],
    })}\n`);
  }

  it.each(cases)('stops %s inference on disconnect and completes another queued client (%j)', async (path, options) => {
    const abandoned = send(path, { text: 'abandoned', ...options });
    await vi.waitFor(() => expect(workers[0]?.requests).toHaveLength(1));
    // Finishing the POST body must not be mistaken for client cancellation.
    expect(workers[0].kill).not.toHaveBeenCalled();
    const abandonedDir = dirname(workers[0].requests[0].output_path);
    const next = send(path, { text: 'next', ...options });
    await vi.waitFor(() => expect(entered).toContain('next'));
    abandoned.client.destroy();
    await abandoned.result;
    await vi.waitFor(() => expect(workers[0].kill).toHaveBeenCalledExactlyOnceWith('SIGKILL'));
    await vi.waitFor(() => expect(workers[1]?.requests).toHaveLength(1));
    expect(workers[0].requests).toHaveLength(1);
    expect(workers[1].requests[0].text).toBe('next');
    await complete(workers[1]);
    expect((await next.result).status).toBe(200);
    expect(workers[1].kill).not.toHaveBeenCalled();
    await vi.waitFor(async () => expect(await stat(abandonedDir).catch(() => null)).toBeNull());
  });

  it.each(cases)('drops queued %s requests while keeping the active worker loaded (%j)', async (path, options) => {
    const first = send(path, { text: 'first', ...options });
    await vi.waitFor(() => expect(workers[0]?.requests).toHaveLength(1));
    const cancelled = send(path, { text: 'cancelled', ...options });
    await vi.waitFor(() => expect(entered).toContain('cancelled'));
    cancelled.client.destroy();
    await cancelled.result;
    const last = send(path, { text: 'last', ...options });
    await vi.waitFor(() => expect(entered).toContain('last'));
    expect(workers[0].kill).not.toHaveBeenCalled();
    await complete(workers[0]);
    expect((await first.result).status).toBe(200);
    await vi.waitFor(() => expect(workers[0].requests).toHaveLength(2));
    expect(workers[0].requests[1].text).toBe('last');
    await complete(workers[0]);
    expect((await last.result).status).toBe(200);
    expect(workers).toHaveLength(1);
    expect(workers[0].kill).not.toHaveBeenCalled();
  });

  it('isolates cancellation from a different Qwen model daemon', async () => {
    const custom = send('/qwen-tts', { text: 'custom' });
    await vi.waitFor(() => expect(workers[0]?.requests).toHaveLength(1));
    const design = send('/qwen-tts/voice-design', { text: 'design', instruct: 'Narrator' });
    await vi.waitFor(() => expect(workers[1]?.requests).toHaveLength(1));
    custom.client.destroy();
    await custom.result;
    await vi.waitFor(() => expect(workers[0].kill).toHaveBeenCalledWith('SIGKILL'));
    expect(workers[1].kill).not.toHaveBeenCalled();
    await complete(workers[1]);
    expect((await design.result).status).toBe(200);
  });

  it.each(cases)('cancels %s output conversion without interrupting the next inference (%j)', async (path, options) => {
    const { execFile } = await import('node:child_process');
    execFile.mockImplementation((command, args, conversion, callback) => {
      conversion.signal.addEventListener('abort', () => {
        callback(new DOMException('Conversion cancelled', 'AbortError'));
      }, { once: true });
    });
    const converting = send(path, { text: 'convert', format: 'opus', ...options });
    await vi.waitFor(() => expect(workers[0]?.requests).toHaveLength(1));
    await complete(workers[0]);
    await vi.waitFor(() => expect(execFile).toHaveBeenCalledTimes(1));
    const signal = execFile.mock.calls[0][2].signal;
    expect(signal.aborted).toBe(false);

    const next = send(path, { text: 'next', ...options });
    await vi.waitFor(() => expect(workers[0].requests).toHaveLength(2));
    converting.client.destroy();
    await converting.result;
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    expect(workers[0].kill).not.toHaveBeenCalled();
    await complete(workers[0]);
    expect((await next.result).status).toBe(200);
  });
});
