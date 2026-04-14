import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';
import { config } from '../config/index.js';
import { QwenTTSError } from '../utils/errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class QwenTTSService {
  /**
   * Create a new QwenTTSService instance
   * @param {string} variant - Model variant to use (e.g., 'base-0.6b', 'custom-voice')
   */
  constructor(variant) {
    this.variant = variant;
    this.daemonProcess = null;
    this.daemonReady = false;
    this.initPromise = null;
    this.requestIdCounter = 0;
    this.pendingRequests = new Map();
    this.readlineInterface = null;
    this.startupTimeoutId = null;
    this.modelInfo = {
      variant: null,
      features: [],
      voices: [],
    };
  }

  /**
   * Initialize the Qwen TTS daemon. Uses promise deduplication
   * to prevent multiple simultaneous initializations.
   */
  async initialize() {
    if (this.daemonReady) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._startDaemon();
    return this.initPromise;
  }

  async _startDaemon() {
    return new Promise((resolve, reject) => {
      const daemonPath = join(__dirname, '../../scripts/qwen_tts_daemon.py');

      console.log(`Starting Qwen3-TTS daemon (variant: ${this.variant})...`);

      const pythonPath = join(__dirname, '../../.venv/bin/python3');
      this.daemonProcess = spawn(pythonPath, [daemonPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          QWEN_TTS_MODEL_VARIANT: this.variant,
          QWEN_TTS_VOICE_CLONES_DIR: config.qwenTts.voiceClonesDir,
          QWEN_TTS_ALLOW_LEGACY_PICKLE_CLONES: config.qwenTts.allowLegacyPickleClones ? '1' : '0',
        },
      });

      // Handle stderr (daemon logs)
      this.daemonProcess.stderr.on('data', (data) => {
        console.log(`[qwen-tts-${this.variant}] ${data.toString().trim()}`);
      });

      // Handle stdout (JSON responses)
      this.readlineInterface = createInterface({ input: this.daemonProcess.stdout });

      this.readlineInterface.on('line', (line) => {
        // Skip empty lines
        if (!line.trim()) return;

        // Check if line looks like JSON before parsing
        if (!line.startsWith('{')) {
          console.log(`[qwen-tts-${this.variant}] ${line}`);
          return;
        }

        try {
          const response = JSON.parse(line);

          // Handle ready signal
          if (response.status === 'ready') {
            console.log(`Qwen3-TTS daemon ready (variant: ${response.model_variant})`);
            this.modelInfo = {
              variant: response.model_variant,
              features: response.features || [],
              voices: response.speakers || response.voices || [],
            };
            this.daemonReady = true;
            if (this.startupTimeoutId) {
              clearTimeout(this.startupTimeoutId);
              this.startupTimeoutId = null;
            }
            resolve();
            return;
          }

          // Handle error during startup
          if (response.status === 'error' && !this.daemonReady) {
            reject(new QwenTTSError(`Daemon failed to start: ${response.error}`));
            return;
          }

          // Handle response
          const requestId = response.id;
          const pending = this.pendingRequests.get(requestId);
          if (pending) {
            this.pendingRequests.delete(requestId);
            if (response.success) {
              pending.resolve(response);
            } else {
              pending.reject(new QwenTTSError(response.error));
            }
          }
        } catch (e) {
          console.error('Failed to parse Qwen TTS daemon JSON response:', line, e);
        }
      });

      // Handle daemon exit
      this.daemonProcess.on('close', (code) => {
        console.log(`Qwen TTS daemon (${this.variant}) exited with code ${code}`);
        this.daemonReady = false;
        this.daemonProcess = null;
        this.initPromise = null;
        if (this.readlineInterface) {
          this.readlineInterface.close();
          this.readlineInterface = null;
        }

        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests) {
          pending.reject(new QwenTTSError('Qwen TTS daemon process terminated'));
          this.pendingRequests.delete(id);
        }

        // If we haven't resolved yet, reject
        if (!this.daemonReady) {
          reject(new QwenTTSError(`Qwen TTS daemon exited unexpectedly with code ${code}`));
        }
      });

      this.daemonProcess.on('error', (error) => {
        this.initPromise = null;
        reject(new QwenTTSError(`Failed to spawn Qwen TTS daemon: ${error.message}`, error));
      });

      // Timeout for initialization
      const startupTimeout = config.qwenTts.daemonStartupTimeout || 180000;
      this.startupTimeoutId = setTimeout(() => {
        if (!this.daemonReady) {
          this.shutdown();
          reject(new QwenTTSError('Qwen TTS daemon initialization timed out'));
        }
      }, startupTimeout);
    });
  }

  /**
   * Ensure daemon is running, restart if needed
   */
  async _ensureDaemon() {
    if (!this.daemonReady || !this.daemonProcess) {
      console.log(`Qwen TTS daemon (${this.variant}) not available, attempting to start...`);
      this.initPromise = null;
      this.daemonReady = false;
      await this.initialize();
    }
  }

  /**
   * Send a request to the daemon and wait for response
   */
  async _sendRequest(request, { timeout: customTimeout } = {}) {
    await this._ensureDaemon();

    if (!this.daemonProcess || !this.daemonReady) {
      throw new QwenTTSError('Qwen TTS daemon not available');
    }

    const requestId = `req-${++this.requestIdCounter}`;
    request.id = requestId;

    const timeout = customTimeout || config.qwenTts.timeout || 300000;
    console.log(`[qwen-tts-${this.variant}] Sending request ${requestId}: type=${request.type}, timeout=${timeout}ms`);

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        console.log(`[qwen-tts-${this.variant}] Request ${requestId} timed out after ${timeout}ms`);
        reject(new QwenTTSError('Qwen TTS request timed out'));
      }, timeout);

      this.pendingRequests.set(requestId, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          console.log(`[qwen-tts-${this.variant}] Request ${requestId} completed successfully`);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          console.log(`[qwen-tts-${this.variant}] Request ${requestId} failed: ${error.message}`);
          reject(error);
        },
      });

      try {
        this.daemonProcess.stdin.write(JSON.stringify(request) + '\n');
      } catch (error) {
        this.pendingRequests.delete(requestId);
        clearTimeout(timeoutId);
        reject(new QwenTTSError(`Failed to write to daemon: ${error.message}`));
      }
    });
  }

  /**
   * Generate speech from text
   * @param {string} text - Text to convert to speech
   * @param {object} options - TTS options
   * @param {string} options.voice - Voice to use
   * @param {string} options.language - Language
   * @param {string} options.outputPath - Path to save audio file
   * @returns {Promise<{outputPath: string, duration: number}>}
   */
  async generate(text, options = {}) {
    const {
      voice = config.qwenTts.defaultVoice,
      language = config.qwenTts.defaultLanguage,
      outputPath,
    } = options;

    if (!outputPath) {
      throw new QwenTTSError('outputPath is required');
    }

    const result = await this._sendRequest({
      type: 'generate',
      text,
      voice,
      language,
      output_path: outputPath,
    });

    return {
      outputPath: result.output_path,
      duration: result.duration,
      voice,
      language,
    };
  }

  /**
   * Generate speech with emotion/style instruction (CustomVoice model)
   * @param {string} text - Text to convert to speech
   * @param {object} options - Options
   * @param {string} options.speaker - Speaker voice
   * @param {string} options.instruct - Emotion/style instruction
   * @param {string} options.outputPath - Path to save audio file
   * @returns {Promise<{outputPath: string, duration: number}>}
   */
  async generateCustomVoice(text, options = {}) {
    const {
      speaker = config.qwenTts.defaultVoice,
      instruct = '',
      outputPath,
    } = options;

    if (!outputPath) {
      throw new QwenTTSError('outputPath is required');
    }

    const result = await this._sendRequest({
      type: 'generate_custom_voice',
      text,
      speaker,
      instruct,
      output_path: outputPath,
    });

    return {
      outputPath: result.output_path,
      duration: result.duration,
      speaker,
      instruct,
    };
  }

  /**
   * Generate speech with voice description (VoiceDesign model)
   * @param {string} text - Text to convert to speech
   * @param {object} options - Options
   * @param {string} options.instruct - Voice description
   * @param {string} options.outputPath - Path to save audio file
   * @returns {Promise<{outputPath: string, duration: number}>}
   */
  async generateVoiceDesign(text, options = {}) {
    const { instruct, outputPath } = options;

    if (!outputPath) {
      throw new QwenTTSError('outputPath is required');
    }

    if (!instruct) {
      throw new QwenTTSError('instruct is required for voice design');
    }

    const result = await this._sendRequest({
      type: 'generate_voice_design',
      text,
      instruct,
      output_path: outputPath,
    });

    return {
      outputPath: result.output_path,
      duration: result.duration,
      instruct,
    };
  }

  /**
   * Create a voice clone from reference audio
   * @param {string} audioPath - Path to reference audio file
   * @param {string} transcript - Text spoken in the reference audio
   * @param {string} cloneId - Unique identifier for this voice clone
   * @returns {Promise<{cloneId: string}>}
   */
  async createVoiceClone(audioPath, transcript, cloneId) {
    if (!audioPath) {
      throw new QwenTTSError('audioPath is required');
    }

    if (!transcript) {
      throw new QwenTTSError('transcript is required');
    }

    if (!cloneId) {
      throw new QwenTTSError('cloneId is required');
    }

    const result = await this._sendRequest({
      type: 'create_voice_clone',
      audio_path: audioPath,
      transcript,
      clone_id: cloneId,
    });

    return {
      cloneId: result.clone_id,
    };
  }

  /**
   * Generate speech using a cloned voice
   * @param {string} text - Text to convert to speech
   * @param {object} options - Options
   * @param {string} options.cloneId - Voice clone ID
   * @param {string} options.language - Language
   * @param {string} options.outputPath - Path to save audio file
   * @returns {Promise<{outputPath: string, duration: number}>}
   */
  async generateVoiceClone(text, options = {}) {
    const {
      cloneId,
      language = config.qwenTts.defaultLanguage,
      outputPath,
    } = options;

    if (!outputPath) {
      throw new QwenTTSError('outputPath is required');
    }

    if (!cloneId) {
      throw new QwenTTSError('cloneId is required');
    }

    const result = await this._sendRequest({
      type: 'generate_voice_clone',
      text,
      clone_id: cloneId,
      language,
      output_path: outputPath,
    }, { timeout: 600000 });

    return {
      outputPath: result.output_path,
      duration: result.duration,
      cloneId,
      language,
    };
  }

  /**
   * Delete a voice clone
   * @param {string} cloneId - Voice clone ID to delete
   * @returns {Promise<{cloneId: string}>}
   */
  async deleteVoiceClone(cloneId) {
    if (!cloneId) {
      throw new QwenTTSError('cloneId is required');
    }

    const result = await this._sendRequest({
      type: 'delete_voice_clone',
      clone_id: cloneId,
    });

    return {
      cloneId: result.clone_id,
    };
  }

  /**
   * Rename a voice clone
   * @param {string} oldCloneId - Current voice clone ID
   * @param {string} newCloneId - New voice clone ID
   * @returns {Promise<{oldCloneId: string, newCloneId: string}>}
   */
  async renameVoiceClone(oldCloneId, newCloneId) {
    if (!oldCloneId) {
      throw new QwenTTSError('oldCloneId is required');
    }

    if (!newCloneId) {
      throw new QwenTTSError('newCloneId is required');
    }

    const result = await this._sendRequest({
      type: 'rename_voice_clone',
      old_clone_id: oldCloneId,
      new_clone_id: newCloneId,
    });

    return {
      oldCloneId: result.old_clone_id,
      newCloneId: result.new_clone_id,
    };
  }

  /**
   * List all voice clones
   * @returns {Promise<{clones: string[]}>}
   */
  async listVoiceClones() {
    const result = await this._sendRequest({
      type: 'list_voice_clones',
    });

    return {
      clones: result.clones || [],
    };
  }

  /**
   * Get the path to a voice clone file (safetensors format)
   * @param {string} cloneId - Voice clone ID
   * @returns {string} Path to the safetensors file
   */
  getVoiceClonePath(cloneId) {
    return join(config.qwenTts.voiceClonesDir, `${cloneId}.safetensors`);
  }

  /**
   * Get the actual path to a voice clone file, checking both formats
   * @param {string} cloneId - Voice clone ID
   * @returns {Promise<string|null>} Path to the file, or null if not found
   */
  async resolveVoiceClonePath(cloneId) {
    const stPath = join(config.qwenTts.voiceClonesDir, `${cloneId}.safetensors`);
    try {
      await access(stPath);
      return stPath;
    } catch {
      if (!config.qwenTts.allowLegacyPickleClones) {
        return null;
      }

      const pklPath = join(config.qwenTts.voiceClonesDir, `${cloneId}.pkl`);

      try {
        await access(pklPath);
        return pklPath;
      } catch {
        return null;
      }
    }
  }

  /**
   * Check if a voice clone exists (either format)
   * @param {string} cloneId - Voice clone ID
   * @returns {Promise<boolean>}
   */
  async voiceCloneExists(cloneId) {
    return (await this.resolveVoiceClonePath(cloneId)) !== null;
  }

  /**
   * Validate a voice clone file (.safetensors or .pkl)
   * @param {string} filePath - Path to the voice clone file
   * @returns {Promise<{valid: boolean, error?: string}>}
   */
  async validateVoiceClone(filePath) {
    if (!filePath) {
      throw new QwenTTSError('filePath is required');
    }

    const result = await this._sendRequest({
      type: 'validate_voice_clone',
      file_path: filePath,
    });

    return {
      valid: result.valid,
      error: result.error,
    };
  }

  /**
   * Import a voice clone from a .safetensors or .pkl file
   * @param {string} filePath - Path to the source file
   * @param {string} cloneId - Clone ID to assign
   * @returns {Promise<{cloneId: string}>}
   */
  async importVoiceClone(filePath, cloneId) {
    if (!filePath) {
      throw new QwenTTSError('filePath is required');
    }

    if (!cloneId) {
      throw new QwenTTSError('cloneId is required');
    }

    const result = await this._sendRequest({
      type: 'import_voice_clone',
      file_path: filePath,
      clone_id: cloneId,
    });

    return {
      cloneId: result.clone_id,
    };
  }

  /**
   * Gracefully shutdown the daemon
   */
  async shutdown() {
    if (!this.daemonProcess) return;

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        console.log(`Qwen TTS daemon (${this.variant}) shutdown timeout, forcing kill...`);
        this.daemonProcess?.kill('SIGKILL');
        resolve();
      }, 5000);

      this.daemonProcess.once('close', () => {
        clearTimeout(timeoutId);
        resolve();
      });

      // Send shutdown command
      try {
        this.daemonProcess.stdin.write(JSON.stringify({ command: 'shutdown' }) + '\n');
      } catch (e) {
        // stdin may already be closed
        this.daemonProcess.kill('SIGTERM');
      }
    });
  }

  /**
   * Check if daemon is ready
   */
  isReady() {
    return this.daemonReady;
  }

  /**
   * Check if Qwen TTS is enabled
   */
  isEnabled() {
    return config.qwenTts.enabled;
  }

  /**
   * Get model info
   */
  getModelInfo() {
    return { ...this.modelInfo };
  }

  /**
   * List available voices
   */
  listVoices() {
    return this.modelInfo.voices.length > 0
      ? this.modelInfo.voices
      : ['Chelsie', 'Ethan', 'Serena', 'Vivian', 'Ryan', 'Aiden', 'Eric', 'Dylan'];
  }

  /**
   * Check if a feature is supported by the current model
   */
  supportsFeature(feature) {
    return this.modelInfo.features.includes(feature);
  }
}

// Export dual service instances for Base (voice cloning) and CustomVoice (style instructions)
export const qwenTtsBaseService = new QwenTTSService(config.qwenTts.baseModelVariant || 'base-0.6b');
export const qwenTtsCustomVoiceService = new QwenTTSService(config.qwenTts.customVoiceModelVariant || 'custom-voice');

// Legacy export for backward compatibility
export const qwenTtsService = qwenTtsBaseService;
