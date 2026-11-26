import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import {
  buildUserAgent,
  isRunningInDocker,
  resolveWorkerType,
} from './config.js';
import { decodeFrame, encodeFrame } from './envelope.js';

export const AUTH_FAILURE_CLOSE_CODE = 4021;
export const AUTH_FAILURE_EXIT_CODE = 102;
export const VERSION_UPGRADE_CLOSE_CODE = 4009;
export const PING_INTERVAL_MS = 15_000;
export const PONG_TIMEOUT_MS = 120_000;
export const RECONNECT_BASE_DELAY_MS = 2_000;
export const RECONNECT_MAX_DELAY_MS = 30_000;
export const RECONNECT_JITTER = 0.25;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function computeReconnectDelayMs(
  attempt,
  {
    baseDelayMs = RECONNECT_BASE_DELAY_MS,
    maxDelayMs = RECONNECT_MAX_DELAY_MS,
    jitter = RECONNECT_JITTER,
    random = Math.random(),
  } = {},
) {
  const base = Math.min(baseDelayMs * (1.5 ** Math.max(0, attempt)), maxDelayMs);
  return Math.max(1, Math.round(base * (1 - jitter + random * 2 * jitter)));
}

export class SogniSocketClient extends EventEmitter {
  constructor({
    url,
    socketApiUrl = null,
    origin = undefined,
    sogniEnv = 'staging',
    apiKey,
    nftTokenId = '',
    workerId,
    workerType = resolveWorkerType(),
    runningInDocker = isRunningInDocker(),
    userAgent = buildUserAgent(),
    sessionTimestamp = null,
    validateClientKey = false,
    pingIntervalMs = PING_INTERVAL_MS,
    pongTimeoutMs = PONG_TIMEOUT_MS,
    reconnectInitialDelayMs = RECONNECT_BASE_DELAY_MS,
    reconnectMaxDelayMs = RECONNECT_MAX_DELAY_MS,
    reconnectJitter = RECONNECT_JITTER,
    authFailureExitGraceMs = 1000,
    WebSocketImpl = WebSocket,
    fetchImpl = fetch,
    onAuthFailure = null,
    onFatalClose = null,
    hardExit = (code) => process.exit(code),
    logger = console,
  }) {
    super();
    this.url = url;
    this.socketApiUrl = socketApiUrl;
    this.origin = origin || url;
    this.sogniEnv = sogniEnv;
    this.apiKey = apiKey;
    this.nftTokenId = nftTokenId || '';
    this.workerId = workerId;
    this.workerType = workerType;
    this.runningInDocker = Boolean(runningInDocker);
    this.userAgent = userAgent;
    this.fixedSessionTimestamp = sessionTimestamp;
    this.sessionTimestamp = sessionTimestamp ?? Math.floor(Date.now() / 1000);
    this.shouldValidateClientKey = Boolean(validateClientKey && socketApiUrl);
    this.pingIntervalMs = pingIntervalMs;
    this.pongTimeoutMs = pongTimeoutMs;
    this.reconnectInitialDelayMs = reconnectInitialDelayMs;
    this.reconnectMaxDelayMs = reconnectMaxDelayMs;
    this.reconnectJitter = reconnectJitter;
    this.reconnectAttempts = 0;
    this.lastScheduledDelayMs = reconnectInitialDelayMs;
    this.authFailureExitGraceMs = authFailureExitGraceMs;
    this.WebSocketImpl = WebSocketImpl;
    this.fetchImpl = fetchImpl;
    this.onAuthFailure = onAuthFailure || (() => this.exitOnAuthFailure());
    this.onFatalClose = onFatalClose;
    this.hardExit = hardExit;
    this.logger = logger;

    this.ws = null;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.lastPongAt = null;
    this.connected = false;
    this.intentionalClose = false;
  }

  buildHeaders() {
    return {
      'app-id': this.workerId,
      'client-type': 'worker',
      'origin': this.origin,
      'user-agent': this.userAgent,
      'session-timestamp': String(this.sessionTimestamp),
      'api-key': this.apiKey,
      ...(this.nftTokenId ? { 'nft-token-id': this.nftTokenId } : {}),
      'worker-type': this.workerType,
      'runningindocker': this.runningInDocker ? '1' : '0',
    };
  }

  safeEmit(event, ...args) {
    try {
      this.emit(event, ...args);
    } catch (error) {
      this.logger.error(`[voice-worker] ${event} listener threw: ${error.message}`);
    }
  }

  async validateClientKey(retry = 0) {
    if (!this.socketApiUrl) return;
    const endpoint = `${String(this.socketApiUrl).replace(/\/+$/, '')}/v1/client/key`;
    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: this.apiKey,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        const error = new Error(
          `Client key validation failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
        );
        error.status = response.status;
        throw error;
      }
    } catch (error) {
      if (error?.status === 401 || error?.status === 403) {
        throw error;
      }
      const attempt = retry + 1;
      this.logger.warn?.(
        `[voice-worker] Client key validation failed (attempt ${attempt}/3): ${error.message}`,
      );
      if (attempt >= 3) throw error;
      await sleep(1000 * attempt);
      return this.validateClientKey(attempt);
    }
  }

  async start() {
    if (this.shouldValidateClientKey) {
      await this.validateClientKey();
    }
    this.connect();
  }

  connect() {
    if (this.ws) {
      const stale = this.ws;
      stale.removeAllListeners();
      stale.on('error', () => {});
      stale.terminate();
      this.ws = null;
      this.connected = false;
      this.stopPingLoop();
    }

    this.intentionalClose = false;
    if (this.fixedSessionTimestamp === null || this.fixedSessionTimestamp === undefined) {
      this.sessionTimestamp = Math.floor(Date.now() / 1000);
    }
    const headers = this.buildHeaders();
    this.logger.log(
      `[voice-worker] Connecting to ${this.url} as ${this.workerId} (UA: "${headers['user-agent']}")`,
    );

    const ws = new this.WebSocketImpl(this.url, {
      headers,
      ...(this.sogniEnv === 'local' ? { rejectUnauthorized: false } : {}),
    });
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.lastPongAt = Date.now();
      this.startPingLoop();
      this.logger.log(`[voice-worker] Connected to Sogni socket (${this.sogniEnv})`);
      this.safeEmit('open');
    });

    ws.on('message', (raw) => {
      this.lastPongAt = Date.now();
      const rawStr = typeof raw === 'string' ? raw : raw.toString('utf-8');
      if (!rawStr || rawStr.length < 10) return;

      let frame;
      try {
        frame = decodeFrame(rawStr);
      } catch (error) {
        this.logger.warn?.(`[voice-worker] Dropping malformed frame: ${error.message}`);
        return;
      }

      if (!frame || frame.data === null || typeof frame.data !== 'object') {
        this.logger.warn?.(`[voice-worker] Dropping frame "${frame?.type}" with empty/invalid data`);
        return;
      }

      if (frame.type === 'authenticated') {
        this.reconnectAttempts = 0;
      }

      this.safeEmit('frame', frame.type, frame.data);
    });

    ws.on('ping', () => {
      this.lastPongAt = Date.now();
    });

    ws.on('pong', () => {
      this.lastPongAt = Date.now();
    });

    ws.on('close', (code, reason) => {
      this.connected = false;
      this.stopPingLoop();
      const reasonText = reason ? Buffer.from(reason).toString('utf-8') : '';
      this.logger.warn?.(`[voice-worker] Socket closed: code=${code} reason="${reasonText}"`);
      this.safeEmit('close', code, reasonText);

      if (code === AUTH_FAILURE_CLOSE_CODE) {
        this.logger.error('[voice-worker] Socket authentication rejected (4021); not retrying');
        this.onAuthFailure(reasonText);
        return;
      }

      if (code === VERSION_UPGRADE_CLOSE_CODE) {
        this.logger.warn?.(`[voice-worker] Socket requested version upgrade (4009): ${reasonText}`);
        if (this.onFatalClose) {
          this.onFatalClose(code, reasonText, 0);
        } else {
          this.close(1000, 'Version upgrade requested');
        }
        return;
      }

      if (code >= 4000 && code !== 4019 && this.onFatalClose) {
        this.onFatalClose(code, reasonText, 2);
        return;
      }

      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    });

    ws.on('error', (error) => {
      this.logger.warn?.(`[voice-worker] Socket error: ${error.message}`);
      this.safeEmit('socketError', error);
    });
  }

  startPingLoop() {
    this.stopPingLoop();
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (this.lastPongAt !== null && Date.now() - this.lastPongAt > this.pongTimeoutMs) {
        this.logger.warn?.(
          `[voice-worker] No pong from Sogni socket in ${Math.round((Date.now() - this.lastPongAt) / 1000)}s; terminating half-open socket`,
        );
        this.ws.terminate();
        return;
      }
      if (typeof this.ws.ping === 'function') {
        this.ws.ping();
      }
    }, this.pingIntervalMs);
    if (typeof this.pingTimer.unref === 'function') this.pingTimer.unref();
  }

  stopPingLoop() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  exitOnAuthFailure() {
    process.exitCode = AUTH_FAILURE_EXIT_CODE;
    this.close(1000, 'Authentication failed');
    const timer = setTimeout(
      () => this.hardExit(AUTH_FAILURE_EXIT_CODE),
      this.authFailureExitGraceMs,
    );
    if (typeof timer.unref === 'function') timer.unref();
  }

  send(type, data = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn?.(`[voice-worker] Cannot send ${type}: socket is not open`);
      return false;
    }
    this.ws.send(encodeFrame(type, data));
    return true;
  }

  scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    const attempt = this.reconnectAttempts++;
    const delay = computeReconnectDelayMs(attempt, {
      baseDelayMs: this.reconnectInitialDelayMs,
      maxDelayMs: this.reconnectMaxDelayMs,
      jitter: this.reconnectJitter,
    });
    this.lastScheduledDelayMs = delay;
    this.logger.log(`[voice-worker] Reconnecting in ${delay}ms (attempt ${attempt + 1})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  close(code = 1000, reason = 'Graceful shutdown') {
    this.intentionalClose = true;
    this.stopPingLoop();

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
