#!/usr/bin/env python3
"""Persistent Qwen3-TTS daemon backed by MLX-Audio on Apple Silicon.

The JSON-line protocol and safe ``.safetensors`` clone format remain compatible
with the earlier PyTorch daemon. Legacy prompts are migrated lazily: their
codec tokens are decoded into an in-memory MLX reference, checked against the
stored speaker embedding, and then cached for subsequent requests.
"""

from collections import OrderedDict
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sys
import tempfile
import time
import traceback


sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)


EXPECTED_MLX_AUDIO_VERSION = "0.4.5"
VOICE_CLONES_DIR = Path(
    os.environ.get(
        "QWEN_TTS_VOICE_CLONES_DIR",
        Path(__file__).resolve().parent.parent / "voice_clones",
    )
).expanduser().resolve()
MODEL_VARIANT = os.environ.get("QWEN_TTS_MODEL_VARIANT", "base-0.6b")
MODEL_PRECISION = os.environ.get("QWEN_TTS_MLX_PRECISION", "8bit").lower()
MAX_CLONE_FILE_BYTES = 64 * 1024 * 1024
MIN_REFERENCE_SECONDS = 1.0
MAX_REFERENCE_SECONDS = 30.0
SAMPLE_RATE = 24000

MAX_CHARS_PER_CHUNK = max(
    20,
    int(os.environ.get("QWEN_TTS_MAX_CHARS_PER_CHUNK", "100")),
)
CHUNK_SILENCE_SEC = max(
    0.0,
    float(os.environ.get("QWEN_TTS_CHUNK_SILENCE_SEC", "0.25")),
)
TOKENS_PER_CHAR = max(
    1.0,
    float(os.environ.get("QWEN_TTS_TOKENS_PER_CHAR", "4")),
)
MIN_MAX_TOKENS = max(
    64,
    int(os.environ.get("QWEN_TTS_MIN_NEW_TOKENS", "128")),
)
MAX_MAX_TOKENS = max(
    MIN_MAX_TOKENS,
    int(os.environ.get("QWEN_TTS_MAX_NEW_TOKENS", "2048")),
)


MODEL_VARIANTS = {
    "base-0.6b": {
        "features": ["tts", "voice_cloning"],
        "models": {
            "8bit": (
                "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit",
                "50f45ef0047cde7e84c2ef04326acb8ada2436a7",
            ),
            "bf16": (
                "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16",
                "1eccf1cb2519b5a4e8a95b5f0544f3303568164f",
            ),
        },
    },
    "base-1.7b": {
        "features": ["tts", "voice_cloning"],
        "models": {
            "8bit": (
                "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit",
                "e7dd0585652209fa0d7783659aad4e8a324de11c",
            ),
            "bf16": (
                "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16",
                "a6eb4f68e4b056f1215157bb696209bc82a6db48",
            ),
        },
    },
    "custom-voice-0.6b": {
        "features": ["tts", "custom_voice"],
        "models": {
            "8bit": (
                "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit",
                "049ef77fe8816b536193c0c25f9a214d17921282",
            ),
            "bf16": (
                "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-bf16",
                "6415d95f88be018ff9e46813119dc3bc12261328",
            ),
        },
    },
    "custom-voice": {
        "features": ["tts", "custom_voice"],
        "models": {
            "8bit": (
                "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit",
                "41d3337e8b7f2843a75841595fc14e4b9a7a4b96",
            ),
            "bf16": (
                "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16",
                "52f4770fd9726457eae3d3b6aa92047a25a10776",
            ),
        },
    },
    "voice-design": {
        "features": ["tts", "voice_design"],
        "models": {
            "8bit": (
                "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit",
                "f90d617701d9f7f4ca499291e0b57f2b3c2fd2ee",
            ),
            "bf16": (
                "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16",
                "7d3824abff87e49756bb0f83fb5411de75d160c4",
            ),
        },
    },
}

SPEAKER_DISPLAY_NAMES = {
    "serena": "Serena",
    "vivian": "Vivian",
    "uncle_fu": "Uncle_Fu",
    "ryan": "Ryan",
    "aiden": "Aiden",
    "ono_anna": "Ono_Anna",
    "sohee": "Sohee",
    "eric": "Eric",
    "dylan": "Dylan",
}

ALLOWED_PROMPT_CLASS = (
    "qwen_tts.inference.qwen3_tts_model",
    "VoiceClonePromptItem",
)
ALLOWED_PROMPT_FIELDS = {
    "ref_code",
    "ref_spk_embedding",
    "x_vector_only_mode",
    "icl_mode",
    "ref_text",
}


def estimate_max_new_tokens(chunk: str) -> int:
    target = int(len(chunk) * TOKENS_PER_CHAR)
    return max(MIN_MAX_TOKENS, min(MAX_MAX_TOKENS, target))


def _split_overlong_sentence(sentence: str, max_chars: int):
    pieces = []
    remaining = sentence.strip()
    while len(remaining) > max_chars:
        cut = remaining.rfind(",", 0, max_chars)
        if cut < max_chars // 2:
            cut = remaining.rfind(" ", 0, max_chars)
        if cut < max_chars // 2:
            cut = max_chars
        pieces.append(remaining[:cut].strip())
        remaining = remaining[cut:].strip()
    if remaining:
        pieces.append(remaining)
    return pieces


def chunk_text(text: str, max_chars: int = MAX_CHARS_PER_CHUNK):
    cleaned = (text or "").strip()
    if not cleaned:
        return []
    if len(cleaned) <= max_chars:
        return [cleaned]

    sentences = re.split(r"(?<=[.!?。！？])\s+|\n+", cleaned)
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


def _literal_value(node, name, expected_type, *, allow_none=False):
    if not isinstance(node, dict) or node.get("kind") != "literal":
        raise ValueError(f"Voice prompt field {name} must be a literal")
    value = node.get("value")
    if value is None and allow_none:
        return None
    if not isinstance(value, expected_type):
        raise ValueError(f"Voice prompt field {name} has an invalid type")
    return value


def _validate_prompt_structure(structure):
    if isinstance(structure, dict) and structure.get("kind") == "dataclass":
        class_id = (structure.get("class_module"), structure.get("class_name"))
        if class_id != ALLOWED_PROMPT_CLASS:
            raise ValueError(
                "Unsupported serialized voice prompt dataclass: "
                f"{class_id[0]}.{class_id[1]}"
            )

    if not isinstance(structure, dict) or structure.get("kind") != "list":
        raise ValueError("Voice prompt must contain one serialized prompt item")
    items = structure.get("items")
    if not isinstance(items, list) or len(items) != 1:
        raise ValueError("Voice prompt must contain exactly one prompt item")

    item = items[0]
    if not isinstance(item, dict) or item.get("kind") != "dataclass":
        raise ValueError("Voice prompt item must be a dataclass record")
    class_id = (item.get("class_module"), item.get("class_name"))
    if class_id != ALLOWED_PROMPT_CLASS:
        raise ValueError(
            "Unsupported serialized voice prompt dataclass: "
            f"{class_id[0]}.{class_id[1]}"
        )

    fields = item.get("fields")
    if not isinstance(fields, dict) or set(fields) != ALLOWED_PROMPT_FIELDS:
        raise ValueError("Unexpected fields for serialized voice prompt dataclass")
    return fields


def load_voice_prompt(path):
    """Load clone tensors without importing or instantiating metadata classes."""
    import numpy as np
    from safetensors import safe_open

    path = Path(path)
    if path.suffix != ".safetensors":
        raise ValueError("Unsupported file format (expected .safetensors)")
    if not path.is_file():
        raise FileNotFoundError(path)
    if path.stat().st_size > MAX_CLONE_FILE_BYTES:
        raise ValueError("Voice clone file exceeds the 64 MB safety limit")

    with safe_open(str(path), framework="np") as handle:
        metadata = handle.metadata() or {}
        if metadata.get("format") != "structured" or not metadata.get("structure"):
            raise ValueError("Voice clone is missing structured safetensors metadata")
        structure = json.loads(metadata["structure"])
        fields = _validate_prompt_structure(structure)

        ref_code_node = fields["ref_code"]
        if ref_code_node.get("kind") == "literal" and ref_code_node.get("value") is None:
            ref_code = None
        elif ref_code_node.get("kind") == "tensor":
            ref_code = handle.get_tensor(ref_code_node.get("key"))
        else:
            raise ValueError("Voice prompt ref_code must be a tensor or null")

        embedding_node = fields["ref_spk_embedding"]
        if embedding_node.get("kind") != "tensor":
            raise ValueError("Voice prompt ref_spk_embedding must be a tensor")
        ref_spk_embedding = handle.get_tensor(embedding_node.get("key"))

        x_vector_only_mode = _literal_value(
            fields["x_vector_only_mode"],
            "x_vector_only_mode",
            bool,
        )
        icl_mode = _literal_value(fields["icl_mode"], "icl_mode", bool)
        ref_text = _literal_value(
            fields["ref_text"],
            "ref_text",
            str,
            allow_none=True,
        )

    if ref_code is not None:
        if ref_code.ndim != 2 or ref_code.shape[1] != 16:
            raise ValueError("Voice prompt ref_code must have shape [frames, 16]")
        if ref_code.shape[0] < 1 or not np.issubdtype(ref_code.dtype, np.integer):
            raise ValueError("Voice prompt ref_code must contain integer codec tokens")
        if int(ref_code.min()) < 0 or int(ref_code.max()) > 65535:
            raise ValueError("Voice prompt ref_code contains out-of-range codec tokens")

    if ref_spk_embedding.ndim != 1 or ref_spk_embedding.shape[0] not in {1024, 2048}:
        raise ValueError("Voice prompt speaker embedding must contain 1024 or 2048 values")
    if not np.issubdtype(ref_spk_embedding.dtype, np.floating):
        raise ValueError("Voice prompt speaker embedding must be floating point")
    if not np.isfinite(ref_spk_embedding).all():
        raise ValueError("Voice prompt speaker embedding contains non-finite values")

    if x_vector_only_mode or not icl_mode or ref_code is None or not ref_text:
        raise ValueError(
            "MLX migration requires an ICL clone with codec tokens and reference text"
        )

    return {
        "ref_code": ref_code.astype(np.int64, copy=False),
        "ref_spk_embedding": ref_spk_embedding.astype(np.float32, copy=False),
        "ref_text": ref_text,
        "x_vector_only_mode": x_vector_only_mode,
        "icl_mode": icl_mode,
    }


def save_voice_prompt(prompt, path):
    """Write the rollback-compatible PyTorch prompt schema using NumPy tensors."""
    import numpy as np
    from safetensors.numpy import save_file

    ref_code = np.asarray(prompt["ref_code"], dtype=np.int64)
    ref_spk_embedding = np.asarray(prompt["ref_spk_embedding"], dtype=np.float32)
    structure = {
        "kind": "list",
        "items": [
            {
                "kind": "dataclass",
                "class_module": ALLOWED_PROMPT_CLASS[0],
                "class_name": ALLOWED_PROMPT_CLASS[1],
                "fields": {
                    "ref_code": {"kind": "tensor", "key": "prompt.0.ref_code"},
                    "ref_spk_embedding": {
                        "kind": "tensor",
                        "key": "prompt.0.ref_spk_embedding",
                    },
                    "x_vector_only_mode": {"kind": "literal", "value": False},
                    "icl_mode": {"kind": "literal", "value": True},
                    "ref_text": {
                        "kind": "literal",
                        "value": prompt["ref_text"],
                    },
                },
            }
        ],
    }

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        prefix=f".{path.stem}-",
        suffix=".safetensors",
        dir=path.parent,
        delete=False,
    )
    temp_path = Path(handle.name)
    handle.close()
    try:
        save_file(
            {
                "prompt.0.ref_code": ref_code,
                "prompt.0.ref_spk_embedding": ref_spk_embedding,
            },
            str(temp_path),
            metadata={
                "format": "structured",
                "structure": json.dumps(structure, separators=(",", ":")),
                "backend": "mlx-audio",
                "mlx_audio_version": EXPECTED_MLX_AUDIO_VERSION,
            },
        )
        os.replace(temp_path, path)
    finally:
        temp_path.unlink(missing_ok=True)


class QwenTTSDaemon:
    def __init__(self):
        self.model = None
        self.running = True
        self.variant = MODEL_VARIANT
        self.precision = MODEL_PRECISION
        self.repo = None
        self.revision = None
        self.features = []
        self.voice_clones = OrderedDict()
        self.max_cached_clones = int(
            os.environ.get("QWEN_TTS_MAX_CACHED_CLONES", "10")
        )
        VOICE_CLONES_DIR.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _validate_clone_id(clone_id):
        return bool(clone_id) and re.fullmatch(r"[A-Za-z0-9_-]{1,100}", clone_id) is not None

    def _model_spec(self):
        if self.variant not in MODEL_VARIANTS:
            raise ValueError(
                f"Unknown Qwen3-TTS model variant: {self.variant}. "
                f"Available: {', '.join(MODEL_VARIANTS)}"
            )
        variant = MODEL_VARIANTS[self.variant]
        if self.precision not in variant["models"]:
            raise ValueError(
                f"Unsupported MLX precision {self.precision}; choose 8bit or bf16"
            )
        return variant, variant["models"][self.precision]

    def load_model(self):
        try:
            from importlib.metadata import version

            installed_version = version("mlx-audio")
            if installed_version != EXPECTED_MLX_AUDIO_VERSION:
                raise RuntimeError(
                    "mlx-audio version mismatch: "
                    f"expected {EXPECTED_MLX_AUDIO_VERSION}, found {installed_version}"
                )

            variant, (self.repo, self.revision) = self._model_spec()
            self.features = list(variant["features"])
            print(
                f"Loading Qwen3-TTS MLX model {self.repo}@{self.revision}...",
                file=sys.stderr,
            )
            from mlx_audio.tts.utils import load

            self.model = load(self.repo, revision=self.revision)
            print("Qwen3-TTS MLX model ready", file=sys.stderr)
            return True
        except Exception as exc:
            print(f"Failed to load Qwen3-TTS MLX model: {exc}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            self.send_response({"status": "error", "error": str(exc)})
            return False

    def _speaker_names(self):
        if self.model is None or not hasattr(self.model, "get_supported_speakers"):
            return []
        return [
            SPEAKER_DISPLAY_NAMES.get(str(name).lower(), str(name))
            for name in self.model.get_supported_speakers()
        ]

    def _expected_embedding_dim(self):
        config = getattr(self.model.config, "speaker_encoder_config", None)
        return int(getattr(config, "enc_dim", 0) or 0)

    def _ensure_prompt_compatible(self, prompt):
        expected_dim = self._expected_embedding_dim()
        actual_dim = int(prompt["ref_spk_embedding"].shape[0])
        if expected_dim and actual_dim != expected_dim:
            expected_variant = "base-0.6b" if actual_dim == 1024 else "base-1.7b"
            raise ValueError(
                f"Voice clone requires {expected_variant} (embedding {actual_dim}); "
                f"configured variant {self.variant} expects {expected_dim}"
            )

    def _cache_clone(self, clone_id, reference):
        if clone_id in self.voice_clones:
            self.voice_clones.move_to_end(clone_id)
        self.voice_clones[clone_id] = reference
        while len(self.voice_clones) > self.max_cached_clones:
            self.voice_clones.popitem(last=False)

    def _prompt_to_reference(self, prompt):
        import mlx.core as mx

        self._ensure_prompt_compatible(prompt)
        codes = mx.array(prompt["ref_code"].astype("int32"))[None, :, :]
        audio, lengths = self.model.speech_tokenizer.decode(codes)
        reference_audio = audio[0][: int(lengths[0])]
        mx.eval(reference_audio)

        reconstructed_embedding = self.model.extract_speaker_embedding(
            reference_audio
        ).reshape(-1)
        stored_embedding = mx.array(prompt["ref_spk_embedding"]).reshape(-1)
        mx.eval(reconstructed_embedding, stored_embedding)
        denominator = mx.sqrt(mx.sum(reconstructed_embedding * reconstructed_embedding))
        denominator *= mx.sqrt(mx.sum(stored_embedding * stored_embedding))
        cosine = float(
            mx.sum(reconstructed_embedding * stored_embedding) / denominator
        )
        if cosine < 0.95:
            raise ValueError(
                f"Legacy clone reconstruction failed speaker check ({cosine:.4f})"
            )
        return {
            "ref_audio": reference_audio,
            "ref_text": prompt["ref_text"],
            "migration_cosine": cosine,
        }

    def _load_clone_reference(self, clone_id):
        cached = self.voice_clones.get(clone_id)
        if cached is not None:
            self.voice_clones.move_to_end(clone_id)
            return cached

        clone_path = VOICE_CLONES_DIR / f"{clone_id}.safetensors"
        if not clone_path.is_file():
            raise FileNotFoundError(f"Voice clone '{clone_id}' not found")
        reference = self._prompt_to_reference(load_voice_prompt(clone_path))
        self._cache_clone(clone_id, reference)
        print(
            f"Migrated clone '{clone_id}' to MLX reference "
            f"(speaker cosine {reference['migration_cosine']:.4f})",
            file=sys.stderr,
        )
        return reference

    @staticmethod
    def _normalize_language(language):
        return str(language or "auto").strip().lower() or "auto"

    def _generate_chunked(self, label, text, output_path, generate_chunk):
        import mlx.core as mx
        import numpy as np
        from mlx_audio.audio_io import write

        chunks = chunk_text(text)
        if not chunks:
            return {"success": False, "error": "Text is empty"}

        sample_rate = None
        audio_parts = []
        started = time.perf_counter()
        for index, chunk in enumerate(chunks, start=1):
            max_tokens = estimate_max_new_tokens(chunk)
            print(
                f"[{label}] chunk {index}/{len(chunks)}: "
                f"{len(chunk)} chars, max_tokens={max_tokens}",
                file=sys.stderr,
            )
            results = list(generate_chunk(chunk, max_tokens))
            if not results:
                return {
                    "success": False,
                    "error": f"No audio generated for chunk {index}",
                }
            for result in results:
                mx.eval(result.audio)
                sample_rate = int(result.sample_rate)
                audio_parts.append(np.asarray(result.audio, dtype=np.float32))
            if index < len(chunks) and CHUNK_SILENCE_SEC > 0:
                audio_parts.append(
                    np.zeros(int(CHUNK_SILENCE_SEC * sample_rate), dtype=np.float32)
                )

        audio = audio_parts[0] if len(audio_parts) == 1 else np.concatenate(audio_parts)
        duration = len(audio) / sample_rate
        elapsed = time.perf_counter() - started
        output_path = Path(output_path)
        if not output_path.parent.is_dir():
            return {
                "success": False,
                "error": "Output directory was cleaned up (request likely timed out)",
            }
        write(output_path, audio, sample_rate, format="wav")
        return {
            "success": True,
            "output_path": str(output_path),
            "duration": duration,
            "processing_time": elapsed,
            "real_time_factor": elapsed / duration if duration else None,
            "backend": "mlx",
            "model": self.repo,
            "revision": self.revision,
        }

    def generate(self, text, language, output_path, ref_audio=None, ref_text=None, voice=None):
        try:
            language = self._normalize_language(language)
            if "voice_cloning" in self.features:
                if ref_audio is None:
                    reference = self._load_clone_reference("_default")
                    ref_audio = reference["ref_audio"]
                    ref_text = reference["ref_text"]

                def run(chunk, max_tokens):
                    return self.model.generate(
                        text=chunk,
                        ref_audio=ref_audio,
                        ref_text=ref_text,
                        lang_code=language,
                        max_tokens=max_tokens,
                        verbose=False,
                        stream=False,
                    )

            elif "custom_voice" in self.features:
                speaker = voice or "Ryan"

                def run(chunk, max_tokens):
                    return self.model.generate_custom_voice(
                        text=chunk,
                        speaker=speaker,
                        language=language,
                        instruct=None,
                        max_tokens=max_tokens,
                        verbose=False,
                        stream=False,
                    )

            else:
                raise ValueError(f"Variant {self.variant} does not support standard TTS")
            return self._generate_chunked("generate", text, output_path, run)
        except Exception as exc:
            print(f"Qwen3-TTS generation failed: {exc}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return {"success": False, "error": str(exc)}

    def generate_custom_voice(self, text, speaker, instruct, language, output_path):
        if "custom_voice" not in self.features:
            return {
                "success": False,
                "error": f"custom_voice not supported by model variant '{self.variant}'",
            }
        try:
            language = self._normalize_language(language)

            def run(chunk, max_tokens):
                return self.model.generate_custom_voice(
                    text=chunk,
                    speaker=speaker,
                    language=language,
                    instruct=instruct or None,
                    max_tokens=max_tokens,
                    verbose=False,
                    stream=False,
                )

            return self._generate_chunked(
                "generate_custom_voice",
                text,
                output_path,
                run,
            )
        except Exception as exc:
            print(f"CustomVoice generation failed: {exc}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return {"success": False, "error": str(exc)}

    def generate_voice_design(self, text, instruct, language, output_path):
        if "voice_design" not in self.features:
            return {
                "success": False,
                "error": f"voice_design not supported by model variant '{self.variant}'",
            }
        try:
            language = self._normalize_language(language)

            def run(chunk, max_tokens):
                return self.model.generate_voice_design(
                    text=chunk,
                    instruct=instruct,
                    language=language,
                    max_tokens=max_tokens,
                    verbose=False,
                    stream=False,
                )

            return self._generate_chunked(
                "generate_voice_design",
                text,
                output_path,
                run,
            )
        except Exception as exc:
            print(f"VoiceDesign generation failed: {exc}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return {"success": False, "error": str(exc)}

    def create_voice_clone(self, audio_path, transcript, clone_id):
        if not self._validate_clone_id(clone_id):
            return {"success": False, "error": "Invalid clone_id"}
        if "voice_cloning" not in self.features:
            return {
                "success": False,
                "error": f"voice_cloning not supported by model variant '{self.variant}'",
            }
        clone_path = VOICE_CLONES_DIR / f"{clone_id}.safetensors"
        if clone_path.exists():
            return {
                "success": False,
                "error": f"Voice clone '{clone_id}' already exists",
            }
        try:
            import mlx.core as mx
            import numpy as np
            from mlx_audio.utils import load_audio

            reference_audio = load_audio(audio_path, sample_rate=SAMPLE_RATE)
            duration = int(reference_audio.shape[-1]) / SAMPLE_RATE
            if duration < MIN_REFERENCE_SECONDS or duration > MAX_REFERENCE_SECONDS:
                raise ValueError(
                    "Reference audio must be between "
                    f"{int(MIN_REFERENCE_SECONDS)} and {int(MAX_REFERENCE_SECONDS)} "
                    f"seconds; received {duration:.2f}"
                )

            encoder_audio = reference_audio
            if encoder_audio.ndim == 1:
                encoder_audio = encoder_audio[None, None, :]
            elif encoder_audio.ndim == 2:
                encoder_audio = encoder_audio[None, :]
            ref_codes = self.model.speech_tokenizer.encode(encoder_audio)
            speaker_embedding = self.model.extract_speaker_embedding(
                reference_audio
            ).reshape(-1)
            mx.eval(ref_codes, speaker_embedding)

            prompt = {
                "ref_code": np.asarray(
                    mx.transpose(ref_codes, (0, 2, 1))[0],
                    dtype=np.int64,
                ),
                "ref_spk_embedding": np.asarray(
                    speaker_embedding,
                    dtype=np.float32,
                ),
                "ref_text": transcript,
            }
            self._ensure_prompt_compatible(prompt)
            save_voice_prompt(prompt, clone_path)
            self._cache_clone(
                clone_id,
                {
                    "ref_audio": reference_audio,
                    "ref_text": transcript,
                    "migration_cosine": 1.0,
                },
            )
            return {
                "success": True,
                "clone_id": clone_id,
                "clone_path": str(clone_path),
            }
        except Exception as exc:
            print(f"Voice clone creation failed: {exc}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            clone_path.unlink(missing_ok=True)
            return {"success": False, "error": str(exc)}

    def generate_voice_clone(self, text, clone_id, language, output_path):
        if not self._validate_clone_id(clone_id):
            return {"success": False, "error": "Invalid clone_id"}
        if "voice_cloning" not in self.features:
            return {
                "success": False,
                "error": f"voice_cloning not supported by model variant '{self.variant}'",
            }
        try:
            reference = self._load_clone_reference(clone_id)
            language = self._normalize_language(language)

            def run(chunk, max_tokens):
                return self.model.generate(
                    text=chunk,
                    ref_audio=reference["ref_audio"],
                    ref_text=reference["ref_text"],
                    lang_code=language,
                    max_tokens=max_tokens,
                    verbose=False,
                    stream=False,
                )

            result = self._generate_chunked(
                "generate_voice_clone",
                text,
                output_path,
                run,
            )
            if result.get("success"):
                result["migration_cosine"] = reference["migration_cosine"]
            return result
        except Exception as exc:
            print(f"Voice clone generation failed: {exc}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return {"success": False, "error": str(exc)}

    def delete_voice_clone(self, clone_id):
        if not self._validate_clone_id(clone_id):
            return {"success": False, "error": "Invalid clone_id"}
        self.voice_clones.pop(clone_id, None)
        deleted = False
        for suffix in (".safetensors", ".pkl"):
            path = VOICE_CLONES_DIR / f"{clone_id}{suffix}"
            if path.exists():
                path.unlink()
                deleted = True
        if not deleted:
            return {"success": False, "error": f"Voice clone '{clone_id}' not found"}
        return {"success": True, "clone_id": clone_id}

    def rename_voice_clone(self, old_clone_id, new_clone_id):
        if not self._validate_clone_id(old_clone_id) or not self._validate_clone_id(new_clone_id):
            return {"success": False, "error": "Invalid clone_id"}
        old_path = VOICE_CLONES_DIR / f"{old_clone_id}.safetensors"
        new_path = VOICE_CLONES_DIR / f"{new_clone_id}.safetensors"
        if not old_path.is_file():
            return {
                "success": False,
                "error": f"Voice clone '{old_clone_id}' not found",
            }
        if new_path.exists():
            return {
                "success": False,
                "error": f"Voice clone '{new_clone_id}' already exists",
            }
        old_path.rename(new_path)
        reference = self.voice_clones.pop(old_clone_id, None)
        if reference is not None:
            self._cache_clone(new_clone_id, reference)
        return {
            "success": True,
            "old_clone_id": old_clone_id,
            "new_clone_id": new_clone_id,
        }

    def list_voice_clones(self):
        clones = sorted(
            path.stem
            for path in VOICE_CLONES_DIR.glob("*.safetensors")
            if not path.name.startswith("_")
        )
        return {"success": True, "clones": clones}

    def validate_voice_clone(self, file_path):
        try:
            prompt = load_voice_prompt(file_path)
            expected = self._expected_embedding_dim()
            actual = int(prompt["ref_spk_embedding"].shape[0])
            return {
                "success": True,
                "valid": True,
                "compatible": not expected or expected == actual,
                "embedding_dim": actual,
            }
        except Exception as exc:
            return {"success": True, "valid": False, "error": str(exc)}

    def import_voice_clone(self, file_path, clone_id):
        if not self._validate_clone_id(clone_id):
            return {"success": False, "error": "Invalid clone_id"}
        destination = VOICE_CLONES_DIR / f"{clone_id}.safetensors"
        if destination.exists():
            return {
                "success": False,
                "error": f"Voice clone '{clone_id}' already exists",
            }
        try:
            prompt = load_voice_prompt(file_path)
            self._ensure_prompt_compatible(prompt)
            source = Path(file_path).resolve()
            handle = tempfile.NamedTemporaryFile(
                prefix=f".{clone_id}-",
                suffix=".safetensors",
                dir=VOICE_CLONES_DIR,
                delete=False,
            )
            temp_path = Path(handle.name)
            handle.close()
            try:
                shutil.copyfile(source, temp_path)
                os.replace(temp_path, destination)
            finally:
                temp_path.unlink(missing_ok=True)
            self.voice_clones.pop(clone_id, None)
            return {"success": True, "clone_id": clone_id}
        except Exception as exc:
            destination.unlink(missing_ok=True)
            return {"success": False, "error": str(exc)}

    def handle_request(self, line):
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            return {"success": False, "error": f"Invalid JSON: {exc}"}

        request_id = request.get("id", "unknown")
        if request.get("command") == "shutdown":
            self.running = False
            return {"id": request_id, "status": "shutdown"}

        request_type = request.get("type", "generate")
        try:
            required_fields = {
                "generate": ("text", "output_path"),
                "generate_custom_voice": ("text", "speaker", "output_path"),
                "generate_voice_design": ("text", "instruct", "output_path"),
                "create_voice_clone": ("audio_path", "transcript", "clone_id"),
                "generate_voice_clone": ("text", "clone_id", "output_path"),
                "delete_voice_clone": ("clone_id",),
                "rename_voice_clone": ("old_clone_id", "new_clone_id"),
                "validate_voice_clone": ("file_path",),
                "import_voice_clone": ("file_path", "clone_id"),
            }
            missing = [
                field
                for field in required_fields.get(request_type, ())
                if not isinstance(request.get(field), str) or not request[field].strip()
            ]
            if missing:
                raise ValueError(f"Missing required field: {missing[0]}")

            if request_type == "generate":
                result = self.generate(
                    request.get("text", ""),
                    request.get("language", "auto"),
                    request.get("output_path", ""),
                    request.get("ref_audio"),
                    request.get("ref_text"),
                    request.get("voice"),
                )
            elif request_type == "generate_custom_voice":
                result = self.generate_custom_voice(
                    request.get("text", ""),
                    request.get("speaker", "Ryan"),
                    request.get("instruct", ""),
                    request.get("language", "auto"),
                    request.get("output_path", ""),
                )
            elif request_type == "generate_voice_design":
                result = self.generate_voice_design(
                    request.get("text", ""),
                    request.get("instruct", ""),
                    request.get("language", "auto"),
                    request.get("output_path", ""),
                )
            elif request_type == "create_voice_clone":
                result = self.create_voice_clone(
                    request.get("audio_path", ""),
                    request.get("transcript", ""),
                    request.get("clone_id", ""),
                )
            elif request_type == "generate_voice_clone":
                result = self.generate_voice_clone(
                    request.get("text", ""),
                    request.get("clone_id", ""),
                    request.get("language", "auto"),
                    request.get("output_path", ""),
                )
            elif request_type == "delete_voice_clone":
                result = self.delete_voice_clone(request.get("clone_id", ""))
            elif request_type == "rename_voice_clone":
                result = self.rename_voice_clone(
                    request.get("old_clone_id", ""),
                    request.get("new_clone_id", ""),
                )
            elif request_type == "list_voice_clones":
                result = self.list_voice_clones()
            elif request_type == "validate_voice_clone":
                result = self.validate_voice_clone(request.get("file_path", ""))
            elif request_type == "import_voice_clone":
                result = self.import_voice_clone(
                    request.get("file_path", ""),
                    request.get("clone_id", ""),
                )
            else:
                result = {
                    "success": False,
                    "error": f"Unknown request type: {request_type}",
                }
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            result = {"success": False, "error": str(exc)}

        result["id"] = request_id
        return result

    @staticmethod
    def send_response(response):
        print(json.dumps(response, ensure_ascii=False), flush=True)

    def run(self):
        if not self.load_model():
            return
        self.send_response(
            {
                "status": "ready",
                "model_variant": self.variant,
                "features": self.features,
                "speakers": self._speaker_names(),
                "backend": "mlx",
                "model": self.repo,
                "revision": self.revision,
                "precision": self.precision,
                "mlx_audio_version": EXPECTED_MLX_AUDIO_VERSION,
                # MLX-Audio supports streaming generation, but this JSONL/REST
                # integration currently writes a complete deterministic WAV.
                "streaming": False,
            }
        )
        for line in sys.stdin:
            if not self.running:
                break
            line = line.strip()
            if line:
                self.send_response(self.handle_request(line))
                if not self.running:
                    break


def main():
    daemon = QwenTTSDaemon()

    def handle_signal(_signum, _frame):
        daemon.running = False

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)
    daemon.run()


if __name__ == "__main__":
    main()
