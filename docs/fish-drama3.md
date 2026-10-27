# Fish Audio Drama 3 — directed, multi-character TTS + voice cloning (experimental)

[Fish Audio Drama 3](https://huggingface.co/fishaudio/drama-3) (released 2026-10-13) is
Fish's successor to S2: a 35B mixture-of-experts model (3B active per token) that is
directed in plain language. Fish's own runtime needs a 48 GB+ NVIDIA GPU; sogni-voice
runs it on Apple Silicon through **[drama3-mlx](https://github.com/Sogni-AI/drama3-mlx)**,
our MLX port, which matches Fish's PyTorch code layer by layer.

- **Directions** in `[brackets]` before or inside a line —
  `[nervous, barely holding it together] I didn't see anything.` — and point tags such
  as `[sighs]`, `[laughs]`.
- **Paired tags** for a few words: `<whisper>stay quiet</whisper>`.
- **Characters**: `<|speaker:0|>` … `<|speaker:15|>` voice up to 16 characters in one
  request. Text without a tag is speaker 0.
- **Voice cloning** from a clip (1-30 s) plus its exact transcript. Drama 3 uses the
  **same clone store as Fish S2** (`fish_voice_clones/`), so existing clones work.
- Long text is chunked like Fish's hosted server, with the first and latest chunks
  kept as context so the voice stays consistent.

> ⚠️ **License: Fish Audio Community License v1.0.** Research and non-commercial use
> are free. Commercial use is licensed only while annual revenue (with affiliates) is
> under USD 500,000, and offering Drama 3 as a hosted TTS / voice-cloning service
> needs a separate license from Fish Audio (business@fish.audio) regardless of
> revenue. Treat this like Fish S2: local evaluation until a commercial license exists.
> Products using it must say "Built with Fish Audio".

## Architecture

Same shape as Fish S2, sharing its code:

```
Browser ──/drama3-tts, /drama3-tts/voices/clone/*──▶ src/routes/fishTts.js (drama3TtsRoutes)
                                                      └▶ src/services/drama3Tts.js ──spawns──▶ scripts/drama3_tts_daemon.py
                                                           (Drama3TTSService extends FishTTSService)   (Drama3TTSDaemon extends FishTTSDaemon)
```

- `scripts/drama3_tts_daemon.py` — subclasses the S2 daemon (protocol, clone CRUD, MLX
  memory cleanup) and swaps in `drama3_mlx.Drama3` for loading and synthesis. Runs in
  `.venv-drama3`.
- `src/services/drama3Tts.js` — the S2 service with Drama 3's config, script and env.
- `src/routes/fishTts.js` — one route factory, two engines: `/fish-tts/*` (S2) and
  `/drama3-tts/*` (Drama 3) with identical shapes.
- `src/config/index.js` → `config.drama3Tts` — env-gated, **off by default**.

## API

| Method | Path | Body |
|---|---|---|
| POST | `/drama3-tts` | `{ text, format?: wav\|opus\|buffer, maxTokens?, temperature? }` |
| POST | `/drama3-tts/voices/clone/{cloneId}/generate` | same as above |
| POST | `/drama3-tts/voices/clone` | multipart: `audio`, `transcript`, `cloneId?` |
| PATCH / DELETE | `/drama3-tts/voices/clone/{cloneId}` | rename `{ newCloneId }` / delete |
| GET | `/drama3-tts/voices`, `/drama3-tts/status` | — |

`maxTokens` is frames per text chunk (21.5 frames per second of audio; default 600).
Text the model cannot take (structural tokens such as `<|im_end|>`, speaker tags above
15) is a 400. Clone routes need an API key unless `DANGEROUSLY_ALLOW_VOICE_CLONING=1`.

## Sampling and stalls

Drama 3 sometimes stalls: it goes silent mid-line and drops the rest. On Fish's own A1
example (cloned, with `[sighs]`/`[laughs]`), 14 of 24 takes were complete at Fish's SDK
defaults (temperature 0.7 / top-p 0.7), and Fish's own PyTorch sampler failed both takes
we ran; at temperature 1.0 / top-p 0.9 (the model card's serving settings) 20 of 24 were.
Every incomplete take held 2 s or more of silence, so the daemon defaults to 1.0 / 0.9
and samples a chunk again (up to 3 tries) when it finds such a silence. Through
`/drama3-tts` that gave 16 of 16 complete takes; one stall was re-sampled. A request's
`temperature` overrides the default; a text that asks for a long pause will be re-sampled
too.

## Performance (M5 Max, 128 GB)

| `DRAMA3_TTS_EXPERTS` | Resident | Peak | Per request (A1, 5–9 s of speech) |
|---|---|---|---|
| `q8` (default at 96 GB+) | 42 GB | 48–55 GB | 3–5 s (≈1.85× faster than real time) |
| `q4` (default below 96 GB) | 28 GB | 32 GB | ≈ the same speed |
| `fp8` (as released) | 42 GB | 47 GB | ≈3× slower than real time |

The daemon loads the release in 5–10 s from a warm file cache. Not yet tested: Fish S2
and Drama 3 loaded together, and the 64 GB macstudio (use `q4` there and check the
other engines' memory first).

## Setup

`./setup.sh` → **Fish Drama 3** in the TTS menu creates `.venv-drama3` and offers
the original release (41.5 GB) or the pruned NVFP4 checkpoint (20.76 GiB).
For the original it sets `DRAMA3_TTS_EXPERTS` from the Mac's memory. Manually:

```bash
uv venv --python 3.12 .venv-drama3
uv pip install --python .venv-drama3/bin/python "git+https://github.com/Sogni-AI/drama3-mlx@7f72841355aeeb351efb47a12837bad99458bcac"
.venv-drama3/bin/hf download fishaudio/drama-3 --revision dd64a85cd82e9521f7202610ede97b367fc83946 \
  --local-dir checkpoints/drama-3
```

Existing installations must run the pinned install above before starting the
updated Mac daemon, including when keeping the original checkpoint.

Then in `.env`:

```bash
DRAMA3_TTS_ENABLED=1
# DRAMA3_TTS_EXPERTS=q4      # on a 64 GB Mac
# PREWARM_DRAMA3_TTS=1
```

| Variable | Default | |
|---|---|---|
| `DRAMA3_TTS_ENABLED` | `0` | |
| `DRAMA3_TTS_PYTHON_PATH` | `./.venv-drama3/bin/python3` | |
| `DRAMA3_TTS_MODEL_PATH` | `./checkpoints/drama-3` | the release, or a `drama3-mlx convert` copy (keeps its own format) |
| `DRAMA3_TTS_EXPERTS` | `q8` | `q8`, `q4`, `fp8` or `bf16`: how the release's experts sit in memory |
| `DRAMA3_TTS_MODEL_ID` | `fish-drama-3` | reported by `/status` |
| `DRAMA3_TTS_TEMPERATURE` / `DRAMA3_TTS_TOP_P` | `1.0` / `0.9` | defaults when a request sends no `temperature` |
| `DRAMA3_TTS_ATTEMPTS` | `3` | tries per chunk when a take stalls (2 s+ of silence) |
| `DRAMA3_TTS_CFG_GAMMA` | `1.5` for native NVFP4, otherwise `1.0` | Mac reference-voice guidance; inactive without audio conditioning |
| `DRAMA3_TTS_VOICE_CLONES_DIR` | `FISH_TTS_VOICE_CLONES_DIR` or `./fish_voice_clones` | shared with S2 |
| `DRAMA3_TTS_MAX_NEW_TOKENS` | `0` (= 600 frames per chunk) | |
| `DRAMA3_TTS_TIMEOUT` / `_TIMEOUT_PER_CHAR_MS` / `_TIMEOUT_MAX` | `300000` / `400` / `900000` | |
| `DRAMA3_TTS_STARTUP_TIMEOUT` | `600000` | |
| `PREWARM_DRAMA3_TTS` | `0` | |

## Pruned NVFP4 checkpoint

[plotarmordev/drama-3-NVFP4-Pruned](https://huggingface.co/plotarmordev/drama-3-NVFP4-Pruned)
keeps 7,369 of the original 10,240 routed experts and stores them in NVFP4.
This is both pruning and quantization. The codec and other weights are unchanged.
Built with Fish Audio; the original model license and the derivative's notice apply.

On Mac, drama3-mlx reads the checkpoint's original packed weights, block scales,
global scales and retained expert IDs directly. `DRAMA3_TTS_EXPERTS` does not
requantize this format. Reference-voice generation defaults to guidance 1.5,
as recommended by the quant's author; existing original/converted checkpoints
keep guidance 1.0. The MLX runtime retains its own sampling and chunk-history
behavior, so it does not promise identical output to TensorFold.

After installing the drama3-mlx version above:

```bash
.venv-drama3/bin/hf download plotarmordev/drama-3-NVFP4-Pruned \
  --revision 494db08481db952f834b2241bce63fb3dfa72554 \
  --local-dir checkpoints/drama-3-NVFP4-Pruned
(cd checkpoints/drama-3-NVFP4-Pruned && shasum -a 256 -c MANIFEST.sha256)
```

Set these in `.env`:

```bash
DRAMA3_TTS_ENABLED=1
DRAMA3_TTS_MODEL_PATH=./checkpoints/drama-3-NVFP4-Pruned
DRAMA3_TTS_MODEL_ID=drama-3-nvfp4-pruned
```

The existing Fish clone store works without converting or replacing the reference
recordings. On DGX Spark the same checkpoint uses the pinned TensorFold engine;
see [the NVIDIA setup](linux-nvidia.md#drama-3-nvfp4-on-dgx-spark).
TensorFold currently accepts only speaker 0, uses fixed temperature 1.0/top-p
0.9/top-k 30, and configures the audio-frame limit at server startup. Its responses
expose `X-Finish-Reason` (`stop`, `length` or `silence`); a playable WAV can still
be incomplete. The demo retains that audio and shows a warning.
The NVIDIA overlay sends whole replies to TensorFold, uses a 4,096-frame budget,
and keeps up to 2,400 characters in one generation. Its onset/mid-silence checks
can redraw a failed take twice with a new seed. Clients should deliver only
`X-Finish-Reason: stop`; see the NVIDIA guide for deadlines and longer scripts.

The author's measurements cover English on GB10. Pruning may affect other
languages, unusual voices and expressive directions differently; verify those
with your own recordings. A comparison against the existing vLLM-Omni deployment
also changes the runtime, guidance and retry behavior, so it is not a measurement
of quantization alone.
