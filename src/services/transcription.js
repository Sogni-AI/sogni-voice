import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.js';
import { TranscriptionError } from '../utils/errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Daemon state (module-level singleton)
let daemonProcess = null;
let daemonReady = false;
let initPromise = null;
let requestIdCounter = 0;
let readlineInterface = null;
let startupTimeoutId = null;
const pendingRequests = new Map();

export class TranscriptionService {
  /**
   * Initialize the parakeet daemon. Uses promise deduplication
   * to prevent multiple simultaneous initializations.
   */
  async initialize() {
    if (daemonReady) return;
    if (initPromise) return initPromise;

    initPromise = this._startDaemon();
    return initPromise;
  }

  async _startDaemon() {
    return new Promise((resolve, reject) => {
      const daemonPath = join(__dirname, '../../scripts/parakeet_daemon.py');

      console.log('Starting parakeet-mlx daemon (model loading may take a moment)...');

      const pythonPath = join(__dirname, '../../.venv/bin/python3');
      daemonProcess = spawn(pythonPath, [daemonPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      });

      // Handle stderr (daemon logs)
      daemonProcess.stderr.on('data', (data) => {
        console.log(`[parakeet-daemon] ${data.toString().trim()}`);
      });

      // Handle stdout (JSON responses)
      readlineInterface = createInterface({ input: daemonProcess.stdout });

      readlineInterface.on('line', (line) => {
        try {
          const response = JSON.parse(line);

          // Handle ready signal
          if (response.status === 'ready') {
            console.log('Parakeet-mlx daemon ready');
            daemonReady = true;
            if (startupTimeoutId) {
              clearTimeout(startupTimeoutId);
              startupTimeoutId = null;
            }
            resolve();
            return;
          }

          // Handle error during startup
          if (response.status === 'error' && !daemonReady) {
            reject(new TranscriptionError(`Daemon failed to start: ${response.error}`));
            return;
          }

          // Handle transcription response
          const requestId = response.id;
          const pending = pendingRequests.get(requestId);
          if (pending) {
            pendingRequests.delete(requestId);
            if (response.success) {
              const result = { text: response.text, rawOutput: '' };
              if (response.timestamps) {
                result.timestamps = response.timestamps;
              }
              pending.resolve(result);
            } else {
              pending.reject(new TranscriptionError(response.error));
            }
          }
        } catch (e) {
          console.error('Failed to parse daemon response:', line, e);
        }
      });

      // Handle daemon exit
      daemonProcess.on('close', (code) => {
        console.log(`Parakeet daemon exited with code ${code}`);
        daemonReady = false;
        daemonProcess = null;
        initPromise = null;
        if (readlineInterface) {
          readlineInterface.close();
          readlineInterface = null;
        }

        // Reject all pending requests
        for (const [id, pending] of pendingRequests) {
          pending.reject(new TranscriptionError('Daemon process terminated'));
          pendingRequests.delete(id);
        }

        // If we haven't resolved yet, reject
        if (!daemonReady) {
          reject(new TranscriptionError(`Daemon exited unexpectedly with code ${code}`));
        }
      });

      daemonProcess.on('error', (error) => {
        initPromise = null;
        reject(new TranscriptionError(`Failed to spawn daemon: ${error.message}`, error));
      });

      // Timeout for initialization
      const startupTimeout = config.transcription.daemonStartupTimeout || 120000;
      startupTimeoutId = setTimeout(() => {
        if (!daemonReady) {
          this.shutdown();
          reject(new TranscriptionError('Daemon initialization timed out'));
        }
      }, startupTimeout);
    });
  }

  /**
   * Ensure daemon is running, restart if needed
   */
  async _ensureDaemon() {
    if (!daemonReady || !daemonProcess) {
      console.log('Daemon not available, attempting to start...');
      initPromise = null;
      daemonReady = false;
      await this.initialize();
    }
  }

  /**
   * Transcribe an audio file
   * @param {string} audioFilePath - Path to the audio file
   * @param {object} options - Transcription options
   * @param {boolean} options.timestamps - Include sentence-level timestamps
   * @param {boolean} options.wordTimestamps - Include word-level timestamps (overrides timestamps)
   * @returns {Promise<{text: string, rawOutput: string, timestamps?: Array}>}
   */
  async transcribe(audioFilePath, options = {}) {
    await this._ensureDaemon();

    if (!daemonProcess || !daemonReady) {
      throw new TranscriptionError('Transcription daemon not available');
    }

    const { timestamps = false, wordTimestamps = false } = options;
    const requestId = `req-${++requestIdCounter}`;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new TranscriptionError('Transcription timed out'));
      }, config.transcription.timeout);

      pendingRequests.set(requestId, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      });

      const request = JSON.stringify({
        id: requestId,
        audio_path: audioFilePath,
        timestamps,
        word_timestamps: wordTimestamps,
      });

      try {
        daemonProcess.stdin.write(request + '\n');
      } catch (error) {
        pendingRequests.delete(requestId);
        clearTimeout(timeoutId);
        reject(new TranscriptionError(`Failed to write to daemon: ${error.message}`));
      }
    });
  }

  /**
   * Gracefully shutdown the daemon
   */
  async shutdown() {
    if (!daemonProcess) return;

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        console.log('Daemon shutdown timeout, forcing kill...');
        daemonProcess?.kill('SIGKILL');
        resolve();
      }, 5000);

      daemonProcess.once('close', () => {
        clearTimeout(timeoutId);
        resolve();
      });

      // Send shutdown command
      try {
        daemonProcess.stdin.write(JSON.stringify({ command: 'shutdown' }) + '\n');
      } catch (e) {
        // stdin may already be closed
        daemonProcess.kill('SIGTERM');
      }
    });
  }

  /**
   * Check if daemon is ready
   */
  isReady() {
    return daemonReady;
  }
}

export const transcriptionService = new TranscriptionService();
