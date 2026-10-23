import { config } from '../config/index.js';
import { FishTTSService, resolveFromProjectRoot } from './fishTts.js';

/**
 * Fish Audio Drama 3 through the drama3-mlx port (scripts/drama3_tts_daemon.py),
 * or on Linux + NVIDIA through vLLM-Omni (scripts/fish_omni_daemon.py).
 * Same JSON-line protocol and voice-clone store as Fish S2 Pro: a clone is a
 * reference clip + transcript, which both models consume as-is.
 */
export class Drama3TTSService extends FishTTSService {
  get cfg() { return config.drama3Tts; }

  get label() { return 'Fish Drama 3'; }

  get logTag() { return 'drama3-tts'; }

  get backend() {
    if (this.cfg?.backend === 'tensorfold') return 'fish-drama3-tensorfold';
    return this.cfg?.backend === 'vllm-omni' ? 'fish-drama3-vllm-omni' : 'fish-drama3-mlx';
  }

  get defaultModelId() { return 'fish-drama-3'; }

  daemonSpec() {
    if (this.cfg.backend === 'tensorfold') {
      const modelPath = resolveFromProjectRoot(this.cfg.modelPath);
      const nativePath = resolveFromProjectRoot(this.cfg.tensorfoldNativePath);
      return {
        script: 'drama3_tensorfold_daemon.py',
        setupHint: 'Build and start the TensorFold NVFP4 server (see docs/linux-nvidia.md).',
        requiredPaths: [['TensorFold encoder', nativePath], ['codec checkpoint', modelPath]],
        env: {
          FISH_OMNI_URL: this.cfg.tensorfoldUrl,
          FISH_OMNI_MODEL: this.cfg.omniModel,
          DRAMA3_TTS_MODEL_PATH: modelPath,
          DRAMA3_TTS_MODEL_ID: this.cfg.modelId,
          DRAMA3_TTS_TENSORFOLD_NATIVE_PATH: nativePath,
          FISH_TTS_VOICE_CLONES_DIR: resolveFromProjectRoot(this.cfg.voiceClonesDir),
        },
      };
    }
    if (this.cfg.backend === 'vllm-omni') {
      return this.omniDaemonSpec({
        FISH_OMNI_ENGINE: 'drama3',
        DRAMA3_TTS_MODEL_ID: this.cfg.modelId,
        DRAMA3_TTS_MAX_NEW_TOKENS: String(this.cfg.maxNewTokens),
      });
    }
    const modelPath = resolveFromProjectRoot(this.cfg.modelPath);
    return {
      script: 'drama3_tts_daemon.py',
      setupHint: 'Run the Fish Drama 3 setup (see docs/fish-drama3.md).',
      requiredPaths: [['model checkpoint', modelPath]],
      env: {
        DRAMA3_TTS_MODEL_PATH: modelPath,
        DRAMA3_TTS_MODEL_ID: this.cfg.modelId,
        DRAMA3_TTS_EXPERTS: this.cfg.experts,
        DRAMA3_TTS_MAX_NEW_TOKENS: String(this.cfg.maxNewTokens),
        // The S2 daemon base class reads the clone store from this variable.
        FISH_TTS_VOICE_CLONES_DIR: resolveFromProjectRoot(this.cfg.voiceClonesDir),
      },
    };
  }
}

export const drama3TtsService = new Drama3TTSService();
