import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { decodeFrame, encodeFrame } from './envelope.js';

export const AUTH_FAILURE_CLOSE_CODE = 4021;
export const AUTH_FAILURE_EXIT_CODE = 102;

export class SogniSocketClient extends EventEmitter {
  constructor({
    url,
    apiKey,
    workerId,
    userAgent,
    reconnectInitialDelayMs = 5000,
    reconnectMaxDelayMs = 60000,
    WebSocketImpl = WebSocket,
    onAuthFailure = () => process.exit(AUTH_FAILURE_EXIT_CODE),
    logger = console,
  }) {
    super();
    this.url = url;
    this.apiKey = apiKey;
    this.workerId = workerId;
    this.userAgent = userAgent;
    this.reconnectInitialDelayMs = reconnectInitialDelayMs;
    this.reconnectMaxDelayMs = reconnectMaxDelayMs;
    this.reconnectDelay = reconnectInitialDelayMs;
    this.WebSocketImpl = WebSocketImpl;
    this.onAuthFailure = onAuthFailure;
    this.logger = logger;
    this.ws = null;
    this.reconnectTimer = null;
    this.connected = false;
    this.intentionalClose = false;
  }

  buildHeaders() {
    return {
      'api-key': this.apiKey,
      'app-id': this.workerId,
      'client-type': 'worker',
      'worker-subtype': 'speech',
      'user-agent': this.userAgent,
    };
  }

  connect() {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.terminate();
      this.ws = null;
    }

    this.intentionalClose = false;
    this.logger.log(`[speech-worker] Connecting to ${this.url} as ${this.workerId}`);

    const ws = new this.WebSocketImpl(this.url, { headers: this.buildHeaders() });
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.reconnectDelay = this.reconnectInitialDelayMs;
      this.logger.log('[speech-worker] Socket open');
      this.emit('open');
    });

    ws.on('message', (raw) => {
      let frame;
      try {
        frame = decodeFrame(raw);
      } catch (error) {
        this.logger.error(`[speech-worker] Dropping malformed frame: ${error.message}`);
        return;
      }
      this.emit('frame', frame.type, frame.data);
    });

    ws.on('close', (code, reason) => {
      this.connected = false;
      const reasonText = reason ? reason.toString() : '';
      this.logger.log(`[speech-worker] Socket closed: code=${code} reason=${reasonText}`);
      this.emit('close', code, reasonText);

      if (code === AUTH_FAILURE_CLOSE_CODE) {
        this.logger.error('[speech-worker] Broker rejected our API key (4021); not retrying');
        this.onAuthFailure();
        return;
      }

      if (!this.intentionalClose) this.scheduleReconnect();
    });

    // 'error' is emitted with a listener here on purpose: a bare EventEmitter
    // 'error' with no listener would crash the process.
    ws.on('error', (error) => {
      this.logger.error(`[speech-worker] Socket error: ${error.message}`);
      this.emit('socketError', error);
    });
  }

  send(type, data = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn(`[speech-worker] Cannot send ${type}: socket is not open`);
      return false;
    }
    this.ws.send(encodeFrame(type, data));
    return true;
  }

  scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    const delay = this.reconnectDelay;
    this.logger.log(`[speech-worker] Reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.reconnectMaxDelayMs);
  }

  close(code = 1000, reason = 'Graceful shutdown') {
    this.intentionalClose = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close(code, reason);
      this.ws = null;
    }

    this.connected = false;
  }
}
