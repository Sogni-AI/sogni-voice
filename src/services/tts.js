import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.js';
import { TTSError } from '../utils/errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Daemon state (module-level singleton)
let daemonProcess = null;
let daemonReady = false;
let initPromise = null;
let requestIdCounter = 0;
const pendingRequests = new Map();

export class TTSService {
  /**
   * Initialize the TTS daemon. Uses promise deduplication
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
      const daemonPath = join(__dirname, '../../scripts/tts_daemon.py');

      console.log('Starting Kokoro TTS daemon (model loading may take a moment)...');

      const pythonPath = join(__dirname, '../../.venv/bin/python3');
      daemonProcess = spawn(pythonPath, [daemonPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      });

      // Handle stderr (daemon logs)
      daemonProcess.stderr.on('data', (data) => {
        console.log(`[tts-daemon] ${data.toString().trim()}`);
      });

      // Handle stdout (JSON responses)
      const rl = createInterface({ input: daemonProcess.stdout });

      rl.on('line', (line) => {
        // Skip empty lines
        if (!line.trim()) return;

        // Check if line looks like JSON before parsing
        // This filters out pip/spacy installation output that leaks to stdout
        if (!line.startsWith('{')) {
          console.log(`[tts-daemon] ${line}`);
          return;
        }

        try {
          const response = JSON.parse(line);

          // Handle ready signal
          if (response.status === 'ready') {
            console.log('Kokoro TTS daemon ready');
            daemonReady = true;
            resolve();
            return;
          }

          // Handle error during startup
          if (response.status === 'error' && !daemonReady) {
            reject(new TTSError(`Daemon failed to start: ${response.error}`));
            return;
          }

          // Handle TTS response
          const requestId = response.id;
          const pending = pendingRequests.get(requestId);
          if (pending) {
            pendingRequests.delete(requestId);
            if (response.success) {
              pending.resolve({
                outputPath: response.output_path,
                duration: response.duration,
              });
            } else {
              pending.reject(new TTSError(response.error));
            }
          }
        } catch (e) {
          // Log unexpected JSON parse failures, but don't spam for known non-JSON output
          console.error('Failed to parse TTS daemon JSON response:', line, e);
        }
      });

      // Handle daemon exit
      daemonProcess.on('close', (code) => {
        console.log(`TTS daemon exited with code ${code}`);
        daemonReady = false;
        daemonProcess = null;
        initPromise = null;

        // Reject all pending requests
        for (const [id, pending] of pendingRequests) {
          pending.reject(new TTSError('TTS daemon process terminated'));
          pendingRequests.delete(id);
        }

        // If we haven't resolved yet, reject
        if (!daemonReady) {
          reject(new TTSError(`TTS daemon exited unexpectedly with code ${code}`));
        }
      });

      daemonProcess.on('error', (error) => {
        initPromise = null;
        reject(new TTSError(`Failed to spawn TTS daemon: ${error.message}`, error));
      });

      // Timeout for initialization
      const startupTimeout = config.tts.daemonStartupTimeout || 60000;
      setTimeout(() => {
        if (!daemonReady) {
          this.shutdown();
          reject(new TTSError('TTS daemon initialization timed out'));
        }
      }, startupTimeout);
    });
  }

  /**
   * Ensure daemon is running, restart if needed
   */
  async _ensureDaemon() {
    if (!daemonReady || !daemonProcess) {
      console.log('TTS daemon not available, attempting to start...');
      initPromise = null;
      daemonReady = false;
      await this.initialize();
    }
  }

  /**
   * Generate speech from text
   * @param {string} text - Text to convert to speech
   * @param {object} options - TTS options
   * @param {string} options.voice - Voice to use
   * @param {number} options.speed - Speech speed
   * @param {string} options.outputPath - Path to save audio file
   * @returns {Promise<{outputPath: string, duration: number}>}
   */
  async generate(text, options = {}) {
    const {
      voice = config.tts.defaultVoice,
      speed = config.tts.defaultSpeed,
      outputPath,
    } = options;

    if (!outputPath) {
      throw new TTSError('outputPath is required');
    }

    await this._ensureDaemon();

    if (!daemonProcess || !daemonReady) {
      throw new TTSError('TTS daemon not available');
    }

    const requestId = `req-${++requestIdCounter}`;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new TTSError('TTS generation timed out'));
      }, config.tts.timeout || 60000);

      pendingRequests.set(requestId, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve({
            audio: null, // Audio is saved to file, not returned
            voice,
            speed,
            outputPath: result.outputPath,
            duration: result.duration,
          });
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      });

      const request = JSON.stringify({
        id: requestId,
        text,
        voice,
        speed,
        output_path: outputPath,
      });

      daemonProcess.stdin.write(request + '\n');
    });
  }

  /**
   * Gracefully shutdown the daemon
   */
  async shutdown() {
    if (!daemonProcess) return;

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        console.log('TTS daemon shutdown timeout, forcing kill...');
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

  /**
   * List available voices
   */
  listVoices() {
    // MLX Kokoro voices - expanded list
    return [
      // American English - Female
      'af_heart', 'af_alloy', 'af_aoede', 'af_bella', 'af_jessica',
      'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah',
      'af_sky', 'af_sage',
      // American English - Male
      'am_adam', 'am_echo', 'am_eric', 'am_fenrir',
      'am_liam', 'am_michael', 'am_onyx', 'am_puck',
      // British English - Female
      'bf_emma', 'bf_isabella', 'bf_alice', 'bf_lily',
      // British English - Male
      'bm_george', 'bm_lewis', 'bm_daniel', 'bm_fable',
      // Japanese - Female
      'jf_alpha', 'jf_gongitsune',
      // Japanese - Male
      'jm_kumo',
      // Chinese - Female
      'zf_xiaobei', 'zf_xiaoni', 'zf_xiaoxuan',
      // Chinese - Male
      'zm_yunjian', 'zm_yunxi', 'zm_yunyang',
    ];
  }
}

export const ttsService = new TTSService();
