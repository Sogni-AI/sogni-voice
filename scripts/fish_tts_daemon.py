#!/usr/bin/env python3
"""
Fish Audio S2 Pro TTS Daemon

A persistent daemon that loads the Fish Audio S2 Pro model (8-bit MLX) once and
accepts text-to-speech requests via a stdin/stdout JSON-line protocol, matching
the pattern used by the other local TTS engines (Pocket, Qwen, MOSS).

Fish S2 is highly expressive: emotion/style is expressed *inline* in the text via
free-form [bracket] tags and (parenthesis) paralanguage cues — no separate
parameter. It also supports zero-shot voice cloning from a short reference clip
plus its transcript (ref_audio + ref_text).

The heavy lifting is delegated to the vendored ``FishMLXServer`` (which applies
the generation fastpath patch and loads the model); this daemon reuses it for the
default-voice path and drives ``model.generate(ref_audio=..., ref_text=...)``
directly for the cloning path. Requires PYTHONPATH to include the vendored
``vendor/fish-s2-mlx`` directory so ``local_mlx`` is importable.

Protocol:
- Input (stdin): one JSON object per line with a "type" field:
  {"id","type":"generate","text","output_path","max_tokens?","temperature?"}
  {"id","type":"generate_voice_clone","text","clone_id","output_path"}
  {"id","type":"create_voice_clone","audio_path","transcript","clone_id"}
  {"id","type":"delete_voice_clone","clone_id"}
  {"id","type":"rename_voice_clone","old_clone_id","new_clone_id"}
  {"id","type":"list_voices"}
  {"command":"shutdown"}
- Output (stdout): one JSON object per line
  Success: {"id","success":true,"output_path","duration","rtf?"}
  Error:   {"id","success":false,"error"}
- Special:
  Ready:   {"status":"ready","voices":[...],"features":[...],"sample_rate":44100}
"""

import json
import os
import shutil
import signal
import sys
import traceback

sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.environ.get(
    "FISH_TTS_MODEL_PATH",
    os.path.join(SCRIPT_DIR, "..", "checkpoints", "fish-audio-s2-pro-8bit-mlx-normalized"),
)
VOICE_CLONES_DIR = os.environ.get(
    "FISH_TTS_VOICE_CLONES_DIR", os.path.join(SCRIPT_DIR, "..", "fish_voice_clones")
)
MODEL_ID = os.environ.get("FISH_TTS_MODEL_ID", "fish-audio-s2-pro-8bit-mlx")
DEFAULT_MAX_TOKENS = int(os.environ.get("FISH_TTS_MAX_TOKENS", "1024"))
DEFAULT_VOICE = "default"


def _log(msg: str) -> None:
    print(f"[fish-tts-daemon] {msg}", file=sys.stderr)


class FishTTSDaemon:
    def __init__(self):
        self.server = None          # vendored FishMLXServer (lifecycle + default path)
        self.model = None           # underlying mlx_audio model (cloning path)
        self.sample_rate = 44100
        self.running = True
        # Lazily imported vendored/library helpers (populated in load_model()).
        self._encode_wav = None
        self._load_audio = None
        self._mx = None
        self._np = None
        os.makedirs(VOICE_CLONES_DIR, exist_ok=True)

    @staticmethod
    def _validate_clone_id(clone_id) -> bool:
        if not clone_id or "/" in clone_id or "\\" in clone_id or ".." in clone_id:
            return False
        return True

    def load_model(self) -> bool:
        try:
            _log(f"Loading Fish S2 Pro model from {MODEL_PATH} ...")
            from pathlib import Path

            import mlx.core as mx
            import numpy as np
            from mlx_audio.utils import load_audio

            # The vendored host server reads its token ceiling from
            # FISH_MLX_MAX_TOKENS at import time (default 256, which caps audio
            # at ~11s regardless of text length). Propagate our configured budget
            # so long text isn't truncated; _effective_max_tokens still scales the
            # real per-request cap down to the actual text length.
            os.environ.setdefault("FISH_MLX_MAX_TOKENS", str(DEFAULT_MAX_TOKENS))
            from local_mlx.host_server import FishMLXServer, _encode_wav_pcm16

            self._mx = mx
            self._np = np
            self._load_audio = load_audio
            self._encode_wav = _encode_wav_pcm16

            # Eager load so "ready" means the weights are resident (matches the
            # other daemons); warmup off — the fastpath patch already primes it.
            self.server = FishMLXServer(model_path=Path(MODEL_PATH), lazy=False, warmup=False)
            self.model = self.server.ensure_model()
            self.sample_rate = int(getattr(self.model, "sample_rate", 44100))
            _log(f"Model loaded (sample_rate={self.sample_rate})")
            return True
        except Exception as e:  # noqa: BLE001 - report any load failure to the parent
            _log(f"Failed to load model: {e}")
            traceback.print_exc(file=sys.stderr)
            return False

    # ------------------------------------------------------------------ generate

    def generate(self, text, output_path, max_tokens=None, temperature=None) -> dict:
        if self.server is None:
            return {"success": False, "error": "Model not loaded"}
        try:
            payload = {
                "input": text,
                "model": MODEL_ID,
                "voice": DEFAULT_VOICE,
                "response_format": "wav",
                "max_tokens": int(max_tokens or DEFAULT_MAX_TOKENS),
            }
            if temperature is not None:
                payload["temperature"] = float(temperature)
            audio_bytes, _media_type, timing = self.server.synthesize(payload)
            with open(output_path, "wb") as f:
                f.write(audio_bytes)
            return {
                "success": True,
                "output_path": output_path,
                "duration": float(timing.get("audio_seconds", 0.0)) if timing else None,
                "rtf": float(timing.get("rtf")) if timing and timing.get("rtf") is not None else None,
            }
        except Exception as e:  # noqa: BLE001
            _log(f"generate error: {e}")
            traceback.print_exc(file=sys.stderr)
            return {"success": False, "error": str(e)}

    def _reference_path(self, clone_id) -> str:
        return os.path.join(VOICE_CLONES_DIR, clone_id, "reference.wav")

    def _metadata_path(self, clone_id) -> str:
        return os.path.join(VOICE_CLONES_DIR, clone_id, "metadata.json")

    def _read_transcript(self, clone_id) -> str:
        try:
            with open(self._metadata_path(clone_id)) as f:
                return json.load(f).get("transcript", "") or ""
        except Exception:  # noqa: BLE001
            return ""

    def _write_wav(self, audio_np, output_path) -> float:
        """Encode a float32 [-1, 1] waveform to a 16-bit PCM WAV. Returns duration."""
        wav_bytes = self._encode_wav(audio_np, self.sample_rate)
        with open(output_path, "wb") as f:
            f.write(wav_bytes)
        return float(audio_np.shape[0]) / float(self.sample_rate)

    def _synthesize_with_reference(self, text, ref_audio, ref_text, max_tokens, temperature):
        """Run the model with a reference prompt and return a concatenated waveform.

        Zero-shot cloning can intermittently run away on some references —
        repeating words or emitting non-speech filler until it exhausts the
        token budget instead of stopping cleanly. A run that hits the token cap
        without a natural stop is the runaway signal; when we see it we retry
        with progressively tighter sampling (which suppresses the low-probability
        tail that triggers the loop). A clean run stops well under the cap and
        returns immediately, so well-behaved references pay no extra cost.
        """
        mx = self._mx
        # Cap the token budget to the text length, exactly like the default path
        # (FishMLXServer.synthesize -> _effective_max_tokens).
        requested = int(max_tokens or DEFAULT_MAX_TOKENS)
        cap = self.server._effective_max_tokens(self.model, text, requested)
        base_temp = float(temperature) if temperature is not None else 0.7
        attempts = [
            {"temperature": base_temp},
            {"temperature": min(base_temp, 0.5), "top_p": 0.6, "top_k": 20},
            {"temperature": 0.3, "top_p": 0.5, "top_k": 15},
        ]

        fallback = None
        for i, kwargs in enumerate(attempts):
            segments = list(
                self.model.generate(
                    text, ref_audio=ref_audio, ref_text=ref_text or "",
                    max_tokens=cap, verbose=False, **kwargs,
                )
            )
            if not segments:
                continue
            token_count = sum(int(s.token_count) for s in segments)
            chunks = [mx.reshape(s.audio, (-1,)) for s in segments]
            audio = chunks[0] if len(chunks) == 1 else mx.concatenate(chunks, axis=0)
            mx.eval(audio)
            arr = self._np.asarray(audio, dtype=self._np.float32)
            # Natural stop (well under the cap) => good output, return it.
            if token_count < cap - 2:
                return arr
            # Runaway (hit the cap). Keep the first as a bounded fallback and
            # retry tighter.
            if fallback is None:
                fallback = arr
            _log(f"clone generation hit token cap ({token_count}/{cap}) on attempt {i + 1}; retrying tighter")

        if fallback is None:
            raise RuntimeError("Model produced no audio segments")
        return fallback

    def generate_with_clone(self, text, clone_id, output_path, max_tokens=None, temperature=None) -> dict:
        if self.model is None:
            return {"success": False, "error": "Model not loaded"}
        if not self._validate_clone_id(clone_id):
            return {"success": False, "error": "Invalid clone_id"}
        ref_path = self._reference_path(clone_id)
        if not os.path.exists(ref_path):
            return {"success": False, "error": f"Voice clone '{clone_id}' not found"}
        try:
            ref_audio = self._load_audio(ref_path, self.sample_rate)
            ref_text = self._read_transcript(clone_id)
            audio_np = self._synthesize_with_reference(
                text, ref_audio, ref_text, max_tokens, temperature
            )
            duration = self._write_wav(audio_np, output_path)
            return {"success": True, "output_path": output_path, "duration": duration}
        except Exception as e:  # noqa: BLE001
            _log(f"generate_voice_clone error: {e}")
            traceback.print_exc(file=sys.stderr)
            return {"success": False, "error": str(e)}

    def create_voice_clone(self, audio_path, transcript, clone_id) -> dict:
        if self.model is None:
            return {"success": False, "error": "Model not loaded"}
        if not self._validate_clone_id(clone_id):
            return {"success": False, "error": "Invalid clone_id"}
        if not transcript or not transcript.strip():
            return {"success": False, "error": "A transcript of the reference audio is required"}
        try:
            # Validate the reference is loadable and encodable before saving.
            ref_audio = self._load_audio(audio_path, self.sample_rate)
            probe = ref_audio
            if probe.ndim == 1:
                probe = probe[None, None, :]
            elif probe.ndim == 2:
                probe = probe[None, :, :]
            self.model.codec.encode(probe)  # raises if the reference is unusable

            clone_dir = os.path.join(VOICE_CLONES_DIR, clone_id)
            os.makedirs(clone_dir, exist_ok=True)
            shutil.copy2(audio_path, self._reference_path(clone_id))
            with open(self._metadata_path(clone_id), "w") as f:
                json.dump(
                    {
                        "clone_id": clone_id,
                        "transcript": transcript.strip(),
                        "sample_rate": self.sample_rate,
                    },
                    f,
                )
            _log(f"Created voice clone '{clone_id}'")
            return {"success": True, "clone_id": clone_id}
        except Exception as e:  # noqa: BLE001
            _log(f"create_voice_clone error: {e}")
            traceback.print_exc(file=sys.stderr)
            return {"success": False, "error": str(e)}

    def delete_voice_clone(self, clone_id) -> dict:
        if not self._validate_clone_id(clone_id):
            return {"success": False, "error": "Invalid clone_id"}
        clone_dir = os.path.join(VOICE_CLONES_DIR, clone_id)
        if not os.path.isdir(clone_dir):
            return {"success": False, "error": f"Voice clone '{clone_id}' not found"}
        try:
            shutil.rmtree(clone_dir)
            return {"success": True, "clone_id": clone_id}
        except Exception as e:  # noqa: BLE001
            return {"success": False, "error": str(e)}

    def rename_voice_clone(self, old_clone_id, new_clone_id) -> dict:
        if not self._validate_clone_id(old_clone_id) or not self._validate_clone_id(new_clone_id):
            return {"success": False, "error": "Invalid clone_id"}
        old_dir = os.path.join(VOICE_CLONES_DIR, old_clone_id)
        new_dir = os.path.join(VOICE_CLONES_DIR, new_clone_id)
        if not os.path.isdir(old_dir):
            return {"success": False, "error": f"Voice clone '{old_clone_id}' not found"}
        if os.path.exists(new_dir):
            return {"success": False, "error": f"Voice clone '{new_clone_id}' already exists"}
        try:
            os.rename(old_dir, new_dir)
            return {"success": True, "old_clone_id": old_clone_id, "new_clone_id": new_clone_id}
        except Exception as e:  # noqa: BLE001
            return {"success": False, "error": str(e)}

    def list_voices(self) -> dict:
        clones = []
        if os.path.isdir(VOICE_CLONES_DIR):
            for name in sorted(os.listdir(VOICE_CLONES_DIR)):
                if os.path.exists(self._reference_path(name)):
                    clones.append(name)
        return {"success": True, "voices": [DEFAULT_VOICE], "clones": clones}

    # ------------------------------------------------------------------ dispatch

    def send_response(self, response: dict) -> None:
        print(json.dumps(response), flush=True)

    def handle_request(self, line: str) -> dict:
        try:
            request = json.loads(line)
        except json.JSONDecodeError as e:
            return {"success": False, "error": f"Invalid JSON: {e}"}

        if request.get("command") == "shutdown":
            self.running = False
            return {"id": request.get("id", "unknown"), "status": "shutdown"}

        request_id = request.get("id", "unknown")
        request_type = request.get("type", "generate")

        def require(*keys):
            for k in keys:
                if not request.get(k):
                    return f"Missing {k}"
            return None

        if request_type == "generate":
            missing = require("text", "output_path")
            if missing:
                return {"id": request_id, "success": False, "error": missing}
            result = self.generate(
                request["text"], request["output_path"],
                request.get("max_tokens"), request.get("temperature"),
            )
        elif request_type == "generate_voice_clone":
            missing = require("text", "output_path", "clone_id")
            if missing:
                return {"id": request_id, "success": False, "error": missing}
            result = self.generate_with_clone(
                request["text"], request["clone_id"], request["output_path"],
                request.get("max_tokens"), request.get("temperature"),
            )
        elif request_type == "create_voice_clone":
            missing = require("audio_path", "clone_id")
            if missing:
                return {"id": request_id, "success": False, "error": missing}
            result = self.create_voice_clone(
                request["audio_path"], request.get("transcript", ""), request["clone_id"],
            )
        elif request_type == "delete_voice_clone":
            missing = require("clone_id")
            if missing:
                return {"id": request_id, "success": False, "error": missing}
            result = self.delete_voice_clone(request["clone_id"])
        elif request_type == "rename_voice_clone":
            missing = require("old_clone_id", "new_clone_id")
            if missing:
                return {"id": request_id, "success": False, "error": missing}
            result = self.rename_voice_clone(request["old_clone_id"], request["new_clone_id"])
        elif request_type == "list_voices":
            result = self.list_voices()
        else:
            return {"id": request_id, "success": False, "error": f"Unknown request type: {request_type}"}

        result["id"] = request_id
        return result

    def run(self) -> None:
        def handle_signal(signum, frame):  # noqa: ARG001
            _log(f"Received signal {signum}, shutting down...")
            self.running = False

        signal.signal(signal.SIGTERM, handle_signal)
        signal.signal(signal.SIGINT, handle_signal)

        if not self.load_model():
            self.send_response({"status": "error", "error": "Failed to load Fish S2 model"})
            sys.exit(1)

        self.send_response({
            "status": "ready",
            "voices": [DEFAULT_VOICE],
            "clones": self.list_voices()["clones"],
            "features": ["tts", "emotion_tags", "voice_cloning"],
            "sample_rate": self.sample_rate,
            "model": MODEL_ID,
        })

        while self.running:
            try:
                line = sys.stdin.readline()
                if not line:
                    _log("stdin closed, shutting down...")
                    break
                line = line.strip()
                if not line:
                    continue
                self.send_response(self.handle_request(line))
            except Exception as e:  # noqa: BLE001
                _log(f"Unexpected error in main loop: {e}")
                traceback.print_exc(file=sys.stderr)
                self.send_response({"success": False, "error": f"Daemon error: {e}"})

        _log("Fish S2 daemon shutdown complete")


if __name__ == "__main__":
    FishTTSDaemon().run()
