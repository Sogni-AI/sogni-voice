#!/usr/bin/env python3
"""Persistent Qwen3-ASR and ForcedAligner daemon for Apple Silicon.

The daemon runs in the isolated ``.venv-qwen-asr`` environment and speaks the
same newline-delimited JSON protocol as the other Sogni Voice model daemons.
Qwen3-ASR is loaded at startup; the heavier ForcedAligner is loaded lazily when
timestamps or an explicit alignment request are first used.
"""

from contextlib import contextmanager
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import traceback
import wave


sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)


DEFAULT_MODEL_ID = "mlx-community/Qwen3-ASR-0.6B-8bit"
DEFAULT_ALIGNER_MODEL_ID = "mlx-community/Qwen3-ForcedAligner-0.6B-8bit"
MODEL_ID = os.environ.get("QWEN_ASR_MODEL_ID", DEFAULT_MODEL_ID)
ALIGNER_MODEL_ID = os.environ.get(
    "QWEN_ASR_ALIGNER_MODEL_ID",
    DEFAULT_ALIGNER_MODEL_ID,
)
MAX_ALIGNMENT_SECONDS = 300.0

ALIGNMENT_LANGUAGES = {
    "Chinese",
    "English",
    "Cantonese",
    "French",
    "German",
    "Italian",
    "Japanese",
    "Korean",
    "Portuguese",
    "Russian",
    "Spanish",
}

LANGUAGE_ALIASES = {
    "zh": "Chinese",
    "en": "English",
    "yue": "Cantonese",
    "ar": "Arabic",
    "de": "German",
    "fr": "French",
    "es": "Spanish",
    "pt": "Portuguese",
    "id": "Indonesian",
    "it": "Italian",
    "ko": "Korean",
    "ru": "Russian",
    "th": "Thai",
    "vi": "Vietnamese",
    "ja": "Japanese",
    "tr": "Turkish",
    "hi": "Hindi",
    "ms": "Malay",
    "nl": "Dutch",
    "sv": "Swedish",
    "da": "Danish",
    "fi": "Finnish",
    "pl": "Polish",
    "cs": "Czech",
    "fil": "Filipino",
    "fa": "Persian",
    "el": "Greek",
    "ro": "Romanian",
    "hu": "Hungarian",
    "mk": "Macedonian",
}


def normalize_language(language, allow_auto=True):
    """Normalize an ISO code or language name for the MLX Qwen models."""
    if language is None:
        return None if allow_auto else "English"

    value = str(language).strip()
    if not value or value.lower() == "auto":
        return None if allow_auto else "English"

    alias = LANGUAGE_ALIASES.get(value.lower())
    if alias:
        return alias
    return value[0].upper() + value[1:]


class QwenAsrDaemon:
    def __init__(self):
        self.asr = None
        self.aligner = None
        self.running = True

    def load_asr(self):
        try:
            from mlx_audio.stt import load

            print(f"Loading {MODEL_ID}...", file=sys.stderr)
            self.asr = load(MODEL_ID)
            print("Qwen3-ASR model ready", file=sys.stderr)
            return True
        except ImportError as exc:
            self.send_response({
                "status": "error",
                "error": (
                    f"mlx-audio is not installed in .venv-qwen-asr: {exc}. "
                    "Run ./setup.sh and enable Qwen3-ASR."
                ),
            })
            return False
        except Exception as exc:
            print(f"Failed to load Qwen3-ASR: {exc}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            self.send_response({"status": "error", "error": str(exc)})
            return False

    def ensure_aligner(self):
        if self.aligner is not None:
            return self.aligner

        from mlx_audio.stt import load

        print(f"Loading {ALIGNER_MODEL_ID}...", file=sys.stderr)
        self.aligner = load(ALIGNER_MODEL_ID)
        print("Qwen3 ForcedAligner ready", file=sys.stderr)
        return self.aligner

    @contextmanager
    def normalized_audio(self, audio_path):
        """Decode any accepted audio/video upload to a backend-safe WAV."""
        if not os.path.isfile(audio_path):
            raise FileNotFoundError(audio_path)

        ffmpeg_bin = shutil.which("ffmpeg") or shutil.which(
            "ffmpeg",
            path="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        )
        if ffmpeg_bin is None:
            raise RuntimeError("ffmpeg not found on PATH. Install with: brew install ffmpeg")

        handle = tempfile.NamedTemporaryFile(prefix="qwen-asr-", suffix=".wav", delete=False)
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
    def result_language(result, requested_language=None):
        languages = getattr(result, "language", None)
        if isinstance(languages, list):
            languages = [language for language in languages if language]
            if languages:
                return languages[0], languages
        if isinstance(languages, str) and languages:
            return languages, [languages]
        fallback = requested_language or "English"
        return fallback, [fallback]

    @staticmethod
    def serialize_alignment(alignment):
        return [
            {
                "text": item.text,
                "start": float(item.start_time),
                "end": float(item.end_time),
            }
            for item in alignment
        ]

    @staticmethod
    def split_sentences(text):
        # Keep terminal punctuation in each sentence and support CJK text where
        # sentence punctuation is not followed by a space.
        matches = re.findall(r".+?(?:[.!?。！？]+(?:[\"'”’）】]*)|$)", text, flags=re.S)
        return [match.strip() for match in matches if match.strip()]

    def sentence_alignment(self, text, language, alignment):
        """Group word alignment into sentence spans using aligner's tokenizer."""
        items = list(alignment)
        if not items:
            return []

        sentences = self.split_sentences(text)
        if not sentences:
            sentences = [text.strip()]

        segments = []
        cursor = 0
        for sentence in sentences:
            word_list, _ = self.aligner.aligner_processor.encode_timestamp(
                sentence,
                language,
            )
            count = len(word_list)
            sentence_items = items[cursor:cursor + count]
            if not sentence_items:
                continue
            segments.append({
                "text": sentence,
                "start": float(sentence_items[0].start_time),
                "end": float(sentence_items[-1].end_time),
            })
            cursor += len(sentence_items)

        # Tokenization can differ around unusual punctuation. Preserve any
        # remaining aligned words by extending the final sentence.
        if cursor < len(items):
            if segments:
                segments[-1]["end"] = float(items[-1].end_time)
            else:
                segments.append({
                    "text": text.strip(),
                    "start": float(items[0].start_time),
                    "end": float(items[-1].end_time),
                })
        return segments

    def align_normalized(self, audio_path, text, language):
        language = normalize_language(language, allow_auto=False)
        if language not in ALIGNMENT_LANGUAGES:
            supported = ", ".join(sorted(ALIGNMENT_LANGUAGES))
            raise ValueError(
                f"Forced alignment does not support {language}. Supported: {supported}"
            )
        duration = self.audio_duration(audio_path)
        if duration > MAX_ALIGNMENT_SECONDS:
            raise ValueError(
                f"Forced alignment supports audio up to {int(MAX_ALIGNMENT_SECONDS)} seconds; "
                f"received {duration:.1f} seconds"
            )
        aligner = self.ensure_aligner()
        return aligner.generate(audio=audio_path, text=text, language=language), language

    def transcribe(self, audio_path, language=None, timestamps=False, word_timestamps=False):
        if self.asr is None:
            return {"success": False, "error": "Qwen3-ASR model not loaded"}

        try:
            requested_language = normalize_language(language, allow_auto=True)
            with self.normalized_audio(audio_path) as normalized_path:
                result = self.asr.generate(
                    normalized_path,
                    language=requested_language,
                    verbose=False,
                )
                detected_language, detected_languages = self.result_language(
                    result,
                    requested_language,
                )

                response = {
                    "success": True,
                    "text": result.text.strip(),
                    "language": detected_language,
                    "languages": detected_languages,
                    "model": MODEL_ID,
                }

                if timestamps or word_timestamps:
                    if not response["text"]:
                        response["timestamps"] = []
                        response["timestamp_level"] = (
                            "word" if word_timestamps else "sentence"
                        )
                        return response
                    alignment, alignment_language = self.align_normalized(
                        normalized_path,
                        response["text"],
                        detected_language,
                    )
                    if word_timestamps:
                        response["timestamps"] = self.serialize_alignment(alignment)
                        response["timestamp_level"] = "word"
                    else:
                        response["timestamps"] = self.sentence_alignment(
                            response["text"],
                            alignment_language,
                            alignment,
                        )
                        response["timestamp_level"] = "sentence"

                return response
        except FileNotFoundError:
            return {"success": False, "error": f"Audio file not found: {audio_path}"}
        except Exception as exc:
            print(f"Qwen3-ASR transcription error: {exc}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return {"success": False, "error": str(exc)}

    def align(self, audio_path, text, language):
        try:
            with self.normalized_audio(audio_path) as normalized_path:
                alignment, normalized_language = self.align_normalized(
                    normalized_path,
                    text,
                    language,
                )
                return {
                    "success": True,
                    "text": text,
                    "language": normalized_language,
                    "timestamps": self.serialize_alignment(alignment),
                    "model": ALIGNER_MODEL_ID,
                }
        except FileNotFoundError:
            return {"success": False, "error": f"Audio file not found: {audio_path}"}
        except Exception as exc:
            print(f"Qwen3 alignment error: {exc}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
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

        request_type = request.get("type", "transcribe")
        audio_path = request.get("audio_path")
        if not audio_path:
            return {"id": request_id, "success": False, "error": "Missing audio_path"}

        if request_type == "align":
            text = str(request.get("text") or "").strip()
            if not text:
                return {"id": request_id, "success": False, "error": "Missing text"}
            result = self.align(audio_path, text, request.get("language"))
        elif request_type == "transcribe":
            result = self.transcribe(
                audio_path,
                language=request.get("language"),
                timestamps=bool(request.get("timestamps")),
                word_timestamps=bool(request.get("word_timestamps")),
            )
        else:
            result = {"success": False, "error": f"Unknown request type: {request_type}"}

        result["id"] = request_id
        return result

    @staticmethod
    def send_response(response):
        print(json.dumps(response, ensure_ascii=False), flush=True)

    def run(self):
        def handle_signal(signum, frame):
            print(f"Received signal {signum}, shutting down...", file=sys.stderr)
            self.running = False

        signal.signal(signal.SIGTERM, handle_signal)
        signal.signal(signal.SIGINT, handle_signal)

        if not self.load_asr():
            sys.exit(1)

        self.send_response({
            "status": "ready",
            "model": MODEL_ID,
            "aligner_model": ALIGNER_MODEL_ID,
            "aligner_loaded": False,
        })

        while self.running:
            try:
                line = sys.stdin.readline()
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                self.send_response(self.handle_request(line))
            except Exception as exc:
                print(f"Unexpected daemon error: {exc}", file=sys.stderr)
                traceback.print_exc(file=sys.stderr)
                self.send_response({"success": False, "error": f"Daemon error: {exc}"})

        print("Qwen3-ASR daemon shutdown complete", file=sys.stderr)


if __name__ == "__main__":
    QwenAsrDaemon().run()
