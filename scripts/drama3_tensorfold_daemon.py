#!/usr/bin/env python3
"""Drama 3 NVFP4 through the pinned TensorFold drama-nvfp4 HTTP server.

The existing Fish clone store remains reference.wav + metadata.json. TensorFold
accepts codec codes, not reference audio, so its native encoder prepares each
distinct reference once per daemon. No reference files are changed. See
docs/linux-nvidia.md for the pinned engine, checkpoint, and serving settings.
"""

import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

from drama3_text import InvalidInputError, validate_text
from drama3_tts_daemon import Drama3TTSDaemon
from fish_omni_daemon import OmniBackendMixin, OmniClient, REQUEST_TIMEOUT_SECONDS
from fish_tts_daemon import _log

NATIVE_PATH = os.environ.get("DRAMA3_TTS_TENSORFOLD_NATIVE_PATH", "/usr/local/bin/tensorfold-native")
MODEL_PATH = os.environ.get("DRAMA3_TTS_MODEL_PATH", "./checkpoints/drama-3-NVFP4-Pruned")


class TensorFoldClient(OmniClient):
    def __init__(self, *args):
        super().__init__(*args)
        self.references = {}

    def encode_reference(self, audio_path, transcript):
        # Clone creation can replace the WAV or transcript under the same ID.
        key = (hashlib.sha256(Path(audio_path).read_bytes()).hexdigest(), transcript)
        if key not in self.references:
            with tempfile.TemporaryDirectory(prefix="drama3-reference-") as temporary:
                output = Path(temporary) / "reference.json"
                subprocess.run(
                    [NATIVE_PATH, "voice", "encode", str(audio_path), "--model", MODEL_PATH,
                     "--text", transcript, "--name", "reference", "--out", str(output)],
                    check=True, stdout=subprocess.DEVNULL, timeout=REQUEST_TIMEOUT_SECONDS,
                )
                encoded = json.loads(output.read_text())
            self.references[key] = {"text": encoded["text"], "vq_codes": encoded["vq_codes"]}
        return self.references[key]

    def speech_wav(self, text, references):
        payload = {
            "model": self.model, "input": text, "voice": "default",
            "response_format": "wav", "references": references,
        }
        request = urllib.request.Request(
            f"{self.url}/v1/audio/speech", data=json.dumps(payload).encode(),
            # Let the engine budget its own seeded redraws. The HTTP timeout
            # remains 600 s for longer API scripts; reserve 3 s for WAV output.
            headers={"Content-Type": "application/json",
                     "X-Deadline-S": str(min(REQUEST_TIMEOUT_SECONDS - 3, 20 + 0.15 * len(text)))},
        )
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
                audio = response.read()
                reason = response.headers.get("X-Finish-Reason", "unknown")
                _log(f"TensorFold finish={reason}, silence_redraws="
                     f"{response.headers.get('X-Silence-Redraws', 'off')}, mid_trips="
                     f"{response.headers.get('X-Silence-Mid-Trips', 'off')}")
                return audio, reason
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")[:500]
            if error.code == 400:
                raise InvalidInputError(detail) from error
            raise RuntimeError(f"TensorFold returned HTTP {error.code}: {detail}") from error


class TensorFoldDrama3TTSDaemon(OmniBackendMixin, Drama3TTSDaemon):
    client_class = TensorFoldClient
    FEATURES = ["tts", "direction_tags", "voice_cloning"]

    def _synthesize(self, text, output_path, references, max_tokens, temperature):
        # speech.zig fixes sampling and the frame cap at server startup. Reject
        # API overrides instead of silently dropping settings the caller chose.
        if max_tokens is not None:
            return {"success": False, "error": "invalid input: TensorFold sets maxTokens at server startup; omit maxTokens"}
        if temperature is not None and float(temperature) != 1.0:
            return {"success": False, "error": "invalid input: TensorFold uses a fixed temperature of 1.0"}
        try:
            validate_text(text)
            if any(speaker != "0" for speaker in re.findall(r"<\|speaker:(\d+)\|>", text)):
                raise InvalidInputError("TensorFold supports only <|speaker:0|>")
            # TensorFold's long-form mode owns segmentation and reference
            # continuity. The vLLM 300-byte splitter restarted prosody here.
            text = " ".join(text.split())
            started = time.perf_counter()
            wav, reason = self.model.speech_wav(text, references)
            audio, sample_rate = self._sf.read(io.BytesIO(wav), dtype="float32", always_2d=True)
            if sample_rate != self.sample_rate:
                raise RuntimeError(f"Expected {self.sample_rate} Hz audio, received {sample_rate} Hz")
            # The engine's onset/mid-silence guards run before its seeded
            # redraws. A recovered pause in a completed take is not a stall.
            duration = self._write_wav(audio.mean(axis=1), output_path)
            elapsed = time.perf_counter() - started
            return {"success": True, "output_path": output_path, "duration": duration,
                    "rtf": elapsed / duration if duration else None,
                    "finish_reason": reason}
        except InvalidInputError as error:
            return {"success": False, "error": f"invalid input: {error}"}

    def generate_with_clone(self, text, clone_id, output_path, max_tokens=None, temperature=None):
        if self.model is None:
            return {"success": False, "error": "Model not loaded"}
        if not self._validate_clone_id(clone_id):
            return {"success": False, "error": "Invalid clone_id"}
        reference_path = self._reference_path(clone_id)
        if not os.path.exists(reference_path):
            return {"success": False, "error": f"Voice clone '{clone_id}' not found"}
        try:
            reference = self.model.encode_reference(reference_path, self._read_transcript(clone_id))
            return self._synthesize(text, output_path, [reference], max_tokens, temperature)
        except Exception as error:
            _log(f"TensorFold clone generation failed: {error}")
            return {"success": False, "error": str(error)}


if __name__ == "__main__":
    TensorFoldDrama3TTSDaemon().run()
