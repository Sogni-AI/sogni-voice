#!/usr/bin/env python3
"""Pinned MOSS Transcribe-Diarize daemon for experimental Apple Silicon use."""

from contextlib import contextmanager
from importlib.metadata import PackageNotFoundError, distribution
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import traceback
import wave


sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)


MODEL_ID = os.environ.get("MOSS_TD_MODEL_ID", "OpenMOSS-Team/MOSS-Transcribe-Diarize")
MODEL_REVISION = os.environ.get(
    "MOSS_TD_MODEL_REVISION",
    "d7231bbae2587a4af278735eb765b318c4f64edd",
)
PACKAGE_REVISION = os.environ.get(
    "MOSS_TD_PACKAGE_REVISION",
    "b5ad0f8386b155ddb89f9332ba3ca71891900357",
)
PACKAGE_SOURCE = "https://github.com/OpenMOSS/MOSS-Transcribe-Diarize.git"
DEVICE_NAME = os.environ.get("MOSS_TD_DEVICE", "mps")
DTYPE_NAME = os.environ.get("MOSS_TD_DTYPE", "fp16")
DEFAULT_MAX_NEW_TOKENS = int(os.environ.get("MOSS_TD_MAX_NEW_TOKENS", "5120"))
MAX_AUDIO_SECONDS = int(os.environ.get("MOSS_TD_MAX_AUDIO_SECONDS", "5400"))
MAX_NEW_TOKENS_LIMIT = 65536


def verify_package_revision():
    """Reject mutable or unexpected source installs before loading model code."""
    try:
        installed = distribution("moss-transcribe-diarize")
    except PackageNotFoundError as exc:
        raise RuntimeError(
            "moss-transcribe-diarize is not installed in .venv-moss-transcribe; "
            "run ./setup.sh and enable the experimental engine"
        ) from exc

    direct_url_raw = installed.read_text("direct_url.json")
    if not direct_url_raw:
        raise RuntimeError("Cannot verify moss-transcribe-diarize source revision")
    direct_url = json.loads(direct_url_raw)
    installed_source = str(direct_url.get("url") or "")
    normalized_source = installed_source.lower().rstrip("/").removesuffix(".git")
    expected_source = PACKAGE_SOURCE.lower().rstrip("/").removesuffix(".git")
    if normalized_source != expected_source:
        raise RuntimeError(
            "moss-transcribe-diarize package source mismatch: "
            f"expected {PACKAGE_SOURCE}, found {installed_source or 'unknown'}"
        )
    installed_revision = direct_url.get("vcs_info", {}).get("commit_id")
    if installed_revision != PACKAGE_REVISION:
        raise RuntimeError(
            "moss-transcribe-diarize package revision mismatch: "
            f"expected {PACKAGE_REVISION}, found {installed_revision or 'unknown'}"
        )
    return installed_revision


class MossTranscribeDiarizeDaemon:
    def __init__(self):
        self.model = None
        self.processor = None
        self.device = None
        self.dtype = None
        self.running = True
        self.package_revision = None

    def load_model(self):
        try:
            self.package_revision = verify_package_revision()

            import torch
            from moss_transcribe_diarize import (
                MossTranscribeDiarizeForConditionalGeneration,
                MossTranscribeDiarizeProcessor,
            )
            from moss_transcribe_diarize.inference_utils import dtype_from_name

            self.device = torch.device(DEVICE_NAME)
            if self.device.type == "mps" and not torch.backends.mps.is_available():
                raise RuntimeError("PyTorch MPS is unavailable on this host")
            if self.device.type not in {"mps", "cpu"}:
                raise RuntimeError("This integration supports only mps or cpu devices")

            self.dtype = dtype_from_name(DTYPE_NAME)
            if self.device.type == "cpu":
                self.dtype = torch.float32

            print(
                f"Loading {MODEL_ID}@{MODEL_REVISION} on {self.device} ({self.dtype})...",
                file=sys.stderr,
            )
            self.model = MossTranscribeDiarizeForConditionalGeneration.from_pretrained(
                MODEL_ID,
                revision=MODEL_REVISION,
                dtype=self.dtype,
                trust_remote_code=False,
            ).to(self.device).eval()
            self.processor = MossTranscribeDiarizeProcessor.from_pretrained(
                MODEL_ID,
                revision=MODEL_REVISION,
                trust_remote_code=False,
                fix_mistral_regex=True,
            )
            print("MOSS Transcribe-Diarize model ready", file=sys.stderr)
            return True
        except Exception as exc:
            print(f"Failed to load MOSS Transcribe-Diarize: {exc}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            self.send_response({"status": "error", "error": str(exc)})
            return False

    @contextmanager
    def normalized_audio(self, audio_path):
        if not os.path.isfile(audio_path):
            raise FileNotFoundError(audio_path)

        ffmpeg_bin = shutil.which("ffmpeg") or shutil.which(
            "ffmpeg",
            path="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        )
        if ffmpeg_bin is None:
            raise RuntimeError("ffmpeg not found on PATH. Install with: brew install ffmpeg")

        handle = tempfile.NamedTemporaryFile(prefix="moss-td-", suffix=".wav", delete=False)
        normalized_path = handle.name
        handle.close()
        try:
            proc = subprocess.run(
                [
                    ffmpeg_bin,
                    "-nostdin",
                    "-y",
                    "-loglevel",
                    "error",
                    "-i",
                    audio_path,
                    "-vn",
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    "-c:a",
                    "pcm_s16le",
                    normalized_path,
                ],
                capture_output=True,
                check=False,
            )
            if proc.returncode != 0:
                stderr = proc.stderr.decode(errors="replace").strip()
                raise RuntimeError(f"ffmpeg decode failed: {stderr or 'unknown error'}")
            yield normalized_path
        finally:
            try:
                os.unlink(normalized_path)
            except FileNotFoundError:
                pass

    @staticmethod
    def audio_duration(audio_path):
        with wave.open(audio_path, "rb") as wav_file:
            return wav_file.getnframes() / float(wav_file.getframerate())

    @staticmethod
    def build_prompt(prompt, hotwords):
        from moss_transcribe_diarize.inference_utils import DEFAULT_PROMPT

        value = (prompt or "").strip() or DEFAULT_PROMPT
        hotword_value = (hotwords or "").strip()
        if hotword_value:
            value = f"{value} 热词提示：{hotword_value}"
        return value

    def transcribe(self, audio_path, prompt=None, hotwords=None, max_new_tokens=None):
        try:
            from moss_transcribe_diarize import parse_transcript
            from moss_transcribe_diarize.inference_utils import (
                build_transcription_messages,
                generate_transcription,
            )

            token_limit = int(max_new_tokens or DEFAULT_MAX_NEW_TOKENS)
            if token_limit < 64 or token_limit > MAX_NEW_TOKENS_LIMIT:
                raise ValueError(
                    f"max_new_tokens must be between 64 and {MAX_NEW_TOKENS_LIMIT}"
                )

            with self.normalized_audio(audio_path) as normalized_path:
                duration = self.audio_duration(normalized_path)
                if duration > MAX_AUDIO_SECONDS:
                    raise ValueError(
                        f"MOSS Transcribe-Diarize supports audio up to {MAX_AUDIO_SECONDS} "
                        f"seconds; received {duration:.1f} seconds"
                    )

                started = time.monotonic()
                result = generate_transcription(
                    self.model,
                    self.processor,
                    build_transcription_messages(
                        normalized_path,
                        self.build_prompt(prompt, hotwords),
                    ),
                    max_new_tokens=token_limit,
                    do_sample=False,
                    device=self.device,
                    dtype=self.dtype,
                )
                elapsed = time.monotonic() - started

            raw_transcript = result["text"].strip()
            parsed = parse_transcript(raw_transcript)
            if raw_transcript and not parsed:
                raise RuntimeError(
                    "MOSS Transcribe-Diarize returned no parseable speaker segments"
                )
            segments = [
                {
                    "start": float(segment.start),
                    "end": float(segment.end),
                    "speaker": segment.speaker,
                    "text": segment.text.strip(),
                }
                for segment in parsed
                if segment.text.strip()
            ]
            speakers = sorted({segment["speaker"] for segment in segments if segment["speaker"]})
            text = " ".join(segment["text"] for segment in segments).strip()
            if not text:
                text = raw_transcript

            return {
                "success": True,
                "text": text,
                "raw_transcript": raw_transcript,
                "segments": segments,
                "num_speakers": len(speakers),
                "model": MODEL_ID,
                "revision": MODEL_REVISION,
                "metrics": {
                    "audio_seconds": round(duration, 3),
                    "elapsed_seconds": round(elapsed, 3),
                    "real_time_factor": round(elapsed / duration, 3) if duration else None,
                    "prompt_tokens": int(result["prompt_len"]),
                    "generated_tokens": int(result["generated_tokens"]),
                    "max_new_tokens": token_limit,
                    "truncated": int(result["generated_tokens"]) >= token_limit,
                },
            }
        except FileNotFoundError:
            return {"success": False, "error": f"Audio file not found: {audio_path}"}
        except Exception as exc:
            print(f"MOSS Transcribe-Diarize request failed: {exc}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return {"success": False, "error": str(exc)}

    def send_response(self, response):
        print(json.dumps(response, ensure_ascii=False), flush=True)

    def run(self):
        if not self.load_model():
            return

        self.send_response({
            "status": "ready",
            "model": MODEL_ID,
            "revision": MODEL_REVISION,
            "package_revision": self.package_revision,
            "device": str(self.device),
            "dtype": str(self.dtype),
            "experimental": True,
            "languages": ["English", "Chinese"],
            "timestamps": "segment",
            "built_in_diarization": True,
            "max_audio_seconds": MAX_AUDIO_SECONDS,
        })

        while self.running:
            line = sys.stdin.readline()
            if not line:
                break
            try:
                request = json.loads(line)
                if request.get("command") == "shutdown":
                    self.running = False
                    break
                if request.get("type") != "transcribe":
                    response = {"success": False, "error": "Unknown request type"}
                else:
                    response = self.transcribe(
                        request.get("audio_path", ""),
                        prompt=request.get("prompt"),
                        hotwords=request.get("hotwords"),
                        max_new_tokens=request.get("max_new_tokens"),
                    )
                response["id"] = request.get("id")
                self.send_response(response)
            except json.JSONDecodeError as exc:
                self.send_response({"success": False, "error": f"Invalid JSON: {exc}"})
            except Exception as exc:
                traceback.print_exc(file=sys.stderr)
                self.send_response({
                    "id": request.get("id") if "request" in locals() else None,
                    "success": False,
                    "error": str(exc),
                })


def handle_signal(_signum, _frame):
    daemon.running = False


daemon = MossTranscribeDiarizeDaemon()
signal.signal(signal.SIGINT, handle_signal)
signal.signal(signal.SIGTERM, handle_signal)
daemon.run()
