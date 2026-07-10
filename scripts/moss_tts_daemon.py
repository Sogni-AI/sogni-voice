#!/usr/bin/env python3
"""Persistent MOSS-TTS-Nano MLX daemon for Apple Silicon.

The MLX implementation currently supports reference-voice synthesis but not
streaming. Reference profiles are stored as normalized WAV files so they stay
portable across mlx-audio updates.
"""

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sys
import time
import traceback
import wave


sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)


MODEL_ID = os.environ.get(
    "MOSS_TTS_MODEL_ID",
    "mlx-community/MOSS-TTS-Nano-100M",
)
VOICES_DIR = Path(
    os.environ.get("MOSS_TTS_VOICES_DIR", "./moss_voice_clones")
).expanduser().resolve()
VOICE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,100}$")
MIN_REFERENCE_SECONDS = 1.0
MAX_REFERENCE_SECONDS = 30.0

# The upstream model card advertises 20 languages. Its metadata includes
# Hebrew, which is omitted from the human-readable table in the same card.
SUPPORTED_LANGUAGES = [
    {"code": "zh", "name": "Chinese"},
    {"code": "en", "name": "English"},
    {"code": "de", "name": "German"},
    {"code": "es", "name": "Spanish"},
    {"code": "fr", "name": "French"},
    {"code": "ja", "name": "Japanese"},
    {"code": "it", "name": "Italian"},
    {"code": "he", "name": "Hebrew"},
    {"code": "ko", "name": "Korean"},
    {"code": "ru", "name": "Russian"},
    {"code": "fa", "name": "Persian"},
    {"code": "ar", "name": "Arabic"},
    {"code": "pl", "name": "Polish"},
    {"code": "pt", "name": "Portuguese"},
    {"code": "cs", "name": "Czech"},
    {"code": "da", "name": "Danish"},
    {"code": "sv", "name": "Swedish"},
    {"code": "hu", "name": "Hungarian"},
    {"code": "el", "name": "Greek"},
    {"code": "tr", "name": "Turkish"},
]


class MossTTSDaemon:
    def __init__(self):
        self.model = None
        self.running = True
        self.prompt_codes = {}
        VOICES_DIR.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def validate_voice_id(voice_id):
        return isinstance(voice_id, str) and bool(VOICE_ID_PATTERN.fullmatch(voice_id))

    @staticmethod
    def send_response(response):
        print(json.dumps(response, ensure_ascii=False), flush=True)

    def voice_dir(self, voice_id):
        if not self.validate_voice_id(voice_id):
            raise ValueError("Invalid voice ID")
        return VOICES_DIR / voice_id

    def reference_path(self, voice_id):
        return self.voice_dir(voice_id) / "reference.wav"

    @staticmethod
    def reference_audio_info(audio_path):
        try:
            with wave.open(str(audio_path), "rb") as wav_file:
                sample_rate = wav_file.getframerate()
                duration = wav_file.getnframes() / float(sample_rate)
                return duration, sample_rate
        except (wave.Error, EOFError) as exc:
            raise ValueError(f"Reference audio is not a valid PCM WAV file: {exc}") from exc

    def load_model(self):
        try:
            from mlx_audio.tts import load

            print(f"Loading {MODEL_ID}...", file=sys.stderr)
            self.model = load(MODEL_ID)
            print("MOSS-TTS-Nano model ready", file=sys.stderr)
            return True
        except ImportError as exc:
            self.send_response({
                "status": "error",
                "error": (
                    f"mlx-audio is not installed in the MOSS environment: {exc}. "
                    "Run ./setup.sh and enable MOSS-TTS-Nano."
                ),
            })
            return False
        except Exception as exc:
            print(f"Failed to load MOSS-TTS-Nano: {exc}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            self.send_response({"status": "error", "error": str(exc)})
            return False

    def list_voices(self):
        voices = []
        for candidate in sorted(VOICES_DIR.iterdir(), key=lambda item: item.name.lower()):
            if (
                candidate.is_dir()
                and self.validate_voice_id(candidate.name)
                and (candidate / "reference.wav").is_file()
            ):
                voices.append(candidate.name)
        return voices

    def load_prompt_codes(self, voice_id):
        cached = self.prompt_codes.get(voice_id)
        if cached is not None:
            return cached

        reference_path = self.reference_path(voice_id)
        if not reference_path.is_file():
            raise FileNotFoundError(f"Reference voice '{voice_id}' not found")

        codes = self.model.encode_reference_audio(str(reference_path))
        self.prompt_codes[voice_id] = codes
        return codes

    def create_voice(self, audio_path, voice_id):
        if not self.validate_voice_id(voice_id):
            raise ValueError("Invalid voice ID")

        source = Path(str(audio_path or "")).expanduser()
        if not source.is_file():
            raise FileNotFoundError("Reference audio file not found")

        duration, sample_rate = self.reference_audio_info(source)
        if duration < MIN_REFERENCE_SECONDS or duration > MAX_REFERENCE_SECONDS:
            raise ValueError(
                "Reference audio must be between "
                f"{int(MIN_REFERENCE_SECONDS)} and {int(MAX_REFERENCE_SECONDS)} seconds; "
                f"received {duration:.1f} seconds"
            )

        destination = self.voice_dir(voice_id)
        if destination.exists():
            raise FileExistsError(f"Reference voice '{voice_id}' already exists")

        temp_destination = VOICES_DIR / f".{voice_id}.tmp-{os.getpid()}"
        try:
            temp_destination.mkdir(parents=False, exist_ok=False)
            reference_path = temp_destination / "reference.wav"
            shutil.copy2(source, reference_path)

            # Encode once now to validate the reference and make the first
            # synthesis request fast. The codes remain in memory only; the WAV
            # is the durable, version-independent source of truth.
            codes = self.model.encode_reference_audio(str(reference_path))
            metadata = {
                "voice_id": voice_id,
                "duration": duration,
                "sample_rate": sample_rate,
                "model": MODEL_ID,
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
            (temp_destination / "metadata.json").write_text(
                json.dumps(metadata, indent=2),
                encoding="utf-8",
            )
            temp_destination.rename(destination)
            self.prompt_codes[voice_id] = codes
            return {
                "success": True,
                "voice_id": voice_id,
                "duration": duration,
            }
        except Exception:
            shutil.rmtree(temp_destination, ignore_errors=True)
            raise

    def delete_voice(self, voice_id):
        destination = self.voice_dir(voice_id)
        if not (destination / "reference.wav").is_file():
            raise FileNotFoundError(f"Reference voice '{voice_id}' not found")
        shutil.rmtree(destination)
        self.prompt_codes.pop(voice_id, None)
        return {"success": True, "voice_id": voice_id}

    def rename_voice(self, old_voice_id, new_voice_id):
        source = self.voice_dir(old_voice_id)
        destination = self.voice_dir(new_voice_id)
        if not (source / "reference.wav").is_file():
            raise FileNotFoundError(f"Reference voice '{old_voice_id}' not found")
        if destination.exists():
            raise FileExistsError(f"Reference voice '{new_voice_id}' already exists")

        source.rename(destination)
        metadata_path = destination / "metadata.json"
        if metadata_path.is_file():
            try:
                metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                metadata = {}
            metadata["voice_id"] = new_voice_id
            metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")

        cached = self.prompt_codes.pop(old_voice_id, None)
        if cached is not None:
            self.prompt_codes[new_voice_id] = cached
        return {
            "success": True,
            "old_voice_id": old_voice_id,
            "voice_id": new_voice_id,
        }

    def generate(self, text, voice_id, output_path):
        if not str(text or "").strip():
            raise ValueError("Text is required")
        if not output_path:
            raise ValueError("Output path is required")

        from mlx_audio.audio_io import write as audio_write

        prompt_codes = self.load_prompt_codes(voice_id)
        started_at = time.perf_counter()
        result = next(self.model.generate(
            text=str(text).strip(),
            prompt_audio_codes=prompt_codes,
            mode="voice_clone",
            stream=False,
        ))
        audio_write(output_path, result.audio, result.sample_rate)
        duration = int(result.audio.shape[0]) / float(result.sample_rate)
        channels = int(result.audio.shape[1]) if result.audio.ndim > 1 else 1
        processing_seconds = time.perf_counter() - started_at
        return {
            "success": True,
            "output_path": output_path,
            "voice_id": voice_id,
            "duration": duration,
            "sample_rate": int(result.sample_rate),
            "channels": channels,
            "processing_seconds": processing_seconds,
            "real_time_factor": duration / processing_seconds if processing_seconds else None,
            "model": MODEL_ID,
        }

    def handle_request(self, line):
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            return {"success": False, "error": f"Invalid JSON: {exc}"}

        request_id = request.get("id", "unknown")
        if request.get("command") == "shutdown":
            self.running = False
            return {"id": request_id, "status": "shutdown"}

        request_type = request.get("type")
        try:
            if request_type == "generate":
                response = self.generate(
                    request.get("text"),
                    request.get("voice_id"),
                    request.get("output_path"),
                )
            elif request_type == "create_voice":
                response = self.create_voice(
                    request.get("audio_path"),
                    request.get("voice_id"),
                )
            elif request_type == "delete_voice":
                response = self.delete_voice(request.get("voice_id"))
            elif request_type == "rename_voice":
                response = self.rename_voice(
                    request.get("old_voice_id"),
                    request.get("voice_id"),
                )
            elif request_type == "list_voices":
                response = {"success": True, "voices": self.list_voices()}
            else:
                response = {
                    "success": False,
                    "error": f"Unknown request type: {request_type}",
                }
        except Exception as exc:
            print(f"MOSS-TTS-Nano request error: {exc}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            response = {"success": False, "error": str(exc)}

        response["id"] = request_id
        return response

    def run(self):
        def handle_signal(signum, frame):
            del frame
            print(f"Received signal {signum}, shutting down...", file=sys.stderr)
            self.running = False

        signal.signal(signal.SIGTERM, handle_signal)
        signal.signal(signal.SIGINT, handle_signal)

        if not self.load_model():
            raise SystemExit(1)

        self.send_response({
            "status": "ready",
            "model": MODEL_ID,
            "features": ["multilingual_tts", "voice_cloning"],
            "streaming": False,
            "sample_rate": 48000,
            "languages": SUPPORTED_LANGUAGES,
        })

        while self.running:
            line = sys.stdin.readline()
            if not line:
                break
            line = line.strip()
            if line:
                self.send_response(self.handle_request(line))

        print("MOSS-TTS-Nano daemon shutdown complete", file=sys.stderr)


if __name__ == "__main__":
    MossTTSDaemon().run()
