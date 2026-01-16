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


class TTSDaemon:
    def __init__(self):
        self.tts = None
        self.running = True

    def load_model(self) -> bool:
        """Load the Kokoro TTS model. Returns True on success."""
        try:
            # Suppress spacy download messages by redirecting stdout temporarily
            import contextlib
            import io

            from kokoro import KokoroTTS
            print("Loading Kokoro TTS model...", file=sys.stderr)

            # Capture any stdout during model init (spacy downloads go to stdout)
            with contextlib.redirect_stdout(io.StringIO()):
                self.tts = KokoroTTS()

            print("Kokoro TTS model loaded successfully", file=sys.stderr)
            return True
        except ImportError as e:
            print(f"kokoro-tts-mlx not installed: {e}", file=sys.stderr)
            print("Install with: pip install git+https://github.com/flight505/kokoro_tts_mlx.git", file=sys.stderr)
            return False
        except Exception as e:
            print(f"Failed to load model: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return False

    def synthesize(self, text: str, voice: str, speed: float, output_path: str) -> dict:
        """Synthesize text to speech. Returns result dict."""
        if self.tts is None:
            return {"success": False, "error": "Model not loaded"}

        try:
            # Use generate() for maximum performance
            result = None
            for r in self.tts.generate(text, voice=voice, speed=speed):
                result = r

            if result is None:
                return {"success": False, "error": "No audio generated"}

            # Save to file
            self.tts.save(result.audio, output_path)

            return {
                "success": True,
                "output_path": output_path,
                "duration": result.duration_seconds if hasattr(result, 'duration_seconds') else 0,
            }
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

        result = self.synthesize(text, voice, speed, output_path)
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
