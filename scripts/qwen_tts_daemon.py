#!/usr/bin/env python3
"""
Qwen3-TTS Daemon

A persistent daemon that loads the Qwen3-TTS model once and accepts
text-to-speech requests via stdin/stdout JSON-line protocol.

Uses the official qwen-tts package with PyTorch on MPS (Apple Silicon).

Supports:
- Voice cloning from reference audio (Base models)
- CustomVoice model for emotion/style control
- VoiceDesign model for creating voices from descriptions

Protocol:
- Input (stdin): One JSON object per line with "type" field:
  {"id": "...", "type": "generate", "text": "Hello", "language": "English", "output_path": "/tmp/out.wav"}
  {"id": "...", "type": "generate_custom_voice", "text": "Hello", "speaker": "Chelsie", "instruct": "Happy tone", "output_path": "/tmp/out.wav"}
  {"id": "...", "type": "generate_voice_design", "text": "Hello", "instruct": "A deep male voice", "output_path": "/tmp/out.wav"}
  {"id": "...", "type": "create_voice_clone", "audio_path": "/tmp/ref.wav", "transcript": "Hello world", "clone_id": "clone_abc123"}
  {"id": "...", "type": "generate_voice_clone", "text": "Hello", "clone_id": "clone_abc123", "language": "English", "output_path": "/tmp/out.wav"}

- Output (stdout): One JSON object per line
  Success: {"id": "...", "success": true, "output_path": "/tmp/out.wav", "duration": 1.5}
  Error: {"id": "...", "success": false, "error": "error message"}

- Special messages:
  Ready signal: {"status": "ready", "model_variant": "base-0.6b"}
  Shutdown ack: {"id": "...", "status": "shutdown"}
"""

import sys
import json
import signal
import traceback
import os
import pickle
import io
import contextlib
from collections import OrderedDict

from safetensors.torch import save_file as _st_save_file
from safetensors import safe_open


# --- Safe voice prompt serialization using safetensors ---
# safetensors stores only tensor data + JSON metadata header.
# No code execution is structurally possible.
#
# Legacy .pkl files are loaded via RestrictedUnpickler (blocks arbitrary
# code execution) and auto-migrated to .safetensors on first load.


def save_voice_prompt(prompt, path):
    """Save a voice prompt as a .safetensors file."""
    import torch

    if isinstance(prompt, torch.Tensor):
        _st_save_file({"prompt": prompt.contiguous()}, path, metadata={"format": "single_tensor"})
    elif isinstance(prompt, dict):
        tensors = {k: v.contiguous() for k, v in prompt.items() if isinstance(v, torch.Tensor)}
        _st_save_file(tensors, path, metadata={"format": "dict"})
    elif isinstance(prompt, (list, tuple)):
        fmt = "tuple" if isinstance(prompt, tuple) else "list"
        tensors = {str(i): t.contiguous() for i, t in enumerate(prompt) if isinstance(t, torch.Tensor)}
        _st_save_file(tensors, path, metadata={"format": fmt, "length": str(len(prompt))})
    else:
        raise ValueError(f"Unsupported voice prompt type for safetensors: {type(prompt)}")


def load_voice_prompt(path):
    """Load a voice prompt from a .safetensors file."""
    with safe_open(path, framework="pt") as f:
        metadata = f.metadata()
        fmt = metadata.get("format", "single_tensor")

        if fmt == "single_tensor":
            return f.get_tensor("prompt")
        elif fmt == "dict":
            return {key: f.get_tensor(key) for key in f.keys()}
        elif fmt in ("list", "tuple"):
            length = int(metadata["length"])
            tensors = [f.get_tensor(str(i)) for i in range(length)]
            return tuple(tensors) if fmt == "tuple" else tensors
        else:
            return f.get_tensor("prompt")


# --- Legacy .pkl support (restricted unpickler for migration only) ---

SAFE_PICKLE_MODULES = {
    'collections': {'OrderedDict', 'defaultdict'},
    '_codecs': {'encode'},
    'copyreg': {'_reconstructor'},
}


class RestrictedUnpickler(pickle.Unpickler):
    """Unpickler that blocks arbitrary code execution.

    Only allows torch tensors, numpy arrays, and basic Python container types.
    Used only for migrating legacy .pkl files to safetensors.
    """

    def find_class(self, module, name):
        if module.startswith(('torch', 'numpy', '_numpy')):
            return super().find_class(module, name)

        allowed_names = SAFE_PICKLE_MODULES.get(module)
        if allowed_names is not None and name in allowed_names:
            return super().find_class(module, name)

        raise pickle.UnpicklingError(
            f"Blocked unsafe class: {module}.{name}"
        )


def safe_pickle_load(f):
    """Safely load a legacy .pkl file, blocking arbitrary code execution."""
    return RestrictedUnpickler(f).load()

# Ensure unbuffered output for reliable communication
sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)


@contextlib.contextmanager
def suppress_flash_attn_warning():
    """Suppress the flash-attn warning that qwen_tts prints on import.

    flash-attn is a CUDA-only library that cannot be installed on Apple Silicon.
    qwen_tts falls back to a PyTorch implementation which works fine on MPS.
    """
    original_stdout = sys.stdout
    sys.stdout = io.StringIO()
    try:
        yield
    finally:
        sys.stdout = original_stdout

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
VOICE_CLONES_DIR = os.environ.get('QWEN_TTS_VOICE_CLONES_DIR', os.path.join(SCRIPT_DIR, "..", "voice_clones"))
ALLOW_LEGACY_PICKLE_CLONES = os.environ.get('QWEN_TTS_ALLOW_LEGACY_PICKLE_CLONES', '0') == '1'
SAMPLE_RATE = 24000

# Model variant configurations (using official Qwen repos)
MODEL_VARIANTS = {
    'base-0.6b': {
        'repo': 'Qwen/Qwen3-TTS-12Hz-0.6B-Base',
        'features': ['tts', 'voice_cloning'],
    },
    'base-1.7b': {
        'repo': 'Qwen/Qwen3-TTS-12Hz-1.7B-Base',
        'features': ['tts', 'voice_cloning'],
    },
    'custom-voice-0.6b': {
        'repo': 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
        'features': ['tts', 'custom_voice'],
    },
    'custom-voice': {
        'repo': 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice',
        'features': ['tts', 'custom_voice'],
    },
    'voice-design': {
        'repo': 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign',
        'features': ['tts', 'voice_design'],
    },
}

# Available speakers for CustomVoice model (from qwen_tts library)
SPEAKERS = ['Aiden', 'Dylan', 'Eric', 'Ono_Anna', 'Ryan', 'Serena', 'Sohee', 'Uncle_Fu', 'Vivian']

# Supported languages
LANGUAGES = ['auto', 'chinese', 'english', 'french', 'german', 'italian', 'japanese', 'korean', 'portuguese', 'russian', 'spanish']


class QwenTTSDaemon:
    def __init__(self):
        self.model = None
        self.model_variant = os.environ.get('QWEN_TTS_MODEL_VARIANT', 'base-0.6b')
        self.running = True
        self.voice_clones = OrderedDict()  # LRU cache of loaded voice clone prompts
        self.max_cached_clones = int(os.environ.get('QWEN_TTS_MAX_CACHED_CLONES', '10'))
        self.default_voice_prompt = None  # cached default voice prompt for base models

        # Ensure voice clones directory exists
        os.makedirs(VOICE_CLONES_DIR, exist_ok=True)

    @staticmethod
    def _validate_clone_id(clone_id):
        """Validate clone_id to prevent path traversal."""
        if not clone_id or '/' in clone_id or '\\' in clone_id or '..' in clone_id:
            return False
        return True

    def _cache_clone(self, clone_id, prompt):
        """Add a voice clone prompt to the LRU cache, evicting oldest if full."""
        if clone_id in self.voice_clones:
            self.voice_clones.move_to_end(clone_id)
            self.voice_clones[clone_id] = prompt
        else:
            if len(self.voice_clones) >= self.max_cached_clones:
                evicted_id, _ = self.voice_clones.popitem(last=False)
                print(f"[cache] Evicted voice clone '{evicted_id}' from cache", file=sys.stderr)
            self.voice_clones[clone_id] = prompt

    def _get_cached_clone(self, clone_id):
        """Get a voice clone prompt from cache, moving it to most-recent. Returns None if not cached."""
        if clone_id in self.voice_clones:
            self.voice_clones.move_to_end(clone_id)
            return self.voice_clones[clone_id]
        return None

    def load_model(self) -> bool:
        """Load the Qwen3-TTS model. Returns True on success."""
        try:
            if self.model_variant not in MODEL_VARIANTS:
                print(f"Unknown model variant: {self.model_variant}", file=sys.stderr)
                print(f"Available variants: {list(MODEL_VARIANTS.keys())}", file=sys.stderr)
                return False

            model_info = MODEL_VARIANTS[self.model_variant]
            model_repo = model_info['repo']

            print(f"Loading Qwen3-TTS model ({self.model_variant})...", file=sys.stderr)
            print(f"Model: {model_repo}", file=sys.stderr)

            import torch
            with suppress_flash_attn_warning():
                from qwen_tts import Qwen3TTSModel

            # Use MPS (Apple Silicon GPU) with float32 for numerical stability
            device = "mps" if torch.backends.mps.is_available() else "cpu"
            print(f"Using device: {device}", file=sys.stderr)

            self.model = Qwen3TTSModel.from_pretrained(
                model_repo,
                device_map=device,
                dtype=torch.float32,  # float32 required for MPS stability
            )

            print("Qwen3-TTS model loaded successfully", file=sys.stderr)
            return True
        except ImportError as e:
            print(f"qwen-tts not installed: {e}", file=sys.stderr)
            print("Install with: pip install qwen-tts", file=sys.stderr)
            return False
        except Exception as e:
            print(f"Failed to load model: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return False

    def _get_default_voice_prompt(self):
        """Get or create a default voice prompt for base models."""
        if self.default_voice_prompt is not None:
            return self.default_voice_prompt

        # Check for a default voice clone on disk (safetensors first, then legacy .pkl)
        st_path = os.path.join(VOICE_CLONES_DIR, "_default.safetensors")
        pkl_path = os.path.join(VOICE_CLONES_DIR, "_default.pkl")

        if os.path.exists(st_path):
            try:
                self.default_voice_prompt = load_voice_prompt(st_path)
                return self.default_voice_prompt
            except Exception as e:
                print(f"[warning] Failed to load default voice prompt: {e}", file=sys.stderr)
        elif ALLOW_LEGACY_PICKLE_CLONES and os.path.exists(pkl_path):
            try:
                with open(pkl_path, 'rb') as f:
                    self.default_voice_prompt = safe_pickle_load(f)
                # Auto-migrate to safetensors
                save_voice_prompt(self.default_voice_prompt, st_path)
                os.remove(pkl_path)
                print(f"[migrate] Migrated _default.pkl to safetensors", file=sys.stderr)
                return self.default_voice_prompt
            except Exception as e:
                print(f"[warning] Failed to load default voice prompt: {e}", file=sys.stderr)

        return None

    def generate(self, text: str, language: str, output_path: str, ref_audio: str = None, ref_text: str = None, voice: str = None) -> dict:
        """Standard TTS generation using voice cloning (Base models require reference audio)."""
        if self.model is None:
            return {"success": False, "error": "Model not loaded"}

        model_info = MODEL_VARIANTS.get(self.model_variant, {})
        features = model_info.get('features', [])

        try:
            import soundfile as sf

            # Base models require voice cloning
            if 'voice_cloning' in features:
                if ref_audio is None:
                    # Try to use default voice prompt
                    voice_prompt = self._get_default_voice_prompt()
                    if voice_prompt is None:
                        return {"success": False, "error": "Base model requires reference audio. Use generate_voice_clone or create a default voice."}

                    wavs, sr = self.model.generate_voice_clone(
                        text=text,
                        language=language.capitalize() if language != "auto" else "Auto",
                        voice_clone_prompt=voice_prompt,
                    )
                else:
                    wavs, sr = self.model.generate_voice_clone(
                        text=text,
                        language=language.capitalize() if language != "auto" else "Auto",
                        ref_audio=ref_audio,
                        ref_text=ref_text or "",
                    )
            elif 'custom_voice' in features:
                # CustomVoice models can handle plain generate via generate_custom_voice with empty instruct
                speaker = voice or os.environ.get('QWEN_TTS_DEFAULT_VOICE', 'Chelsie')
                wavs, sr = self.model.generate_custom_voice(
                    text=text,
                    speaker=speaker.lower(),
                    instruct="",
                )
            else:
                return {"success": False, "error": f"Model variant '{self.model_variant}' does not support standard TTS"}

            if len(wavs) == 0 or wavs[0] is None:
                return {"success": False, "error": "No audio generated"}

            audio = wavs[0]
            duration = len(audio) / sr

            output_dir = os.path.dirname(output_path)
            if not os.path.exists(output_dir):
                print(f"[generate] Output directory no longer exists (caller likely timed out), skipping write", file=sys.stderr)
                return {"success": False, "error": "Output directory was cleaned up (request likely timed out)"}

            sf.write(output_path, audio, sr)

            return {
                "success": True,
                "output_path": output_path,
                "duration": duration,
            }
        except Exception as e:
            print(f"TTS generation error: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return {"success": False, "error": str(e)}

    def generate_custom_voice(self, text: str, speaker: str, instruct: str, output_path: str) -> dict:
        """Generate TTS with emotion/style instruction (CustomVoice model)."""
        if self.model is None:
            return {"success": False, "error": "Model not loaded"}

        model_info = MODEL_VARIANTS.get(self.model_variant, {})
        if 'custom_voice' not in model_info.get('features', []):
            return {"success": False, "error": f"custom_voice not supported by model variant '{self.model_variant}'"}

        try:
            import soundfile as sf

            # Speaker names must be lowercase for the model
            wavs, sr = self.model.generate_custom_voice(
                text=text,
                speaker=speaker.lower(),
                instruct=instruct,
            )

            if len(wavs) == 0 or wavs[0] is None:
                return {"success": False, "error": "No audio generated"}

            audio = wavs[0]
            duration = len(audio) / sr

            output_dir = os.path.dirname(output_path)
            if not os.path.exists(output_dir):
                print(f"[generate_custom_voice] Output directory no longer exists (caller likely timed out), skipping write", file=sys.stderr)
                return {"success": False, "error": "Output directory was cleaned up (request likely timed out)"}

            sf.write(output_path, audio, sr)

            return {
                "success": True,
                "output_path": output_path,
                "duration": duration,
            }
        except Exception as e:
            print(f"CustomVoice generation error: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return {"success": False, "error": str(e)}

    def generate_voice_design(self, text: str, instruct: str, output_path: str) -> dict:
        """Generate TTS with voice description (VoiceDesign model)."""
        if self.model is None:
            return {"success": False, "error": "Model not loaded"}

        model_info = MODEL_VARIANTS.get(self.model_variant, {})
        if 'voice_design' not in model_info.get('features', []):
            return {"success": False, "error": f"voice_design not supported by model variant '{self.model_variant}'"}

        try:
            import soundfile as sf

            wavs, sr = self.model.generate_voice_design(
                text=text,
                instruct=instruct,
            )

            if len(wavs) == 0 or wavs[0] is None:
                return {"success": False, "error": "No audio generated"}

            audio = wavs[0]
            duration = len(audio) / sr

            output_dir = os.path.dirname(output_path)
            if not os.path.exists(output_dir):
                print(f"[generate_voice_design] Output directory no longer exists (caller likely timed out), skipping write", file=sys.stderr)
                return {"success": False, "error": "Output directory was cleaned up (request likely timed out)"}

            sf.write(output_path, audio, sr)

            return {
                "success": True,
                "output_path": output_path,
                "duration": duration,
            }
        except Exception as e:
            print(f"VoiceDesign generation error: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return {"success": False, "error": str(e)}

    def create_voice_clone(self, audio_path: str, transcript: str, clone_id: str) -> dict:
        """Create a voice clone from reference audio."""
        if self.model is None:
            return {"success": False, "error": "Model not loaded"}

        if not self._validate_clone_id(clone_id):
            return {"success": False, "error": "Invalid clone_id"}

        model_info = MODEL_VARIANTS.get(self.model_variant, {})
        if 'voice_cloning' not in model_info.get('features', []):
            return {"success": False, "error": f"voice_cloning not supported by model variant '{self.model_variant}'"}

        try:
            import time

            print(f"[create_voice_clone] Creating clone '{clone_id}' from {audio_path}", file=sys.stderr)
            print(f"[create_voice_clone] Transcript: '{transcript[:100]}...'", file=sys.stderr)

            # Create voice prompt from reference audio
            start_time = time.time()
            prompt = self.model.create_voice_clone_prompt(
                ref_audio=audio_path,
                ref_text=transcript,
            )
            elapsed = time.time() - start_time
            print(f"[create_voice_clone] Prompt created in {elapsed:.2f}s, type: {type(prompt)}", file=sys.stderr)

            # Save the voice prompt to disk as safetensors
            clone_path = os.path.join(VOICE_CLONES_DIR, f"{clone_id}.safetensors")
            save_voice_prompt(prompt, clone_path)
            print(f"[create_voice_clone] Saved to {clone_path}", file=sys.stderr)

            # Cache it (LRU)
            self._cache_clone(clone_id, prompt)

            return {
                "success": True,
                "clone_id": clone_id,
                "clone_path": clone_path,
            }
        except Exception as e:
            print(f"Voice clone creation error: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return {"success": False, "error": str(e)}

    def generate_voice_clone(self, text: str, clone_id: str, language: str, output_path: str) -> dict:
        """Generate TTS using a cloned voice."""
        if self.model is None:
            return {"success": False, "error": "Model not loaded"}

        if not self._validate_clone_id(clone_id):
            return {"success": False, "error": "Invalid clone_id"}

        model_info = MODEL_VARIANTS.get(self.model_variant, {})
        if 'voice_cloning' not in model_info.get('features', []):
            return {"success": False, "error": f"voice_cloning not supported by model variant '{self.model_variant}'"}

        try:
            import soundfile as sf
            import time

            # Load voice prompt from LRU cache or disk
            print(f"[generate_voice_clone] Loading voice clone '{clone_id}'...", file=sys.stderr)
            prompt = self._get_cached_clone(clone_id)
            if prompt is None:
                st_path = os.path.join(VOICE_CLONES_DIR, f"{clone_id}.safetensors")
                pkl_path = os.path.join(VOICE_CLONES_DIR, f"{clone_id}.pkl")

                if os.path.exists(st_path):
                    print(f"[generate_voice_clone] Reading prompt from {st_path}", file=sys.stderr)
                    prompt = load_voice_prompt(st_path)
                elif ALLOW_LEGACY_PICKLE_CLONES and os.path.exists(pkl_path):
                    print(f"[generate_voice_clone] Migrating legacy {pkl_path}", file=sys.stderr)
                    with open(pkl_path, 'rb') as f:
                        prompt = safe_pickle_load(f)
                    # Auto-migrate to safetensors
                    save_voice_prompt(prompt, st_path)
                    os.remove(pkl_path)
                    print(f"[migrate] Migrated {clone_id}.pkl to safetensors", file=sys.stderr)
                else:
                    return {"success": False, "error": f"Voice clone '{clone_id}' not found"}

                self._cache_clone(clone_id, prompt)
                print(f"[generate_voice_clone] Prompt loaded and cached", file=sys.stderr)
            print(f"[generate_voice_clone] Prompt type: {type(prompt)}", file=sys.stderr)

            print(f"[generate_voice_clone] Starting generation: text='{text[:50]}...', language={language}", file=sys.stderr)
            start_time = time.time()

            wavs, sr = self.model.generate_voice_clone(
                text=text,
                language=language.capitalize() if language != "auto" else "Auto",
                voice_clone_prompt=prompt,
            )

            elapsed = time.time() - start_time
            print(f"[generate_voice_clone] Generation completed in {elapsed:.2f}s", file=sys.stderr)

            if len(wavs) == 0 or wavs[0] is None:
                return {"success": False, "error": "No audio generated"}

            audio = wavs[0]
            duration = len(audio) / sr

            # Check if output directory still exists (caller may have timed out and cleaned up)
            output_dir = os.path.dirname(output_path)
            if not os.path.exists(output_dir):
                print(f"[generate_voice_clone] Output directory no longer exists (caller likely timed out), skipping write", file=sys.stderr)
                return {"success": False, "error": "Output directory was cleaned up (request likely timed out)"}

            print(f"[generate_voice_clone] Writing audio to {output_path}, samples={len(audio)}, sr={sr}", file=sys.stderr)
            sf.write(output_path, audio, sr)

            return {
                "success": True,
                "output_path": output_path,
                "duration": duration,
            }
        except Exception as e:
            print(f"Voice clone generation error: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return {"success": False, "error": str(e)}

    def delete_voice_clone(self, clone_id: str) -> dict:
        """Delete a voice clone."""
        if not self._validate_clone_id(clone_id):
            return {"success": False, "error": "Invalid clone_id"}

        try:
            st_path = os.path.join(VOICE_CLONES_DIR, f"{clone_id}.safetensors")
            # Remove from cache
            if clone_id in self.voice_clones:
                del self.voice_clones[clone_id]

            # Remove from disk (check both formats)
            deleted = False
            delete_paths = [st_path]
            if os.path.exists(os.path.join(VOICE_CLONES_DIR, f"{clone_id}.pkl")):
                delete_paths.append(os.path.join(VOICE_CLONES_DIR, f"{clone_id}.pkl"))

            for path in delete_paths:
                if os.path.exists(path):
                    os.remove(path)
                    deleted = True

            if deleted:
                return {"success": True, "clone_id": clone_id}
            else:
                return {"success": False, "error": f"Voice clone '{clone_id}' not found"}
        except Exception as e:
            print(f"Voice clone deletion error: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return {"success": False, "error": str(e)}

    def rename_voice_clone(self, old_clone_id: str, new_clone_id: str) -> dict:
        """Rename a voice clone."""
        if not self._validate_clone_id(old_clone_id) or not self._validate_clone_id(new_clone_id):
            return {"success": False, "error": "Invalid clone_id"}

        try:
            # Find source file (safetensors or legacy pkl)
            st_old = os.path.join(VOICE_CLONES_DIR, f"{old_clone_id}.safetensors")
            if os.path.exists(st_old):
                old_path = st_old
                ext = ".safetensors"
            elif os.path.exists(os.path.join(VOICE_CLONES_DIR, f"{old_clone_id}.pkl")):
                if not ALLOW_LEGACY_PICKLE_CLONES:
                    return {"success": False, "error": "Legacy .pkl voice clones are disabled. Set QWEN_TTS_ALLOW_LEGACY_PICKLE_CLONES=1 to migrate this clone."}
                old_path = os.path.join(VOICE_CLONES_DIR, f"{old_clone_id}.pkl")
                ext = ".safetensors"  # migrate on rename
            else:
                return {"success": False, "error": f"Voice clone '{old_clone_id}' not found"}

            new_path = os.path.join(VOICE_CLONES_DIR, f"{new_clone_id}.safetensors")

            # Check if destination already exists (either format)
            if os.path.exists(new_path) or os.path.exists(os.path.join(VOICE_CLONES_DIR, f"{new_clone_id}.pkl")):
                return {"success": False, "error": f"Voice clone '{new_clone_id}' already exists"}

            if old_path.endswith('.pkl'):
                # Migrate legacy pkl to safetensors during rename
                with open(old_path, 'rb') as f:
                    prompt = safe_pickle_load(f)
                save_voice_prompt(prompt, new_path)
                os.remove(old_path)
                print(f"[migrate] Migrated {old_clone_id}.pkl to {new_clone_id}.safetensors", file=sys.stderr)
            else:
                os.rename(old_path, new_path)

            # Update cache if the old clone was cached
            if old_clone_id in self.voice_clones:
                prompt = self.voice_clones.pop(old_clone_id)
                self._cache_clone(new_clone_id, prompt)

            print(f"[rename_voice_clone] Renamed '{old_clone_id}' to '{new_clone_id}'", file=sys.stderr)

            return {
                "success": True,
                "old_clone_id": old_clone_id,
                "new_clone_id": new_clone_id,
            }
        except Exception as e:
            print(f"Voice clone rename error: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return {"success": False, "error": str(e)}

    def list_voice_clones(self) -> dict:
        """List all available voice clones."""
        try:
            clones = set()
            if os.path.exists(VOICE_CLONES_DIR):
                for filename in os.listdir(VOICE_CLONES_DIR):
                    if filename.startswith('_'):
                        continue
                    if filename.endswith('.safetensors'):
                        clones.add(filename[:-len('.safetensors')])
                    elif ALLOW_LEGACY_PICKLE_CLONES and filename.endswith('.pkl'):
                        clones.add(filename[:-4])
            return {"success": True, "clones": sorted(clones)}
        except Exception as e:
            print(f"List voice clones error: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return {"success": False, "error": str(e)}

    def validate_voice_clone(self, file_path: str) -> dict:
        """Validate a voice clone file (.safetensors or legacy .pkl).

        For .safetensors: verifies the file can be opened and contains tensors.
        For .pkl: uses RestrictedUnpickler to block code execution, then validates.
        """
        try:
            if not os.path.exists(file_path):
                return {"success": True, "valid": False, "error": "File not found"}

            print(f"[validate_voice_clone] Validating {file_path}", file=sys.stderr)

            import torch

            if file_path.endswith('.safetensors'):
                # safetensors is safe by design — just verify it contains valid data
                prompt = load_voice_prompt(file_path)
            elif file_path.endswith('.pkl'):
                if not ALLOW_LEGACY_PICKLE_CLONES:
                    return {"success": True, "valid": False, "error": "Legacy .pkl voice clones are disabled"}
                # Legacy pickle — use restricted unpickler
                with open(file_path, 'rb') as f:
                    prompt = safe_pickle_load(f)
            else:
                return {"success": True, "valid": False, "error": "Unsupported file format (expected .safetensors or .pkl)"}

            if isinstance(prompt, (torch.Tensor, dict, list, tuple)):
                print(f"[validate_voice_clone] Valid prompt type: {type(prompt)}", file=sys.stderr)
                return {"success": True, "valid": True}
            else:
                return {"success": True, "valid": False, "error": f"Unexpected type: {type(prompt).__name__}"}

        except Exception as e:
            print(f"Validate voice clone error: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return {"success": True, "valid": False, "error": str(e)}

    def import_voice_clone(self, file_path: str, clone_id: str) -> dict:
        """Import a voice clone from a .safetensors or legacy .pkl file.

        Loads the prompt, saves as .safetensors in the voice clones directory, and caches it.
        """
        if not self._validate_clone_id(clone_id):
            return {"success": False, "error": "Invalid clone_id"}

        try:
            if not os.path.exists(file_path):
                return {"success": False, "error": "Source file not found"}

            import shutil

            dest_path = os.path.join(VOICE_CLONES_DIR, f"{clone_id}.safetensors")

            # Check if destination already exists (either format)
            if os.path.exists(dest_path) or os.path.exists(os.path.join(VOICE_CLONES_DIR, f"{clone_id}.pkl")):
                return {"success": False, "error": f"Voice clone '{clone_id}' already exists"}

            # Load from source file
            if file_path.endswith('.safetensors'):
                prompt = load_voice_prompt(file_path)
                print(f"[import_voice_clone] Loaded safetensors from {file_path}", file=sys.stderr)
            elif file_path.endswith('.pkl'):
                if not ALLOW_LEGACY_PICKLE_CLONES:
                    return {"success": False, "error": "Legacy .pkl voice clones are disabled"}
                with open(file_path, 'rb') as f:
                    prompt = safe_pickle_load(f)
                print(f"[import_voice_clone] Loaded legacy pkl from {file_path}", file=sys.stderr)
            else:
                return {"success": False, "error": "Unsupported file format (expected .safetensors or .pkl)"}

            # Always save as safetensors
            save_voice_prompt(prompt, dest_path)
            self._cache_clone(clone_id, prompt)

            print(f"[import_voice_clone] Imported and cached '{clone_id}' as safetensors", file=sys.stderr)

            return {"success": True, "clone_id": clone_id}

        except Exception as e:
            print(f"Import voice clone error: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return {"success": False, "error": str(e)}

    def send_response(self, response: dict):
        """Send JSON response to stdout."""
        print(json.dumps(response), flush=True)

    def handle_request(self, line: str) -> dict:
        """Parse and handle a request line. Returns response dict."""
        try:
            request = json.loads(line)
        except json.JSONDecodeError as e:
            return {"success": False, "error": f"Invalid JSON: {e}"}

        request_id = request.get("id", "unknown")
        request_type = request.get("type", "generate")

        # Handle shutdown command
        if request.get("command") == "shutdown":
            self.running = False
            return {"id": request_id, "status": "shutdown"}

        # Route to appropriate handler
        if request_type == "generate":
            text = request.get("text")
            if not text:
                return {"id": request_id, "success": False, "error": "Missing text"}

            output_path = request.get("output_path")
            if not output_path:
                return {"id": request_id, "success": False, "error": "Missing output_path"}

            language = request.get("language", "english")
            voice = request.get("voice")
            ref_audio = request.get("ref_audio")
            ref_text = request.get("ref_text")

            result = self.generate(text, language, output_path, ref_audio, ref_text, voice=voice)
            result["id"] = request_id
            return result

        elif request_type == "generate_custom_voice":
            text = request.get("text")
            if not text:
                return {"id": request_id, "success": False, "error": "Missing text"}

            output_path = request.get("output_path")
            if not output_path:
                return {"id": request_id, "success": False, "error": "Missing output_path"}

            speaker = request.get("speaker", "Chelsie")
            instruct = request.get("instruct", "")

            result = self.generate_custom_voice(text, speaker, instruct, output_path)
            result["id"] = request_id
            return result

        elif request_type == "generate_voice_design":
            text = request.get("text")
            if not text:
                return {"id": request_id, "success": False, "error": "Missing text"}

            output_path = request.get("output_path")
            if not output_path:
                return {"id": request_id, "success": False, "error": "Missing output_path"}

            instruct = request.get("instruct")
            if not instruct:
                return {"id": request_id, "success": False, "error": "Missing instruct"}

            result = self.generate_voice_design(text, instruct, output_path)
            result["id"] = request_id
            return result

        elif request_type == "create_voice_clone":
            audio_path = request.get("audio_path")
            if not audio_path:
                return {"id": request_id, "success": False, "error": "Missing audio_path"}

            transcript = request.get("transcript")
            if not transcript:
                return {"id": request_id, "success": False, "error": "Missing transcript"}

            clone_id = request.get("clone_id")
            if not clone_id:
                return {"id": request_id, "success": False, "error": "Missing clone_id"}

            result = self.create_voice_clone(audio_path, transcript, clone_id)
            result["id"] = request_id
            return result

        elif request_type == "generate_voice_clone":
            text = request.get("text")
            if not text:
                return {"id": request_id, "success": False, "error": "Missing text"}

            output_path = request.get("output_path")
            if not output_path:
                return {"id": request_id, "success": False, "error": "Missing output_path"}

            clone_id = request.get("clone_id")
            if not clone_id:
                return {"id": request_id, "success": False, "error": "Missing clone_id"}

            language = request.get("language", "english")

            result = self.generate_voice_clone(text, clone_id, language, output_path)
            result["id"] = request_id
            return result

        elif request_type == "delete_voice_clone":
            clone_id = request.get("clone_id")
            if not clone_id:
                return {"id": request_id, "success": False, "error": "Missing clone_id"}

            result = self.delete_voice_clone(clone_id)
            result["id"] = request_id
            return result

        elif request_type == "list_voice_clones":
            result = self.list_voice_clones()
            result["id"] = request_id
            return result

        elif request_type == "rename_voice_clone":
            old_clone_id = request.get("old_clone_id")
            if not old_clone_id:
                return {"id": request_id, "success": False, "error": "Missing old_clone_id"}

            new_clone_id = request.get("new_clone_id")
            if not new_clone_id:
                return {"id": request_id, "success": False, "error": "Missing new_clone_id"}

            result = self.rename_voice_clone(old_clone_id, new_clone_id)
            result["id"] = request_id
            return result

        elif request_type == "validate_voice_clone":
            file_path = request.get("file_path") or request.get("pkl_path")
            if not file_path:
                return {"id": request_id, "success": False, "error": "Missing file_path"}

            result = self.validate_voice_clone(file_path)
            result["id"] = request_id
            return result

        elif request_type == "import_voice_clone":
            file_path = request.get("file_path") or request.get("pkl_path")
            if not file_path:
                return {"id": request_id, "success": False, "error": "Missing file_path"}

            clone_id = request.get("clone_id")
            if not clone_id:
                return {"id": request_id, "success": False, "error": "Missing clone_id"}

            result = self.import_voice_clone(file_path, clone_id)
            result["id"] = request_id
            return result

        else:
            return {"id": request_id, "success": False, "error": f"Unknown request type: {request_type}"}

    def run(self):
        """Main daemon loop."""
        # Setup signal handlers for graceful shutdown
        def handle_signal(signum, frame):
            print(f"Received signal {signum}, shutting down...", file=sys.stderr)
            self.running = False

        signal.signal(signal.SIGTERM, handle_signal)
        signal.signal(signal.SIGINT, handle_signal)

        # Load model
        if not self.load_model():
            self.send_response({"status": "error", "error": "Failed to load model"})
            sys.exit(1)

        # Get model info
        model_info = MODEL_VARIANTS.get(self.model_variant, {})
        features = model_info.get('features', [])

        # Get speakers from model if available
        try:
            speakers = self.model.get_supported_speakers() or []
        except Exception as e:
            print(f"[warning] Failed to get speakers from model: {e}", file=sys.stderr)
            speakers = SPEAKERS if 'custom_voice' in features else []

        # Signal ready with model info
        self.send_response({
            "status": "ready",
            "model_variant": self.model_variant,
            "features": features,
            "speakers": speakers,
            "languages": LANGUAGES,
        })

        # Main loop - read requests from stdin
        while self.running:
            try:
                line = sys.stdin.readline()
                if not line:  # EOF - parent process closed stdin
                    print("stdin closed, shutting down...", file=sys.stderr)
                    break

                line = line.strip()
                if not line:  # Empty line
                    continue

                response = self.handle_request(line)
                self.send_response(response)

            except Exception as e:
                print(f"Unexpected error in main loop: {e}", file=sys.stderr)
                traceback.print_exc(file=sys.stderr)
                self.send_response({
                    "success": False,
                    "error": f"Daemon error: {e}"
                })

        print("Qwen TTS daemon shutdown complete", file=sys.stderr)


if __name__ == "__main__":
    daemon = QwenTTSDaemon()
    daemon.run()
