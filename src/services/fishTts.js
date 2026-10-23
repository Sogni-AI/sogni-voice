import { DaemonRequestQueue } from '../utils/daemonRequestQueue.js';
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
function computeGenerationTimeout(engineConfig, text = '') {
  const base = engineConfig.timeout || 300000;
  const perChar = engineConfig.timeoutPerChar || 400;
  const ceiling = engineConfig.timeoutMax || 900000;
  const scaled = base + (text.length || 0) * perChar;
  return Math.min(ceiling, Math.max(base, scaled));
}

/**
 * Manages the Fish S2 Pro TTS daemon (scripts/fish_tts_daemon.py) over a
 * stdin/stdout JSON-line protocol, matching the other local TTS engines.
 * The daemon drives the 8-bit MLX model (default-voice generation with inline
 * emotion tags, plus zero-shot voice cloning from a reference clip + transcript).
 */
export const resolveFromProjectRoot = resolveFromRoot;

export class FishTTSService {
  constructor() {
    this.daemonProcess = null;
    this.daemonReady = false;
    this.initPromise = null;
    this.pendingRequests = new Map();
    this.requestQueue = new DaemonRequestQueue({
      ensureDaemon: () => this._ensureDaemon(),
      getProcess: () => this.daemonReady ? this.daemonProcess : null,
      pendingRequests: this.pendingRequests,
      createError: (message) => new FishTTSError(message),
    });
    this.readlineInterface = null;
    this.startupTimeoutId = null;
    this.modelInfo = {
      model: this.cfg?.modelId || this.defaultModelId,
      backend: this.backend,
      voices: ['default'],
      clones: [],
      features: [],
      sampleRate: 44100,
      streaming: false,
    };
  }

  // Engine hooks; Drama3TTSService (services/drama3Tts.js) overrides them.
  get cfg() { return config.fishTts; }

  get label() { return 'Fish S2 Pro'; }

  get logTag() { return 'fish-tts'; }

  get backend() { return this.cfg?.backend === 'vllm-omni' ? 'fish-s2-pro-vllm-omni' : 'fish-s2-pro-mlx'; }

  get defaultModelId() { return 'fish-audio-s2-pro-8bit-mlx'; }

  /** Daemon script, environment, and the paths that must exist before spawning. */
  daemonSpec() {
    if (this.cfg.backend === 'vllm-omni') {
      return this.omniDaemonSpec({
        FISH_OMNI_ENGINE: 's2',
        FISH_TTS_MODEL_ID: this.cfg.modelId,
        FISH_TTS_MAX_TOKENS: String(this.cfg.maxTokens),
      });
    }
    const modelPath = resolveFromRoot(this.cfg.modelPath);
    return {
      script: 'fish_tts_daemon.py',
      setupHint: 'Run the Fish S2 setup (see docs/fish-s2-eval.md).',
      requiredPaths: [['model checkpoint', modelPath]],
      env: {
        PYTHONPATH: resolveFromRoot(this.cfg.serverDir),
        FISH_TTS_MODEL_PATH: modelPath,
        FISH_TTS_MODEL_ID: this.cfg.modelId,
        FISH_TTS_VOICE_CLONES_DIR: resolveFromRoot(this.cfg.voiceClonesDir),
        FISH_TTS_MAX_TOKENS: String(this.cfg.maxTokens),
      },
    };
  }

  /**
   * Linux + NVIDIA: the model runs in a vLLM-Omni server (docker/nvidia/) and
   * scripts/fish_omni_daemon.py renders through it, keeping the protocol,
   * chunking and clone store of the MLX daemons.
   */
  omniDaemonSpec(engineEnv) {
    return {
      script: 'fish_omni_daemon.py',
      setupHint: 'Start the vLLM-Omni servers (see docs/linux-nvidia.md).',
      requiredPaths: [],
      env: {
        FISH_OMNI_URL: this.cfg.omniUrl,
        FISH_OMNI_MODEL: this.cfg.omniModel,
        FISH_TTS_VOICE_CLONES_DIR: resolveFromRoot(this.cfg.voiceClonesDir),
        ...engineEnv,
      },
    };
  }

  async initialize() {
    if (this.daemonReady) return;
    if (this.initPromise) return this.initPromise;
    const initialization = this._startDaemon();
    this.initPromise = initialization;
    try {
      await initialization;
    } catch (error) {
      if (this.initPromise === initialization) this.initPromise = null;
      throw error;
    }
  }

  async _startDaemon() {
    const spec = this.daemonSpec();
    const daemonPath = join(projectRoot, 'scripts', spec.script);
    const pythonPath = resolveFromRoot(this.cfg.pythonPath);

    for (const [label, p] of [['python', pythonPath], ...spec.requiredPaths]) {
      try {
        await access(p);
      } catch {
        throw new FishTTSError(`${this.label} ${label} not found at ${p}. ${spec.setupHint}`);
      }
    }

    return new Promise((resolveReady, reject) => {
      console.log(`Starting ${this.label} TTS daemon...`);

      this.daemonProcess = spawn(pythonPath, [daemonPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1', ...spec.env },
      });

      this.daemonProcess.stderr.on('data', (data) => {
        console.log(`[${this.logTag}] ${data.toString().trim()}`);
      });

      this.readlineInterface = createInterface({ input: this.daemonProcess.stdout });
      this.readlineInterface.on('line', (line) => {
        if (!line.trim()) return;
        if (!line.startsWith('{')) {
          console.log(`[${this.logTag}] ${line}`);
          return;
        }

        let response;
        try {
          response = JSON.parse(line);
        } catch (e) {
          console.error(`Failed to parse ${this.label} daemon JSON response:`, line, e);
          return;
        }

        if (response.status === 'ready') {
          console.log(`${this.label} TTS daemon ready`);
          this.modelInfo = {
            model: response.model || this.cfg.modelId,
            backend: this.backend,
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
        clearTimeout(this.startupTimeoutId);
        this.startupTimeoutId = null;
        console.log(`${this.label} daemon exited with code ${code}`);
        this.daemonReady = false;
        this.daemonProcess = null;
        this.initPromise = null;
        if (this.readlineInterface) {
          this.readlineInterface.close();
          this.readlineInterface = null;
        }
        for (const [id, pending] of this.pendingRequests) {
          pending.reject(new FishTTSError(`${this.label} daemon process terminated`));
          this.pendingRequests.delete(id);
        }
        if (!this.daemonReady) {
          reject(new FishTTSError(`${this.label} daemon exited unexpectedly with code ${code}`));
        }
      });

      this.daemonProcess.on('error', (error) => {
        clearTimeout(this.startupTimeoutId);
        this.startupTimeoutId = null;
        this.initPromise = null;
        reject(new FishTTSError(`Failed to spawn ${this.label} daemon: ${error.message}`, error));
      });

      const startupTimeout = this.cfg.daemonStartupTimeout || 240000;
      this.startupTimeoutId = setTimeout(() => {
        if (!this.daemonReady) {
          this.shutdown();
          reject(new FishTTSError(`${this.label} daemon initialization timed out`));
        }
      }, startupTimeout);
    });
  }

  async _ensureDaemon() {
    if (!this.daemonReady || !this.daemonProcess) {
      console.log(`${this.label} daemon not available, attempting to start...`);
      await this.initialize();
    }
  }

  async _sendRequest(request, { timeout: customTimeout, signal } = {}) {
    return this.requestQueue.request(request, {
      signal,
      timeout: customTimeout || this.cfg.timeout || 300000,
      interruptOnTimeout: request.type.startsWith('generate'),
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
      { timeout: computeGenerationTimeout(this.cfg, text), signal: options.signal },
    );
    return {
      outputPath: result.output_path,
      duration: result.duration,
      rtf: result.rtf ?? null,
      model: this.modelInfo.model,
      ...(result.finish_reason ? { finishReason: result.finish_reason } : {}),
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
      { timeout: computeGenerationTimeout(this.cfg, text), signal: options.signal },
    );
    return {
      outputPath: result.output_path, duration: result.duration, cloneId,
      rtf: result.rtf ?? null, model: this.modelInfo.model,
      ...(result.finish_reason ? { finishReason: result.finish_reason } : {}),
    };
  }

  /** Create a voice clone from reference audio plus its transcript. */
  async createVoiceClone(audioPath, transcript, cloneId) {
    if (!audioPath) throw new FishTTSError('audioPath is required');
    if (!transcript) throw new FishTTSError('transcript is required');
    if (!cloneId) throw new FishTTSError('cloneId is required');

    const result = await this._sendRequest(
      { type: 'create_voice_clone', audio_path: audioPath, transcript, clone_id: cloneId },
      { timeout: this.cfg.timeout || 300000 },
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
    return join(resolveFromRoot(this.cfg.voiceClonesDir), cloneId);
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
    this.requestQueue.cancelWaiting(new FishTTSError('TTS service shutting down'));
    if (!this.daemonProcess) return;
    const processToStop = this.daemonProcess;
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        processToStop.kill('SIGKILL');
        resolve();
      }, 5000);
      processToStop.once('close', () => { clearTimeout(timeoutId); resolve(); });
      try {
        processToStop.stdin.write(JSON.stringify({ command: 'shutdown' }) + '\n');
      } catch {
        processToStop.kill('SIGTERM');
      }
    });
  }

  isReady() {
    return this.daemonReady;
  }

  isEnabled() {
    return Boolean(this.cfg?.enabled);
  }

  getModelInfo() {
    return { ...this.modelInfo };
  }

  listVoices() {
    return this.modelInfo.voices;
  }
}

export const fishTtsService = new FishTTSService();
