import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { decodeFrame, encodeFrame } from './envelope.js';

export const AUTH_FAILURE_CLOSE_CODE = 4021;
export const AUTH_FAILURE_EXIT_CODE = 102;

// The broker pings every 15s. Two missed pings plus slack is a dead peer, not a
// quiet one — a TCP connection that dies without a FIN (NAT timeout, laptop
// sleep, a broker host that vanishes) leaves ws in OPEN forever, so nothing else
// would ever fire the reconnect.
export const INBOUND_IDLE_THRESHOLD_MS = 37500;
export const INBOUND_IDLE_CHECK_INTERVAL_MS = 45000;

export class SogniSocketClient extends EventEmitter {
  constructor({
    url,
    apiKey,
    nftTokenId,
    workerId,
    userAgent,
    reconnectInitialDelayMs = 5000,
    reconnectMaxDelayMs = 60000,
    inboundIdleThresholdMs = INBOUND_IDLE_THRESHOLD_MS,
    inboundIdleCheckIntervalMs = INBOUND_IDLE_CHECK_INTERVAL_MS,
    authFailureExitGraceMs = 1000,
    WebSocketImpl = WebSocket,
    onAuthFailure = null,
    hardExit = (code) => process.exit(code),
    logger = console,
  }) {
    super();
    this.url = url;
    this.apiKey = apiKey;
    this.nftTokenId = nftTokenId;
    this.workerId = workerId;
    this.userAgent = userAgent;
    this.reconnectInitialDelayMs = reconnectInitialDelayMs;
    this.reconnectMaxDelayMs = reconnectMaxDelayMs;
    this.reconnectDelay = reconnectInitialDelayMs;
    this.inboundIdleThresholdMs = inboundIdleThresholdMs;
    this.inboundIdleCheckIntervalMs = inboundIdleCheckIntervalMs;
    this.authFailureExitGraceMs = authFailureExitGraceMs;
    this.WebSocketImpl = WebSocketImpl;
    // Bound in the body, not as a parameter default: `this` is still in TDZ while
    // the constructor's defaults are evaluated.
    this.onAuthFailure = onAuthFailure || (() => this.exitOnAuthFailure());
    this.hardExit = hardExit;
    this.logger = logger;
    this.ws = null;
    this.reconnectTimer = null;
    this.inboundTimer = null;
    this.lastInboundAt = null;
    this.connected = false;
    this.intentionalClose = false;
  }

  // Standard worker auth: api-key + nft-token-id, client-type 'worker'.
  // NO authorization header (its presence forces the JWT branch and api-key
  // auth never runs) and NO worker-subtype (that selects the LLM lane).
  buildHeaders() {
    return {
      'api-key': this.apiKey,
      'nft-token-id': this.nftTokenId,
      'app-id': this.workerId,
      'client-type': 'worker',
      'user-agent': this.userAgent,
    };
  }

  // Listeners live outside our control once a frame is handed off, so a throwing
  // listener must never escape into ws's internals: it would either kill the
  // process or, on the close path, skip the reconnect and strand the worker.
  safeEmit(event, ...args) {
    try {
      this.emit(event, ...args);
    } catch (error) {
      this.logger.error(`[speech-worker] ${event} listener threw: ${error.message}`);
    }
  }

  connect() {
    if (this.ws) {
      const stale = this.ws;
      stale.removeAllListeners();
      // terminate() on a CONNECTING socket aborts the handshake and emits 'error'
      // on the next tick; with no listener left that is an unhandled 'error' and
      // the worker dies. Keep a no-op listener on the socket we are discarding.
      stale.on('error', () => {});
      stale.terminate();
      this.ws = null;
      // The discarded socket's 'close' never reaches our handler, so retire its
      // watchdog here: left running, it would judge the *new* socket by the old
      // one's clock and terminate a handshake that is still in flight.
      this.connected = false;
      this.stopInboundWatchdog();
    }

    this.intentionalClose = false;
    this.logger.log(`[speech-worker] Connecting to ${this.url} as ${this.workerId}`);

    const ws = new this.WebSocketImpl(this.url, { headers: this.buildHeaders() });
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.reconnectDelay = this.reconnectInitialDelayMs;
      this.lastInboundAt = Date.now();
      this.startInboundWatchdog();
      this.logger.log('[speech-worker] Socket open');
      this.safeEmit('open');
    });

    ws.on('message', (raw) => {
      this.lastInboundAt = Date.now();
      let frame;
      try {
        frame = decodeFrame(raw);
      } catch (error) {
        this.logger.error(`[speech-worker] Dropping malformed frame: ${error.message}`);
        return;
      }
      this.safeEmit('frame', frame.type, frame.data);
    });

    // ws answers a ping with a pong on its own; these listeners only stamp the
    // clock. A broker that is pinging is alive even when it has no frames for us.
    ws.on('ping', () => {
      this.lastInboundAt = Date.now();
    });

    ws.on('pong', () => {
      this.lastInboundAt = Date.now();
    });

    ws.on('close', (code, reason) => {
      this.connected = false;
      this.stopInboundWatchdog();
      const reasonText = reason ? reason.toString() : '';
      this.logger.log(`[speech-worker] Socket closed: code=${code} reason=${reasonText}`);
      this.safeEmit('close', code, reasonText);

      if (code === AUTH_FAILURE_CLOSE_CODE) {
        this.logger.error('[speech-worker] Broker rejected our API key / NFT (4021); not retrying');
        this.onAuthFailure();
        return;
      }

      if (!this.intentionalClose) this.scheduleReconnect();
    });

    // 'error' is emitted with a listener here on purpose: a bare EventEmitter
    // 'error' with no listener would crash the process.
    ws.on('error', (error) => {
      this.logger.error(`[speech-worker] Socket error: ${error.message}`);
      this.safeEmit('socketError', error);
    });
  }

  // terminate() (not close()) on purpose: a half-open socket's peer is gone, so a
  // close handshake would just hang until ws's own timeout. terminate() emits
  // 'close' synchronously enough for the existing backoff to own the recovery.
  startInboundWatchdog() {
    this.stopInboundWatchdog();
    this.inboundTimer = setInterval(
      () => this.checkInboundLiveness(),
      this.inboundIdleCheckIntervalMs,
    );
    if (typeof this.inboundTimer.unref === 'function') this.inboundTimer.unref();
  }

  stopInboundWatchdog() {
    if (this.inboundTimer) {
      clearInterval(this.inboundTimer);
      this.inboundTimer = null;
    }
  }

  checkInboundLiveness() {
    if (!this.ws || !this.connected || this.lastInboundAt === null) return;

    const idleMs = Date.now() - this.lastInboundAt;
    if (idleMs < this.inboundIdleThresholdMs) return;

    this.logger.error(
      `[speech-worker] No inbound traffic for ${idleMs}ms; terminating half-open socket`,
    );
    this.stopInboundWatchdog();
    this.ws.terminate();
  }

  // This key will be rejected on every retry, so the process has to die with 102
  // for PM2's stop_exit_codes to stop restarting it. A bare process.exit() can cut
  // the diagnostic above off mid-write when stderr is a pipe, so flag the code and
  // tear the socket down instead, and let the loop drain on its own. The unref'd
  // backstop only ever fires when something else — a pre-warmed Python daemon's
  // handles — is holding the loop open past the grace period.
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
    this.stopInboundWatchdog();

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
