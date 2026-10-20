# Linux + NVIDIA (DGX Spark)

The same API, routes, demo page and voice-clone stores run on Linux with an
NVIDIA GPU. Only the model runtimes differ from macOS:

| Engine | macOS (Apple Silicon) | Linux + NVIDIA |
|---|---|---|
| Fish S2 Pro (`/fish-tts`) | 8-bit MLX community conversion | Fish's official release in a vLLM-Omni server |
| Fish Drama 3 (`/drama3-tts`) | drama3-mlx | Fish's official release (FP8 experts) in a vLLM-Omni server |
| Parakeet (`/transcribe`) | parakeet-mlx, batch + realtime | NVIDIA's checkpoint through transformers, **batch only** |
| Pocket TTS (`/pocket-tts`) | CPU | CPU |
| Kokoro, Qwen3-TTS/ASR, MOSS | MLX | not available |

Each engine picks its backend from the platform. `PARAKEET_BACKEND`
(`mlx`/`transformers`), `FISH_TTS_BACKEND` and `DRAMA3_TTS_BACKEND`
(`mlx`/`vllm-omni`) override that choice.

The Fish daemons keep running in the API container. `scripts/fish_omni_daemon.py`
subclasses the MLX daemons, so chunking, the clone store, the S2 runaway retry and
the Drama 3 stall re-sampling behave the same. It sends each chunk to the vLLM-Omni
server over HTTP on 127.0.0.1.

## Requirements

- Linux with an NVIDIA GPU, driver 580 or newer, Docker and the NVIDIA Container
  Toolkit (both ship with DGX OS)
- Memory: about 100 GB in use with every engine loaded. On a DGX Spark,
  Drama 3's two stages hold ~60 GB, S2's ~17 GB, Parakeet ~2 GB, plus each
  process's CPU-side memory. That leaves ~19 GB available.
- About 60 GB of disk for the weights and ~25 GB for the image

The image targets the DGX Spark's driver (`CUDA_DRIVER_VERSION` in
`docker/nvidia/Dockerfile`). On another machine, pass yours with
`--build-arg CUDA_DRIVER_VERSION=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader)`.

## Setup

```bash
git clone https://github.com/Sogni-AI/sogni-voice.git && cd sogni-voice

# Weights, at the revisions this setup was verified with
uvx --from 'huggingface_hub[hf_xet]' hf download fishaudio/s2-pro \
  --revision 1de9996b6be38b745688de084d87a5633f714e4e --local-dir checkpoints/s2-pro
uvx --from 'huggingface_hub[hf_xet]' hf download fishaudio/drama-3 \
  --revision b2b5ee998034b2975720906c815e7fb0e9f007bd --local-dir checkpoints/drama-3
uvx --from 'huggingface_hub[hf_xet]' hf download nvidia/parakeet-tdt-0.6b-v3 \
  --revision 541d1f99c6b0c3cd0b11a95167540bb8edefd82b --exclude '*.gguf' \
  --local-dir checkpoints/parakeet-tdt-0.6b-v3

mkdir -p fish_voice_clones
cp docker/nvidia/env.example .env   # then set AUTH_API_KEY (and HOST)

docker compose -f docker/nvidia/compose.yaml up -d --build
```

Compose starts Drama 3 first, then S2 once Drama 3 is healthy (each server sizes
its memory from what is free), then the API. Drama 3 takes about 10 minutes to
become healthy and S2 about 3: both read their weights and capture CUDA graphs.
Compilation results are cached in the `cache` volume. All services restart with
Docker after a reboot.

```bash
docker compose -f docker/nvidia/compose.yaml ps
docker compose -f docker/nvidia/compose.yaml logs -f api
curl http://localhost:3000/health
```

To update, `git pull` and run the same `up -d --build`. Because all three
services share the image, that restarts the model servers too, and Fish TTS is
unavailable for about 13 minutes. For a change that touches only the API or the Python
daemons, rebuild and restart just the API:
`docker compose -f docker/nvidia/compose.yaml up -d --build --no-deps api`.

The vLLM-Omni servers listen on 127.0.0.1 only (S2 on 8001, Drama 3 on 8002).
The API listens on `HOST:PORT` from `.env`. Clones live in `fish_voice_clones/`
and `pocket_voice_clones/` on the host, as on macOS. They are written by root
from inside the container.

## Measured on a DGX Spark (GB10, 128 GB)

These are single requests on an otherwise idle box, cloning one 20 s reference.
Time is wall-clock seconds per second of audio produced (lower is faster).

| Engine | 291 characters | 967 characters | Time per audio second |
|---|---|---|---|
| Fish Drama 3 | 13–14 s | 41–56 s | 0.83–0.91 |
| Fish S2 Pro (official bf16) | 31–34 s | 105 s | 2.07 |
| Fish S2 Pro, stage 0 in FP8 | 25–26 s | 83 s | 1.63 |

Through `/transcribe`, Parakeet returned a plain transcript of 477 s of audio
in 3.0–4.4 s, and 53 s in about 1.2 s. Asking for timestamps adds the token
timestamp decoding in transformers, which took ~11 s for the 477 s file. For
comparison, an idle M2 Ultra runs the 8-bit MLX S2 at about 0.74.

S2 is dense (4.6B parameters). It runs slower than real time on the Spark because its
memory bandwidth (273 GB/s) is about a third of an M2 Ultra's. Drama 3 activates
only ~3B of its 35B parameters per step, so it is the faster model here. To try
FP8 for S2, add `quantization: fp8` under stage 0 in `docker/nvidia/fish_s2.yaml`.
Judge the quality by ear before keeping it.

## Differences from macOS

- **No realtime transcription.** `WS /v1/realtime/transcription` needs
  parakeet-mlx's streaming context. Batch `/transcribe` keeps sentence and word
  timestamps. Sentences are grouped at sentence-ending punctuation, and long
  files are transcribed in `PARAKEET_CHUNK_DURATION` windows (default 120 s),
  each cut at a quiet point.
- **Drama 3 chunks do not share context.** drama3-mlx passes earlier chunks'
  audio as context so a long text keeps one delivery. vLLM-Omni takes one
  reference per request, so each chunk sees only the clone's reference. Fish S2
  works this way on both platforms.
- **Sampling defaults come from the server** except where the daemons set them
  (S2 temperature 0.7, Drama 3 temperature 1.0 / top-p 0.9).

## License

Fish S2 Pro is under the Fish Audio Research License (non-commercial). Drama 3
is under the Fish Audio Community License: commercial use only below USD 500k
annual revenue, and offering it as a hosted TTS or voice-cloning service needs a
separate license from Fish Audio. See [fish-s2-eval.md](fish-s2-eval.md) and
[fish-drama3.md](fish-drama3.md).
