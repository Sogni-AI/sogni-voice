#!/usr/bin/env python3
"""
Kokoro-MLX TTS Daemon

A persistent daemon that loads the Kokoro TTS model once and accepts
text-to-speech requests via stdin/stdout JSON-line protocol.

Protocol:
- Input (stdin): One JSON object per line
  {"id": "unique-request-id", "text": "Hello", "voice": "af_heart", "speed": 1.0, "output_path": "/tmp/out.wav"}

- Output (stdout): One JSON object per line
  Success: {"id": "unique-request-id", "success": true, "output_path": "/tmp/out.wav", "duration": 1.5}
  Error: {"id": "unique-request-id", "success": false, "error": "error message"}

- Special messages:
  Ready signal: {"status": "ready"}
  Shutdown ack: {"id": "...", "status": "shutdown"}
"""

import sys
import json
import signal
import traceback

# Ensure unbuffered output for reliable communication
sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)

# Local model path (relative to this script)
import os
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(SCRIPT_DIR, "..", "models", "kokoro-tts")
MODEL_REPO = "mlx-community/Kokoro-82M-bf16"
SAMPLE_RATE = 24000


class TTSDaemon:
    def __init__(self):
        self.model = None
        self.running = True

    def ensure_model_downloaded(self) -> bool:
        """Download the model if not present locally. Returns True on success."""
        if os.path.exists(MODEL_PATH) and os.path.isdir(MODEL_PATH):
            # Check for required files
            required = ["config.json", "kokoro-v1_0.safetensors", "voices"]
            if all(os.path.exists(os.path.join(MODEL_PATH, f)) for f in required):
                return True

        print(f"Model not found at {MODEL_PATH}, downloading...", file=sys.stderr)
        try:
            from huggingface_hub import snapshot_download
            os.makedirs(MODEL_PATH, exist_ok=True)
            snapshot_download(
                MODEL_REPO,
                local_dir=MODEL_PATH,
            )
            print("Model downloaded successfully", file=sys.stderr)
            return True
        except Exception as e:
            print(f"Failed to download model: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return False

    def load_model(self) -> bool:
        """Load the Kokoro TTS model. Returns True on success."""
        try:
            # Ensure model is downloaded
            if not self.ensure_model_downloaded():
                return False

            print("Loading Kokoro TTS model...", file=sys.stderr)

            # Use mlx_audio's load_model utility which properly initializes weights
            from mlx_audio.tts.utils import load_model

            # Load from local path - no network access needed
            self.model = load_model(MODEL_PATH)

            print("Kokoro TTS model loaded successfully", file=sys.stderr)
            return True
        except ImportError as e:
            print(f"mlx-audio not installed: {e}", file=sys.stderr)
            print("Install with: pip install mlx-audio", file=sys.stderr)
            return False
        except Exception as e:
            print(f"Failed to load model: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return False

    def _get_lang_code(self, voice: str) -> str:
        """Get language code from voice prefix."""
        if voice.startswith(('af_', 'am_')):
            return 'a'  # American English
        elif voice.startswith(('bf_', 'bm_')):
            return 'b'  # British English
        elif voice.startswith(('jf_', 'jm_')):
            return 'j'  # Japanese
        elif voice.startswith(('zf_', 'zm_')):
            return 'z'  # Chinese
        return 'a'  # Default to American English

    def synthesize(self, text: str, voice: str, speed: float, output_path: str, timestamps: bool = False) -> dict:
        """Synthesize text to speech. Returns result dict with optional word timestamps."""
        if self.model is None:
            return {"success": False, "error": "Model not loaded"}

        try:
            import mlx.core as mx
            import numpy as np
            import soundfile as sf

            lang_code = self._get_lang_code(voice)
            word_timestamps = []

            if timestamps:
                # Use pipeline directly to get word-level timestamps
                pipeline = self.model._get_pipeline(lang_code)
                audio_segments = []

                for result in pipeline(text, voice=voice, speed=speed):
                    # Collect timestamps from tokens
                    if result.tokens:
                        for token in result.tokens:
                            word_timestamps.append({
                                "word": token.text,
                                "start": round(token.start_ts, 3),
                                "end": round(token.end_ts, 3),
                            })

                    # Collect audio
                    if result.output and result.output.audio is not None:
                        mx.eval(result.output.audio)
                        audio_segments.append(np.array(result.output.audio))

                if not audio_segments:
                    return {"success": False, "error": "No audio generated"}

                # Concatenate all audio segments
                audio_np = np.concatenate(audio_segments) if len(audio_segments) > 1 else audio_segments[0]
            else:
                # Use model.generate() for simpler path when timestamps not needed
                audio_segments = []
                for r in self.model.generate(text, voice=voice, speed=speed, lang_code=lang_code):
                    if r.audio is not None:
                        mx.eval(r.audio)
                        audio_segments.append(np.array(r.audio))

                if not audio_segments:
                    return {"success": False, "error": "No audio generated"}

                audio_np = np.concatenate(audio_segments) if len(audio_segments) > 1 else audio_segments[0]

            # Check for NaN values
            if np.isnan(audio_np).any():
                return {"success": False, "error": "Generated audio contains NaN values"}

            # Normalize if needed
            max_val = np.abs(audio_np).max()
            if max_val > 1.0:
                audio_np = audio_np / max_val

            # Save to file
            sf.write(output_path, audio_np, SAMPLE_RATE)

            # Calculate duration
            duration = len(audio_np) / SAMPLE_RATE

            response = {
                "success": True,
                "output_path": output_path,
                "duration": duration,
            }

            if timestamps:
                response["timestamps"] = word_timestamps

            return response
        except FileNotFoundError as e:
            return {"success": False, "error": f"Output path not accessible: {output_path}"}
        except Exception as e:
            print(f"TTS error: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return {"success": False, "error": str(e)}

    def send_response(self, response: dict):
        """Send JSON response to stdout."""
        print(json.dumps(response), flush=True)

    def handle_request(self, line: str) -> dict:
        """Parse and handle a request line. Returns response dict."""
        try:
            request = json.loads(line)
        except json.JSONDecodeError as e:
            return {"success": False, "error": f"Invalid JSON: {e}"}

        request_id = request.get("id", "unknown")

        # Handle shutdown command
        if request.get("command") == "shutdown":
            self.running = False
            return {"id": request_id, "status": "shutdown"}

        # Handle TTS request
        text = request.get("text")
        if not text:
            return {"id": request_id, "success": False, "error": "Missing text"}

        output_path = request.get("output_path")
        if not output_path:
            return {"id": request_id, "success": False, "error": "Missing output_path"}

        voice = request.get("voice", "af_heart")
        speed = request.get("speed", 1.0)
        timestamps = request.get("timestamps", False)

        result = self.synthesize(text, voice, speed, output_path, timestamps)
        result["id"] = request_id
        return result

    def run(self):
        """Main daemon loop."""
        # Setup signal handlers for graceful shutdown
        def handle_signal(signum, frame):
            print(f"Received signal {signum}, shutting down...", file=sys.stderr)
            self.running = False

        signal.signal(signal.SIGTERM, handle_signal)
        signal.signal(signal.SIGINT, handle_signal)

        # Load model
        if not self.load_model():
            self.send_response({"status": "error", "error": "Failed to load model"})
            sys.exit(1)

        # Signal ready
        self.send_response({"status": "ready"})

        # Main loop - read requests from stdin
        while self.running:
            try:
                line = sys.stdin.readline()
                if not line:  # EOF - parent process closed stdin
                    print("stdin closed, shutting down...", file=sys.stderr)
                    break

                line = line.strip()
                if not line:  # Empty line
                    continue

                response = self.handle_request(line)
                self.send_response(response)

            except Exception as e:
                print(f"Unexpected error in main loop: {e}", file=sys.stderr)
                traceback.print_exc(file=sys.stderr)
                self.send_response({
                    "success": False,
                    "error": f"Daemon error: {e}"
                })

        print("TTS daemon shutdown complete", file=sys.stderr)


if __name__ == "__main__":
    daemon = TTSDaemon()
    daemon.run()
