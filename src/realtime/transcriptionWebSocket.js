import { WebSocket, WebSocketServer } from 'ws';
import { config } from '../config/index.js';
import { transcriptionService } from '../services/transcription.js';
import { apiKeysMatch, extractApiKeyFromHeaders } from '../utils/apiKey.js';
import { buildCorsPolicy, isCorsOriginAllowed } from '../utils/cors.js';

export const REALTIME_TRANSCRIPTION_PATH = '/v1/realtime/transcription';
export const REALTIME_TRANSCRIPTION_PROTOCOL = 'sogni.parakeet.realtime.v1';

const closeReasons = {
  badRequest: 1008,
  internalError: 1011,
  busy: 1013,
};

const protocolError = (message, realtimeCode = 'invalid_request') => {
  const error = new Error(message);
  error.realtimeCode = realtimeCode;
  return error;
};

const sendHttpError = (socket, statusCode, statusText) => {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
};

const isSameOrigin = (origin, request) => {
  if (!origin || !request.headers.host) return false;
  try {
    return new URL(origin).host.toLowerCase() === request.headers.host.toLowerCase();
  } catch {
    return false;
  }
};

const publicError = (error) => {
  const message = error?.message || 'Realtime transcription failed';
  if (error?.realtimeCode === 'unauthorized') {
    return {
      code: 'unauthorized',
      message,
      retryable: false,
      closeCode: closeReasons.badRequest,
    };
  }
  if (error?.realtimeCode === 'invalid_request') {
    return {
      code: 'invalid_request',
      message,
      retryable: false,
      closeCode: closeReasons.badRequest,
    };
  }
  if (error?.realtimeCode === 'backpressure') {
    return {
      code: 'backpressure',
      message,
      retryable: true,
      closeCode: closeReasons.busy,
    };
  }
  if (/session exceeds the .* second limit/i.test(message)) {
    return {
      code: 'duration_limit',
      message,
      retryable: false,
      closeCode: closeReasons.badRequest,
    };
  }
  if (/realtime audio|float32 pcm|non-finite samples|accepted range/i.test(message)) {
    return {
      code: 'invalid_audio',
      message,
      retryable: false,
      closeCode: closeReasons.badRequest,
    };
  }
  if (/already active|\bbusy\b/i.test(message)) {
    return { code: 'busy', message, retryable: true, closeCode: closeReasons.busy };
  }
  if (/disabled/i.test(message)) {
    return {
      code: 'realtime_disabled',
      message,
      retryable: false,
      closeCode: closeReasons.badRequest,
    };
  }
  if (/timed out|terminated|not available/i.test(message)) {
    return {
      code: 'service_unavailable',
      message,
      retryable: true,
      closeCode: closeReasons.internalError,
    };
  }
  return {
    code: 'transcription_error',
    message,
    retryable: false,
    closeCode: closeReasons.internalError,
  };
};

const parseClientMessage = (data) => {
  let message;
  try {
    message = JSON.parse(data.toString('utf8'));
  } catch {
    throw protocolError('Text messages must contain valid JSON');
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw protocolError('Realtime messages must be JSON objects');
  }
  return message;
};

export const attachRealtimeTranscriptionWebSocket = (
  server,
  {
    service = transcriptionService,
    realtimeConfig = config.transcription,
    authConfig = config.auth,
    corsOrigins = config.server.corsOrigins,
  } = {},
) => {
  const maxChunkBytes = realtimeConfig?.realtimeMaxChunkBytes || 256 * 1024;
  const maxQueuedBytes = maxChunkBytes * 4;
  const idleTimeoutMs = realtimeConfig?.realtimeIdleTimeout || 15000;
  const effectiveAuthConfig = authConfig || { enabled: false, apiKey: null };
  const corsPolicy = buildCorsPolicy(corsOrigins || []);
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxChunkBytes });
  const cleanupPromises = new Set();

  const trackCleanup = (promise) => {
    cleanupPromises.add(promise);
    promise.then(
      () => cleanupPromises.delete(promise),
      () => cleanupPromises.delete(promise),
    );
    return promise;
  };

  const handleConnection = (socket, request) => {
    let state = 'awaiting_start';
    let sessionId = null;
    let idleTimer = null;
    let operationQueue = Promise.resolve();
    let queuedAudioBytes = 0;
    const headerApiKey = extractApiKeyFromHeaders(request.headers);

    const send = (message) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    };

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (state === 'closed' || state === 'starting') return;
      idleTimer = setTimeout(() => {
        const currentSessionId = sessionId;
        sessionId = null;
        state = 'closed';
        send({
          type: 'error',
          code: 'idle_timeout',
          message: `No realtime audio received for ${idleTimeoutMs} ms`,
          retryable: true,
        });
        socket.close(closeReasons.badRequest, 'idle timeout');
        if (currentSessionId) {
          void trackCleanup(service.abortRealtimeSession(currentSessionId).catch(() => {}));
        }
      }, idleTimeoutMs);
      idleTimer.unref?.();
    };

    const fail = async (error) => {
      if (state === 'closed') return;
      const currentSessionId = sessionId;
      sessionId = null;
      state = 'closed';
      if (idleTimer) clearTimeout(idleTimer);

      const details = publicError(error);
      send({
        type: 'error',
        code: details.code,
        message: details.message,
        retryable: details.retryable,
      });
      if (currentSessionId) {
        try {
          await service.abortRealtimeSession(currentSessionId);
        } catch {
          // The underlying daemon recovery is handled by the service.
        }
      }
      socket.close(details.closeCode, details.code);
    };

    const authenticate = (messageApiKey) => {
      if (!effectiveAuthConfig.enabled) return true;
      return apiKeysMatch(headerApiKey || messageApiKey, effectiveAuthConfig.apiKey);
    };

    const start = async (message) => {
      if (state !== 'awaiting_start') {
        throw protocolError('A realtime session has already been started on this connection');
      }
      if (!authenticate(message.apiKey)) {
        const error = new Error('Missing or invalid API key');
        error.realtimeCode = 'unauthorized';
        throw error;
      }
      if (message.encoding != null && message.encoding !== 'pcm_f32le') {
        throw protocolError('Only pcm_f32le audio encoding is supported');
      }
      if (message.sampleRate != null && message.sampleRate !== 16000) {
        throw protocolError('Realtime PCM must use a 16000 Hz sample rate');
      }

      state = 'starting';
      if (idleTimer) clearTimeout(idleTimer);
      const started = await service.startRealtimeSession();
      if (state === 'closed' || socket.readyState !== WebSocket.OPEN) {
        await service.abortRealtimeSession(started.session_id).catch(() => {});
        return;
      }
      sessionId = started.session_id;
      state = 'streaming';
      send({
        type: 'session.started',
        sessionId,
        model: service.getModelInfo(),
        encoding: started.encoding,
        sampleRate: started.sample_rate,
        maxSeconds: started.max_seconds,
        contextSize: started.context_size,
        depth: started.depth,
      });
      resetIdleTimer();
    };

    const handleAudio = async (audio) => {
      if (state !== 'streaming' || !sessionId) {
        throw protocolError('Send a start message before streaming audio');
      }
      if (audio.length === 0 || audio.length % 4 !== 0) {
        throw protocolError('Binary messages must contain non-empty float32 PCM frames');
      }
      if (audio.length > maxChunkBytes) {
        throw protocolError('Realtime audio chunk exceeds the configured size limit');
      }

      const update = await service.sendRealtimeAudio(sessionId, audio);
      send({
        type: 'transcript.partial',
        sessionId,
        sequence: update.sequence,
        text: update.text,
        finalizedText: update.finalized_text,
        draftText: update.draft_text,
        finalizedDelta: update.finalized_delta,
        audioSeconds: update.audio_seconds,
        processingSeconds: update.processing_seconds,
        realTimeFactor: update.real_time_factor,
      });
      resetIdleTimer();
    };

    const stop = async () => {
      if (state !== 'streaming' || !sessionId) {
        throw protocolError('No realtime session is available to stop');
      }
      state = 'finalizing';
      if (idleTimer) clearTimeout(idleTimer);
      const finishingSessionId = sessionId;
      const result = await service.finishRealtimeSession(finishingSessionId);
      sessionId = null;
      state = 'closed';
      send({
        type: 'transcript.final',
        sessionId: finishingSessionId,
        sequence: result.sequence,
        text: result.text,
        finalizedText: result.finalized_text,
        draftText: result.draft_text,
        timestamps: result.timestamps || [],
        audioSeconds: result.audio_seconds,
        realTimeFactor: result.real_time_factor,
      });
      socket.close(1000, 'complete');
    };

    const abort = async () => {
      const abortingSessionId = sessionId;
      sessionId = null;
      state = 'closed';
      if (idleTimer) clearTimeout(idleTimer);
      if (abortingSessionId) await service.abortRealtimeSession(abortingSessionId);
      send({ type: 'session.aborted', sessionId: abortingSessionId });
      socket.close(1000, 'aborted');
    };

    const handleMessage = async (data, isBinary) => {
      if (isBinary) {
        await handleAudio(Buffer.from(data));
        return;
      }

      const message = parseClientMessage(data);
      switch (message.type) {
        case 'start':
          await start(message);
          break;
        case 'stop':
          await stop();
          break;
        case 'abort':
          await abort();
          break;
        case 'ping':
          send({ type: 'pong' });
          resetIdleTimer();
          break;
        default:
          throw protocolError(`Unknown realtime message type: ${message.type || '(missing)'}`);
      }
    };

    socket.on('message', (data, isBinary) => {
      if (state === 'closed') return;
      resetIdleTimer();
      const audioBytes = isBinary ? data.length : 0;
      if (audioBytes && queuedAudioBytes + audioBytes > maxQueuedBytes) {
        void fail(protocolError(
          'Realtime audio arrived faster than it could be processed',
          'backpressure',
        ));
        return;
      }
      queuedAudioBytes += audioBytes;
      operationQueue = operationQueue
        .then(() => handleMessage(data, isBinary))
        .catch(fail)
        .finally(() => {
          queuedAudioBytes -= audioBytes;
        });
    });

    socket.on('close', () => {
      if (idleTimer) clearTimeout(idleTimer);
      const closingSessionId = sessionId;
      sessionId = null;
      state = 'closed';
      if (closingSessionId) {
        const abortAfterQueue = () => (
          service.abortRealtimeSession(closingSessionId).catch(() => {})
        );
        void trackCleanup(operationQueue.then(abortAfterQueue, abortAfterQueue));
      }
    });

    socket.on('error', () => {
      // close performs session cleanup.
    });

    send({
      type: 'connected',
      protocol: REALTIME_TRANSCRIPTION_PROTOCOL,
      path: REALTIME_TRANSCRIPTION_PATH,
      requiresAuth: Boolean(effectiveAuthConfig.enabled),
      encoding: 'pcm_f32le',
      sampleRate: 16000,
      maxChunkBytes,
    });
    resetIdleTimer();
  };

  wss.on('connection', handleConnection);

  const handleUpgrade = (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url, 'http://localhost').pathname;
    } catch {
      sendHttpError(socket, 400, 'Bad Request');
      return;
    }

    if (pathname !== REALTIME_TRANSCRIPTION_PATH) {
      sendHttpError(socket, 404, 'Not Found');
      return;
    }

    const origin = request.headers.origin;
    if (origin && !isSameOrigin(origin, request) && !isCorsOriginAllowed(origin, corsPolicy)) {
      sendHttpError(socket, 403, 'Forbidden');
      return;
    }

    if (effectiveAuthConfig.enabled) {
      const headerApiKey = extractApiKeyFromHeaders(request.headers);
      if (headerApiKey && !apiKeysMatch(headerApiKey, effectiveAuthConfig.apiKey)) {
        sendHttpError(socket, 401, 'Unauthorized');
        return;
      }
    }

    wss.handleUpgrade(request, socket, head, (webSocket) => {
      wss.emit('connection', webSocket, request);
    });
  };

  server.listener.on('upgrade', handleUpgrade);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    server.listener.removeListener('upgrade', handleUpgrade);
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await Promise.allSettled([...cleanupPromises]);
  };

  server.ext('onPreStop', close);
  const controller = { wss, close, path: REALTIME_TRANSCRIPTION_PATH };
  server.app.realtimeTranscription = controller;
  return controller;
};
