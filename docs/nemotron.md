# NVIDIA Nemotron 3.5 Transcribe

Select **Nemotron 3.5** in the recording/upload model selector, or send
`engine=nemotron` to `POST /transcribe`. It uses the
[final NVIDIA checkpoint](https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B)
at revision `a188fff16c4f129a046788c2ad69e6198079a102`, licensed under
OpenMDW-1.1. The early-access community checkpoints are not used.

| Capability | Apple Silicon | Linux + NVIDIA |
|---|---|---|
| Runtime | Native MLX Audio | NeMo Speech plugin for vLLM 0.32.0 |
| Language-model precision | 4-bit affine, group 64 | Online FP8 from the official BF16 weights |
| Audio/speaker encoders | Original precision; MoE routers stay FP32 | BF16 |
| Transcription | 40 languages, automatic detection | Same |
| Speaker labels | Built in, untimed turns | Built in, optional timed words/sentences |
| Timestamps | Unavailable in the MLX port | Native CTC word alignment |
| Live microphone streaming | No | No |

Both backends decode at temperature 0 with reasoning disabled. Audio is decoded
to mono 16 kHz PCM before inference. The model accepts recordings up to one hour;
the API's separate upload size limit still applies (25 MB by default). A first
request includes model loading on Mac. This is an offline model, so recording
finishes before transcription begins.

## Mac setup

`./setup.sh` offers Nemotron with the other transcription engines and installs
its isolated environment. To add it to an existing installation:

```bash
uv venv --python 3.12 .venv-nemotron
uv pip install --python .venv-nemotron/bin/python -r requirements-nemotron.txt
```

Nemotron is enabled by default. Set `NEMOTRON_BACKEND=mlx` and
`NEMOTRON_PYTHON_PATH=./.venv-nemotron/bin/python3` to override automatic platform
selection. The first request downloads the pinned 67.5 GB checkpoint; reserve
at least 75 GB of disk space. The language model is quantized in memory before
inference. Loading the original weights also needs substantial free unified
memory; use a 128 GB Mac for the original-checkpoint path.

`requirements-nemotron.txt` pins MLX Audio to
`c1e429151c56ce4057c62709f958df998e301d3f` and its MLX 0.32.4 dependency.
The adapter removes only the final release's separate `ctc_timestamp.*` head,
which this MLX port does not implement. Every ASR/speaker weight is loaded
strictly, so missing or mismatched inference weights fail startup.

`NEMOTRON_MLX_BITS=4` is the default; `8` retains more precision at higher memory
cost. `NEMOTRON_MODEL_PATH` can name a local original or prequantized MLX
checkpoint directory, while preserving the official model ID in responses.

## DGX Spark setup

Keep the existing Fish containers and their vLLM-Omni runtime. Nemotron runs in
a separate image, pinned to NeMo Speech
`7b05f096d54db47078fd1569a54d1f3ba4a4c51f`, using the upstream dependency lock.
Build the base Sogni NVIDIA image first as described in [linux-nvidia.md](linux-nvidia.md).

```bash
uvx --from huggingface_hub hf download nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B \
  --revision a188fff16c4f129a046788c2ad69e6198079a102 \
  --local-dir checkpoints/nemotron-3.5-transcribe
docker compose -f docker/nvidia/compose.yaml -f docker/nvidia/compose.nemotron.yaml \
  build nemotron
docker compose -f docker/nvidia/compose.yaml -f docker/nvidia/compose.nemotron.yaml \
  up -d --no-deps nemotron
```

Include `-f docker/nvidia/compose.tensorfold.yaml` before the Nemotron overlay
when using the Drama 3 TensorFold stack. Wait for Nemotron's
`http://127.0.0.1:8003/health` and `/v1/models` before updating the API image and
recreating only `api` with `--no-deps`. The API overlay enables Nemotron and points
its Python adapter at that loopback server. Hold the Spark workload and production
deployment leases during a live worker update.

The overlay allocates 1 GiB for the KV cache and serves one request at a time,
with a 65,536-token context and 4,096-token prefill batches. Model weights and
working memory are additional. It uses online FP8 because
the FP8/NVFP4 repositories linked in the release card were inaccessible when this
integration was prepared. MTP speculation is disabled. Unlike NVIDIA's dedicated
H100 throughput recipe, this setup shares the Spark with S2, Drama 3 and Parakeet.

## API

```bash
curl https://voice.sogni.ai/transcribe \
  -H "X-API-Key: $VOICE_API_KEY" \
  -F file=@recording.wav -F engine=nemotron -F diarize=true
```

Optional fields:

| Field | Behavior |
|---|---|
| `diarize` | Native speaker tags; defaults to true for Nemotron, set false for plain text |
| `hotwords` | Comma-separated context terms, at most 1,000 characters |
| `prompt` | Custom instruction, at most 2,000 characters; defaults to NVIDIA's ASR prompt |
| `timestamps` | Sentence timing on vLLM; rejected on MLX |
| `wordTimestamps` | Word timing on vLLM; overrides sentence timing |
| `maxNewTokens` | 64–65,536; default 16,384, subject to the model context limit |

Language detection is automatic. A supplied `language` must be `auto`; language
instructions or translation requests belong in `prompt`. Speaker-count constraints
are unsupported. Native speaker tags identify voices within the recording, not
real-world identities. For audio questions or translation, disable speaker labels
and timestamps unless the instruction also asks for a transcription.

Responses include `transcript`, `engine`, `model`, `revision`, `backend`,
`segments` (speaker/text pairs), `finishReason`, `complete`, and `metrics` with
audio duration and elapsed inference time. Timing requests also return
`timestamps` and `timestampLevel`. A token-capped transcript is preserved with
`finishReason: "length"` and `complete: false`; clients must check completion.
Timestamp alignment errors fail the request instead of inventing timings.

`GET /transcription/models` reports each worker's timestamp capabilities.
`GET /auth/status` exposes enablement for the page before authentication.
Existing API-key requirements apply to transcription requests.

Configuration: `NEMOTRON_TIMEOUT=3600000`,
`NEMOTRON_STARTUP_TIMEOUT=1800000`, `NEMOTRON_MAX_NEW_TOKENS=16384`,
`PREWARM_NEMOTRON=false`. Mac model downloads and startup have a separate budget
from queued transcription. `NEMOTRON_ENABLED=false` disables this engine.

## Hardware qualification

Validated on October 28, 2026 PT (October 29 SGT) with NVIDIA's published
[LibriSpeech sample](https://dldata-public.s3.us-east-2.amazonaws.com/2086-149220-0033.wav):
7.435 seconds, 16 kHz mono PCM16 WAV. These are short canaries, not throughput
benchmarks or validation of every supported language.

- Apple M5 Max, native Metal MLX: the local 4-bit checkpoint returned the expected
  complete transcript. The first API request took 14.24 seconds including model
  startup; a warm browser request with speaker labels took 1.38 seconds and
  displayed one untimed speaker turn.
- DGX Spark, online FP8 with the 1 GiB KV cache: plain transcription, speaker
  labels, 23 CTC-aligned words, and two timed sentences passed through the API.
  The first browser timing request took 25.41 seconds including first-use
  compilation; the later sentence request took 5.17 seconds through the local
  API and SSH tunnel.

The original checkpoint SHA-256 is
`03142dde5176c1d4df21ee829642745a1d670ea4d79e1a4684c64d53195acff2`.
The tested MLX checkpoint was converted from those same weights with the pinned
loader, retaining the encoder precision and FP32 routers. Its weight-file
SHA-256 is `3031dc09d8c5f3963896f49e83b692e644a472856fa4dcbf5067a41bf4e5536c`.
One-hour recordings, all 40 languages, and multi-speaker quality remain untested.
