#!/usr/bin/env python3
"""Parakeet TDT batch transcription for Linux + NVIDIA through Hugging Face transformers.

Same stdin/stdout JSON-line protocol as scripts/parakeet_daemon.py, whose
ParakeetDaemon this subclasses: the model is wrapped in an adapter shaped like a
parakeet-mlx result (text, tokens, sentences), so batch transcription and the
sentence/word timestamp extraction run unchanged. Runs NVIDIA's own checkpoint
(nvidia/parakeet-tdt-0.6b-v3, the model parakeet-mlx converts).

Realtime streaming is not available on this backend; stream requests fail and
the ready message reports realtime: false.
"""

import os
import subprocess
import sys
import traceback
from functools import cached_property
from types import SimpleNamespace

from parakeet_daemon import MODEL_ID, MODEL_REVISION, ParakeetDaemon

SENTENCE_END = (".", "?", "!", "…", "。", "？", "！")
# A long recording is transcribed in windows of PARAKEET_CHUNK_DURATION seconds,
# each cut at the quietest 100 ms near its end so the cut rarely splits a word.
CUT_SEARCH_SECONDS = 10.0


def quietest_cut(audio, start: int, end: int, sample_rate: int) -> int:
    """Sample index of the quietest 100 ms window in the last seconds before ``end``."""
    import numpy as np

    window = sample_rate // 10
    search_start = max(start + window, end - int(CUT_SEARCH_SECONDS * sample_rate))
    span = audio[search_start:end]
    count = len(span) // window
    if count < 2:
        return end
    energy = (span[: count * window].reshape(count, window) ** 2).mean(axis=1)
    return search_start + int(np.argmin(energy)) * window + window // 2


def sentences_from_tokens(tokens) -> list:
    """Group timestamped tokens into sentences at sentence-ending punctuation."""
    sentences, current = [], []
    for token in tokens:
        current.append(token)
        if token.text.rstrip().endswith(SENTENCE_END):
            sentences.append(current)
            current = []
    if current:
        sentences.append(current)
    return [
        SimpleNamespace(
            text="".join(token.text for token in group).strip(),
            start=group[0].start,
            end=group[-1].end,
        )
        for group in sentences
    ]


class TransformersParakeet:
    """parakeet-mlx's model.transcribe() on top of transformers' ParakeetForTDT."""

    def __init__(self, model_id: str, revision: str):
        import numpy as np
        import torch
        from transformers import AutoProcessor, ParakeetForTDT

        self._np = np
        self._torch = torch
        self.device = os.environ.get("PARAKEET_DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")
        self.dtype = torch.bfloat16 if self.device == "cuda" else torch.float32
        self.processor = AutoProcessor.from_pretrained(model_id, revision=revision)
        self.model = (
            ParakeetForTDT.from_pretrained(model_id, revision=revision, dtype=self.dtype)
            .to(self.device)
            .eval()
        )
        self.sample_rate = int(self.processor.feature_extractor.sampling_rate)

    def load_audio(self, audio_path: str):
        """Decode any ffmpeg-readable file to mono float32 at the model's rate."""
        if not os.path.exists(audio_path):
            raise FileNotFoundError(audio_path)
        decoded = subprocess.run(
            [
                "ffmpeg", "-nostdin", "-v", "error", "-i", audio_path,
                "-f", "f32le", "-ac", "1", "-ar", str(self.sample_rate), "-",
            ],
            capture_output=True,
            check=False,
        )
        if decoded.returncode != 0:
            raise RuntimeError(
                "ffmpeg could not decode the audio: "
                + decoded.stderr.decode("utf-8", "replace").strip()[-300:]
            )
        return self._np.frombuffer(decoded.stdout, dtype="<f4")

    def transcribe(self, audio_path: str, chunk_duration: float = 120.0):
        audio = self.load_audio(audio_path)
        window = max(int(chunk_duration * self.sample_rate), self.sample_rate)
        windows = []
        start = 0
        while start < len(audio):
            end = len(audio) if len(audio) - start <= window else quietest_cut(
                audio, start, start + window, self.sample_rate
            )
            inputs = self.processor(audio[start:end], sampling_rate=self.sample_rate, return_tensors="pt")
            with self._torch.inference_mode():
                output = self.model.generate(
                    **inputs.to(self.device, self.dtype), return_dict_in_generate=True
                )
            windows.append((output, start / self.sample_rate))
            start = end
        return TranscriptionResult(self.processor, windows)


class TranscriptionResult:
    """parakeet-mlx's result shape. Token timestamps cost transformers several
    seconds per few minutes of audio, so they are decoded only when read (a
    request asked for timestamps)."""

    def __init__(self, processor, windows):
        self._processor = processor
        self._windows = windows
        texts = (
            processor.batch_decode(output.sequences, skip_special_tokens=True)[0].strip()
            for output, _offset in windows
        )
        self.text = " ".join(text for text in texts if text)

    @cached_property
    def tokens(self) -> list:
        tokens = []
        for output, offset in self._windows:
            _texts, timestamps = self._processor.decode(
                output.sequences, durations=output.durations, skip_special_tokens=True
            )
            window_tokens = [
                SimpleNamespace(
                    text=entry["token"],
                    start=round(float(entry["start"]) + offset, 3),
                    end=round(float(entry["end"]) + offset, 3),
                )
                for entry in timestamps[0]
            ]
            # Each window decodes from a fresh stream, so its first token has no
            # leading space; without one it would join the previous window's last word.
            if tokens and window_tokens and not window_tokens[0].text.startswith(" "):
                window_tokens[0].text = " " + window_tokens[0].text
            tokens.extend(window_tokens)
        return tokens

    @cached_property
    def sentences(self) -> list:
        return sentences_from_tokens(self.tokens)


class ParakeetTransformersDaemon(ParakeetDaemon):
    def load_model(self) -> bool:
        try:
            print(f"Loading {MODEL_ID}@{MODEL_REVISION} with transformers...", file=sys.stderr)
            self.model = TransformersParakeet(MODEL_ID, MODEL_REVISION)
            self.sample_rate = self.model.sample_rate
            print(f"Parakeet model ready on {self.model.device}", file=sys.stderr)
            return True
        except Exception as exc:
            print(f"Failed to load Parakeet model: {exc}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            self.send_response({"status": "error", "error": str(exc)})
            return False

    def start_stream(self, session_id: str) -> dict:
        return {
            "success": False,
            "error": "Realtime transcription is not available with the transformers backend",
        }

    def ready_info(self) -> dict:
        import transformers

        info = super().ready_info()
        info.pop("parakeet_mlx_version", None)
        info["transformers_version"] = transformers.__version__
        info["realtime"] = False
        return info


if __name__ == "__main__":
    ParakeetTransformersDaemon().run()
