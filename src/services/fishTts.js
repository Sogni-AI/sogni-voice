import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';
import { config } from '../config/index.js';
import { FishTTSError } from '../utils/errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolvePath(__dirname, '../..');

const resolveFromRoot = (p) => (isAbsolute(p) ? p : resolvePath(projectRoot, p));

/**
 * Per-request timeout that scales with text length. Fish S2 on Apple Silicon
 * runs slower than realtime, so longer input needs a larger ceiling.
 */
function computeGenerationTimeout(text = '') {
  const base = config.fishTts.timeout || 300000;
  const perChar = config.fishTts.timeoutPerChar || 400;
  const ceiling = config.fishTts.timeoutMax || 900000;
  const scaled = base + (text.length || 0) * perChar;
  return Math.min(ceiling, Math.max(base, scaled));
}

/**
 * Manages the Fish S2 Pro TTS daemon (scripts/fish_tts_daemon.py) over a
 * stdin/stdout JSON-line protocol, matching the other local TTS engines.
 * The daemon drives the 8-bit MLX model (default-voice generation with inline
 * emotion tags, plus zero-shot voice cloning from a reference clip + transcript).
 */
export class FishTTSService {
  constructor() {
    this.daemonProcess = null;
    this.daemonReady = false;
    this.initPromise = null;
    this.requestIdCounter = 0;
    this.pendingRequests = new Map();
    this.readlineInterface = null;
    this.startupTimeoutId = null;
    this.modelInfo = {
      model: config.fishTts?.modelId || 'fish-audio-s2-pro-8bit-mlx',
      backend: 'fish-s2-pro-mlx',
      voices: ['default'],
      clones: [],
      features: [],
      sampleRate: 44100,
      streaming: false,
    };
  }

  async initialize() {
    if (this.daemonReady) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._startDaemon();
    return this.initPromise;
  }

  async _startDaemon() {
    const daemonPath = join(projectRoot, 'scripts', 'fish_tts_daemon.py');
    const pythonPath = resolveFromRoot(config.fishTts.pythonPath);
    const serverDir = resolveFromRoot(config.fishTts.serverDir);
    const modelPath = resolveFromRoot(config.fishTts.modelPath);
    const voiceClonesDir = resolveFromRoot(config.fishTts.voiceClonesDir);

    for (const [label, p] of [['python', pythonPath], ['model checkpoint', modelPath]]) {
      try {
        await access(p);
      } catch {
        throw new FishTTSError(
          `Fish S2 ${label} not found at ${p}. Run the Fish S2 setup (see docs/fish-s2-eval.md).`,
        );
      }
    }

    return new Promise((resolveReady, reject) => {
      console.log('Starting Fish S2 Pro TTS daemon...');

      this.daemonProcess = spawn(pythonPath, [daemonPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          PYTHONPATH: serverDir,
          FISH_TTS_MODEL_PATH: modelPath,
          FISH_TTS_MODEL_ID: config.fishTts.modelId,
          FISH_TTS_VOICE_CLONES_DIR: voiceClonesDir,
          FISH_TTS_MAX_TOKENS: String(config.fishTts.maxTokens),
        },
      });

      this.daemonProcess.stderr.on('data', (data) => {
        console.log(`[fish-tts] ${data.toString().trim()}`);
      });

      this.readlineInterface = createInterface({ input: this.daemonProcess.stdout });
      this.readlineInterface.on('line', (line) => {
        if (!line.trim()) return;
        if (!line.startsWith('{')) {
          console.log(`[fish-tts] ${line}`);
          return;
        }

        let response;
        try {
          response = JSON.parse(line);
        } catch (e) {
          console.error('Failed to parse Fish TTS daemon JSON response:', line, e);
          return;
        }

        if (response.status === 'ready') {
          console.log('Fish S2 Pro TTS daemon ready');
          this.modelInfo = {
            model: response.model || config.fishTts.modelId,
            backend: 'fish-s2-pro-mlx',
            voices: response.voices || ['default'],
            clones: response.clones || [],
            features: response.features || [],
            sampleRate: response.sample_rate || 44100,
            streaming: false,
          };
          this.daemonReady = true;
          if (this.startupTimeoutId) {
            clearTimeout(this.startupTimeoutId);
            this.startupTimeoutId = null;
          }
          resolveReady();
          return;
        }

        if (response.status === 'error' && !this.daemonReady) {
          reject(new FishTTSError(`Daemon failed to start: ${response.error}`));
          return;
        }

        const pending = this.pendingRequests.get(response.id);
        if (pending) {
          this.pendingRequests.delete(response.id);
          if (response.success) pending.resolve(response);
          else pending.reject(new FishTTSError(response.error));
        }
      });

      this.daemonProcess.on('close', (code) => {
        console.log(`Fish TTS daemon exited with code ${code}`);
        this.daemonReady = false;
        this.daemonProcess = null;
        this.initPromise = null;
        if (this.readlineInterface) {
          this.readlineInterface.close();
          this.readlineInterface = null;
        }
        for (const [id, pending] of this.pendingRequests) {
          pending.reject(new FishTTSError('Fish TTS daemon process terminated'));
          this.pendingRequests.delete(id);
        }
        if (!this.daemonReady) {
          reject(new FishTTSError(`Fish TTS daemon exited unexpectedly with code ${code}`));
        }
      });

      this.daemonProcess.on('error', (error) => {
        this.initPromise = null;
        reject(new FishTTSError(`Failed to spawn Fish TTS daemon: ${error.message}`, error));
      });

      const startupTimeout = config.fishTts.daemonStartupTimeout || 240000;
      this.startupTimeoutId = setTimeout(() => {
        if (!this.daemonReady) {
          this.shutdown();
          reject(new FishTTSError('Fish TTS daemon initialization timed out'));
        }
      }, startupTimeout);
    });
  }

  async _ensureDaemon() {
    if (!this.daemonReady || !this.daemonProcess) {
      console.log('Fish TTS daemon not available, attempting to start...');
      this.initPromise = null;
      this.daemonReady = false;
      await this.initialize();
    }
  }

  async _sendRequest(request, { timeout: customTimeout } = {}) {
    await this._ensureDaemon();
    if (!this.daemonProcess || !this.daemonReady) {
      throw new FishTTSError('Fish TTS daemon not available');
    }

    const requestId = `req-${++this.requestIdCounter}`;
    request.id = requestId;
    const timeout = customTimeout || config.fishTts.timeout || 300000;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new FishTTSError('Fish TTS request timed out'));
      }, timeout);

      this.pendingRequests.set(requestId, {
        resolve: (result) => { clearTimeout(timeoutId); resolve(result); },
        reject: (error) => { clearTimeout(timeoutId); reject(error); },
      });

      try {
        this.daemonProcess.stdin.write(JSON.stringify(request) + '\n');
      } catch (error) {
        this.pendingRequests.delete(requestId);
        clearTimeout(timeoutId);
        reject(new FishTTSError(`Failed to write to daemon: ${error.message}`));
      }
    });
  }

  /**
   * Generate speech with the default voice. Emotion/style comes from inline
   * [bracket] tags and (paralanguage) cues in `text`.
   */
  async generate(text, options = {}) {
    const { outputPath, maxTokens, temperature } = options;
    if (!outputPath) throw new FishTTSError('outputPath is required');

    const result = await this._sendRequest(
      { type: 'generate', text, output_path: outputPath, max_tokens: maxTokens, temperature },
      { timeout: computeGenerationTimeout(text) },
    );
    return {
      outputPath: result.output_path,
      duration: result.duration,
      rtf: result.rtf ?? null,
      model: this.modelInfo.model,
    };
  }

  /** Generate speech using a saved voice clone (reference + transcript). */
  async generateVoiceClone(text, options = {}) {
    const { cloneId, outputPath, maxTokens, temperature } = options;
    if (!outputPath) throw new FishTTSError('outputPath is required');
    if (!cloneId) throw new FishTTSError('cloneId is required');

    const result = await this._sendRequest(
      {
        type: 'generate_voice_clone',
        text,
        clone_id: cloneId,
        output_path: outputPath,
        max_tokens: maxTokens,
        temperature,
      },
      { timeout: computeGenerationTimeout(text) },
    );
    return { outputPath: result.output_path, duration: result.duration, cloneId };
  }

  /** Create a voice clone from reference audio plus its transcript. */
  async createVoiceClone(audioPath, transcript, cloneId) {
    if (!audioPath) throw new FishTTSError('audioPath is required');
    if (!transcript) throw new FishTTSError('transcript is required');
    if (!cloneId) throw new FishTTSError('cloneId is required');

    const result = await this._sendRequest(
      { type: 'create_voice_clone', audio_path: audioPath, transcript, clone_id: cloneId },
      { timeout: config.fishTts.timeout || 300000 },
    );
    return { cloneId: result.clone_id };
  }

  async deleteVoiceClone(cloneId) {
    if (!cloneId) throw new FishTTSError('cloneId is required');
    const result = await this._sendRequest({ type: 'delete_voice_clone', clone_id: cloneId });
    return { cloneId: result.clone_id };
  }

  async renameVoiceClone(oldCloneId, newCloneId) {
    if (!oldCloneId) throw new FishTTSError('oldCloneId is required');
    if (!newCloneId) throw new FishTTSError('newCloneId is required');
    const result = await this._sendRequest({
      type: 'rename_voice_clone',
      old_clone_id: oldCloneId,
      new_clone_id: newCloneId,
    });
    return { oldCloneId: result.old_clone_id, newCloneId: result.new_clone_id };
  }

  async listVoiceClones() {
    const result = await this._sendRequest({ type: 'list_voices' });
    this.modelInfo.clones = result.clones || [];
    return { voices: result.voices || ['default'], clones: result.clones || [] };
  }

  getVoiceClonePath(cloneId) {
    return join(resolveFromRoot(config.fishTts.voiceClonesDir), cloneId);
  }

  async voiceCloneExists(cloneId) {
    try {
      await access(join(this.getVoiceClonePath(cloneId), 'reference.wav'));
      return true;
    } catch {
      return false;
    }
  }

  async shutdown() {
    if (!this.daemonProcess) return;
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.daemonProcess?.kill('SIGKILL');
        resolve();
      }, 5000);
      this.daemonProcess.once('close', () => { clearTimeout(timeoutId); resolve(); });
      try {
        this.daemonProcess.stdin.write(JSON.stringify({ command: 'shutdown' }) + '\n');
      } catch {
        this.daemonProcess.kill('SIGTERM');
      }
    });
  }

  isReady() {
    return this.daemonReady;
  }

  isEnabled() {
    return config.fishTts.enabled;
  }

  getModelInfo() {
    return { ...this.modelInfo };
  }

  listVoices() {
    return this.modelInfo.voices;
  }
}

export const fishTtsService = new FishTTSService();
