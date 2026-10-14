#!/usr/bin/env python3
"""
Fish Audio Drama 3 TTS Daemon

Loads Fish Audio Drama 3 once through the drama3-mlx port and serves the same
stdin/stdout JSON-line protocol as scripts/fish_tts_daemon.py, whose
FishTTSDaemon this subclasses: request dispatch, MLX memory cleanup and the
voice-clone store (reference.wav + transcript in fish_voice_clones/) are shared,
so every Fish S2 clone works here too. Only model loading, synthesis and the
reference check differ.

Drama 3 is directed in plain language: [bracket] directions before or inside a
line, paired tags such as <whisper>...</whisper>, and <|speaker:N|> tags for up
to 16 characters in one request. Long text is split and generated chunk by chunk
the way Fish's hosted server does it.

Runs in .venv-drama3 (pip install drama3-mlx); see docs/fish-drama3.md.
Errors caused by the request text start with "invalid input:".
"""

import os
import time
import traceback

from fish_tts_daemon import SCRIPT_DIR, FishTTSDaemon, _log

MODEL_PATH = os.environ.get(
    "DRAMA3_TTS_MODEL_PATH", os.path.join(SCRIPT_DIR, "..", "checkpoints", "drama-3")
)
MODEL_ID = os.environ.get("DRAMA3_TTS_MODEL_ID", "fish-drama-3")
# How the release's experts are held: q8 (default), q4, fp8 or bf16.
EXPERTS = os.environ.get("DRAMA3_TTS_EXPERTS", "q8")
# Frames per text chunk; 0 keeps Fish's default (600 frames, ~28 s).
DEFAULT_MAX_NEW_TOKENS = int(os.environ.get("DRAMA3_TTS_MAX_NEW_TOKENS", "0"))
# Fish's model-card serving settings, not its SDK's 0.7 / 0.7: on Fish's own A1
# example (tagged, cloned) 20/24 takes were complete at 1.0 / 0.9 against 14/24.
DEFAULT_TEMPERATURE = float(os.environ.get("DRAMA3_TTS_TEMPERATURE", "1.0"))
DEFAULT_TOP_P = float(os.environ.get("DRAMA3_TTS_TOP_P", "0.9"))
# Every incomplete take in those runs (15/15) held a silence of 2 s or more, where
# the model stalls instead of speaking; such a chunk is sampled again.
ATTEMPTS = int(os.environ.get("DRAMA3_TTS_ATTEMPTS", "3"))
STALL_SECONDS = 2.0
SILENCE_DBFS = -50.0


def longest_silence(audio, sample_rate) -> float:
    """Seconds of the longest run of 0.1 s windows quieter than SILENCE_DBFS."""
    import numpy as np

    window = int(sample_rate * 0.1)
    frames = audio[: len(audio) // window * window].reshape(-1, window)
    quiet = 20 * np.log10(np.sqrt((frames**2).mean(axis=1)) + 1e-9) < SILENCE_DBFS
    longest = run = 0
    for is_quiet in quiet:
        run = run + 1 if is_quiet else 0
        longest = max(longest, run)
    return longest * 0.1


class Drama3TTSDaemon(FishTTSDaemon):
    ENGINE_LABEL = "Fish Drama 3"
    FEATURES = ["tts", "direction_tags", "speaker_tags", "voice_cloning"]
    MODEL_ID = MODEL_ID

    def load_model(self) -> bool:
        try:
            _log(f"Loading Fish Drama 3 from {MODEL_PATH} (experts: {EXPERTS}) ...")
            import mlx.core as mx
            import numpy as np
            import soundfile as sf
            from drama3_mlx import Drama3

            self._configure_mlx_memory(mx)
            self._np, self._sf = np, sf
            started = time.perf_counter()
            self.model = Drama3.load(MODEL_PATH, experts=EXPERTS)
            # The base class treats a non-None server as "model loaded".
            self.server = self.model
            self.sample_rate = self.model.sample_rate
            mx.reset_peak_memory()
            _log(
                f"Model loaded in {time.perf_counter() - started:.1f}s "
                f"({mx.get_active_memory() / 1024**3:.1f} GiB resident)"
            )
            return True
        except Exception as e:  # noqa: BLE001 - report any load failure to the parent
            _log(f"Failed to load model: {e}")
            traceback.print_exc()
            return False

    def _write_wav(self, audio_np, output_path) -> float:
        self._sf.write(output_path, audio_np, self.sample_rate, subtype="PCM_16")
        return float(audio_np.shape[0]) / float(self.sample_rate)

    def _validate_reference(self, audio_path) -> None:
        audio, sample_rate = self._sf.read(audio_path, dtype="float32", always_2d=True)
        self.model.codec.encode(audio.mean(axis=1), sample_rate)

    def _synthesize(self, text, output_path, references, max_tokens, temperature) -> dict:
        from drama3_mlx.prompt import InvalidInputError

        def accept(segment) -> bool:
            stall = longest_silence(segment.audio, self.sample_rate)
            if stall < STALL_SECONDS:
                return True
            _log(f"{stall:.1f}s silence in {segment.text[:50]!r}; sampling the chunk again")
            return False

        options = {
            "max_new_tokens": int(max_tokens or DEFAULT_MAX_NEW_TOKENS),
            "temperature": DEFAULT_TEMPERATURE if temperature is None else float(temperature),
            "top_p": DEFAULT_TOP_P,
            "accept": accept,
            "attempts": ATTEMPTS,
        }
        started = time.perf_counter()
        try:
            segments = list(self.model.generate(text, references=references, **options))
        except InvalidInputError as e:
            return {"success": False, "error": f"invalid input: {e}"}
        if not segments:
            raise RuntimeError("Drama 3 produced no audio")
        for segment in segments:
            if segment.finish_reason != "eos":
                _log(f"chunk hit the frame limit before stopping: {segment.text[:60]!r}")
        audio = self._np.concatenate([segment.audio for segment in segments])
        duration = self._write_wav(audio, output_path)
        elapsed = time.perf_counter() - started
        _log(f"{len(segments)} chunk(s), {duration:.2f}s audio in {elapsed:.2f}s")
        return {
            "success": True,
            "output_path": output_path,
            "duration": duration,
            "rtf": elapsed / duration if duration > 0 else None,
        }

    def generate(self, text, output_path, max_tokens=None, temperature=None) -> dict:
        if self.model is None:
            return {"success": False, "error": "Model not loaded"}
        try:
            return self._synthesize(text, output_path, [], max_tokens, temperature)
        except Exception as e:  # noqa: BLE001
            _log(f"generate error: {e}")
            traceback.print_exc()
            return {"success": False, "error": str(e)}

    def generate_with_clone(
        self, text, clone_id, output_path, max_tokens=None, temperature=None
    ) -> dict:
        if self.model is None:
            return {"success": False, "error": "Model not loaded"}
        if not self._validate_clone_id(clone_id):
            return {"success": False, "error": "Invalid clone_id"}
        ref_path = self._reference_path(clone_id)
        if not os.path.exists(ref_path):
            return {"success": False, "error": f"Voice clone '{clone_id}' not found"}
        try:
            audio, sample_rate = self._sf.read(ref_path, dtype="float32", always_2d=True)
            reference = self.model.reference(
                audio.mean(axis=1), sample_rate, self._read_transcript(clone_id)
            )
            return self._synthesize(text, output_path, [reference], max_tokens, temperature)
        except Exception as e:  # noqa: BLE001
            _log(f"generate_voice_clone error: {e}")
            traceback.print_exc()
            return {"success": False, "error": str(e)}


if __name__ == "__main__":
    Drama3TTSDaemon().run()
