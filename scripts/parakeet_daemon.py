#!/usr/bin/env python3
"""Persistent Parakeet-MLX batch and realtime transcription daemon.

The stdin/stdout JSON-line protocol keeps the model resident. Batch requests
continue to accept an ``audio_path``. Realtime requests create one native
``transcribe_stream`` context and then feed base64-encoded 16 kHz float32 PCM
chunks through that context.
"""

import base64
import json
import os
import re
import signal
import sys
import time
import traceback


sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)


EXPECTED_PARAKEET_MLX_VERSION = "0.5.2"
MODEL_ID = os.environ.get(
    "PARAKEET_MODEL_ID",
    "mlx-community/parakeet-tdt-0.6b-v3",
)
MODEL_REVISION = os.environ.get(
    "PARAKEET_MODEL_REVISION",
    "ed2b7e8c15f9aaa0b5772e2efb986255eaef7e15",
)
REALTIME_ENABLED = os.environ.get("PARAKEET_REALTIME_ENABLED", "1").lower() in {
    "1",
    "true",
    "yes",
    "on",
}
REALTIME_MAX_SECONDS = max(
    1.0,
    float(os.environ.get("PARAKEET_REALTIME_MAX_SECONDS", "300")),
)
REALTIME_MAX_CHUNK_BYTES = max(
    4096,
    int(os.environ.get("PARAKEET_REALTIME_MAX_CHUNK_BYTES", str(256 * 1024))),
)
REALTIME_CONTEXT_LEFT = max(
    16,
    int(os.environ.get("PARAKEET_REALTIME_CONTEXT_LEFT", "256")),
)
REALTIME_CONTEXT_RIGHT = max(
    16,
    int(os.environ.get("PARAKEET_REALTIME_CONTEXT_RIGHT", "256")),
)
REALTIME_DEPTH = max(1, int(os.environ.get("PARAKEET_REALTIME_DEPTH", "1")))
SESSION_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,100}$")


class ParakeetDaemon:
    def __init__(self):
        self.model = None
        self.model_path = None
        self.sample_rate = 16000
        self.running = True
        self.stream = None

    def load_model(self) -> bool:
        try:
            from importlib.metadata import version

            installed_version = version("parakeet-mlx")
            if installed_version != EXPECTED_PARAKEET_MLX_VERSION:
                raise RuntimeError(
                    "parakeet-mlx version mismatch: "
                    f"expected {EXPECTED_PARAKEET_MLX_VERSION}, found {installed_version}"
                )

            from huggingface_hub import snapshot_download
            from parakeet_mlx import from_pretrained

            print(
                f"Loading {MODEL_ID}@{MODEL_REVISION} with parakeet-mlx "
                f"{installed_version}...",
                file=sys.stderr,
            )
            self.model_path = snapshot_download(
                repo_id=MODEL_ID,
                revision=MODEL_REVISION,
                allow_patterns=[
                    "config.json",
                    "model.safetensors",
                    "tokenizer.model",
                    "tokenizer.vocab",
                    "vocab.txt",
                ],
            )
            self.model = from_pretrained(self.model_path)
            self.sample_rate = int(self.model.preprocessor_config.sample_rate)
            print("Parakeet-MLX model ready", file=sys.stderr)
            return True
        except Exception as exc:
            print(f"Failed to load Parakeet-MLX model: {exc}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            self.send_response({"status": "error", "error": str(exc)})
            return False

    def transcribe(
        self,
        audio_path: str,
        timestamps: bool = False,
        word_timestamps: bool = False,
    ) -> dict:
        if self.model is None:
            return {"success": False, "error": "Model not loaded"}
        if self.stream is not None:
            return {
                "success": False,
                "error": "Parakeet realtime session is active; retry batch transcription later",
            }

        try:
            chunk_duration_env = os.environ.get("PARAKEET_CHUNK_DURATION")
            chunk_duration = (
                float(chunk_duration_env) if chunk_duration_env else 120.0
            )
            result = self.model.transcribe(
                audio_path,
                chunk_duration=chunk_duration,
            )

            if hasattr(result, "text"):
                text = result.text
            elif isinstance(result, dict):
                text = result.get("text", str(result))
            elif isinstance(result, str):
                text = result
            else:
                text = str(result)

            response = {"success": True, "text": text.strip()}
            if word_timestamps:
                segments = self._extract_word_timestamps(result)
                if segments:
                    response["timestamps"] = segments
            elif timestamps:
                segments = self._extract_timestamps(result)
                if segments:
                    response["timestamps"] = segments
            return response
        except FileNotFoundError:
            return {
                "success": False,
                "error": f"Audio file not found: {audio_path}",
            }
        except Exception as exc:
            print(f"Transcription error: {exc}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return {"success": False, "error": str(exc)}

    @staticmethod
    def _extract_timestamps(result) -> list:
        segments = []
        try:
            if hasattr(result, "sentences"):
                for sentence in result.sentences:
                    segments.append(
                        {
                            "start": sentence.start,
                            "end": sentence.end,
                            "text": sentence.text.strip(),
                        }
                    )
        except Exception as exc:
            print(f"Error extracting timestamps: {exc}", file=sys.stderr)
        return segments

    @staticmethod
    def _extract_word_timestamps(result) -> list:
        segments = []
        try:
            if not hasattr(result, "tokens") or not result.tokens:
                return segments

            current_word = None
            for token in result.tokens:
                text = token.text
                if text.startswith(" "):
                    if current_word is not None:
                        word_text = current_word["text"].strip()
                        if word_text:
                            segments.append(
                                {
                                    "start": current_word["start"],
                                    "end": current_word["end"],
                                    "text": word_text,
                                }
                            )
                    current_word = {
                        "text": text,
                        "start": token.start,
                        "end": token.end,
                    }
                elif current_word is None:
                    current_word = {
                        "text": text,
                        "start": token.start,
                        "end": token.end,
                    }
                else:
                    current_word["text"] += text
                    current_word["end"] = token.end

            if current_word is not None:
                word_text = current_word["text"].strip()
                if word_text:
                    segments.append(
                        {
                            "start": current_word["start"],
                            "end": current_word["end"],
                            "text": word_text,
                        }
                    )
        except Exception as exc:
            print(f"Error extracting word timestamps: {exc}", file=sys.stderr)
        return segments

    @staticmethod
    def _serialize_token(token) -> dict:
        return {
            "text": token.text,
            "start": float(token.start),
            "end": float(token.end),
            "confidence": float(getattr(token, "confidence", 1.0)),
        }

    def _validate_session_id(self, session_id: str) -> bool:
        return (
            isinstance(session_id, str)
            and bool(session_id)
            and SESSION_ID_PATTERN.fullmatch(session_id) is not None
        )

    def start_stream(self, session_id: str) -> dict:
        if not REALTIME_ENABLED:
            return {"success": False, "error": "Realtime transcription is disabled"}
        if self.model is None:
            return {"success": False, "error": "Model not loaded"}
        if not self._validate_session_id(session_id):
            return {"success": False, "error": "Invalid realtime session ID"}
        if self.stream is not None:
            return {
                "success": False,
                "error": "Another Parakeet realtime session is already active",
            }

        context = None
        try:
            context = self.model.transcribe_stream(
                context_size=(REALTIME_CONTEXT_LEFT, REALTIME_CONTEXT_RIGHT),
                depth=REALTIME_DEPTH,
            )
            transcriber = context.__enter__()
            self.stream = {
                "id": session_id,
                "context": context,
                "transcriber": transcriber,
                "audio_samples": 0,
                "processing_seconds": 0.0,
                "reported_finalized": 0,
                "sequence": 0,
            }
            return {
                "success": True,
                "session_id": session_id,
                "sample_rate": self.sample_rate,
                "encoding": "pcm_f32le",
                "max_seconds": REALTIME_MAX_SECONDS,
                "context_size": [REALTIME_CONTEXT_LEFT, REALTIME_CONTEXT_RIGHT],
                "depth": REALTIME_DEPTH,
            }
        except Exception as exc:
            if self.stream is not None:
                self._close_stream()
            elif context is not None:
                try:
                    context.__exit__(*sys.exc_info())
                except Exception as close_exc:
                    print(
                        f"Failed to unwind realtime context: {close_exc}",
                        file=sys.stderr,
                    )
            print(f"Failed to start realtime transcription: {exc}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return {"success": False, "error": str(exc)}

    def _require_stream(self, session_id: str):
        if self.stream is None:
            raise ValueError("No Parakeet realtime session is active")
        if session_id != self.stream["id"]:
            raise ValueError("Realtime session ID does not match the active session")
        return self.stream

    def stream_audio(self, session_id: str, audio_base64: str) -> dict:
        try:
            import mlx.core as mx
            import numpy as np

            stream = self._require_stream(session_id)
            if not isinstance(audio_base64, str) or not audio_base64:
                raise ValueError("Missing realtime audio payload")

            raw = base64.b64decode(audio_base64, validate=True)
            if not raw or len(raw) % 4 != 0:
                raise ValueError("Realtime audio must be non-empty float32 PCM")
            if len(raw) > REALTIME_MAX_CHUNK_BYTES:
                raise ValueError("Realtime audio chunk exceeds the configured size limit")

            audio = np.frombuffer(raw, dtype="<f4")
            if not np.isfinite(audio).all():
                raise ValueError("Realtime audio contains non-finite samples")
            if float(np.max(np.abs(audio))) > 8.0:
                raise ValueError("Realtime audio samples are outside the accepted range")

            new_sample_count = stream["audio_samples"] + int(audio.size)
            audio_seconds = new_sample_count / self.sample_rate
            if audio_seconds > REALTIME_MAX_SECONDS + 1e-6:
                raise ValueError(
                    f"Realtime session exceeds the {REALTIME_MAX_SECONDS:g} second limit"
                )

            started = time.perf_counter()
            stream["transcriber"].add_audio(mx.array(audio.copy()))
            processing_seconds = time.perf_counter() - started
            stream["audio_samples"] = new_sample_count
            stream["processing_seconds"] += processing_seconds
            stream["sequence"] += 1
            return self._stream_snapshot(processing_seconds=processing_seconds)
        except ValueError as exc:
            print(f"Rejected realtime transcription chunk: {exc}", file=sys.stderr)
            return {"success": False, "error": str(exc)}
        except Exception as exc:
            print(f"Realtime transcription chunk failed: {exc}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return {"success": False, "error": str(exc)}

    def _stream_snapshot(self, *, processing_seconds: float = 0.0, final=False) -> dict:
        stream = self.stream
        transcriber = stream["transcriber"]
        result = transcriber.result
        finalized = transcriber.finalized_tokens
        draft = transcriber.draft_tokens
        delta = finalized[stream["reported_finalized"] :]
        stream["reported_finalized"] = len(finalized)
        audio_seconds = stream["audio_samples"] / self.sample_rate
        response = {
            "success": True,
            "session_id": stream["id"],
            "sequence": stream["sequence"],
            "text": result.text,
            "finalized_text": "".join(token.text for token in finalized).strip(),
            "draft_text": "".join(token.text for token in draft).strip(),
            "finalized_delta": [self._serialize_token(token) for token in delta],
            "audio_seconds": audio_seconds,
            "processing_seconds": processing_seconds,
            "real_time_factor": (
                stream["processing_seconds"] / audio_seconds if audio_seconds else None
            ),
            "final": final,
        }
        if final:
            response["timestamps"] = self._extract_word_timestamps(result)
        return response

    def finish_stream(self, session_id: str) -> dict:
        matched_session = False
        try:
            self._require_stream(session_id)
            matched_session = True
            response = self._stream_snapshot(final=True)
            response["finalized_text"] = response["text"].strip()
            response["draft_text"] = ""
            return response
        except Exception as exc:
            return {"success": False, "error": str(exc)}
        finally:
            if matched_session:
                self._close_stream()

    def abort_stream(self, session_id: str) -> dict:
        matched_session = False
        try:
            self._require_stream(session_id)
            matched_session = True
            return {"success": True, "session_id": session_id, "aborted": True}
        except Exception as exc:
            return {"success": False, "error": str(exc)}
        finally:
            if matched_session:
                self._close_stream()

    def _close_stream(self):
        stream = self.stream
        self.stream = None
        if stream is None:
            return
        try:
            stream["context"].__exit__(None, None, None)
        except Exception as exc:
            print(f"Failed to close realtime context: {exc}", file=sys.stderr)

    @staticmethod
    def send_response(response: dict):
        print(json.dumps(response, ensure_ascii=False), flush=True)

    def handle_request(self, line: str) -> dict:
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            return {"success": False, "error": f"Invalid JSON: {exc}"}
        if not isinstance(request, dict):
            return {"success": False, "error": "Request must be a JSON object"}

        request_id = request.get("id", "unknown")
        if request.get("command") == "shutdown":
            self._close_stream()
            self.running = False
            return {"id": request_id, "status": "shutdown"}

        request_type = request.get("type", "transcribe")
        if request_type == "stream_start":
            result = self.start_stream(request.get("session_id", ""))
        elif request_type == "stream_audio":
            result = self.stream_audio(
                request.get("session_id", ""),
                request.get("audio", ""),
            )
        elif request_type == "stream_finish":
            result = self.finish_stream(request.get("session_id", ""))
        elif request_type == "stream_abort":
            result = self.abort_stream(request.get("session_id", ""))
        elif request_type == "transcribe":
            audio_path = request.get("audio_path")
            if not audio_path:
                result = {"success": False, "error": "Missing audio_path"}
            else:
                result = self.transcribe(
                    audio_path,
                    timestamps=request.get("timestamps", False),
                    word_timestamps=request.get("word_timestamps", False),
                )
        else:
            result = {
                "success": False,
                "error": f"Unknown request type: {request_type}",
            }

        result["id"] = request_id
        return result

    def run(self):
        def handle_signal(signum, _frame):
            print(f"Received signal {signum}, shutting down...", file=sys.stderr)
            self._close_stream()
            self.running = False

        signal.signal(signal.SIGTERM, handle_signal)
        signal.signal(signal.SIGINT, handle_signal)

        if not self.load_model():
            return

        self.send_response(
            {
                "status": "ready",
                "model": MODEL_ID,
                "revision": MODEL_REVISION,
                "parakeet_mlx_version": EXPECTED_PARAKEET_MLX_VERSION,
                "sample_rate": self.sample_rate,
                "realtime": REALTIME_ENABLED,
            }
        )

        while self.running:
            try:
                line = sys.stdin.readline()
                if not line:
                    print("stdin closed, shutting down...", file=sys.stderr)
                    break
                line = line.strip()
                if not line:
                    continue
                self.send_response(self.handle_request(line))
            except Exception as exc:
                print(f"Unexpected daemon error: {exc}", file=sys.stderr)
                traceback.print_exc(file=sys.stderr)
                self.send_response(
                    {"success": False, "error": f"Daemon error: {exc}"}
                )

        self._close_stream()
        print("Daemon shutdown complete", file=sys.stderr)


if __name__ == "__main__":
    ParakeetDaemon().run()
