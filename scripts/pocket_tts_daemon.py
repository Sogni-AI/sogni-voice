#!/usr/bin/env python3
"""
Pocket TTS Daemon

A persistent daemon that loads the Kyutai Pocket TTS model once and accepts
text-to-speech requests via stdin/stdout JSON-line protocol.

Pocket TTS is a 100M-parameter, CPU-only, English-only TTS model with
voice cloning from audio files and ~200ms latency.

Protocol:
- Input (stdin): One JSON object per line with "type" field:
  {"id": "...", "type": "generate", "text": "Hello", "voice": "alba", "output_path": "/tmp/out.wav"}
  {"id": "...", "type": "create_voice_clone", "audio_path": "/tmp/ref.wav", "clone_id": "my_clone"}
  {"id": "...", "type": "generate_voice_clone", "text": "Hello", "clone_id": "my_clone", "output_path": "/tmp/out.wav"}
  {"id": "...", "type": "delete_voice_clone", "clone_id": "my_clone"}
  {"id": "...", "type": "list_voices"}

- Output (stdout): One JSON object per line
  Success: {"id": "...", "success": true, "output_path": "/tmp/out.wav", "duration": 1.5}
  Error: {"id": "...", "success": false, "error": "error message"}

- Special messages:
  Ready signal: {"status": "ready", "voices": ["alba", ...]}
  Shutdown ack: {"id": "...", "status": "shutdown"}
"""

import sys
import json
import signal
import traceback
import os
import shutil

# Ensure unbuffered output for reliable communication
sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
VOICE_CLONES_DIR = os.environ.get('POCKET_TTS_VOICE_CLONES_DIR', os.path.join(SCRIPT_DIR, "..", "pocket_voice_clones"))

BUILT_IN_VOICES = ['alba', 'marius', 'javert', 'jean', 'fantine', 'cosette', 'eponine', 'azelma']
DEFAULT_SAMPLE_RATE = 24000


class PocketTTSDaemon:
    def __init__(self):
        self.model = None
        self.running = True
        self.voice_states = {}  # cached voice states (built-in + cloned)

        # Ensure voice clones directory exists
        os.makedirs(VOICE_CLONES_DIR, exist_ok=True)

    @staticmethod
    def _validate_clone_id(clone_id):
        """Validate clone_id to prevent path traversal."""
        if not clone_id or '/' in clone_id or '\\' in clone_id or '..' in clone_id:
            return False
        return True

    def load_model(self) -> bool:
        """Load the Pocket TTS model. Returns True on success."""
        try:
            print("Loading Pocket TTS model...", file=sys.stderr)

            from pocket_tts import TTSModel
            self.model = TTSModel.load_model()

            print("Pocket TTS model loaded successfully", file=sys.stderr)

            self.sample_rate = self.model.sample_rate or DEFAULT_SAMPLE_RATE

            # Pre-cache built-in voice states
            for voice in BUILT_IN_VOICES:
                try:
                    state = self.model.get_state_for_audio_prompt(voice)
                    self.voice_states[voice] = state
                except Exception as e:
                    print(f"[warning] Failed to cache built-in voice '{voice}': {e}", file=sys.stderr)

            # Load any saved voice clones from disk
            self._load_saved_clones()

            return True
        except ImportError as e:
            print(f"pocket-tts not installed: {e}", file=sys.stderr)
            print("Install with: pip install pocket-tts", file=sys.stderr)
            return False
        except Exception as e:
            print(f"Failed to load model: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return False

    def _load_saved_clones(self):
        """Load saved voice clone states from disk."""
        if not os.path.exists(VOICE_CLONES_DIR):
            return

        for name in os.listdir(VOICE_CLONES_DIR):
            clone_dir = os.path.join(VOICE_CLONES_DIR, name)
            if not os.path.isdir(clone_dir):
                continue
            ref_audio_path = os.path.join(clone_dir, "reference.wav")
            if os.path.exists(ref_audio_path):
                try:
                    state = self.model.get_state_for_audio_prompt(ref_audio_path)
                    self.voice_states[f"clone:{name}"] = state
                    print(f"[load] Loaded voice clone '{name}' from disk", file=sys.stderr)
                except Exception as e:
                    print(f"[warning] Failed to load voice clone '{name}': {e}", file=sys.stderr)

    def generate(self, text: str, voice: str, output_path: str) -> dict:
        """Generate speech from text using a built-in voice."""
        if self.model is None:
            return {"success": False, "error": "Model not loaded"}

        try:
            import scipy.io.wavfile
            import numpy as np

            state = self.voice_states.get(voice)
            if state is None:
                if voice in BUILT_IN_VOICES:
                    state = self.model.get_state_for_audio_prompt(voice)
                    self.voice_states[voice] = state
                else:
                    return {"success": False, "error": f"Voice '{voice}' not found"}

            audio = self.model.generate_audio(state, text)

            # Convert to numpy array if needed
            if hasattr(audio, 'numpy'):
                audio_np = audio.numpy()
            elif hasattr(audio, 'cpu'):
                audio_np = audio.cpu().numpy()
            else:
                audio_np = np.array(audio)

            # Ensure 1D
            if audio_np.ndim > 1:
                audio_np = audio_np.squeeze()

            # Normalize to int16 for WAV
            if audio_np.dtype in (np.float32, np.float64):
                audio_np = np.clip(audio_np, -1.0, 1.0)
                audio_np = (audio_np * 32767).astype(np.int16)

            scipy.io.wavfile.write(output_path, self.sample_rate, audio_np)
            duration = len(audio_np) / self.sample_rate

            return {
                "success": True,
                "output_path": output_path,
                "duration": duration,
            }
        except Exception as e:
            print(f"TTS generation error: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return {"success": False, "error": str(e)}

    def generate_with_clone(self, text: str, clone_id: str, output_path: str) -> dict:
        """Generate speech using a cloned voice."""
        if self.model is None:
            return {"success": False, "error": "Model not loaded"}

        if not self._validate_clone_id(clone_id):
            return {"success": False, "error": "Invalid clone_id"}

        cache_key = f"clone:{clone_id}"
        state = self.voice_states.get(cache_key)

        if state is None:
            # Try loading from disk
            ref_audio_path = os.path.join(VOICE_CLONES_DIR, clone_id, "reference.wav")
            if not os.path.exists(ref_audio_path):
                return {"success": False, "error": f"Voice clone '{clone_id}' not found"}
            try:
                state = self.model.get_state_for_audio_prompt(ref_audio_path)
                self.voice_states[cache_key] = state
            except Exception as e:
                return {"success": False, "error": f"Failed to load voice clone: {e}"}

        try:
            import scipy.io.wavfile
            import numpy as np

            audio = self.model.generate_audio(state, text)

            if hasattr(audio, 'numpy'):
                audio_np = audio.numpy()
            elif hasattr(audio, 'cpu'):
                audio_np = audio.cpu().numpy()
            else:
                audio_np = np.array(audio)

            if audio_np.ndim > 1:
                audio_np = audio_np.squeeze()

            if audio_np.dtype in (np.float32, np.float64):
                audio_np = np.clip(audio_np, -1.0, 1.0)
                audio_np = (audio_np * 32767).astype(np.int16)

            scipy.io.wavfile.write(output_path, self.sample_rate, audio_np)
            duration = len(audio_np) / self.sample_rate

            return {
                "success": True,
                "output_path": output_path,
                "duration": duration,
            }
        except Exception as e:
            print(f"Voice clone generation error: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return {"success": False, "error": str(e)}

    def create_voice_clone(self, audio_path: str, clone_id: str) -> dict:
        """Create a voice clone from reference audio."""
        if self.model is None:
            return {"success": False, "error": "Model not loaded"}

        if not self._validate_clone_id(clone_id):
            return {"success": False, "error": "Invalid clone_id"}

        try:
            import time

            print(f"[create_voice_clone] Creating clone '{clone_id}' from {audio_path}", file=sys.stderr)

            clone_dir = os.path.join(VOICE_CLONES_DIR, clone_id)
            os.makedirs(clone_dir, exist_ok=True)

            start_time = time.time()
            # Copy reference audio to clone directory for future state extraction
            import shutil as _shutil
            ref_audio_path = os.path.join(clone_dir, "reference.wav")
            _shutil.copy2(audio_path, ref_audio_path)

            # Extract voice state from audio and cache it
            state = self.model.get_state_for_audio_prompt(ref_audio_path)
            elapsed = time.time() - start_time
            print(f"[create_voice_clone] State extracted in {elapsed:.2f}s", file=sys.stderr)

            # Save metadata
            metadata = {"clone_id": clone_id, "source_audio": os.path.basename(audio_path)}
            metadata_path = os.path.join(clone_dir, "metadata.json")
            with open(metadata_path, 'w') as f:
                json.dump(metadata, f)

            # Cache it
            self.voice_states[f"clone:{clone_id}"] = state

            print(f"[create_voice_clone] Saved to {clone_dir}", file=sys.stderr)

            return {
                "success": True,
                "clone_id": clone_id,
            }
        except Exception as e:
            print(f"Voice clone creation error: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return {"success": False, "error": str(e)}

    def delete_voice_clone(self, clone_id: str) -> dict:
        """Delete a voice clone."""
        if not self._validate_clone_id(clone_id):
            return {"success": False, "error": "Invalid clone_id"}

        try:
            cache_key = f"clone:{clone_id}"
            if cache_key in self.voice_states:
                del self.voice_states[cache_key]

            clone_dir = os.path.join(VOICE_CLONES_DIR, clone_id)
            if os.path.exists(clone_dir):
                shutil.rmtree(clone_dir)
                return {"success": True, "clone_id": clone_id}
            else:
                return {"success": False, "error": f"Voice clone '{clone_id}' not found"}
        except Exception as e:
            print(f"Voice clone deletion error: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return {"success": False, "error": str(e)}

    def list_voices(self) -> dict:
        """List all available voices (built-in + clones)."""
        try:
            clones = []
            if os.path.exists(VOICE_CLONES_DIR):
                for name in os.listdir(VOICE_CLONES_DIR):
                    clone_dir = os.path.join(VOICE_CLONES_DIR, name)
                    if os.path.isdir(clone_dir) and os.path.exists(os.path.join(clone_dir, "reference.wav")):
                        clones.append(name)

            return {
                "success": True,
                "voices": BUILT_IN_VOICES,
                "clones": clones,
            }
        except Exception as e:
            print(f"List voices error: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return {"success": False, "error": str(e)}

    def send_response(self, response: dict):
        """Send JSON response to stdout."""
        print(json.dumps(response), flush=True)

    def handle_request(self, line: str) -> dict:
        """Parse and handle a request line."""
        try:
            request = json.loads(line)
        except json.JSONDecodeError as e:
            return {"success": False, "error": f"Invalid JSON: {e}"}

        request_id = request.get("id", "unknown")
        request_type = request.get("type", "generate")

        # Handle shutdown command
        if request.get("command") == "shutdown":
            self.running = False
            return {"id": request_id, "status": "shutdown"}

        if request_type == "generate":
            text = request.get("text")
            if not text:
                return {"id": request_id, "success": False, "error": "Missing text"}

            output_path = request.get("output_path")
            if not output_path:
                return {"id": request_id, "success": False, "error": "Missing output_path"}

            voice = request.get("voice", "alba")

            result = self.generate(text, voice, output_path)
            result["id"] = request_id
            return result

        elif request_type == "create_voice_clone":
            audio_path = request.get("audio_path")
            if not audio_path:
                return {"id": request_id, "success": False, "error": "Missing audio_path"}

            clone_id = request.get("clone_id")
            if not clone_id:
                return {"id": request_id, "success": False, "error": "Missing clone_id"}

            result = self.create_voice_clone(audio_path, clone_id)
            result["id"] = request_id
            return result

        elif request_type == "generate_voice_clone":
            text = request.get("text")
            if not text:
                return {"id": request_id, "success": False, "error": "Missing text"}

            output_path = request.get("output_path")
            if not output_path:
                return {"id": request_id, "success": False, "error": "Missing output_path"}

            clone_id = request.get("clone_id")
            if not clone_id:
                return {"id": request_id, "success": False, "error": "Missing clone_id"}

            result = self.generate_with_clone(text, clone_id, output_path)
            result["id"] = request_id
            return result

        elif request_type == "delete_voice_clone":
            clone_id = request.get("clone_id")
            if not clone_id:
                return {"id": request_id, "success": False, "error": "Missing clone_id"}

            result = self.delete_voice_clone(clone_id)
            result["id"] = request_id
            return result

        elif request_type == "list_voices":
            result = self.list_voices()
            result["id"] = request_id
            return result

        else:
            return {"id": request_id, "success": False, "error": f"Unknown request type: {request_type}"}

    def run(self):
        """Main daemon loop."""
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
        self.send_response({
            "status": "ready",
            "voices": BUILT_IN_VOICES,
            "features": ["tts", "voice_cloning"],
        })

        # Main loop
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
                self.send_response({
                    "success": False,
                    "error": f"Daemon error: {e}"
                })

        print("Pocket TTS daemon shutdown complete", file=sys.stderr)


if __name__ == "__main__":
    daemon = PocketTTSDaemon()
    daemon.run()
