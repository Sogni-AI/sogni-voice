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
import re
import signal
import traceback
import os
import io
import contextlib
import importlib
import time
from collections import OrderedDict
from dataclasses import fields, is_dataclass

from safetensors.torch import save_file as _st_save_file
from safetensors import safe_open


# --- Safe voice prompt serialization using safetensors ---
# safetensors stores only tensor data + JSON metadata header.
# No code execution is structurally possible.

ALLOWED_VOICE_PROMPT_DATACLASSES = {
    (
        "qwen_tts.inference.qwen3_tts_model",
        "VoiceClonePromptItem",
    ): frozenset({
        "ref_code",
        "ref_spk_embedding",
        "x_vector_only_mode",
        "icl_mode",
        "ref_text",
    }),
}


def _resolve_allowed_voice_prompt_dataclass(class_module, class_name, field_nodes):
    """Resolve only dataclasses that this service writes to clone files."""
    allowed_fields = ALLOWED_VOICE_PROMPT_DATACLASSES.get((class_module, class_name))
    if allowed_fields is None:
        raise ValueError(
            f"Unsupported serialized voice prompt dataclass: {class_module}.{class_name}"
        )

    if not isinstance(field_nodes, dict):
        raise ValueError("Serialized dataclass fields must be an object")

    provided_fields = frozenset(field_nodes.keys())
    if provided_fields != allowed_fields:
        raise ValueError(
            f"Unexpected fields for serialized voice prompt dataclass: {sorted(provided_fields)}"
        )

    module = importlib.import_module(class_module)
    cls = module
    for part in class_name.split("."):
        cls = getattr(cls, part)

    if not is_dataclass(cls):
        raise ValueError(f"Allowed voice prompt type is not a dataclass: {class_module}.{class_name}")

    actual_fields = frozenset(field.name for field in fields(cls))
    if actual_fields != allowed_fields:
        raise ValueError(
            f"Allowed voice prompt dataclass schema changed: {class_module}.{class_name}"
        )

    return cls


def save_voice_prompt(prompt, path):
    """Save a voice prompt as a .safetensors file."""
    import torch

    tensors = {}

    def pack(value, key_prefix):
        if isinstance(value, torch.Tensor):
            tensor_key = key_prefix or "prompt"
            tensors[tensor_key] = value.detach().contiguous().cpu()
            return {"kind": "tensor", "key": tensor_key}

        if is_dataclass(value):
            cls = type(value)
            return {
                "kind": "dataclass",
                "class_module": cls.__module__,
                "class_name": cls.__qualname__,
                "fields": {
                    field.name: pack(getattr(value, field.name), f"{key_prefix}.{field.name}")
                    for field in fields(value)
                },
            }

        if isinstance(value, dict):
            return {
                "kind": "dict",
                "items": {
                    str(k): pack(v, f"{key_prefix}.{k}")
                    for k, v in value.items()
                },
            }

        if isinstance(value, list):
            return {
                "kind": "list",
                "items": [pack(item, f"{key_prefix}.{i}") for i, item in enumerate(value)],
            }

        if isinstance(value, tuple):
            return {
                "kind": "tuple",
                "items": [pack(item, f"{key_prefix}.{i}") for i, item in enumerate(value)],
            }

        if value is None or isinstance(value, (bool, int, float, str)):
            return {"kind": "literal", "value": value}

        raise ValueError(f"Unsupported voice prompt type for safetensors: {type(value)}")

    structure = pack(prompt, "prompt")
    _st_save_file(
        tensors,
        path,
        metadata={
            "format": "structured",
            "structure": json.dumps(structure, separators=(",", ":")),
        },
    )


def load_voice_prompt(path):
    """Load a voice prompt from a .safetensors file."""
    with safe_open(path, framework="pt") as f:
        metadata = f.metadata()
        fmt = metadata.get("format", "single_tensor")

        if fmt == "structured" and metadata.get("structure"):
            structure = json.loads(metadata["structure"])

            def unpack(node):
                kind = node["kind"]

                if kind == "tensor":
                    return f.get_tensor(node["key"])

                if kind == "literal":
                    return node["value"]

                if kind == "list":
                    return [unpack(item) for item in node["items"]]

                if kind == "tuple":
                    return tuple(unpack(item) for item in node["items"])

                if kind == "dict":
                    return {
                        key: unpack(value)
                        for key, value in node["items"].items()
                    }

                if kind == "dataclass":
                    field_nodes = node.get("fields")
                    cls = _resolve_allowed_voice_prompt_dataclass(
                        node.get("class_module"),
                        node.get("class_name"),
                        field_nodes,
                    )
                    kwargs = {
                        key: unpack(value)
                        for key, value in field_nodes.items()
                    }
                    return cls(**kwargs)

                raise ValueError(f"Unsupported serialized voice prompt kind: {kind}")

            return unpack(structure)

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
SAMPLE_RATE = 24000

# Qwen3 TTS is autoregressive with max_new_tokens=2048 codec tokens (~170s at
# 12Hz). On MPS the talker's attention slows non-linearly as the KV cache
# grows, so even modest output lengths (~600 tokens) push the JS-side timeout.
# Keep chunks small enough that each generation stays in the fast regime, and
# cap max_new_tokens proportional to chunk length so a non-terminating
# generation can't run away.
MAX_CHARS_PER_CHUNK = max(20, int(os.environ.get('QWEN_TTS_MAX_CHARS_PER_CHUNK', '100')))
CHUNK_SILENCE_SEC = max(0.0, float(os.environ.get('QWEN_TTS_CHUNK_SILENCE_SEC', '0.25')))
# Codec tokens per input char. English speech at ~12Hz codec rate uses roughly
# 1 codec token per 1-1.5 chars; 4x gives ample headroom while still bounding
# pathological generations.
TOKENS_PER_CHAR = max(1.0, float(os.environ.get('QWEN_TTS_TOKENS_PER_CHAR', '4')))
MIN_MAX_NEW_TOKENS = max(64, int(os.environ.get('QWEN_TTS_MIN_NEW_TOKENS', '128')))
MAX_MAX_NEW_TOKENS = max(MIN_MAX_NEW_TOKENS, int(os.environ.get('QWEN_TTS_MAX_NEW_TOKENS', '2048')))


def estimate_max_new_tokens(chunk: str) -> int:
    """Bound model.generate() output by chunk length so MPS slowdowns can't hang."""
    target = int(len(chunk) * TOKENS_PER_CHAR)
    return max(MIN_MAX_NEW_TOKENS, min(MAX_MAX_NEW_TOKENS, target))


def _split_overlong_sentence(sentence: str, max_chars: int):
    """Break a single sentence longer than max_chars at clause/word boundaries."""
    pieces = []
    remaining = sentence.strip()
    while len(remaining) > max_chars:
        cut = remaining.rfind(',', 0, max_chars)
        if cut < max_chars // 2:
            cut = remaining.rfind(' ', 0, max_chars)
        if cut < max_chars // 2:
            cut = max_chars
        pieces.append(remaining[:cut].strip())
        remaining = remaining[cut:].strip()
    if remaining:
        pieces.append(remaining)
    return pieces


def chunk_text(text: str, max_chars: int = MAX_CHARS_PER_CHUNK):
    """Split text at sentence boundaries so each chunk is <= max_chars.

    Returns a list of non-empty chunks. Short texts pass through as a single
    chunk so callers can keep the original single-shot generation path.
    """
    cleaned = (text or "").strip()
    if not cleaned:
        return []
    if len(cleaned) <= max_chars:
        return [cleaned]

    sentences = re.split(r'(?<=[.!?。！？])\s+|\n+', cleaned)
    chunks = []
    current = ""
    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue
        if len(sentence) > max_chars:
            if current:
                chunks.append(current)
                current = ""
            chunks.extend(_split_overlong_sentence(sentence, max_chars))
            continue
        candidate = f"{current} {sentence}".strip() if current else sentence
        if len(candidate) <= max_chars:
            current = candidate
        else:
            chunks.append(current)
            current = sentence
    if current:
        chunks.append(current)
    return chunks

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

    def _generate_chunked(self, label: str, text: str, output_path: str, generate_chunk):
        """Synthesise text in sentence-sized chunks and write concatenated audio.

        `generate_chunk(chunk_text, max_new_tokens)` must return `(wavs, sample_rate)`
        where `wavs[0]` is the numpy waveform for the chunk. Returns the standard
        response dict (success/output_path/duration on success, error otherwise).
        """
        import numpy as np
        import soundfile as sf

        chunks = chunk_text(text)
        if not chunks:
            return {"success": False, "error": "Text is empty"}

        total_chars = sum(len(c) for c in chunks)
        print(
            f"[{label}] Chunking input: {len(chunks)} chunk(s), {total_chars} chars total",
            file=sys.stderr,
        )

        sr = None
        audio_parts = []
        for i, chunk in enumerate(chunks, start=1):
            cap = estimate_max_new_tokens(chunk)
            print(
                f"[{label}] Generating chunk {i}/{len(chunks)} ({len(chunk)} chars, max_new_tokens={cap})",
                file=sys.stderr,
            )
            t0 = time.time()
            wavs, this_sr = generate_chunk(chunk, cap)
            if len(wavs) == 0 or wavs[0] is None:
                return {"success": False, "error": f"No audio generated for chunk {i}"}
            sr = this_sr
            audio_parts.append(wavs[0])
            print(
                f"[{label}] Chunk {i}/{len(chunks)} done in {time.time() - t0:.2f}s",
                file=sys.stderr,
            )
            if i < len(chunks) and CHUNK_SILENCE_SEC > 0:
                audio_parts.append(
                    np.zeros(int(CHUNK_SILENCE_SEC * sr), dtype=wavs[0].dtype)
                )

        audio = audio_parts[0] if len(audio_parts) == 1 else np.concatenate(audio_parts)
        duration = len(audio) / sr

        output_dir = os.path.dirname(output_path)
        if not os.path.exists(output_dir):
            print(
                f"[{label}] Output directory no longer exists (caller likely timed out), skipping write",
                file=sys.stderr,
            )
            return {"success": False, "error": "Output directory was cleaned up (request likely timed out)"}

        sf.write(output_path, audio, sr)
        return {"success": True, "output_path": output_path, "duration": duration}

    def _get_default_voice_prompt(self):
        """Get or create a default voice prompt for base models."""
        if self.default_voice_prompt is not None:
            return self.default_voice_prompt

        # Check for a default voice clone on disk.
        st_path = os.path.join(VOICE_CLONES_DIR, "_default.safetensors")

        if os.path.exists(st_path):
            try:
                self.default_voice_prompt = load_voice_prompt(st_path)
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
            lang_arg = language.capitalize() if language != "auto" else "Auto"

            if 'voice_cloning' in features:
                if ref_audio is None:
                    voice_prompt = self._get_default_voice_prompt()
                    if voice_prompt is None:
                        return {"success": False, "error": "Base model requires reference audio. Use generate_voice_clone or create a default voice."}

                    def run(chunk, max_new_tokens):
                        return self.model.generate_voice_clone(
                            text=chunk,
                            language=lang_arg,
                            voice_clone_prompt=voice_prompt,
                            max_new_tokens=max_new_tokens,
                        )
                else:
                    ref_text_arg = ref_text or ""

                    def run(chunk, max_new_tokens):
                        return self.model.generate_voice_clone(
                            text=chunk,
                            language=lang_arg,
                            ref_audio=ref_audio,
                            ref_text=ref_text_arg,
                            max_new_tokens=max_new_tokens,
                        )
            elif 'custom_voice' in features:
                speaker = (voice or os.environ.get('QWEN_TTS_DEFAULT_VOICE', 'Chelsie')).lower()

                def run(chunk, max_new_tokens):
                    return self.model.generate_custom_voice(
                        text=chunk,
                        speaker=speaker,
                        instruct="",
                        max_new_tokens=max_new_tokens,
                    )
            else:
                return {"success": False, "error": f"Model variant '{self.model_variant}' does not support standard TTS"}

            return self._generate_chunked("generate", text, output_path, run)
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
            speaker_arg = speaker.lower()

            def run(chunk, max_new_tokens):
                return self.model.generate_custom_voice(
                    text=chunk,
                    speaker=speaker_arg,
                    instruct=instruct,
                    max_new_tokens=max_new_tokens,
                )

            return self._generate_chunked("generate_custom_voice", text, output_path, run)
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
            def run(chunk, max_new_tokens):
                return self.model.generate_voice_design(
                    text=chunk,
                    instruct=instruct,
                    max_new_tokens=max_new_tokens,
                )

            return self._generate_chunked("generate_voice_design", text, output_path, run)
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
            print(f"[generate_voice_clone] Loading voice clone '{clone_id}'...", file=sys.stderr)
            prompt = self._get_cached_clone(clone_id)
            if prompt is None:
                st_path = os.path.join(VOICE_CLONES_DIR, f"{clone_id}.safetensors")
                if not os.path.exists(st_path):
                    return {"success": False, "error": f"Voice clone '{clone_id}' not found"}
                print(f"[generate_voice_clone] Reading prompt from {st_path}", file=sys.stderr)
                prompt = load_voice_prompt(st_path)
                self._cache_clone(clone_id, prompt)
                print(f"[generate_voice_clone] Prompt loaded and cached", file=sys.stderr)
            print(f"[generate_voice_clone] Prompt type: {type(prompt)}", file=sys.stderr)

            lang_arg = language.capitalize() if language != "auto" else "Auto"
            print(
                f"[generate_voice_clone] Starting generation: text='{text[:50]}...', language={language}",
                file=sys.stderr,
            )

            def run(chunk, max_new_tokens):
                return self.model.generate_voice_clone(
                    text=chunk,
                    language=lang_arg,
                    voice_clone_prompt=prompt,
                    max_new_tokens=max_new_tokens,
                )

            return self._generate_chunked("generate_voice_clone", text, output_path, run)
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
            legacy_path = os.path.join(VOICE_CLONES_DIR, f"{clone_id}.pkl")

            # Remove from cache
            if clone_id in self.voice_clones:
                del self.voice_clones[clone_id]

            deleted = False
            for path in (st_path, legacy_path):
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
            st_old = os.path.join(VOICE_CLONES_DIR, f"{old_clone_id}.safetensors")
            legacy_old = os.path.join(VOICE_CLONES_DIR, f"{old_clone_id}.pkl")
            if os.path.exists(st_old):
                old_path = st_old
            elif os.path.exists(legacy_old):
                return {"success": False, "error": "Legacy .pkl voice clones are no longer supported. Delete and recreate this clone as a .safetensors file."}
            else:
                return {"success": False, "error": f"Voice clone '{old_clone_id}' not found"}

            new_path = os.path.join(VOICE_CLONES_DIR, f"{new_clone_id}.safetensors")
            legacy_new = os.path.join(VOICE_CLONES_DIR, f"{new_clone_id}.pkl")

            if os.path.exists(new_path) or os.path.exists(legacy_new):
                return {"success": False, "error": f"Voice clone '{new_clone_id}' already exists"}

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
            return {"success": True, "clones": sorted(clones)}
        except Exception as e:
            print(f"List voice clones error: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return {"success": False, "error": str(e)}

    def validate_voice_clone(self, file_path: str) -> dict:
        """Validate a voice clone file stored in .safetensors format."""
        try:
            if not os.path.exists(file_path):
                return {"success": True, "valid": False, "error": "File not found"}

            print(f"[validate_voice_clone] Validating {file_path}", file=sys.stderr)

            import torch

            if not file_path.endswith('.safetensors'):
                return {"success": True, "valid": False, "error": "Unsupported file format (expected .safetensors)"}

            prompt = load_voice_prompt(file_path)

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
        """Import a voice clone from a .safetensors file."""
        if not self._validate_clone_id(clone_id):
            return {"success": False, "error": "Invalid clone_id"}

        try:
            if not os.path.exists(file_path):
                return {"success": False, "error": "Source file not found"}

            import shutil

            dest_path = os.path.join(VOICE_CLONES_DIR, f"{clone_id}.safetensors")

            if os.path.exists(dest_path):
                return {"success": False, "error": f"Voice clone '{clone_id}' already exists"}

            if not file_path.endswith('.safetensors'):
                return {"success": False, "error": "Unsupported file format (expected .safetensors)"}

            prompt = load_voice_prompt(file_path)
            print(f"[import_voice_clone] Loaded safetensors from {file_path}", file=sys.stderr)

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
