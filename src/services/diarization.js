import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.js';
import { DiarizationError } from '../utils/errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let daemonProcess = null;
let daemonReady = false;
let initPromise = null;
let requestIdCounter = 0;
let readlineInterface = null;
let startupTimeoutId = null;
const pendingRequests = new Map();

export class DiarizationService {
  async initialize() {
    if (daemonReady) return;
    if (initPromise) return initPromise;
    initPromise = this._startDaemon();
    return initPromise;
  }

  async _startDaemon() {
    return new Promise((resolve, reject) => {
      if (!config.diarization.hfToken) {
        reject(new DiarizationError(
          'HF_TOKEN required. Create one at https://hf.co/settings/tokens and accept the model license at https://hf.co/pyannote/speaker-diarization-3.1',
        ));
        return;
      }

      const daemonPath = join(__dirname, '../../scripts/diarize_daemon.py');
      console.log('Starting pyannote diarization daemon (model loading may take a moment)...');

      const pythonPath = join(__dirname, '../../.venv/bin/python3');
      daemonProcess = spawn(pythonPath, [daemonPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          HF_TOKEN: config.diarization.hfToken,
        },
      });

      daemonProcess.stderr.on('data', (data) => {
        console.log(`[diarize-daemon] ${data.toString().trim()}`);
      });

      readlineInterface = createInterface({ input: daemonProcess.stdout });

      readlineInterface.on('line', (line) => {
        try {
          const response = JSON.parse(line);

          if (response.status === 'ready') {
            console.log('Diarization daemon ready');
            daemonReady = true;
            if (startupTimeoutId) {
              clearTimeout(startupTimeoutId);
              startupTimeoutId = null;
            }
            resolve();
            return;
          }

          if (response.status === 'error' && !daemonReady) {
            reject(new DiarizationError(`Daemon failed to start: ${response.error}`));
            return;
          }

          const requestId = response.id;
          const pending = pendingRequests.get(requestId);
          if (pending) {
            pendingRequests.delete(requestId);
            if (response.success) {
              pending.resolve({
                turns: response.turns || [],
                numSpeakers: response.num_speakers || 0,
              });
            } else {
              pending.reject(new DiarizationError(response.error));
            }
          }
        } catch (e) {
          console.error('Failed to parse diarization daemon response:', line, e);
        }
      });

      daemonProcess.on('close', (code) => {
        console.log(`Diarization daemon exited with code ${code}`);
        daemonReady = false;
        daemonProcess = null;
        initPromise = null;
        if (readlineInterface) {
          readlineInterface.close();
          readlineInterface = null;
        }
        for (const [id, pending] of pendingRequests) {
          pending.reject(new DiarizationError('Daemon process terminated'));
          pendingRequests.delete(id);
        }
        if (!daemonReady) {
          reject(new DiarizationError(`Daemon exited unexpectedly with code ${code}`));
        }
      });

      daemonProcess.on('error', (error) => {
        initPromise = null;
        reject(new DiarizationError(`Failed to spawn daemon: ${error.message}`, error));
      });

      const startupTimeout = config.diarization.daemonStartupTimeout || 180000;
      startupTimeoutId = setTimeout(() => {
        if (!daemonReady) {
          this.shutdown();
          reject(new DiarizationError('Daemon initialization timed out'));
        }
      }, startupTimeout);
    });
  }

  async _ensureDaemon() {
    if (!daemonReady || !daemonProcess) {
      console.log('Diarization daemon not available, attempting to start...');
      initPromise = null;
      daemonReady = false;
      await this.initialize();
    }
  }

  /**
   * Diarize an audio file.
   * @param {string} audioFilePath
   * @param {object} options
   * @param {number} [options.numSpeakers]
   * @param {number} [options.minSpeakers]
   * @param {number} [options.maxSpeakers]
   * @returns {Promise<{turns: Array<{start:number,end:number,speaker:string}>, numSpeakers: number}>}
   */
  async diarize(audioFilePath, options = {}) {
    await this._ensureDaemon();

    if (!daemonProcess || !daemonReady) {
      throw new DiarizationError('Diarization daemon not available');
    }

    const { numSpeakers, minSpeakers, maxSpeakers } = options;
    const requestId = `dia-${++requestIdCounter}`;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new DiarizationError('Diarization timed out'));
      }, config.diarization.timeout);

      pendingRequests.set(requestId, {
        resolve: (result) => { clearTimeout(timeoutId); resolve(result); },
        reject: (error) => { clearTimeout(timeoutId); reject(error); },
      });

      const request = JSON.stringify({
        id: requestId,
        audio_path: audioFilePath,
        num_speakers: numSpeakers ?? null,
        min_speakers: minSpeakers ?? null,
        max_speakers: maxSpeakers ?? null,
      });

      try {
        daemonProcess.stdin.write(request + '\n');
      } catch (error) {
        pendingRequests.delete(requestId);
        clearTimeout(timeoutId);
        reject(new DiarizationError(`Failed to write to daemon: ${error.message}`));
      }
    });
  }

  async shutdown() {
    if (!daemonProcess) return;
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        console.log('Diarization daemon shutdown timeout, forcing kill...');
        daemonProcess?.kill('SIGKILL');
        resolve();
      }, 5000);

      daemonProcess.once('close', () => {
        clearTimeout(timeoutId);
        resolve();
      });

      try {
        daemonProcess.stdin.write(JSON.stringify({ command: 'shutdown' }) + '\n');
      } catch (e) {
        daemonProcess.kill('SIGTERM');
      }
    });
  }

  isReady() {
    return daemonReady;
  }
}

export const diarizationService = new DiarizationService();
