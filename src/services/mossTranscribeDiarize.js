import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.js';
import { MossTranscribeDiarizeError } from '../utils/errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');

const DEFAULT_CONFIG = {
  modelId: 'OpenMOSS-Team/MOSS-Transcribe-Diarize',
  modelRevision: 'd7231bbae2587a4af278735eb765b318c4f64edd',
  packageRevision: 'b5ad0f8386b155ddb89f9332ba3ca71891900357',
  pythonPath: './.venv-moss-transcribe/bin/python3',
  device: 'mps',
  dtype: 'fp16',
  maxNewTokens: 5120,
  maxAudioSeconds: 5400,
  timeout: 3600000,
  daemonStartupTimeout: 300000,
};

const mossConfig = { ...DEFAULT_CONFIG, ...(config.mossTranscribeDiarize || {}) };

let daemonProcess = null;
let daemonReady = false;
let initPromise = null;
let requestIdCounter = 0;
let readlineInterface = null;
let startupTimeoutId = null;
const pendingRequests = new Map();

export class MossTranscribeDiarizeService {
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

      const daemonPath = resolve(projectRoot, 'scripts/moss_transcribe_diarize_daemon.py');
      const pythonPath = isAbsolute(mossConfig.pythonPath)
        ? mossConfig.pythonPath
        : resolve(projectRoot, mossConfig.pythonPath);

      console.log(`Starting experimental MOSS Transcribe-Diarize daemon (${mossConfig.modelId})...`);
      daemonProcess = spawn(pythonPath, [daemonPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          PYTORCH_ENABLE_MPS_FALLBACK: process.env.PYTORCH_ENABLE_MPS_FALLBACK || '1',
          MOSS_TD_MODEL_ID: mossConfig.modelId,
          MOSS_TD_MODEL_REVISION: mossConfig.modelRevision,
          MOSS_TD_PACKAGE_REVISION: mossConfig.packageRevision,
          MOSS_TD_DEVICE: mossConfig.device,
          MOSS_TD_DTYPE: mossConfig.dtype,
          MOSS_TD_MAX_NEW_TOKENS: String(mossConfig.maxNewTokens),
          MOSS_TD_MAX_AUDIO_SECONDS: String(mossConfig.maxAudioSeconds),
        },
      });

      daemonProcess.stderr.on('data', (data) => {
        console.log(`[moss-td-daemon] ${data.toString().trim()}`);
      });

      readlineInterface = createInterface({ input: daemonProcess.stdout });
      readlineInterface.on('line', (line) => {
        try {
          const response = JSON.parse(line);
          if (response.status === 'ready') {
            daemonReady = true;
            clearStartupTimeout();
            console.log(`MOSS Transcribe-Diarize daemon ready (${response.model || mossConfig.modelId})`);
            settleResolve();
            return;
          }

          if (response.status === 'error' && !daemonReady) {
            clearStartupTimeout();
            initPromise = null;
            settleReject(new MossTranscribeDiarizeError(`Daemon failed to start: ${response.error}`));
            return;
          }

          const pending = pendingRequests.get(response.id);
          if (!pending) return;
          pendingRequests.delete(response.id);
          if (response.success) {
            pending.resolve(response);
          } else {
            pending.reject(new MossTranscribeDiarizeError(
              response.error || 'MOSS Transcribe-Diarize request failed',
            ));
          }
        } catch (error) {
          console.error('Failed to parse MOSS Transcribe-Diarize daemon response:', line, error);
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
          pending.reject(new MossTranscribeDiarizeError(
            'MOSS Transcribe-Diarize daemon process terminated',
          ));
          pendingRequests.delete(id);
        }

        settleReject(new MossTranscribeDiarizeError(
          `MOSS Transcribe-Diarize daemon exited unexpectedly with code ${code}`,
        ));
      });

      daemonProcess.on('error', (error) => {
        clearStartupTimeout();
        initPromise = null;
        settleReject(new MossTranscribeDiarizeError(
          `Failed to spawn MOSS Transcribe-Diarize daemon: ${error.message}`,
          error,
        ));
      });

      startupTimeoutId = setTimeout(() => {
        if (!daemonReady) {
          this.shutdown();
          settleReject(new MossTranscribeDiarizeError(
            'MOSS Transcribe-Diarize daemon initialization timed out',
          ));
        }
      }, mossConfig.daemonStartupTimeout);
    });
  }

  async _ensureDaemon() {
    if (!daemonReady || !daemonProcess) {
      initPromise = null;
      daemonReady = false;
      await this.initialize();
    }
  }

  async transcribe(audioFilePath, options = {}) {
    await this._ensureDaemon();
    if (!daemonReady || !daemonProcess) {
      throw new MossTranscribeDiarizeError('MOSS Transcribe-Diarize daemon is not available');
    }

    const requestId = `moss-td-${++requestIdCounter}`;
    const payload = {
      id: requestId,
      type: 'transcribe',
      audio_path: audioFilePath,
      ...(options.prompt ? { prompt: options.prompt } : {}),
      ...(options.hotwords ? { hotwords: options.hotwords } : {}),
      ...(options.maxNewTokens ? { max_new_tokens: options.maxNewTokens } : {}),
    };

    const response = await new Promise((resolveRequest, rejectRequest) => {
      const timeoutId = setTimeout(() => {
        pendingRequests.delete(requestId);
        rejectRequest(new MossTranscribeDiarizeError(
          'MOSS Transcribe-Diarize request timed out',
        ));
      }, mossConfig.timeout);

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
        daemonProcess.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        pendingRequests.delete(requestId);
        clearTimeout(timeoutId);
        rejectRequest(new MossTranscribeDiarizeError(
          `Failed to write to MOSS Transcribe-Diarize daemon: ${error.message}`,
          error,
        ));
      }
    });

    const metrics = response.metrics;
    return {
      text: response.text,
      rawTranscript: response.raw_transcript,
      timestamps: response.segments || [],
      numSpeakers: response.num_speakers || 0,
      model: response.model,
      revision: response.revision,
      timestampLevel: 'segment',
      ...(metrics ? {
        metrics: {
          audioSeconds: metrics.audio_seconds,
          elapsedSeconds: metrics.elapsed_seconds,
          realTimeFactor: metrics.real_time_factor,
          promptTokens: metrics.prompt_tokens,
          generatedTokens: metrics.generated_tokens,
          maxNewTokens: metrics.max_new_tokens,
          truncated: Boolean(metrics.truncated),
        },
      } : {}),
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

export const mossTranscribeDiarizeService = new MossTranscribeDiarizeService();
