#!/usr/bin/env python3
"""
Fish S2 Pro / Fish Drama 3 TTS daemon for Linux + NVIDIA, through vLLM-Omni

On NVIDIA GPUs Fish's own releases run in vLLM-Omni (docker/nvidia/), which
serves them over an OpenAI-style /v1/audio/speech API. This daemon is that
server's client. It subclasses the MLX daemons, so the stdin/stdout JSON-line
protocol, text chunking, the shared clone store (fish_voice_clones/), the S2
runaway retry and the Drama 3 stall check all stay identical; only synthesis
becomes a local HTTP call.

FISH_OMNI_ENGINE picks the engine ("s2" or "drama3"); FISH_OMNI_URL and
FISH_OMNI_MODEL name the vLLM-Omni server and the model it serves.

Known gap: vLLM-Omni takes one reference per request, so Drama 3 chunks do not
carry the previous chunks' audio as context the way drama3-mlx does.
"""

import base64
import io
import json
import os
import re
import time
import traceback
import urllib.error
import urllib.request

from drama3_tts_daemon import (
    ATTEMPTS,
    DEFAULT_MAX_NEW_TOKENS,
    DEFAULT_TEMPERATURE,
    DEFAULT_TOP_P,
    STALL_SECONDS,
    Drama3TTSDaemon,
    longest_silence,
)
from fish_tts_daemon import DEFAULT_MAX_TOKENS, FishTTSDaemon, _log, prepare_text_chunks

ENGINE = os.environ.get("FISH_OMNI_ENGINE", "s2")
OMNI_URL = os.environ.get("FISH_OMNI_URL", "http://127.0.0.1:8001").rstrip("/")
OMNI_MODEL = os.environ.get("FISH_OMNI_MODEL", "fishaudio/s2-pro")
# The daemon reports ready only once the server serves the model. A cold
# Drama 3 start (load + compile + graph capture) takes several minutes.
READY_TIMEOUT_SECONDS = float(os.environ.get("FISH_OMNI_READY_TIMEOUT", "900"))
REQUEST_TIMEOUT_SECONDS = float(os.environ.get("FISH_OMNI_REQUEST_TIMEOUT", "600"))
SAMPLE_RATE = 44100
# Both models emit 21.5 codec frames per second of audio. Speech runs at about
# 16 characters per second (~1.35 frames per UTF-8 byte), so 3 frames per byte
# leaves room for slow delivery while bounding a runaway or a stall.
FRAMES_PER_BYTE = 3
MIN_FRAMES = 256
# Drama 3 takes <|speaker:0|> … <|speaker:15|>; drama3-mlx rejects any other
# <|…|> token as invalid input, and vLLM-Omni would speak it instead.
UNSUPPORTED_TOKEN_RE = re.compile(r"<\|(?!speaker:(?:1[0-5]|[0-9])\|>)[^|>]*\|>")


def frame_budget(text: str, requested: int, floor: int = MIN_FRAMES) -> int:
    """Frames to allow for one chunk: scaled to its length, never above the request."""
    scaled = max(floor, FRAMES_PER_BYTE * len(text.encode("utf-8")))
    return min(int(requested), scaled) if requested else scaled


class InvalidInputError(ValueError):
    """The server rejected the request text (HTTP 400)."""


class OmniClient:
    """Minimal client for vLLM-Omni's speech API, shaped like the MLX objects.

    ``synthesize`` mirrors the vendored FishMLXServer (used by the S2 default
    path) and ``reference`` mirrors drama3-mlx (used by the Drama 3 clone path),
    so the base daemons' generate methods run unchanged.
    """

    def __init__(self, url: str, model: str, np, sf):
        self.url = url
        self.model = model
        self._np = np
        self._sf = sf
        self.sample_rate = SAMPLE_RATE

    def served(self) -> bool:
        try:
            with urllib.request.urlopen(f"{self.url}/v1/models", timeout=5) as response:
                models = json.load(response).get("data", [])
        except (OSError, ValueError):
            return False
        return any(entry.get("id") == self.model for entry in models)

    def speech_wav(self, text, reference=None, max_new_tokens=None, sampling=None) -> bytes:
        payload = {
            "model": self.model,
            "input": text,
            "voice": "default",
            "response_format": "wav",
        }
        if max_new_tokens:
            payload["max_new_tokens"] = int(max_new_tokens)
        if reference is not None:
            payload["ref_audio"], payload["ref_text"] = reference
        if sampling:
            payload["extra_params"] = sampling
        request = urllib.request.Request(
            f"{self.url}/v1/audio/speech",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
                return response.read()
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:500]
            if e.code == 400:
                raise InvalidInputError(detail) from e
            raise RuntimeError(f"vLLM-Omni returned HTTP {e.code}: {detail}") from e

    def speech(self, text, reference=None, max_new_tokens=None, sampling=None):
        """Render one chunk and return mono float32 samples."""
        wav = self.speech_wav(text, reference, max_new_tokens, sampling)
        audio, sample_rate = self._sf.read(io.BytesIO(wav), dtype="float32", always_2d=True)
        if sample_rate != self.sample_rate:
            raise RuntimeError(f"Expected {self.sample_rate} Hz audio, received {sample_rate} Hz")
        return audio.mean(axis=1)

    def synthesize(self, payload):
        """FishMLXServer.synthesize: (wav bytes, media type, timing) for one chunk."""
        started = time.perf_counter()
        wav = self.speech_wav(
            payload["input"],
            max_new_tokens=frame_budget(payload["input"], payload.get("max_tokens")),
            sampling=_temperature(payload.get("temperature")),
        )
        elapsed = time.perf_counter() - started
        info = self._sf.info(io.BytesIO(wav))
        seconds = float(info.frames) / float(info.samplerate)
        return wav, "audio/wav", {
            "audio_seconds": seconds,
            "rtf": elapsed / seconds if seconds > 0 else None,
        }

    def encode_reference(self, path_or_audio, sample_rate=None, transcript=""):
        """A clone reference as vLLM-Omni takes it: a WAV data URL plus its transcript."""
        if isinstance(path_or_audio, str):
            with open(path_or_audio, "rb") as f:
                wav = f.read()
        else:
            buffer = io.BytesIO()
            self._sf.write(buffer, path_or_audio, sample_rate, format="WAV", subtype="PCM_16")
            wav = buffer.getvalue()
        return f"data:audio/wav;base64,{base64.b64encode(wav).decode('ascii')}", transcript

    def reference(self, audio, sample_rate, transcript):
        """drama3-mlx's Drama3.reference."""
        return self.encode_reference(audio, sample_rate, transcript)


def _temperature(value):
    return None if value is None else {"temperature": float(value)}


class OmniBackendMixin:
    """Replaces MLX model loading with waiting for the vLLM-Omni server."""

    def load_model(self) -> bool:
        try:
            import numpy as np
            import soundfile as sf

            self._np, self._sf = np, sf
            client = OmniClient(OMNI_URL, OMNI_MODEL, np, sf)
            _log(f"Waiting for {OMNI_MODEL} at {OMNI_URL} ...")
            started = time.perf_counter()
            while not client.served():
                if time.perf_counter() - started > READY_TIMEOUT_SECONDS:
                    raise RuntimeError(
                        f"{OMNI_URL} did not serve {OMNI_MODEL} within {READY_TIMEOUT_SECONDS:.0f}s"
                    )
                time.sleep(5)
            # The base classes treat a non-None server/model as "model loaded".
            self.server = self.model = client
            self.sample_rate = client.sample_rate
            _log(f"{OMNI_MODEL} is served at {OMNI_URL}")
            return True
        except Exception as e:  # noqa: BLE001 - report any startup failure to the parent
            _log(f"Failed to reach the vLLM-Omni server: {e}")
            traceback.print_exc()
            return False

    def _write_wav(self, audio_np, output_path) -> float:
        self._sf.write(output_path, audio_np, self.sample_rate, subtype="PCM_16")
        return float(audio_np.shape[0]) / float(self.sample_rate)

    def _validate_reference(self, audio_path) -> None:
        audio, sample_rate = self._sf.read(audio_path, dtype="float32", always_2d=True)
        if audio.shape[0] < sample_rate // 2:
            raise ValueError("Reference audio must be at least 0.5 s long")


class OmniFishTTSDaemon(OmniBackendMixin, FishTTSDaemon):
    """Fish S2 Pro: the base generate paths, rendered by vLLM-Omni."""

    def load_model(self) -> bool:
        if not super().load_model():
            return False
        # generate_with_clone loads the reference with this hook; here it becomes
        # the request's data URL instead of samples.
        self._load_audio = lambda path, _sample_rate: path
        return True

    def _synthesize_with_reference(self, text, ref_audio, ref_text, max_tokens, temperature):
        """One cloned chunk, retried with tighter sampling when it runs away.

        Same policy as the MLX path: a take that fills its frame budget never
        stopped on its own, so it is sampled again more conservatively and the
        first take is kept only as a fallback.
        """
        cap = frame_budget(text, max_tokens or DEFAULT_MAX_TOKENS)
        reference = self.model.encode_reference(ref_audio, transcript=ref_text or "")
        base_temp = float(temperature) if temperature is not None else 0.7
        attempts = [
            {"temperature": base_temp},
            {"temperature": min(base_temp, 0.5), "top_p": 0.6, "top_k": 20},
            {"temperature": 0.3, "top_p": 0.5, "top_k": 15},
        ]
        fallback = None
        for i, sampling in enumerate(attempts):
            audio = self.model.speech(text, reference, cap, sampling)
            frames = audio.shape[0] / self.sample_rate * 21.5
            if frames < cap - 2:
                return audio
            if fallback is None:
                fallback = audio
            _log(f"clone generation hit the frame cap ({frames:.0f}/{cap}) on attempt {i + 1}; retrying tighter")
        return fallback


class OmniDrama3TTSDaemon(OmniBackendMixin, Drama3TTSDaemon):
    """Fish Drama 3: chunked like the S2 daemon, each chunk checked for stalls."""

    def _synthesize(self, text, output_path, references, max_tokens, temperature) -> dict:
        unsupported = UNSUPPORTED_TOKEN_RE.search(text)
        if unsupported:
            return {
                "success": False,
                "error": f"invalid input: {unsupported.group(0)} is not a token Drama 3 accepts "
                "(speaker tags run from <|speaker:0|> to <|speaker:15|>)",
            }
        chunks = prepare_text_chunks(text)
        if not chunks:
            return {"success": False, "error": "invalid input: text is empty"}
        reference = references[0] if references else None
        sampling = {
            "temperature": DEFAULT_TEMPERATURE if temperature is None else float(temperature),
            "top_p": DEFAULT_TOP_P,
        }
        requested = int(max_tokens or DEFAULT_MAX_NEW_TOKENS)
        started = time.perf_counter()
        rendered = []
        try:
            for chunk in chunks:
                # Fish's default of 600 frames per chunk, more for one long
                # speaker-tagged scene (which is never split).
                budget = requested or frame_budget(chunk, 0, floor=600)
                for attempt in range(1, ATTEMPTS + 1):
                    audio = self.model.speech(chunk, reference, budget, sampling)
                    stall = longest_silence(audio, self.sample_rate)
                    if stall < STALL_SECONDS:
                        break
                    _log(
                        f"{stall:.1f}s silence in {chunk[:50]!r} (attempt {attempt}/{ATTEMPTS}); "
                        "sampling the chunk again"
                    )
                rendered.append(audio)
        except InvalidInputError as e:
            return {"success": False, "error": f"invalid input: {e}"}
        audio = self._join_audio_chunks(rendered)
        duration = self._write_wav(audio, output_path)
        elapsed = time.perf_counter() - started
        _log(f"{len(chunks)} chunk(s), {duration:.2f}s audio in {elapsed:.2f}s")
        return {
            "success": True,
            "output_path": output_path,
            "duration": duration,
            "rtf": elapsed / duration if duration > 0 else None,
        }


if __name__ == "__main__":
    (OmniDrama3TTSDaemon if ENGINE == "drama3" else OmniFishTTSDaemon)().run()
