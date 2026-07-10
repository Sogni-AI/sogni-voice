import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.js';
import { MossTTSError } from '../utils/errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');
const mossConfig = {
  enabled: false,
  modelId: 'mlx-community/MOSS-TTS-Nano-100M',
  pythonPath: './.venv-moss-tts/bin/python3',
  defaultVoice: null,
  timeout: 300000,
  timeoutPerChar: 120,
  timeoutMax: 1800000,
  daemonStartupTimeout: 300000,
  preWarmDaemon: false,
  voicesDir: './moss_voice_clones',
  ...(config.mossTts || {}),
};

export const MOSS_TTS_LANGUAGES = [
  { code: 'zh', name: 'Chinese' },
  { code: 'en', name: 'English' },
  { code: 'de', name: 'German' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'ja', name: 'Japanese' },
  { code: 'it', name: 'Italian' },
  { code: 'he', name: 'Hebrew' },
  { code: 'ko', name: 'Korean' },
  { code: 'ru', name: 'Russian' },
  { code: 'fa', name: 'Persian' },
  { code: 'ar', name: 'Arabic' },
  { code: 'pl', name: 'Polish' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'cs', name: 'Czech' },
  { code: 'da', name: 'Danish' },
  { code: 'sv', name: 'Swedish' },
  { code: 'hu', name: 'Hungarian' },
  { code: 'el', name: 'Greek' },
  { code: 'tr', name: 'Turkish' },
];

export class MossTTSService {
  constructor() {
    this.daemonProcess = null;
    this.daemonReady = false;
    this.initPromise = null;
    this.requestIdCounter = 0;
    this.pendingRequests = new Map();
    this.readlineInterface = null;
    this.startupTimeoutId = null;
    this.modelInfo = {
      model: mossConfig.modelId,
      features: ['multilingual_tts', 'voice_cloning'],
      streaming: false,
      sampleRate: 48000,
      languages: MOSS_TTS_LANGUAGES,
    };
  }

  async initialize() {
    if (this.daemonReady) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._startDaemon();
    return this.initPromise;
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
        if (this.startupTimeoutId) {
          clearTimeout(this.startupTimeoutId);
          this.startupTimeoutId = null;
        }
      };

      const daemonPath = resolve(projectRoot, 'scripts/moss_tts_daemon.py');
      const pythonPath = isAbsolute(mossConfig.pythonPath)
        ? mossConfig.pythonPath
        : resolve(projectRoot, mossConfig.pythonPath);
      const voicesDir = isAbsolute(mossConfig.voicesDir)
        ? mossConfig.voicesDir
        : resolve(projectRoot, mossConfig.voicesDir);

      console.log(`Starting MOSS-TTS-Nano daemon (${mossConfig.modelId})...`);
      this.daemonProcess = spawn(pythonPath, [daemonPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          MOSS_TTS_MODEL_ID: mossConfig.modelId,
          MOSS_TTS_VOICES_DIR: voicesDir,
        },
      });

      this.daemonProcess.stderr.on('data', (data) => {
        console.log(`[moss-tts-daemon] ${data.toString().trim()}`);
      });

      this.readlineInterface = createInterface({ input: this.daemonProcess.stdout });
      this.readlineInterface.on('line', (line) => {
        try {
          const response = JSON.parse(line);
          if (response.status === 'ready') {
            this.daemonReady = true;
            clearStartupTimeout();
            this.modelInfo = {
              model: response.model || mossConfig.modelId,
              features: response.features || ['multilingual_tts', 'voice_cloning'],
              streaming: Boolean(response.streaming),
              sampleRate: response.sample_rate || 48000,
              languages: response.languages || MOSS_TTS_LANGUAGES,
            };
            console.log(`MOSS-TTS-Nano daemon ready (${this.modelInfo.model})`);
            settleResolve();
            return;
          }

          if (response.status === 'error' && !this.daemonReady) {
            clearStartupTimeout();
            this.initPromise = null;
            settleReject(new MossTTSError(`Daemon failed to start: ${response.error}`));
            return;
          }

          const pending = this.pendingRequests.get(response.id);
          if (!pending) return;
          this.pendingRequests.delete(response.id);
          if (response.success) {
            pending.resolve(response);
          } else {
            pending.reject(new MossTTSError(response.error || 'MOSS-TTS-Nano request failed'));
          }
        } catch (error) {
          console.error('Failed to parse MOSS-TTS-Nano daemon response:', line, error);
        }
      });

      this.daemonProcess.on('close', (code) => {
        clearStartupTimeout();
        this.daemonReady = false;
        this.daemonProcess = null;
        this.initPromise = null;
        this.readlineInterface?.close();
        this.readlineInterface = null;

        for (const [id, pending] of this.pendingRequests) {
          pending.reject(new MossTTSError('MOSS-TTS-Nano daemon process terminated'));
          this.pendingRequests.delete(id);
        }

        settleReject(new MossTTSError(`MOSS-TTS-Nano daemon exited unexpectedly with code ${code}`));
      });

      this.daemonProcess.on('error', (error) => {
        clearStartupTimeout();
        this.initPromise = null;
        settleReject(new MossTTSError(`Failed to spawn MOSS-TTS-Nano daemon: ${error.message}`, error));
      });

      this.startupTimeoutId = setTimeout(() => {
        if (!this.daemonReady) {
          this.shutdown();
          settleReject(new MossTTSError('MOSS-TTS-Nano daemon initialization timed out'));
        }
      }, mossConfig.daemonStartupTimeout);
    });
  }

  async _ensureDaemon() {
    if (!this.daemonReady || !this.daemonProcess) {
      this.initPromise = null;
      this.daemonReady = false;
      await this.initialize();
    }
  }

  requestTimeout(type, payload) {
    if (type !== 'generate') return mossConfig.timeout;
    const scaled = String(payload.text || '').length * mossConfig.timeoutPerChar;
    return Math.min(
      mossConfig.timeoutMax,
      Math.max(mossConfig.timeout, scaled),
    );
  }

  async _request(type, payload = {}) {
    await this._ensureDaemon();
    if (!this.daemonReady || !this.daemonProcess) {
      throw new MossTTSError('MOSS-TTS-Nano daemon is not available');
    }

    const requestId = `moss-tts-${++this.requestIdCounter}`;
    const timeout = this.requestTimeout(type, payload);
    return new Promise((resolveRequest, rejectRequest) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        rejectRequest(new MossTTSError(`MOSS-TTS-Nano ${type} request timed out`));
      }, timeout);

      this.pendingRequests.set(requestId, {
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
        this.daemonProcess.stdin.write(`${JSON.stringify({ id: requestId, type, ...payload })}\n`);
      } catch (error) {
        this.pendingRequests.delete(requestId);
        clearTimeout(timeoutId);
        rejectRequest(new MossTTSError(`Failed to write to MOSS-TTS-Nano daemon: ${error.message}`, error));
      }
    });
  }

  async generate(text, { voiceId, outputPath } = {}) {
    if (!voiceId) throw new MossTTSError('voiceId is required');
    if (!outputPath) throw new MossTTSError('outputPath is required');

    const response = await this._request('generate', {
      text,
      voice_id: voiceId,
      output_path: outputPath,
    });
    return {
      outputPath: response.output_path,
      voiceId: response.voice_id,
      duration: response.duration,
      sampleRate: response.sample_rate,
      channels: response.channels,
      processingSeconds: response.processing_seconds,
      realTimeFactor: response.real_time_factor,
      model: response.model,
    };
  }

  async createVoice(audioPath, voiceId) {
    if (!audioPath) throw new MossTTSError('audioPath is required');
    if (!voiceId) throw new MossTTSError('voiceId is required');
    const response = await this._request('create_voice', {
      audio_path: audioPath,
      voice_id: voiceId,
    });
    return { voiceId: response.voice_id, duration: response.duration };
  }

  async deleteVoice(voiceId) {
    if (!voiceId) throw new MossTTSError('voiceId is required');
    const response = await this._request('delete_voice', { voice_id: voiceId });
    return { voiceId: response.voice_id };
  }

  async renameVoice(oldVoiceId, voiceId) {
    if (!oldVoiceId) throw new MossTTSError('oldVoiceId is required');
    if (!voiceId) throw new MossTTSError('voiceId is required');
    const response = await this._request('rename_voice', {
      old_voice_id: oldVoiceId,
      voice_id: voiceId,
    });
    return { oldVoiceId: response.old_voice_id, voiceId: response.voice_id };
  }

  voicesPath() {
    return isAbsolute(mossConfig.voicesDir)
      ? mossConfig.voicesDir
      : resolve(projectRoot, mossConfig.voicesDir);
  }

  async listVoices() {
    const root = this.voicesPath();
    try {
      const entries = await readdir(root, { withFileTypes: true });
      const voices = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^[A-Za-z0-9_-]{1,100}$/.test(entry.name)) continue;
        try {
          const reference = await stat(join(root, entry.name, 'reference.wav'));
          if (reference.isFile()) voices.push(entry.name);
        } catch {
          // Ignore incomplete profiles.
        }
      }
      return voices.sort((a, b) => a.localeCompare(b));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new MossTTSError(`Failed to list MOSS reference voices: ${error.message}`, error);
    }
  }

  getModelInfo() {
    return { ...this.modelInfo };
  }

  isReady() {
    return this.daemonReady;
  }

  async shutdown() {
    if (!this.daemonProcess) return;
    return new Promise((resolveShutdown) => {
      const processToStop = this.daemonProcess;
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
}

export const mossTtsService = new MossTTSService();
