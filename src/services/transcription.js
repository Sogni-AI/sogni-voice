import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.js';
import { TranscriptionError } from '../utils/errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolvePath(__dirname, '../..');

// Parakeet switches its encoder attention mode while transcribe_stream() is
// active, so the resident model can safely own only one realtime session.
let daemonProcess = null;
let daemonReady = false;
let daemonModelInfo = null;
let initPromise = null;
let requestIdCounter = 0;
let activeRealtimeSessionId = null;
const pendingRequests = new Map();

const resolveConfiguredPath = (configuredPath = './.venv/bin/python3') => (
  isAbsolute(configuredPath) ? configuredPath : resolvePath(projectRoot, configuredPath)
);

export class TranscriptionService {
  async initialize() {
    if (daemonReady) return;
    if (initPromise) return initPromise;

    initPromise = this._startDaemon();
    return initPromise;
  }

  async _startDaemon() {
    return new Promise((resolve, reject) => {
      const daemonPath = join(projectRoot, 'scripts/parakeet_daemon.py');
      const pythonPath = resolveConfiguredPath(config.transcription.pythonPath);
      let startupSettled = false;
      let startupTimer = null;

      console.log('Starting parakeet-mlx daemon (model loading may take a moment)...');

      const spawnedProcess = spawn(pythonPath, [daemonPath], {
        cwd: projectRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          PARAKEET_MODEL_ID: config.transcription.modelId,
          PARAKEET_MODEL_REVISION: config.transcription.modelRevision,
          PARAKEET_REALTIME_ENABLED: config.transcription.realtimeEnabled ? '1' : '0',
          PARAKEET_REALTIME_MAX_SECONDS: String(config.transcription.realtimeMaxSeconds),
          PARAKEET_REALTIME_MAX_CHUNK_BYTES: String(
            config.transcription.realtimeMaxChunkBytes,
          ),
          PARAKEET_REALTIME_CONTEXT_LEFT: String(
            config.transcription.realtimeContextLeft,
          ),
          PARAKEET_REALTIME_CONTEXT_RIGHT: String(
            config.transcription.realtimeContextRight,
          ),
          PARAKEET_REALTIME_DEPTH: String(config.transcription.realtimeDepth),
        },
      });
      daemonProcess = spawnedProcess;

      spawnedProcess.stderr.on('data', (data) => {
        console.log(`[parakeet-daemon] ${data.toString().trim()}`);
      });

      const lineReader = createInterface({ input: spawnedProcess.stdout });
      lineReader.on('line', (line) => {
        try {
          const response = JSON.parse(line);

          if (response.status === 'ready') {
            if (daemonProcess !== spawnedProcess) return;
            console.log('Parakeet-mlx daemon ready');
            daemonReady = true;
            daemonModelInfo = {
              model: response.model || config.transcription.modelId,
              revision: response.revision || config.transcription.modelRevision,
              parakeetMlxVersion: response.parakeet_mlx_version || null,
              sampleRate: response.sample_rate || 16000,
              realtime: response.realtime == null
                ? Boolean(config.transcription.realtimeEnabled)
                : Boolean(response.realtime),
            };
            if (startupTimer) {
              clearTimeout(startupTimer);
              startupTimer = null;
            }
            startupSettled = true;
            resolve();
            return;
          }

          if (response.status === 'error' && !daemonReady) {
            if (startupTimer) {
              clearTimeout(startupTimer);
              startupTimer = null;
            }
            startupSettled = true;
            if (daemonProcess === spawnedProcess) initPromise = null;
            reject(new TranscriptionError(`Daemon failed to start: ${response.error}`));
            return;
          }

          const pending = pendingRequests.get(response.id);
          if (!pending) return;

          pendingRequests.delete(response.id);
          if (!response.success) {
            pending.reject(new TranscriptionError(response.error || 'Parakeet request failed'));
          } else if (pending.rawResponse) {
            pending.resolve(response);
          } else {
            const result = { text: response.text, rawOutput: '' };
            if (response.timestamps) result.timestamps = response.timestamps;
            pending.resolve(result);
          }
        } catch (error) {
          console.error('Failed to parse daemon response:', line, error);
        }
      });

      spawnedProcess.on('close', (code) => {
        console.log(`Parakeet daemon exited with code ${code}`);
        if (startupTimer) {
          clearTimeout(startupTimer);
          startupTimer = null;
        }
        lineReader.close();

        if (daemonProcess === spawnedProcess) {
          daemonReady = false;
          daemonProcess = null;
          daemonModelInfo = null;
          activeRealtimeSessionId = null;
          initPromise = null;

          for (const [id, pending] of pendingRequests) {
            pending.reject(new TranscriptionError('Daemon process terminated'));
            pendingRequests.delete(id);
          }
        }

        if (!startupSettled) {
          startupSettled = true;
          reject(new TranscriptionError(`Daemon exited unexpectedly with code ${code}`));
        }
      });

      spawnedProcess.on('error', (error) => {
        if (startupTimer) {
          clearTimeout(startupTimer);
          startupTimer = null;
        }
        if (daemonProcess === spawnedProcess) {
          initPromise = null;
          daemonReady = false;
          daemonProcess = null;
        }
        if (!startupSettled) {
          startupSettled = true;
          reject(new TranscriptionError(`Failed to spawn daemon: ${error.message}`, error));
        }
      });

      startupTimer = setTimeout(() => {
        if (!daemonReady && !startupSettled) {
          startupSettled = true;
          spawnedProcess.kill('SIGKILL');
          reject(new TranscriptionError('Daemon initialization timed out'));
        }
      }, config.transcription.daemonStartupTimeout || 120000);
    });
  }

  async _ensureDaemon() {
    if (!daemonReady || !daemonProcess) {
      console.log('Daemon not available, attempting to start...');
      initPromise = null;
      daemonReady = false;
      await this.initialize();
    }
  }

  async _sendRawRequest(payload, timeout = config.transcription.timeout) {
    await this._ensureDaemon();

    if (!daemonProcess || !daemonReady) {
      throw new TranscriptionError('Transcription daemon not available');
    }

    const requestId = `req-${++requestIdCounter}`;
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new TranscriptionError('Transcription timed out'));
      }, timeout);

      pendingRequests.set(requestId, {
        rawResponse: true,
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      });

      try {
        daemonProcess.stdin.write(`${JSON.stringify({ id: requestId, ...payload })}\n`);
      } catch (error) {
        pendingRequests.delete(requestId);
        clearTimeout(timeoutId);
        reject(new TranscriptionError(`Failed to write to daemon: ${error.message}`));
      }
    });
  }

  async transcribe(audioFilePath, options = {}) {
    if (activeRealtimeSessionId) {
      throw new TranscriptionError(
        'Parakeet is busy with a realtime session; retry batch transcription later',
      );
    }

    const { timestamps = false, wordTimestamps = false } = options;
    const response = await this._sendRawRequest({
      type: 'transcribe',
      audio_path: audioFilePath,
      timestamps,
      word_timestamps: wordTimestamps,
    });

    const result = { text: response.text, rawOutput: '' };
    if (response.timestamps) result.timestamps = response.timestamps;
    return result;
  }

  async startRealtimeSession() {
    if (!config.transcription.enabled || !config.transcription.realtimeEnabled) {
      throw new TranscriptionError('Parakeet realtime transcription is disabled');
    }

    await this._ensureDaemon();
    if (activeRealtimeSessionId) {
      throw new TranscriptionError('Another Parakeet realtime session is already active');
    }

    const sessionId = randomUUID().replaceAll('-', '');
    activeRealtimeSessionId = sessionId;
    try {
      return await this._sendRawRequest(
        { type: 'stream_start', session_id: sessionId },
        config.transcription.realtimeChunkTimeout,
      );
    } catch (error) {
      if (daemonProcess && daemonReady) {
        try {
          await this._sendRawRequest(
            { type: 'stream_abort', session_id: sessionId },
            Math.min(config.transcription.realtimeChunkTimeout, 5000),
          );
        } catch {
          await this.shutdown();
        }
      }
      activeRealtimeSessionId = null;
      throw error;
    }
  }

  _assertActiveRealtimeSession(sessionId) {
    if (!activeRealtimeSessionId || sessionId !== activeRealtimeSessionId) {
      throw new TranscriptionError('Realtime session is not active');
    }
  }

  async sendRealtimeAudio(sessionId, audioBuffer) {
    this._assertActiveRealtimeSession(sessionId);
    if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
      throw new TranscriptionError('Realtime audio must be a non-empty Buffer');
    }
    if (audioBuffer.length > config.transcription.realtimeMaxChunkBytes) {
      throw new TranscriptionError('Realtime audio chunk exceeds the configured size limit');
    }

    return this._sendRawRequest(
      {
        type: 'stream_audio',
        session_id: sessionId,
        audio: audioBuffer.toString('base64'),
      },
      config.transcription.realtimeChunkTimeout,
    );
  }

  async finishRealtimeSession(sessionId) {
    this._assertActiveRealtimeSession(sessionId);
    try {
      return await this._sendRawRequest(
        { type: 'stream_finish', session_id: sessionId },
        config.transcription.realtimeChunkTimeout,
      );
    } catch (error) {
      try {
        await this._sendRawRequest(
          { type: 'stream_abort', session_id: sessionId },
          Math.min(config.transcription.realtimeChunkTimeout, 5000),
        );
      } catch {
        // A timed-out finish can leave native local attention enabled. Restart
        // the daemon if we cannot prove that the stream was released.
        await this.shutdown();
      }
      throw error;
    } finally {
      if (activeRealtimeSessionId === sessionId) activeRealtimeSessionId = null;
    }
  }

  async abortRealtimeSession(sessionId) {
    if (!activeRealtimeSessionId || sessionId !== activeRealtimeSessionId) return;

    try {
      await this._sendRawRequest(
        { type: 'stream_abort', session_id: sessionId },
        Math.min(config.transcription.realtimeChunkTimeout, 5000),
      );
    } catch (error) {
      await this.shutdown();
      throw error;
    } finally {
      if (activeRealtimeSessionId === sessionId) activeRealtimeSessionId = null;
    }
  }

  async shutdown() {
    activeRealtimeSessionId = null;
    if (!daemonProcess) return;

    const processToStop = daemonProcess;
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        console.log('Daemon shutdown timeout, forcing kill...');
        processToStop.kill('SIGKILL');
        resolve();
      }, 5000);

      processToStop.once('close', () => {
        clearTimeout(timeoutId);
        resolve();
      });

      try {
        processToStop.stdin.write(`${JSON.stringify({ command: 'shutdown' })}\n`);
      } catch {
        processToStop.kill('SIGTERM');
      }
    });
  }

  isReady() {
    return daemonReady;
  }

  isRealtimeActive() {
    return Boolean(activeRealtimeSessionId);
  }

  getModelInfo() {
    return daemonModelInfo || {
      model: config.transcription.modelId,
      revision: config.transcription.modelRevision,
      parakeetMlxVersion: null,
      sampleRate: 16000,
      realtime: Boolean(config.transcription.realtimeEnabled),
    };
  }
}

export const transcriptionService = new TranscriptionService();
