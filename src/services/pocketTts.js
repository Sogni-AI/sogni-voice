import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';
import { config } from '../config/index.js';
import { PocketTTSError } from '../utils/errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class PocketTTSService {
  constructor() {
    this.daemonProcess = null;
    this.daemonReady = false;
    this.initPromise = null;
    this.requestIdCounter = 0;
    this.pendingRequests = new Map();
    this.readlineInterface = null;
    this.startupTimeoutId = null;
    this.voiceInfo = {
      voices: [],
      features: [],
    };
  }

  async initialize() {
    if (this.daemonReady) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._startDaemon();
    return this.initPromise;
  }

  async _startDaemon() {
    return new Promise((resolve, reject) => {
      const daemonPath = join(__dirname, '../../scripts/pocket_tts_daemon.py');

      console.log('Starting Pocket TTS daemon...');

      const pythonPath = join(__dirname, '../../.venv/bin/python3');
      this.daemonProcess = spawn(pythonPath, [daemonPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          POCKET_TTS_VOICE_CLONES_DIR: config.pocketTts.voiceClonesDir,
        },
      });

      this.daemonProcess.stderr.on('data', (data) => {
        console.log(`[pocket-tts] ${data.toString().trim()}`);
      });

      this.readlineInterface = createInterface({ input: this.daemonProcess.stdout });

      this.readlineInterface.on('line', (line) => {
        if (!line.trim()) return;

        if (!line.startsWith('{')) {
          console.log(`[pocket-tts] ${line}`);
          return;
        }

        try {
          const response = JSON.parse(line);

          if (response.status === 'ready') {
            console.log('Pocket TTS daemon ready');
            this.voiceInfo = {
              voices: response.voices || [],
              features: response.features || [],
            };
            this.daemonReady = true;
            if (this.startupTimeoutId) {
              clearTimeout(this.startupTimeoutId);
              this.startupTimeoutId = null;
            }
            resolve();
            return;
          }

          if (response.status === 'error' && !this.daemonReady) {
            reject(new PocketTTSError(`Daemon failed to start: ${response.error}`));
            return;
          }

          const requestId = response.id;
          const pending = this.pendingRequests.get(requestId);
          if (pending) {
            this.pendingRequests.delete(requestId);
            if (response.success) {
              pending.resolve(response);
            } else {
              pending.reject(new PocketTTSError(response.error));
            }
          }
        } catch (e) {
          console.error('Failed to parse Pocket TTS daemon JSON response:', line, e);
        }
      });

      this.daemonProcess.on('close', (code) => {
        console.log(`Pocket TTS daemon exited with code ${code}`);
        this.daemonReady = false;
        this.daemonProcess = null;
        this.initPromise = null;
        if (this.readlineInterface) {
          this.readlineInterface.close();
          this.readlineInterface = null;
        }

        for (const [id, pending] of this.pendingRequests) {
          pending.reject(new PocketTTSError('Pocket TTS daemon process terminated'));
          this.pendingRequests.delete(id);
        }

        if (!this.daemonReady) {
          reject(new PocketTTSError(`Pocket TTS daemon exited unexpectedly with code ${code}`));
        }
      });

      this.daemonProcess.on('error', (error) => {
        this.initPromise = null;
        reject(new PocketTTSError(`Failed to spawn Pocket TTS daemon: ${error.message}`, error));
      });

      const startupTimeout = config.pocketTts.daemonStartupTimeout || 60000;
      this.startupTimeoutId = setTimeout(() => {
        if (!this.daemonReady) {
          this.shutdown();
          reject(new PocketTTSError('Pocket TTS daemon initialization timed out'));
        }
      }, startupTimeout);
    });
  }

  async _ensureDaemon() {
    if (!this.daemonReady || !this.daemonProcess) {
      console.log('Pocket TTS daemon not available, attempting to start...');
      this.initPromise = null;
      this.daemonReady = false;
      await this.initialize();
    }
  }

  async _sendRequest(request) {
    await this._ensureDaemon();

    if (!this.daemonProcess || !this.daemonReady) {
      throw new PocketTTSError('Pocket TTS daemon not available');
    }

    const requestId = `req-${++this.requestIdCounter}`;
    request.id = requestId;

    const timeout = config.pocketTts.timeout || 60000;
    console.log(`[pocket-tts] Sending request ${requestId}: type=${request.type}, timeout=${timeout}ms`);

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        console.log(`[pocket-tts] Request ${requestId} timed out after ${timeout}ms`);
        reject(new PocketTTSError('Pocket TTS request timed out'));
      }, timeout);

      this.pendingRequests.set(requestId, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          console.log(`[pocket-tts] Request ${requestId} completed successfully`);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          console.log(`[pocket-tts] Request ${requestId} failed: ${error.message}`);
          reject(error);
        },
      });

      try {
        this.daemonProcess.stdin.write(JSON.stringify(request) + '\n');
      } catch (error) {
        this.pendingRequests.delete(requestId);
        clearTimeout(timeoutId);
        reject(new PocketTTSError(`Failed to write to daemon: ${error.message}`));
      }
    });
  }

  async generate(text, options = {}) {
    const {
      voice = config.pocketTts.defaultVoice,
      outputPath,
    } = options;

    if (!outputPath) {
      throw new PocketTTSError('outputPath is required');
    }

    const result = await this._sendRequest({
      type: 'generate',
      text,
      voice,
      output_path: outputPath,
    });

    return {
      outputPath: result.output_path,
      duration: result.duration,
      voice,
    };
  }

  async createVoiceClone(audioPath, cloneId) {
    if (!audioPath) {
      throw new PocketTTSError('audioPath is required');
    }

    if (!cloneId) {
      throw new PocketTTSError('cloneId is required');
    }

    const result = await this._sendRequest({
      type: 'create_voice_clone',
      audio_path: audioPath,
      clone_id: cloneId,
    });

    return {
      cloneId: result.clone_id,
    };
  }

  async generateVoiceClone(text, options = {}) {
    const { cloneId, outputPath } = options;

    if (!outputPath) {
      throw new PocketTTSError('outputPath is required');
    }

    if (!cloneId) {
      throw new PocketTTSError('cloneId is required');
    }

    const result = await this._sendRequest({
      type: 'generate_voice_clone',
      text,
      clone_id: cloneId,
      output_path: outputPath,
    });

    return {
      outputPath: result.output_path,
      duration: result.duration,
      cloneId,
    };
  }

  async deleteVoiceClone(cloneId) {
    if (!cloneId) {
      throw new PocketTTSError('cloneId is required');
    }

    const result = await this._sendRequest({
      type: 'delete_voice_clone',
      clone_id: cloneId,
    });

    return {
      cloneId: result.clone_id,
    };
  }

  async listVoices() {
    const result = await this._sendRequest({
      type: 'list_voices',
    });

    return {
      voices: result.voices || [],
      clones: result.clones || [],
    };
  }

  async shutdown() {
    if (!this.daemonProcess) return;

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        console.log('Pocket TTS daemon shutdown timeout, forcing kill...');
        this.daemonProcess?.kill('SIGKILL');
        resolve();
      }, 5000);

      this.daemonProcess.once('close', () => {
        clearTimeout(timeoutId);
        resolve();
      });

      try {
        this.daemonProcess.stdin.write(JSON.stringify({ command: 'shutdown' }) + '\n');
      } catch (e) {
        this.daemonProcess.kill('SIGTERM');
      }
    });
  }

  isReady() {
    return this.daemonReady;
  }

  isEnabled() {
    return config.pocketTts.enabled;
  }

  getBuiltInVoices() {
    return this.voiceInfo.voices.length > 0
      ? this.voiceInfo.voices
      : ['alba', 'marius', 'javert', 'jean', 'fantine', 'cosette', 'eponine', 'azelma'];
  }

  getVoiceClonePath(cloneId) {
    return join(config.pocketTts.voiceClonesDir, cloneId);
  }

  async voiceCloneExists(cloneId) {
    const clonePath = this.getVoiceClonePath(cloneId);
    try {
      await access(clonePath);
      return true;
    } catch {
      return false;
    }
  }
}

export const pocketTtsService = new PocketTTSService();
