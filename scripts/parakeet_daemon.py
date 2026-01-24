#!/usr/bin/env python3
"""
Parakeet-MLX Transcription Daemon

A persistent daemon that loads the parakeet-mlx model once and accepts
transcription requests via stdin/stdout JSON-line protocol.

Protocol:
- Input (stdin): One JSON object per line
  {"id": "unique-request-id", "audio_path": "/path/to/audio.mp3"}

- Output (stdout): One JSON object per line
  Success: {"id": "unique-request-id", "success": true, "text": "transcription..."}
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


class ParakeetDaemon:
    def __init__(self):
        self.model = None
        self.running = True

    def load_model(self) -> bool:
        """Load the parakeet-mlx model. Returns True on success."""
        try:
            from parakeet_mlx import from_pretrained
            print("Loading parakeet-mlx model...", file=sys.stderr)
            self.model = from_pretrained("mlx-community/parakeet-tdt-0.6b-v3")
            print("Model loaded successfully", file=sys.stderr)
            return True
        except ImportError as e:
            print(f"parakeet-mlx not installed: {e}", file=sys.stderr)
            print("Install with: pip install parakeet-mlx", file=sys.stderr)
            return False
        except Exception as e:
            print(f"Failed to load model: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return False

    def transcribe(self, audio_path: str, timestamps: bool = False, word_timestamps: bool = False) -> dict:
        """Transcribe audio file. Returns result dict with optional timestamps."""
        if self.model is None:
            return {"success": False, "error": "Model not loaded"}

        try:
            result = self.model.transcribe(audio_path)

            # Handle different return formats from parakeet-mlx
            if hasattr(result, 'text'):
                text = result.text
            elif isinstance(result, dict):
                text = result.get('text', str(result))
            elif isinstance(result, str):
                text = result
            else:
                text = str(result)

            response = {"success": True, "text": text.strip()}

            # Extract timestamps if requested (word-level takes priority)
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
            return {"success": False, "error": f"Audio file not found: {audio_path}"}
        except Exception as e:
            print(f"Transcription error: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return {"success": False, "error": str(e)}

    def _extract_timestamps(self, result) -> list:
        """Extract sentence-level timestamp segments from transcription result."""
        segments = []

        try:
            # parakeet-mlx returns AlignedResult with sentences attribute
            if hasattr(result, 'sentences'):
                for sentence in result.sentences:
                    segments.append({
                        "start": sentence.start,
                        "end": sentence.end,
                        "text": sentence.text.strip()
                    })
        except Exception as e:
            print(f"Error extracting timestamps: {e}", file=sys.stderr)

        return segments

    def _extract_word_timestamps(self, result) -> list:
        """Extract word-level timestamp segments from transcription result."""
        segments = []

        try:
            # parakeet-mlx returns AlignedResult with words attribute
            if hasattr(result, 'words'):
                for word in result.words:
                    segments.append({
                        "start": word.start,
                        "end": word.end,
                        "text": word.text.strip()
                    })
        except Exception as e:
            print(f"Error extracting word timestamps: {e}", file=sys.stderr)

        return segments

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

        # Handle transcription request
        audio_path = request.get("audio_path")
        if not audio_path:
            return {"id": request_id, "success": False, "error": "Missing audio_path"}

        timestamps = request.get("timestamps", False)
        word_timestamps = request.get("word_timestamps", False)
        result = self.transcribe(audio_path, timestamps=timestamps, word_timestamps=word_timestamps)
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

        print("Daemon shutdown complete", file=sys.stderr)


if __name__ == "__main__":
    daemon = ParakeetDaemon()
    daemon.run()
