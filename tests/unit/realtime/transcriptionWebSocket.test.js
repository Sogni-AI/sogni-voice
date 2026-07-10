import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Hapi from '@hapi/hapi';
import { WebSocket } from 'ws';
import {
  attachRealtimeTranscriptionWebSocket,
  REALTIME_TRANSCRIPTION_PATH,
  REALTIME_TRANSCRIPTION_PROTOCOL,
} from '../../../src/realtime/transcriptionWebSocket.js';

const createMessageReader = (socket) => {
  const messages = [];
  const readers = [];

  socket.on('message', (data) => {
    const message = JSON.parse(data.toString('utf8'));
    const reader = readers.shift();
    if (reader) reader.resolve(message);
    else messages.push(message);
  });

  return () => {
    if (messages.length) return Promise.resolve(messages.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for WebSocket message')), 2000);
      readers.push({
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  };
};

const openClient = (url, options) => {
  const socket = new WebSocket(url, options);
  const nextMessage = createMessageReader(socket);
  const opened = new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return { socket, nextMessage, opened };
};

describe('Parakeet realtime transcription WebSocket', () => {
  let server;
  let service;
  let wsUrl;

  beforeEach(async () => {
    service = {
      startRealtimeSession: vi.fn().mockResolvedValue({
        session_id: 'session-one',
        encoding: 'pcm_f32le',
        sample_rate: 16000,
        max_seconds: 300,
        context_size: [256, 256],
        depth: 1,
      }),
      sendRealtimeAudio: vi.fn().mockResolvedValue({
        sequence: 1,
        text: 'Hello wor',
        finalized_text: 'Hello',
        draft_text: 'wor',
        finalized_delta: [{ text: 'Hello', start: 0, end: 0.4 }],
        audio_seconds: 0.5,
        processing_seconds: 0.08,
        real_time_factor: 0.16,
      }),
      finishRealtimeSession: vi.fn().mockResolvedValue({
        sequence: 1,
        text: 'Hello world.',
        finalized_text: 'Hello world.',
        draft_text: '',
        timestamps: [
          { text: 'Hello', start: 0, end: 0.4 },
          { text: 'world.', start: 0.4, end: 0.8 },
        ],
        audio_seconds: 0.8,
        real_time_factor: 0.16,
      }),
      abortRealtimeSession: vi.fn().mockResolvedValue(undefined),
      getModelInfo: vi.fn().mockReturnValue({
        model: 'mlx-community/parakeet-tdt-0.6b-v3',
        revision: 'test-revision',
        parakeetMlxVersion: '0.5.2',
        sampleRate: 16000,
        realtime: true,
      }),
    };

    server = Hapi.server({ port: 0, host: '127.0.0.1' });
    attachRealtimeTranscriptionWebSocket(server, {
      service,
      realtimeConfig: {
        realtimeMaxChunkBytes: 64 * 1024,
        realtimeIdleTimeout: 1000,
      },
      authConfig: { enabled: false, apiKey: null },
      corsOrigins: [],
    });
    await server.start();
    wsUrl = `ws://127.0.0.1:${server.info.port}${REALTIME_TRANSCRIPTION_PATH}`;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('streams binary PCM into interim and final transcript events', async () => {
    const { socket, nextMessage, opened } = openClient(wsUrl);
    await opened;

    await expect(nextMessage()).resolves.toMatchObject({
      type: 'connected',
      protocol: REALTIME_TRANSCRIPTION_PROTOCOL,
      encoding: 'pcm_f32le',
      sampleRate: 16000,
    });

    socket.send(JSON.stringify({
      type: 'start',
      encoding: 'pcm_f32le',
      sampleRate: 16000,
    }));
    await expect(nextMessage()).resolves.toMatchObject({
      type: 'session.started',
      sessionId: 'session-one',
      model: { parakeetMlxVersion: '0.5.2' },
    });

    const samples = new Float32Array([0.1, -0.1, 0.2, -0.2]);
    const pcm = Buffer.from(samples.buffer);
    socket.send(pcm);
    await expect(nextMessage()).resolves.toMatchObject({
      type: 'transcript.partial',
      sequence: 1,
      text: 'Hello wor',
      finalizedText: 'Hello',
      draftText: 'wor',
      realTimeFactor: 0.16,
    });
    expect(service.sendRealtimeAudio).toHaveBeenCalledWith('session-one', pcm);

    const closed = new Promise((resolve) => socket.once('close', resolve));
    socket.send(JSON.stringify({ type: 'stop' }));
    await expect(nextMessage()).resolves.toMatchObject({
      type: 'transcript.final',
      text: 'Hello world.',
      timestamps: expect.any(Array),
    });
    await closed;
    expect(service.finishRealtimeSession).toHaveBeenCalledWith('session-one');
    expect(service.abortRealtimeSession).not.toHaveBeenCalled();
  });

  it('accepts browser API-key authentication in the start message', async () => {
    await server.stop();
    server = Hapi.server({ port: 0, host: '127.0.0.1' });
    attachRealtimeTranscriptionWebSocket(server, {
      service,
      realtimeConfig: {
        realtimeMaxChunkBytes: 64 * 1024,
        realtimeIdleTimeout: 1000,
      },
      authConfig: { enabled: true, apiKey: 'correct-key' },
      corsOrigins: [],
    });
    await server.start();
    wsUrl = `ws://127.0.0.1:${server.info.port}${REALTIME_TRANSCRIPTION_PATH}`;

    const { socket, nextMessage, opened } = openClient(wsUrl);
    await opened;
    await expect(nextMessage()).resolves.toMatchObject({
      type: 'connected',
      requiresAuth: true,
    });
    socket.send(JSON.stringify({ type: 'start', apiKey: 'correct-key' }));
    await expect(nextMessage()).resolves.toMatchObject({ type: 'session.started' });

    const closed = new Promise((resolve) => socket.once('close', resolve));
    socket.send(JSON.stringify({ type: 'abort' }));
    await expect(nextMessage()).resolves.toMatchObject({ type: 'session.aborted' });
    await closed;
    expect(service.abortRealtimeSession).toHaveBeenCalledWith('session-one');
  });

  it('rejects an invalid browser API key before allocating a model session', async () => {
    await server.stop();
    server = Hapi.server({ port: 0, host: '127.0.0.1' });
    attachRealtimeTranscriptionWebSocket(server, {
      service,
      realtimeConfig: {
        realtimeMaxChunkBytes: 64 * 1024,
        realtimeIdleTimeout: 1000,
      },
      authConfig: { enabled: true, apiKey: 'correct-key' },
      corsOrigins: [],
    });
    await server.start();
    wsUrl = `ws://127.0.0.1:${server.info.port}${REALTIME_TRANSCRIPTION_PATH}`;

    const { socket, nextMessage, opened } = openClient(wsUrl);
    await opened;
    await nextMessage();
    const closed = new Promise((resolve) => socket.once('close', resolve));
    socket.send(JSON.stringify({ type: 'start', apiKey: 'wrong-key' }));
    await expect(nextMessage()).resolves.toMatchObject({
      type: 'error',
      code: 'unauthorized',
      retryable: false,
    });
    await closed;
    expect(service.startRealtimeSession).not.toHaveBeenCalled();
  });

  it('accepts API-key headers from programmatic WebSocket clients', async () => {
    await server.stop();
    server = Hapi.server({ port: 0, host: '127.0.0.1' });
    attachRealtimeTranscriptionWebSocket(server, {
      service,
      realtimeConfig: {
        realtimeMaxChunkBytes: 64 * 1024,
        realtimeIdleTimeout: 1000,
      },
      authConfig: { enabled: true, apiKey: 'correct-key' },
      corsOrigins: [],
    });
    await server.start();
    wsUrl = `ws://127.0.0.1:${server.info.port}${REALTIME_TRANSCRIPTION_PATH}`;

    const { socket, nextMessage, opened } = openClient(wsUrl, {
      headers: { 'X-API-Key': 'correct-key' },
    });
    await opened;
    await nextMessage();
    socket.send(JSON.stringify({ type: 'start' }));
    await expect(nextMessage()).resolves.toMatchObject({ type: 'session.started' });
    const closed = new Promise((resolve) => socket.once('close', resolve));
    socket.send(JSON.stringify({ type: 'abort' }));
    await nextMessage();
    await closed;
  });

  it('rejects an invalid API-key header during the HTTP upgrade', async () => {
    await server.stop();
    server = Hapi.server({ port: 0, host: '127.0.0.1' });
    attachRealtimeTranscriptionWebSocket(server, {
      service,
      realtimeConfig: {
        realtimeMaxChunkBytes: 64 * 1024,
        realtimeIdleTimeout: 1000,
      },
      authConfig: { enabled: true, apiKey: 'correct-key' },
      corsOrigins: [],
    });
    await server.start();
    wsUrl = `ws://127.0.0.1:${server.info.port}${REALTIME_TRANSCRIPTION_PATH}`;

    await new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl, { headers: { 'X-API-Key': 'wrong-key' } });
      socket.once('open', () => reject(new Error('Invalid-key socket unexpectedly opened')));
      socket.once('unexpected-response', (_request, response) => {
        try {
          expect(response.statusCode).toBe(401);
          response.resume();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      socket.once('error', () => {});
    });
    expect(service.startRealtimeSession).not.toHaveBeenCalled();
  });

  it('maps the single-session limit to a retryable busy event', async () => {
    service.startRealtimeSession.mockRejectedValueOnce(
      new Error('Another Parakeet realtime session is already active'),
    );
    const { socket, nextMessage, opened } = openClient(wsUrl);
    await opened;
    await nextMessage();
    const closed = new Promise((resolve) => socket.once('close', (code) => resolve(code)));
    socket.send(JSON.stringify({ type: 'start' }));

    await expect(nextMessage()).resolves.toMatchObject({
      type: 'error',
      code: 'busy',
      retryable: true,
    });
    await expect(closed).resolves.toBe(1013);
  });

  it('rejects malformed PCM as an invalid client request and cleans up', async () => {
    const { socket, nextMessage, opened } = openClient(wsUrl);
    await opened;
    await nextMessage();
    socket.send(JSON.stringify({ type: 'start' }));
    await nextMessage();
    const closed = new Promise((resolve) => socket.once('close', (code) => resolve(code)));
    socket.send(Buffer.from([1, 2, 3]));

    await expect(nextMessage()).resolves.toMatchObject({
      type: 'error',
      code: 'invalid_request',
      retryable: false,
    });
    await expect(closed).resolves.toBe(1008);
    expect(service.abortRealtimeSession).toHaveBeenCalledWith('session-one');
  });

  it('maps daemon PCM validation failures to an invalid-audio event', async () => {
    service.sendRealtimeAudio.mockRejectedValueOnce(
      new Error('Realtime audio contains non-finite samples'),
    );
    const { socket, nextMessage, opened } = openClient(wsUrl);
    await opened;
    await nextMessage();
    socket.send(JSON.stringify({ type: 'start' }));
    await nextMessage();
    const closed = new Promise((resolve) => socket.once('close', (code) => resolve(code)));
    socket.send(Buffer.alloc(4));

    await expect(nextMessage()).resolves.toMatchObject({
      type: 'error',
      code: 'invalid_audio',
      retryable: false,
    });
    await expect(closed).resolves.toBe(1008);
    expect(service.abortRealtimeSession).toHaveBeenCalledWith('session-one');
  });

  it('aborts a model session when the client disconnects', async () => {
    const { socket, nextMessage, opened } = openClient(wsUrl);
    await opened;
    await nextMessage();
    socket.send(JSON.stringify({ type: 'start' }));
    await nextMessage();
    socket.terminate();

    await vi.waitFor(() => {
      expect(service.abortRealtimeSession).toHaveBeenCalledWith('session-one');
    });
  });

  it('aborts a session that finishes starting after its client disconnects', async () => {
    let resolveStart;
    service.startRealtimeSession.mockReturnValueOnce(new Promise((resolve) => {
      resolveStart = resolve;
    }));
    const { socket, nextMessage, opened } = openClient(wsUrl);
    await opened;
    await nextMessage();
    socket.send(JSON.stringify({ type: 'start' }));
    await vi.waitFor(() => expect(service.startRealtimeSession).toHaveBeenCalledTimes(1));
    socket.terminate();
    resolveStart({
      session_id: 'late-session',
      encoding: 'pcm_f32le',
      sample_rate: 16000,
      max_seconds: 300,
      context_size: [256, 256],
      depth: 1,
    });

    await vi.waitFor(() => {
      expect(service.abortRealtimeSession).toHaveBeenCalledWith('late-session');
    });
  });

  it('waits for active model-session cleanup when Hapi stops', async () => {
    let cleanupFinished = false;
    service.abortRealtimeSession.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      cleanupFinished = true;
    });
    const { socket, nextMessage, opened } = openClient(wsUrl);
    await opened;
    await nextMessage();
    socket.send(JSON.stringify({ type: 'start' }));
    await nextMessage();

    await server.stop();
    expect(service.abortRealtimeSession).toHaveBeenCalledWith('session-one');
    expect(cleanupFinished).toBe(true);
  });

  it('rejects cross-origin upgrades that are outside the CORS policy', async () => {
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl, { origin: 'https://evil.example' });
      socket.once('open', () => reject(new Error('Cross-origin socket unexpectedly opened')));
      socket.once('unexpected-response', (_request, response) => {
        try {
          expect(response.statusCode).toBe(403);
          response.resume();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      socket.once('error', () => {});
    });
  });
});
