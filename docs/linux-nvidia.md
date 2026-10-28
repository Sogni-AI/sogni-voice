# Linux + NVIDIA (DGX Spark)

The same API, routes, demo page and voice-clone stores run on Linux with an
NVIDIA GPU. Only the model runtimes differ from macOS:

| Engine | macOS (Apple Silicon) | Linux + NVIDIA |
|---|---|---|
| Fish S2 Pro (`/fish-tts`) | 8-bit MLX community conversion | Fish's official release in a vLLM-Omni server |
| Fish Drama 3 (`/drama3-tts`) | drama3-mlx | Fish's official release (FP8 experts) in a vLLM-Omni server |
| Parakeet (`/transcribe`) | parakeet-mlx, batch + realtime | NVIDIA's checkpoint through transformers, **batch only** |
| Nemotron 3.5 (`engine=nemotron`) | native MLX, text + speaker labels | isolated NeMo/vLLM, text + speakers + CTC timings; [setup](nemotron.md) |
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

On a DGX Spark (GB10), also keep 2 GiB of memory free. Once the page cache fills
RAM (after the ~50 GB of weights are read), the NVIDIA driver can fail to allocate a
new process's GPU context with `NV_ERR_NO_MEMORY`; it doesn't reclaim the cache.
That shows up as `CUDA error: out of memory` when a vLLM stage or Parakeet starts,
with plenty of memory "available":

```bash
echo 'vm.min_free_kbytes = 2097152' | sudo tee /etc/sysctl.d/90-gb10-cuda-free-memory.conf
sudo sysctl -p /etc/sysctl.d/90-gb10-cuda-free-memory.conf
```

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
Docker after a reboot. S2 still waits for Drama 3, and the API's Fish daemons
wait up to 30 minutes for their servers; Fish requests made in the meantime wait for them.

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
- **Drama 3 chunks do not share context.** Text is validated and split exactly as
  drama3-mlx does it (`scripts/drama3_text.py`: chunks of about 300 bytes with at
  most three speakers, joined without pauses). drama3-mlx also passes earlier
  chunks' audio as context so a long text keeps one delivery. vLLM-Omni takes
  one reference per request, so each chunk sees only the clone's reference.
  Fish S2 works this way on both platforms.
- **Sampling** matches the MLX daemons: S2 at temperature 0.7, Drama 3 at
  temperature 1.0 / top-p 0.9; other settings come from the server's deploy
  config.

## Drama 3 NVFP4 on DGX Spark

Built with Fish Audio. The community
[NVFP4 pruned checkpoint](https://huggingface.co/plotarmordev/drama-3-NVFP4-Pruned)
uses 7,369 routed experts, compared with the original 10,240. It requires the
author's TensorFold fork; selecting this checkpoint in vLLM-Omni will not load it.
The [author's recipe](https://github.com/plotarmordev/drama-tensorfold) and
[engine guide](https://github.com/plotarmordev/TensorFold/blob/b1f4b9b4830c9bd43bf7c432cffe7dea21313537/docs/drama-3-nvfp4.md)
document the measured setup. This integration pins:

| Component | Version |
|---|---|
| NVFP4 checkpoint | `494db08481db952f834b2241bce63fb3dfa72554` |
| TensorFold `drama-nvfp4` | `b1f4b9b4830c9bd43bf7c432cffe7dea21313537` |
| Zig | `0.17.0` (download SHA-256 checked in the Dockerfile) |
| CUDA toolkit / GPU target | `13.0.1` / GB10 `sm_121` |
| Guidance | gamma `1.5`, batched; active only with a reference voice |

Keep the original model and capture reference outputs before changing servers.
Download into its own directory; do not replace `checkpoints/drama-3`:

```bash
uvx --from 'huggingface_hub[hf_xet]' hf download plotarmordev/drama-3-NVFP4-Pruned \
  --revision 494db08481db952f834b2241bce63fb3dfa72554 \
  --local-dir checkpoints/drama-3-NVFP4-Pruned
```

Verify the files with the checkpoint's `MANIFEST.sha256` from that pinned revision.
The original API image supplies Python and the other engines; the TensorFold image
adds the native encoder/server without changing the S2 image. Build and start:

```bash
docker build -f docker/nvidia/Dockerfile -t sogni-voice-nvidia:latest .
docker build -f docker/nvidia/Dockerfile.tensorfold -t sogni-voice-tensorfold:latest .
docker compose -f docker/nvidia/compose.yaml -f docker/nvidia/compose.tensorfold.yaml up -d --no-build --no-deps drama3
docker compose -f docker/nvidia/compose.yaml -f docker/nvidia/compose.tensorfold.yaml up -d --no-build --no-deps api
```

Wait for Drama 3's `http://127.0.0.1:8002/health` and `/v1/models` to report ready
before restarting the API. The overlay preserves the existing S2 and Parakeet
backends and uses the existing `/drama3-tts` routes. Restarting the model server
temporarily interrupts Drama 3 requests. On a shared Spark, hold the host's GPU
workload lease for the change and preserve the old image ID for rollback.

For a separately managed TensorFold server, set `DRAMA3_TTS_BACKEND=tensorfold`,
`DRAMA3_TTS_TENSORFOLD_URL=http://127.0.0.1:8002`,
`DRAMA3_TTS_TENSORFOLD_NATIVE_PATH` to its pinned binary, and
`DRAMA3_TTS_MODEL_PATH` to the NVFP4 checkpoint. The API's Python environment
still needs numpy and soundfile. The native binary requires CUDA at runtime,
including when encoding a clone's reference.

The same Fish clone IDs work here. The daemon encodes the original reference WAV
through `tensorfold-native voice encode`, keeps the resulting codec codes in
memory, and sends those codes and the exact transcript with each request. The
first use after an API restart includes reference-encoding time; later requests
reuse the codes. Replacing a clone's audio or transcript causes fresh encoding.
Clone uploads, renames and deletions retain the original store format.

TensorFold's pinned HTTP contract has these differences:

- Only speaker `0` is supported; multi-speaker requests are rejected.
- Sampling is fixed in the engine at temperature `1.0`, top-p `0.9`, top-k `30`.
  Other request temperatures and per-request `maxTokens` are rejected. The
  overlay sets a maximum of 4,096 frames per generation (about 190 seconds).
- Seed salt is server-wide (`TENSORFOLD_SEED_SALT=0` in the overlay), with each
  request's seed derived from its prompt. It is not a per-request API seed.
- The adapter sends the whole reply in one request, with whitespace collapsed.
  TensorFold long-form mode keeps up to 2,400 characters in one generation;
  longer scripts use the engine's own sentence segmentation and audio history.
  It receives the original clone reference. There is no client synthesis retry:
  replaying the same prompt and salt would produce the same take.
- Following [Undertone](https://github.com/plotarmordev/undertone), the overlay
  enables 3-second onset/mid-silence detection and up to two seeded server
  redraws, with delivery controls removed on redraw. The adapter sends a
  deadline of 20 + 0.15 seconds per character, capped at its HTTP timeout minus
  3 seconds (597 seconds by default); the engine also applies its own redraw
  budget. Reference guidance stays at 1.5. The voice-specific short-reply and
  high-register thresholds are not enabled without calibration. General API
  users retain the full delivery-control vocabulary.
- The server's `X-Finish-Reason` is forwarded on WAV/Opus replies; buffer JSON
  includes `finishReason` and `complete`. A capped or stalled take is preserved
  with `complete: false`. Clients must check for `stop` before delivering audio.
  Engine silence verdicts are authoritative; a recovered pause in a completed
  take is available for client-side pacing. The author measured guidance with a reference;
  built-in voice requests remain unguided even when the gamma header says 1.5.

Qualify one author-example canary before comparing a larger set. Compare exact
prompts and reference hashes, save the original and candidate WAVs, and judge
clone fidelity by ear. Report the engine change and settings alongside the quant:
this replaces vLLM-Omni with TensorFold as well as changing weights. The author's
quant was derived from original revision `e0a9218aa48888270f06ef1ed9ea67622c0e17d2`,
whose weights, codec, configuration and tokenizer match the original revision
pinned above; the upstream revision difference is in the model card.

## License

Fish S2 Pro is under the Fish Audio Research License (non-commercial). Drama 3
is under the Fish Audio Community License: commercial use only below USD 500k
annual revenue, and offering it as a hosted TTS or voice-cloning service needs a
separate license from Fish Audio. See [fish-s2-eval.md](fish-s2-eval.md) and
[fish-drama3.md](fish-drama3.md).
