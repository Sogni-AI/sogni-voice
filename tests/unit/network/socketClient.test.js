import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SogniSocketClient } from '../../../src/network/socketClient.js';
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
    apiKey: 'test-api-key',
    workerId: 'WORKER-UUID',
    userAgent: 'Sogni/3.0.118 (Darwin) | Speech:MLX | speech-worker/1.0.0',
    reconnectInitialDelayMs: 20,
    reconnectMaxDelayMs: 80,
    logger: silentLogger,
    ...overrides,
  });

  it('sends the frozen upgrade headers and no nft-token-id', async () => {
    client = makeClient();
    client.connect();
    await waitFor(() => server.headers !== null);

    expect(server.headers['api-key']).toBe('test-api-key');
    expect(server.headers['app-id']).toBe('WORKER-UUID');
    expect(server.headers['client-type']).toBe('worker');
    expect(server.headers['worker-subtype']).toBe('speech');
    expect(server.headers['user-agent'])
      .toBe('Sogni/3.0.118 (Darwin) | Speech:MLX | speech-worker/1.0.0');
    expect(server.headers['nft-token-id']).toBeUndefined();
  });

  it('emits open and delivers decoded frames', async () => {
    client = makeClient();
    const frames = [];
    const opened = vi.fn();
    client.on('open', opened);
    client.on('frame', (type, data) => frames.push({ type, data }));
    client.connect();

    await waitFor(() => opened.mock.calls.length === 1);
    server.send('authenticated', { workerId: 'WORKER-UUID' });

    await waitFor(() => frames.length === 1);
    expect(frames[0]).toEqual({ type: 'authenticated', data: { workerId: 'WORKER-UUID' } });
    expect(client.connected).toBe(true);
  });

  it('encodes outbound sends as base64 envelopes', async () => {
    client = makeClient();
    client.connect();
    await waitFor(() => client.connected);

    expect(client.send('speechCapacityUpdate', { activeRequests: 1 })).toBe(true);
    await waitFor(() => server.received.length === 1);
    expect(server.received[0]).toEqual({
      type: 'speechCapacityUpdate',
      data: { activeRequests: 1 },
    });
  });

  it('refuses to send while disconnected', () => {
    client = makeClient();
    expect(client.send('workerInfo', {})).toBe(false);
  });

  it('reconnects with exponential backoff after an unexpected close', async () => {
    client = makeClient();
    client.connect();
    await waitFor(() => client.connected);
    expect(client.reconnectDelay).toBe(20);

    // The delay is bumped synchronously after the 'close' emit and reset again by
    // the reconnect's 'open', so sample it on the microtask that follows the close
    // rather than after the reconnect lands.
    let delayAfterClose = null;
    client.once('close', () => queueMicrotask(() => {
      delayAfterClose = client.reconnectDelay;
    }));

    // 1006 is reserved and ws refuses to send it; 1012 (Service Restart) is the
    // closest thing the broker would emit on a rolling deploy.
    server.closeClients(1012, 'server restart');
    await waitFor(() => server.upgradeHeaders.length === 2);

    expect(delayAfterClose).toBe(40);
    await waitFor(() => client.reconnectDelay === 20);
  });

  it('caps the backoff delay at the configured maximum', async () => {
    const deadServer = await startMockSogniSocket();
    const deadUrl = deadServer.url;
    await deadServer.close();

    client = makeClient({ url: deadUrl });
    const delays = [];
    client.on('close', () => queueMicrotask(() => delays.push(client.reconnectDelay)));
    client.connect();

    await waitFor(() => delays.length >= 4);
    expect(delays.slice(0, 4)).toEqual([40, 80, 80, 80]);
  });

  it('exits without retrying when the broker closes with 4021', async () => {
    const onAuthFailure = vi.fn();
    client = makeClient({ onAuthFailure });
    client.connect();
    await waitFor(() => client.connected);

    server.closeClients(4021, 'bad api key');
    await waitFor(() => onAuthFailure.mock.calls.length === 1);

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(server.upgradeHeaders.length).toBe(1);
  });

  it('flags exit code 102 and stops retrying on 4021 without a hard exit', async () => {
    const previousExitCode = process.exitCode;
    const hardExit = vi.fn();
    try {
      // Default onAuthFailure (no injected override): the graceful path.
      client = makeClient({ hardExit, authFailureExitGraceMs: 30 });
      client.connect();
      await waitFor(() => client.connected);

      server.closeClients(4021, 'bad api key');
      await waitFor(() => process.exitCode === 102);

      expect(hardExit).not.toHaveBeenCalled();
      expect(client.intentionalClose).toBe(true);

      // Vitest's own loop keeps the process alive, so the backstop always fires
      // here; in the worker it only fires when a daemon handle outlives the grace.
      await waitFor(() => hardExit.mock.calls.length === 1);
      expect(hardExit).toHaveBeenCalledWith(102);
      expect(server.upgradeHeaders.length).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('terminates and reconnects when the broker goes silent', async () => {
    // The mock server never pings, so every check after the first is idle.
    client = makeClient({ inboundIdleCheckIntervalMs: 10, inboundIdleThresholdMs: 25 });
    client.connect();
    await waitFor(() => client.connected);
    expect(server.upgradeHeaders.length).toBe(1);

    await waitFor(() => server.upgradeHeaders.length === 2);
    await waitFor(() => client.connected);
  });

  it('leaves the socket alone while frames keep arriving', async () => {
    client = makeClient({ inboundIdleCheckIntervalMs: 25, inboundIdleThresholdMs: 120 });
    client.connect();
    await waitFor(() => client.connected);

    const chatter = setInterval(() => server.send('speechCapacityRequest', {}), 20);
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      clearInterval(chatter);
    }

    expect(server.upgradeHeaders.length).toBe(1);
    expect(client.connected).toBe(true);
  });

  it('stops the watchdog on an intentional close', async () => {
    client = makeClient({ inboundIdleCheckIntervalMs: 10, inboundIdleThresholdMs: 25 });
    client.connect();
    await waitFor(() => client.connected);

    client.close();
    expect(client.inboundTimer).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(server.upgradeHeaders.length).toBe(1);
  });

  it('does not reconnect after an intentional close', async () => {
    client = makeClient();
    client.connect();
    await waitFor(() => client.connected);

    client.close();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(server.upgradeHeaders.length).toBe(1);
  });

  it('survives a second connect() while the first handshake is in flight', async () => {
    client = makeClient();
    client.connect();
    // Tears down a still-CONNECTING socket: ws aborts the handshake and emits a
    // deferred 'error', which is an unhandled 'error' unless we keep a listener.
    client.connect();

    await waitFor(() => client.connected);
    expect(client.send('workerInfo', {})).toBe(true);
    await waitFor(() => server.received.length === 1);
    expect(server.received[0].type).toBe('workerInfo');
  });

  it('keeps the socket alive when a frame listener throws', async () => {
    client = makeClient();
    const seen = [];
    client.on('frame', (type) => {
      seen.push(type);
      if (type === 'boom') throw new Error('listener exploded');
    });
    client.connect();
    await waitFor(() => client.connected);

    server.send('boom', {});
    await waitFor(() => seen.length === 1);
    server.send('authenticated', {});

    await waitFor(() => seen.length === 2);
    expect(seen).toEqual(['boom', 'authenticated']);
    expect(client.connected).toBe(true);
  });

  it('still reconnects when a close listener throws', async () => {
    client = makeClient();
    client.on('close', () => {
      throw new Error('close listener exploded');
    });
    client.connect();
    await waitFor(() => client.connected);

    server.closeClients(1012, 'server restart');
    await waitFor(() => server.upgradeHeaders.length === 2);
    await waitFor(() => client.connected);
  });

  it('drops malformed frames without throwing', async () => {
    client = makeClient();
    const frames = [];
    client.on('frame', (type) => frames.push(type));
    client.connect();
    await waitFor(() => client.connected);

    for (const socket of server.sockets) socket.send('this is not json');
    server.send('authenticated', {});

    await waitFor(() => frames.length === 1);
    expect(frames).toEqual(['authenticated']);
  });
});
