#!/usr/bin/env python3
"""
pyannote Speaker Diarization Daemon

Loads pyannote/speaker-diarization-3.1 once and serves diarization
requests via stdin/stdout JSON-line protocol. Mirrors the Parakeet daemon
pattern for lifecycle, request matching, and shutdown.

Protocol:
- Input (stdin): one JSON object per line
  {"id": "req-N", "audio_path": "/tmp/...",
   "num_speakers": null, "min_speakers": null, "max_speakers": null}

- Output (stdout): one JSON object per line
  Success: {"id": "req-N", "success": true,
            "turns": [{"start": 0.0, "end": 3.2, "speaker": "SPEAKER_00"}],
            "num_speakers": 2}
  Error:   {"id": "req-N", "success": false, "error": "..."}

- Special messages:
  Ready:   {"status": "ready"}
  Startup error: {"status": "error", "error": "..."}
  Shutdown ack:  {"id": "...", "status": "shutdown"}

Setup:
  pip install -r requirements-diarization.txt
  Set HF_TOKEN env var (https://hf.co/settings/tokens) and accept the
  model license at https://hf.co/pyannote/speaker-diarization-3.1
"""

import os
import sys
import json
import shutil
import signal
import subprocess
import traceback

sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)


HF_TOKEN_HELP = (
    "HF_TOKEN required. Create one at https://hf.co/settings/tokens and "
    "accept the model license at https://hf.co/pyannote/speaker-diarization-3.1"
)


class DiarizationDaemon:
    def __init__(self):
        self.pipeline = None
        self.running = True

    def load_model(self) -> bool:
        token = os.environ.get("HF_TOKEN")
        if not token:
            print(HF_TOKEN_HELP, file=sys.stderr)
            self.send_response({"status": "error", "error": HF_TOKEN_HELP})
            return False

        try:
            from pyannote.audio import Pipeline
            print("Loading pyannote/speaker-diarization-3.1...", file=sys.stderr)
            self.pipeline = Pipeline.from_pretrained(
                "pyannote/speaker-diarization-3.1",
                token=token,
            )
        except ImportError as e:
            msg = f"pyannote.audio not installed: {e}. Install: pip install -r requirements-diarization.txt"
            print(msg, file=sys.stderr)
            self.send_response({"status": "error", "error": msg})
            return False
        except Exception as e:
            msg = f"Failed to load pyannote pipeline: {e}"
            print(msg, file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            self.send_response({"status": "error", "error": msg})
            return False

        try:
            import torch
            if torch.backends.mps.is_available():
                self.pipeline.to(torch.device("mps"))
                print("pyannote pipeline moved to MPS", file=sys.stderr)
        except Exception as e:
            print(f"MPS unavailable, using CPU: {e}", file=sys.stderr)

        print("pyannote pipeline ready", file=sys.stderr)
        return True

    def _decode_to_mono_16k(self, audio_path: str):
        """Decode any audio/video file to mono 16kHz float32 tensor via ffmpeg.

        Bypasses torchcodec's AAC priming-padding behavior that causes
        pyannote 4.x to fail on m4a/mp4 inputs with a sample-count mismatch.
        Returning a pre-decoded waveform also makes diarization codec-agnostic.
        """
        import torch

        ffmpeg_bin = shutil.which("ffmpeg") or shutil.which(
            "ffmpeg", path="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        )
        if ffmpeg_bin is None:
            raise RuntimeError(
                "ffmpeg not found on PATH. Install with: brew install ffmpeg",
            )

        proc = subprocess.run(
            [
                ffmpeg_bin, "-nostdin", "-loglevel", "error",
                "-i", audio_path,
                "-ac", "1",
                "-ar", "16000",
                "-f", "f32le",
                "-",
            ],
            capture_output=True,
            check=False,
        )
        if proc.returncode != 0:
            stderr = proc.stderr.decode(errors="replace").strip()
            raise RuntimeError(f"ffmpeg decode failed: {stderr or 'unknown error'}")
        if not proc.stdout:
            raise RuntimeError("ffmpeg produced no audio (empty or unreadable file)")

        samples = torch.frombuffer(proc.stdout, dtype=torch.float32).clone()
        waveform = samples.unsqueeze(0)
        return waveform, 16000

    def diarize(self, audio_path: str, num_speakers=None,
                min_speakers=None, max_speakers=None) -> dict:
        if self.pipeline is None:
            return {"success": False, "error": "Pipeline not loaded"}

        if not os.path.isfile(audio_path):
            return {"success": False, "error": f"Audio file not found: {audio_path}"}

        try:
            kwargs = {}
            if num_speakers is not None:
                kwargs["num_speakers"] = int(num_speakers)
            else:
                if min_speakers is not None:
                    kwargs["min_speakers"] = int(min_speakers)
                if max_speakers is not None:
                    kwargs["max_speakers"] = int(max_speakers)

            waveform, sample_rate = self._decode_to_mono_16k(audio_path)
            result = self.pipeline(
                {"waveform": waveform, "sample_rate": sample_rate},
                **kwargs,
            )

            # pyannote.audio 4.x returns DiarizeOutput; 3.x returns Annotation.
            # Prefer the exclusive (non-overlapping) variant — it aligns
            # cleanly with per-segment transcript timestamps.
            if hasattr(result, 'exclusive_speaker_diarization'):
                annotation = result.exclusive_speaker_diarization
            elif hasattr(result, 'speaker_diarization'):
                annotation = result.speaker_diarization
            else:
                annotation = result

            turns = []
            speakers_seen = set()
            for turn, _, speaker in annotation.itertracks(yield_label=True):
                turns.append({
                    "start": float(turn.start),
                    "end": float(turn.end),
                    "speaker": str(speaker),
                })
                speakers_seen.add(str(speaker))

            return {
                "success": True,
                "turns": turns,
                "num_speakers": len(speakers_seen),
            }
        except Exception as e:
            print(f"Diarization error: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return {"success": False, "error": str(e)}

    def send_response(self, response: dict):
        print(json.dumps(response), flush=True)

    def handle_request(self, line: str) -> dict:
        try:
            request = json.loads(line)
        except json.JSONDecodeError as e:
            return {"success": False, "error": f"Invalid JSON: {e}"}

        request_id = request.get("id", "unknown")

        if request.get("command") == "shutdown":
            self.running = False
            return {"id": request_id, "status": "shutdown"}

        audio_path = request.get("audio_path")
        if not audio_path:
            return {"id": request_id, "success": False, "error": "Missing audio_path"}

        result = self.diarize(
            audio_path,
            num_speakers=request.get("num_speakers"),
            min_speakers=request.get("min_speakers"),
            max_speakers=request.get("max_speakers"),
        )
        result["id"] = request_id
        return result

    def run(self):
        def handle_signal(signum, frame):
            print(f"Received signal {signum}, shutting down...", file=sys.stderr)
            self.running = False

        signal.signal(signal.SIGTERM, handle_signal)
        signal.signal(signal.SIGINT, handle_signal)

        if not self.load_model():
            sys.exit(1)

        self.send_response({"status": "ready"})

        while self.running:
            try:
                line = sys.stdin.readline()
                if not line:
                    print("stdin closed, shutting down...", file=sys.stderr)
                    break
                line = line.strip()
                if not line:
                    continue
                response = self.handle_request(line)
                self.send_response(response)
            except Exception as e:
                print(f"Unexpected error in main loop: {e}", file=sys.stderr)
                traceback.print_exc(file=sys.stderr)
                self.send_response({"success": False, "error": f"Daemon error: {e}"})

        print("Daemon shutdown complete", file=sys.stderr)


if __name__ == "__main__":
    DiarizationDaemon().run()
