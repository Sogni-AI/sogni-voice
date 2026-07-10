import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.js';
import { QwenASRError } from '../utils/errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');

let daemonProcess = null;
let daemonReady = false;
let initPromise = null;
let requestIdCounter = 0;
let readlineInterface = null;
let startupTimeoutId = null;
const pendingRequests = new Map();

export class QwenASRService {
  async initialize() {
    if (daemonReady) return;
    if (initPromise) return initPromise;
    initPromise = this._startDaemon();
    return initPromise;
  }

  async _startDaemon() {
    return new Promise((resolveStartup, rejectStartup) => {
      let startupSettled = false;
      const settleResolve = () => {
        if (startupSettled) return;
        startupSettled = true;
        resolveStartup();
      };
      const settleReject = (error) => {
        if (startupSettled) return;
        startupSettled = true;
        rejectStartup(error);
      };
      const clearStartupTimeout = () => {
        if (startupTimeoutId) {
          clearTimeout(startupTimeoutId);
          startupTimeoutId = null;
        }
      };

      const daemonPath = resolve(projectRoot, 'scripts/qwen_asr_daemon.py');
      const configuredPython = config.qwenAsr.pythonPath;
      const pythonPath = isAbsolute(configuredPython)
        ? configuredPython
        : resolve(projectRoot, configuredPython);

      console.log(`Starting Qwen3-ASR daemon (${config.qwenAsr.modelId})...`);
      daemonProcess = spawn(pythonPath, [daemonPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          QWEN_ASR_MODEL_ID: config.qwenAsr.modelId,
          QWEN_ASR_ALIGNER_MODEL_ID: config.qwenAsr.alignerModelId,
        },
      });

      daemonProcess.stderr.on('data', (data) => {
        console.log(`[qwen-asr-daemon] ${data.toString().trim()}`);
      });

      readlineInterface = createInterface({ input: daemonProcess.stdout });
      readlineInterface.on('line', (line) => {
        try {
          const response = JSON.parse(line);
          if (response.status === 'ready') {
            daemonReady = true;
            clearStartupTimeout();
            console.log(`Qwen3-ASR daemon ready (${response.model || config.qwenAsr.modelId})`);
            settleResolve();
            return;
          }

          if (response.status === 'error' && !daemonReady) {
            clearStartupTimeout();
            initPromise = null;
            settleReject(new QwenASRError(`Daemon failed to start: ${response.error}`));
            return;
          }

          const pending = pendingRequests.get(response.id);
          if (!pending) return;
          pendingRequests.delete(response.id);
          if (response.success) {
            pending.resolve(response);
          } else {
            pending.reject(new QwenASRError(response.error || 'Qwen3-ASR request failed'));
          }
        } catch (error) {
          console.error('Failed to parse Qwen3-ASR daemon response:', line, error);
        }
      });

      daemonProcess.on('close', (code) => {
        clearStartupTimeout();
        daemonReady = false;
        daemonProcess = null;
        initPromise = null;
        readlineInterface?.close();
        readlineInterface = null;

        for (const [id, pending] of pendingRequests) {
          pending.reject(new QwenASRError('Qwen3-ASR daemon process terminated'));
          pendingRequests.delete(id);
        }

        settleReject(new QwenASRError(`Qwen3-ASR daemon exited unexpectedly with code ${code}`));
      });

      daemonProcess.on('error', (error) => {
        clearStartupTimeout();
        initPromise = null;
        settleReject(new QwenASRError(`Failed to spawn Qwen3-ASR daemon: ${error.message}`, error));
      });

      startupTimeoutId = setTimeout(() => {
        if (!daemonReady) {
          this.shutdown();
          settleReject(new QwenASRError('Qwen3-ASR daemon initialization timed out'));
        }
      }, config.qwenAsr.daemonStartupTimeout);
    });
  }

  async _ensureDaemon() {
    if (!daemonReady || !daemonProcess) {
      initPromise = null;
      daemonReady = false;
      await this.initialize();
    }
  }

  async _request(type, payload) {
    await this._ensureDaemon();
    if (!daemonReady || !daemonProcess) {
      throw new QwenASRError('Qwen3-ASR daemon is not available');
    }

    const requestId = `qwen-asr-${++requestIdCounter}`;
    return new Promise((resolveRequest, rejectRequest) => {
      const timeoutId = setTimeout(() => {
        pendingRequests.delete(requestId);
        rejectRequest(new QwenASRError(`Qwen3-ASR ${type} request timed out`));
      }, config.qwenAsr.timeout);

      pendingRequests.set(requestId, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolveRequest(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          rejectRequest(error);
        },
      });

      try {
        daemonProcess.stdin.write(`${JSON.stringify({ id: requestId, type, ...payload })}\n`);
      } catch (error) {
        pendingRequests.delete(requestId);
        clearTimeout(timeoutId);
        rejectRequest(new QwenASRError(`Failed to write to Qwen3-ASR daemon: ${error.message}`, error));
      }
    });
  }

  async transcribe(audioFilePath, options = {}) {
    const response = await this._request('transcribe', {
      audio_path: audioFilePath,
      language: options.language || config.qwenAsr.defaultLanguage,
      timestamps: Boolean(options.timestamps),
      word_timestamps: Boolean(options.wordTimestamps),
    });
    return {
      text: response.text,
      rawOutput: '',
      language: response.language,
      languages: response.languages || [],
      model: response.model,
      timestampLevel: response.timestamp_level,
      ...(response.timestamps ? { timestamps: response.timestamps } : {}),
    };
  }

  async align(audioFilePath, text, language = 'English') {
    const response = await this._request('align', {
      audio_path: audioFilePath,
      text,
      language,
    });
    return {
      text: response.text,
      language: response.language,
      model: response.model,
      timestamps: response.timestamps || [],
    };
  }

  async shutdown() {
    if (!daemonProcess) return;
    return new Promise((resolveShutdown) => {
      const processToStop = daemonProcess;
      const timeoutId = setTimeout(() => {
        processToStop.kill('SIGKILL');
        resolveShutdown();
      }, 5000);

      processToStop.once('close', () => {
        clearTimeout(timeoutId);
        resolveShutdown();
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
}

export const qwenAsrService = new QwenASRService();
