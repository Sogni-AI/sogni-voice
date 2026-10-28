#!/usr/bin/env python3
"""Nemotron 3.5 Transcribe: native MLX on Mac, NeMo/vLLM on NVIDIA."""

import base64
from contextlib import redirect_stdout
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import traceback
from urllib.request import Request, urlopen
import wave

MODEL_ID = os.environ.get("NEMOTRON_MODEL_ID", "nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B")
REVISION = os.environ.get("NEMOTRON_MODEL_REVISION", "a188fff16c4f129a046788c2ad69e6198079a102")
ASR_PROMPT = "Transcribe the following audio."
SPEAKER_PROMPT = (
    "Transcribe this audio with punctuation and capitalization. "
    "Include all spoken words and verbal fillers. "
    "Write numbers in their standard written form. "
    "Put speaker tags <spk:0> <spk:1> <spk:2> <spk:3> on the transcription."
)


def build_prompt(request):
    prompt = request.get("prompt") or (SPEAKER_PROMPT if request.get("diarize") else ASR_PROMPT)
    if request.get("prompt") and request.get("diarize"):
        prompt += " Put speaker tags <spk:0> <spk:1> <spk:2> <spk:3> on the transcription."
    if request.get("hotwords"):
        prompt += f" Context terms: {request['hotwords']}."
    return prompt


def speaker_segments(text):
    matches = list(re.finditer(r"<spk:(\d+)>", text))
    return [
        {"speaker": f"S{int(match[1]) + 1:02d}",
         "text": text[match.end():matches[i + 1].start() if i + 1 < len(matches) else len(text)].strip()}
        for i, match in enumerate(matches)
    ]


def sentence_segments(words):
    sentences = []
    current = None
    for word in words:
        if current is None or current.get("speaker") != word.get("speaker"):
            current = dict(word)
            sentences.append(current)
        else:
            current["text"] += " " + word["text"]
            current["end"] = word["end"]
        if re.search(r"[.!?。！？][\"'”’]*$", word["text"]):
            current = None
    return sentences


def load_mlx_model():
    import mlx.core as mx
    import mlx.nn as nn
    from huggingface_hub import snapshot_download
    from mlx_audio.convert import build_quant_predicate
    from mlx_audio.stt.models.nemotron_transcribe.config import ModelConfig
    from mlx_audio.stt.models.nemotron_transcribe.nemotron_transcribe import Model
    from mlx_audio.utils import apply_quantization, load_weights

    local_path = os.environ.get("NEMOTRON_MODEL_PATH")
    path = Path(local_path).expanduser() if local_path else Path(snapshot_download(
        MODEL_ID, revision=REVISION, allow_patterns=["*.json", "*.safetensors"]))
    config = json.loads((path / "config.json").read_text())
    model = Model(ModelConfig.from_dict(config))
    # The final release adds a bundled CTC alignment head. The pinned MLX port
    # implements ASR/speaker decoding only. Keep strict loading for every weight
    # it does use, and omit exactly the separate head (NeMo uses the same prefix).
    weights = Model.sanitize({
        key: value for key, value in load_weights(path).items()
        if not key.startswith("ctc_timestamp.")
    })
    apply_quantization(model, config, weights, model.model_quant_predicate)
    model.load_weights(list(weights.items()), strict=True)
    del weights
    if not config.get("quantization"):
        quantizable = build_quant_predicate(model)
        # The port's sanitizer explicitly keeps MoE routing in FP32. Preserve
        # those small gate matrices when quantizing the language-model weights.
        nn.quantize(model, bits=int(os.environ.get("NEMOTRON_MLX_BITS", "4")),
                    group_size=64, class_predicate=lambda path, layer:
                    quantizable(path, layer) and not path.endswith(".gate"))
    mx.eval(model.parameters())
    model.eval()
    return Model.post_load_hook(model, path)


class NemotronDaemon:
    def __init__(self):
        self.backend = os.environ.get("NEMOTRON_BACKEND", "mlx" if sys.platform == "darwin" else "vllm")
        self.url = os.environ.get("NEMOTRON_URL", "http://127.0.0.1:8003").rstrip("/")
        self.timeout = int(os.environ.get("NEMOTRON_TIMEOUT", "3600000")) / 1000
        self.model = None

    def initialize(self):
        if self.backend == "mlx":
            self.model = load_mlx_model()
        elif self.backend == "vllm":
            with urlopen(self.url + "/v1/models", timeout=10) as response:
                models = json.load(response)["data"]
            if MODEL_ID not in [model["id"] for model in models]:
                raise RuntimeError(f"Nemotron server does not serve {MODEL_ID}")
        else:
            raise ValueError(f"Unsupported Nemotron backend: {self.backend}")

    def transcribe(self, request):
        want_times = request.get("timestamps") or request.get("word_timestamps")
        if want_times and self.backend == "mlx":
            raise ValueError("Nemotron MLX supports text and speaker labels without timestamps")
        start = time.monotonic()
        with tempfile.TemporaryDirectory(prefix="nemotron-") as directory:
            audio = Path(directory) / "audio.wav"
            # Decode at most one hour plus one second so the model's documented
            # limit is enforced even for a small compressed upload of long audio.
            decoded = subprocess.run([
                "ffmpeg", "-nostdin", "-y", "-v", "error", "-i", request["audio_path"],
                "-t", "3601", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(audio),
            ], capture_output=True, timeout=120)
            if decoded.returncode:
                raise ValueError("Cannot decode the uploaded audio: " + decoded.stderr.decode(errors="replace"))
            with wave.open(str(audio), "rb") as wav:
                duration = wav.getnframes() / wav.getframerate()
            if not 0 < duration <= 3600:
                raise ValueError("Nemotron requires nonempty audio up to 60 minutes")
            max_tokens = request.get("max_new_tokens") or int(os.environ.get("NEMOTRON_MAX_NEW_TOKENS", "16384"))
            prompt = build_prompt(request)
            if self.backend == "mlx":
                result = self.model.generate(str(audio), prompt=prompt, max_tokens=max_tokens,
                                             temperature=0, enable_thinking=False, verbose=False)
                text = result.text
                finish_reason = "length" if result.generation_tokens >= max_tokens else "stop"
                output = {"generatedTokens": result.generation_tokens}
                timestamps = None
            else:
                body = {
                    "model": MODEL_ID,
                    "messages": [{"role": "user", "content": [
                        {"type": "text", "text": prompt},
                        {"type": "audio_url", "audio_url": {
                            "url": "data:audio/wav;base64," + base64.b64encode(audio.read_bytes()).decode()}},
                    ]}],
                    "temperature": 0, "top_p": 1.0, "seed": 0, "max_tokens": max_tokens,
                    "chat_template_kwargs": {"enable_thinking": False},
                    "skip_special_tokens": False, "spaces_between_special_tokens": False,
                }
                if want_times:
                    body["mm_processor_kwargs"] = {"capture_ctc_timestamps": True}
                call = Request(self.url + "/v1/chat/completions", data=json.dumps(body).encode(),
                               headers={"Content-Type": "application/json"})
                with urlopen(call, timeout=self.timeout) as response:
                    result = json.load(response)
                choice = result["choices"][0]
                text = choice["message"]["content"]
                finish_reason = choice["finish_reason"]
                output = {"generatedTokens": result.get("usage", {}).get("completion_tokens")}
                timestamps = None
                if want_times:
                    alignment = result["ctc_timestamps"]
                    if alignment["error"]:
                        raise RuntimeError("Nemotron timestamp alignment failed: " + alignment["error"])
                    timestamps = []
                    for word in alignment["words"]:
                        item = {"text": word["word"], "start": word["start"], "end": word["end"]}
                        if request.get("diarize") and word.get("speaker") is not None:
                            tag = re.search(r"\d+", str(word["speaker"]))
                            if tag:
                                item["speaker"] = f"S{int(tag[0]) + 1:02d}"
                        timestamps.append(item)
                    if not request.get("word_timestamps"):
                        timestamps = sentence_segments(timestamps)
        elapsed = time.monotonic() - start
        return {
            "text": text.strip(), "segments": speaker_segments(text),
            "finish_reason": finish_reason,
            **({"timestamps": timestamps} if timestamps is not None else {}),
            "metrics": {"audioSeconds": duration, "elapsedSeconds": round(elapsed, 3),
                        "realTimeFactor": round(elapsed / duration, 4), **output},
        }


def main():
    def send(response):
        print(json.dumps(response, ensure_ascii=False), flush=True)

    daemon = NemotronDaemon()
    try:
        with redirect_stdout(sys.stderr):
            daemon.initialize()
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        send({"status": "error", "error": str(error)})
        return 1
    send({"status": "ready", "model": MODEL_ID, "backend": daemon.backend})
    for line in sys.stdin:
        request = json.loads(line)
        if request.get("command") == "shutdown":
            break
        try:
            with redirect_stdout(sys.stderr):
                result = daemon.transcribe(request)
            send({"id": request["id"], "success": True, **result})
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            send({"id": request["id"], "success": False, "error": str(error),
                  "invalid_input": isinstance(error, ValueError)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
