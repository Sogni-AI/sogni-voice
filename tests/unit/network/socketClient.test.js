import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SogniSocketClient,
  computeReconnectDelayMs,
} from '../../../src/network/socketClient.js';
import { startMockSogniSocket, waitFor } from '../../utils/mockSogniSocket.js';

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

describe('SogniSocketClient', () => {
  let server;
  let client;

  beforeEach(async () => {
    server = await startMockSogniSocket();
  });

  afterEach(async () => {
    client?.close();
    await server.close();
  });

  const makeClient = (overrides = {}) => new SogniSocketClient({
    url: server.url,
    origin: 'wss://socket-staging.sogni.ai',
    sogniEnv: 'staging',
    apiKey: 'test-api-key',
    nftTokenId: '777',
    workerId: 'WORKER-UUID',
    workerType: 'Comfy.FastWorker',
    runningInDocker: true,
    sessionTimestamp: 1700000000,
    userAgent: 'Sogni/3.0.0129 (linux) | IMG:COMFY | comfy-worker/1.0.260',
    reconnectInitialDelayMs: 30,
    reconnectMaxDelayMs: 100,
    reconnectJitter: 0,
    logger: silentLogger,
    ...overrides,
  });

  it('sends exact Sogni media-worker upgrade headers', async () => {
    client = makeClient();
    client.connect();
    await waitFor(() => server.headers !== null);

    expect(server.headers['app-id']).toBe('WORKER-UUID');
    expect(server.headers['client-type']).toBe('worker');
    expect(server.headers['origin']).toBe('wss://socket-staging.sogni.ai');
    expect(server.headers['user-agent'])
      .toBe('Sogni/3.0.0129 (linux) | IMG:COMFY | comfy-worker/1.0.260');
    expect(server.headers['session-timestamp']).toBe('1700000000');
    expect(server.headers['api-key']).toBe('test-api-key');
    expect(server.headers['nft-token-id']).toBe('777');
    expect(server.headers['worker-type']).toBe('Comfy.FastWorker');
    expect(server.headers['runningindocker']).toBe('1');
  });

  it('omits nft-token-id header when unset (Mac Relaxed mode)', async () => {
    client = makeClient({ nftTokenId: '' });
    client.connect();
    await waitFor(() => server.headers !== null);
    expect(server.headers['nft-token-id']).toBeUndefined();
  });

  it('runs optional preflight POST /v1/client/key with text/plain apiKey before connecting', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
    client = makeClient({
      socketApiUrl: 'https://socket-staging.sogni.ai/api',
      validateClientKey: true,
      fetchImpl,
    });

    await client.start();
    await waitFor(() => client.connected);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://socket-staging.sogni.ai/api/v1/client/key',
      {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'test-api-key',
      },
    );
  });

  it('encodes outbound sends as base64 envelopes and decodes inbound frames', async () => {
    client = makeClient();
    const frames = [];
    client.on('frame', (type, data) => frames.push({ type, data }));
    client.connect();
    await waitFor(() => client.connected);

    expect(client.send('readyToAcceptJobs', { ready: true, reason: 'authenticated' })).toBe(true);
    await waitFor(() => server.received.length === 1);
    expect(server.received[0]).toEqual({
      type: 'readyToAcceptJobs',
      data: { ready: true, reason: 'authenticated' },
    });

    server.send('authenticated', { workerId: 'WORKER-UUID' });
    await waitFor(() => frames.length === 1);
    expect(frames[0]).toEqual({ type: 'authenticated', data: { workerId: 'WORKER-UUID' } });
  });

  it('computes exponential reconnect backoff with jitter and caps at maxDelayMs', () => {
    expect(computeReconnectDelayMs(0, { baseDelayMs: 2000, maxDelayMs: 30000, jitter: 0.25, random: 0.5 }))
      .toBe(2000);
    expect(computeReconnectDelayMs(2, { baseDelayMs: 2000, maxDelayMs: 30000, jitter: 0, random: 0 }))
      .toBe(4500);
    expect(computeReconnectDelayMs(20, { baseDelayMs: 2000, maxDelayMs: 30000, jitter: 0, random: 0 }))
      .toBe(30000);
  });

  it('reconnects after an unexpected close and resets attempts on authenticated', async () => {
    client = makeClient();
    client.connect();
    await waitFor(() => client.connected);

    server.closeClients(1012, 'rolling deploy');
    await waitFor(() => server.upgradeHeaders.length === 2);
    await waitFor(() => client.connected);
    expect(client.reconnectAttempts).toBeGreaterThanOrEqual(1);

    server.send('authenticated', { ok: true });
    await waitFor(() => client.reconnectAttempts === 0);
  });

  it('terminates and reconnects when no pong arrives within pongTimeoutMs', async () => {
    client = makeClient({ pingIntervalMs: 15, pongTimeoutMs: 25 });
    client.connect();
    await waitFor(() => client.connected);

    // Prevent mock server sockets from replying to ping with pong so pongTimeoutMs trips.
    for (const sock of server.sockets) {
      sock.pong = () => {};
    }
    client.lastPongAt = Date.now() - 100;

    await waitFor(() => server.upgradeHeaders.length >= 2);
  });

  it('flags exit code 102 and stops retrying on 4021 authentication failure', async () => {
    const previousExitCode = process.exitCode;
    const hardExit = vi.fn();
    try {
      client = makeClient({ hardExit, authFailureExitGraceMs: 25 });
      client.connect();
      await waitFor(() => client.connected);

      server.closeClients(4021, 'bad api key');
      await waitFor(() => process.exitCode === 102);
      expect(client.intentionalClose).toBe(true);
      await waitFor(() => hardExit.mock.calls.length === 1);
      expect(hardExit).toHaveBeenCalledWith(102);
      expect(server.upgradeHeaders.length).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('drops malformed frames without crashing or disconnecting', async () => {
    client = makeClient();
    const frames = [];
    client.on('frame', (type) => frames.push(type));
    client.connect();
    await waitFor(() => client.connected);

    for (const socket of server.sockets) socket.send('not-valid-json-envelope');
    server.send('authenticated', { ok: true });

    await waitFor(() => frames.length === 1);
    expect(frames).toEqual(['authenticated']);
  });

  it('computes a fresh session-timestamp on each connect() when sessionTimestamp is not pinned', async () => {
    const spy = vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1_710_000_000_000)
      .mockReturnValueOnce(1_710_000_005_000)
      .mockReturnValue(1_710_000_010_000);
    try {
      client = makeClient({ sessionTimestamp: null });
      client.connect();
      await waitFor(() => server.upgradeHeaders.length === 1);
      const firstTs = Number(server.upgradeHeaders[0]['session-timestamp']);

      spy.mockReturnValue(1_710_000_099_000);
      client.connect();
      await waitFor(() => server.upgradeHeaders.length === 2);
      const secondTs = Number(server.upgradeHeaders[1]['session-timestamp']);

      expect(secondTs).toBe(1_710_000_099);
      expect(secondTs).toBeGreaterThan(firstTs);
    } finally {
      spy.mockRestore();
    }
  });
});
