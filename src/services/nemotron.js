import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Boom from '@hapi/boom';
import { config } from '../config/index.js';
import { DaemonRequestQueue } from '../utils/daemonRequestQueue.js';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

export class NemotronService {
  constructor() {
    this.process = null;
    this.ready = false;
    this.initializing = null;
    this.pending = new Map();
    this.queue = new DaemonRequestQueue({
      ensureDaemon: () => this.initialize(),
      getProcess: () => this.process,
      pendingRequests: this.pending,
      createError: (message) => Boom.serverUnavailable(message),
      idPrefix: 'nemotron',
    });
  }

  initialize() {
    if (this.ready) return Promise.resolve();
    if (this.initializing) return this.initializing;
    const cfg = config.nemotron;
    const child = spawn(resolve(projectRoot, cfg.pythonPath), [
      resolve(projectRoot, 'scripts/nemotron_daemon.py'),
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        NEMOTRON_BACKEND: cfg.backend,
        NEMOTRON_MODEL_ID: cfg.modelId,
        NEMOTRON_MODEL_REVISION: cfg.modelRevision,
        NEMOTRON_MODEL_PATH: cfg.modelPath,
        NEMOTRON_URL: cfg.url,
        NEMOTRON_MLX_BITS: String(cfg.mlxBits),
        NEMOTRON_MAX_NEW_TOKENS: String(cfg.maxNewTokens),
        NEMOTRON_TIMEOUT: String(cfg.timeout),
      },
    });
    this.process = child;
    child.stderr.on('data', (data) => console.log(`[nemotron] ${data.toString().trim()}`));
    const lines = createInterface({ input: child.stdout });
    this.initializing = new Promise((resolveStartup, rejectStartup) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        rejectStartup(Boom.serverUnavailable('Nemotron model initialization timed out'));
      }, cfg.daemonStartupTimeout);
      const failStartup = (message) => {
        clearTimeout(timer);
        rejectStartup(Boom.serverUnavailable(message));
      };
      lines.on('line', (line) => {
        let response;
        try {
          response = JSON.parse(line);
        } catch {
          console.error('Invalid Nemotron daemon response:', line);
          return;
        }
        if (response.status === 'ready') {
          clearTimeout(timer);
          this.ready = true;
          resolveStartup();
        } else if (response.status === 'error') {
          failStartup(`Nemotron failed to load: ${response.error}`);
          child.kill('SIGTERM');
        } else {
          const pending = this.pending.get(response.id);
          if (response.success) pending?.resolve(response);
          else pending?.reject(response.invalid_input
            ? Boom.badRequest(response.error)
            : Boom.badGateway(response.error || 'Nemotron transcription failed'));
        }
      });
      child.on('error', (error) => failStartup(`Cannot start Nemotron: ${error.message}`));
      child.on('close', (code) => {
        clearTimeout(timer);
        lines.close();
        this.ready = false;
        this.process = null;
        this.initializing = null;
        const error = Boom.serverUnavailable(`Nemotron daemon exited (${code})`);
        rejectStartup(error);
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
      });
    });
    return this.initializing;
  }

  async transcribe(audioFilePath, options = {}) {
    const response = await this.queue.request({
      audio_path: audioFilePath,
      timestamps: Boolean(options.timestamps),
      word_timestamps: Boolean(options.wordTimestamps),
      diarize: Boolean(options.diarize),
      prompt: options.prompt,
      hotwords: options.hotwords,
      max_new_tokens: options.maxNewTokens || config.nemotron.maxNewTokens,
    }, { timeout: config.nemotron.timeout, signal: options.signal });
    return {
      text: response.text,
      model: config.nemotron.modelId,
      revision: config.nemotron.modelRevision,
      backend: config.nemotron.backend,
      segments: response.segments,
      ...(response.timestamps ? {
        timestamps: response.timestamps,
        timestampLevel: options.wordTimestamps ? 'word' : 'sentence',
      } : {}),
      finishReason: response.finish_reason,
      complete: response.finish_reason === 'stop',
      metrics: response.metrics,
    };
  }

  async shutdown() {
    this.queue.cancelWaiting(Boom.serverUnavailable('Nemotron is shutting down'));
    const child = this.process;
    if (!child) return;
    await new Promise((resolveShutdown) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('close', () => {
        clearTimeout(timer);
        resolveShutdown();
      });
      child.kill('SIGTERM');
    });
  }

  isReady() { return this.ready; }
}

export const nemotronService = new NemotronService();
