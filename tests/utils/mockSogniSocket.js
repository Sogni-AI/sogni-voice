import { WebSocketServer } from 'ws';
import { encodeFrame, decodeFrame } from '../../src/network/envelope.js';

export async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

export async function startMockSogniSocket() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));

  const received = [];
  const sockets = [];
  const upgradeHeaders = [];

  server.on('connection', (socket, request) => {
    upgradeHeaders.push(request.headers);
    sockets.push(socket);
    socket.on('message', (raw) => received.push(decodeFrame(raw)));
  });

  return {
    url: `ws://127.0.0.1:${server.address().port}`,
    received,
    sockets,
    upgradeHeaders,
    get headers() {
      return upgradeHeaders[upgradeHeaders.length - 1] || null;
    },
    send(type, data) {
      for (const socket of sockets) socket.send(encodeFrame(type, data));
    },
    closeClients(code = 1012, reason = 'test close') {
      for (const socket of sockets) socket.close(code, reason);
    },
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
