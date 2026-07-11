# Fish Audio S2 Pro — expressive TTS + voice cloning (experimental)

An **evaluation-only** integration of [Fish Audio S2 Pro](https://fish.audio/s2/), an
open-weights, highly expressive TTS model, running locally in 8-bit on Apple Silicon
via MLX. It matches the architecture of the other engines: a persistent
stdin/stdout daemon (`scripts/fish_tts_daemon.py`) driving the MLX model.

Two capabilities:

- **Expressive default-voice synthesis** — emotion/style is controlled with **inline
  tags** in the text (no separate parameter): `[brackets]` for emotions (`[happy]`,
  `[whispers]`, `[laughing]`, free-form like `[laughing nervously]`), `(parens)` for
  paralanguage sounds (`(laugh)`, `(sigh)`, `(break)`).
  Example: `[excited] We shipped it! (laugh) [whispers] and it sounds incredible.`
- **Zero-shot voice cloning** — from a short reference clip (1-30s) plus its
  transcript. No training step; the reference is encoded to prompt tokens at
  generation time.

> ⚠️ **License: non-commercial.** The S2 weights are under the Fish Audio Research
> License (research / non-commercial only). This is wired up for **local evaluation
> only**. Shipping S2 in a commercial product (e.g. voice.sogni.ai) requires a
> commercial license from Fish Audio (business@fish.audio). The vendored server code,
> model checkpoints, and voice clones are **git-ignored** and must not be committed.

## Architecture

Matches the other TTS engines (a stdin/stdout JSON daemon), unlike the earlier
HTTP-sidecar prototype:

```
Browser ──/fish-tts, /fish-tts/voices/clone/*──▶ src/routes/fishTts.js
                                                   └▶ src/services/fishTts.js  ──spawns──▶ scripts/fish_tts_daemon.py
                                                        (JSON over stdin/stdout)             drives the 8-bit MLX model
```

- `scripts/fish_tts_daemon.py` — loads the model once, handles `generate`,
  `generate_voice_clone`, `create/list/delete/rename_voice_clone`. Reuses the
  vendored `FishMLXServer` (fastpath patch + WAV encoding) for the default path and
  `model.generate(ref_audio=..., ref_text=...)` for cloning. Needs
  `PYTHONPATH=vendor/fish-s2-mlx`.
- `src/services/fishTts.js` — daemon manager (spawn, JSON protocol, lifecycle),
  mirroring `pocketTts.js` / `qwenTts.js`.
- `src/routes/fishTts.js` — `POST /fish-tts`, `GET /fish-tts/status`, `GET
  /fish-tts/voices`, and clone CRUD + `POST /fish-tts/voices/clone/{id}/generate`.
- `src/config/index.js` → `config.fishTts` — env-gated, **off by default**.
- Voice clones live in `fish_voice_clones/<id>/` (`reference.wav` + `metadata.json`).
- Demo UI: "Fish S2 Pro" TTS radio + emotion chips, and a "Fish S2 Pro" tab in the
  Voice Cloning section (with a required transcript field).

## Setup

**Easiest:** run `./setup.sh` and check **Fish S2 Pro** in the TTS engine menu — it
creates the venv, installs the pinned stack, vendors the inference repo, and
downloads + normalizes the checkpoint.

**Manual** (requires `uv`, Python 3.11, `git`):

```bash
# 1. Python venv + MLX stack (the fish-audio-s2 branch of mlx-audio)
uv venv --python 3.11 .venv-fish-tts
uv pip install --python .venv-fish-tts/bin/python \
  "git+https://github.com/lucasnewman/mlx-audio.git@fish-audio-s2" \
  soundfile numpy scipy huggingface_hub
# IMPORTANT pin: the branch declares transformers>=5 but ships mlx-lm==0.31.1,
# which only works on transformers <5. Force the fork's validated combo:
uv pip install --python .venv-fish-tts/bin/python "transformers==4.56.1" "tokenizers==0.22.0"

# 2. Vendor the community MLX deploy (non-commercial — git-ignored)
git clone --depth 1 https://github.com/groxaxo/fish-s2-pro-mlx-local-deploy vendor/fish-s2-mlx
rm -rf vendor/fish-s2-mlx/.git

# 3. Download the ungated 8-bit checkpoint (~6.7 GB) and normalize it (~7 GB more)
huggingface-cli download cs2764/fish-audio-s2-pro-8bit-mlx \
  --local-dir checkpoints/fish-audio-s2-pro-8bit-mlx
PYTHONPATH="$PWD/vendor/fish-s2-mlx" .venv-fish-tts/bin/python \
  vendor/fish-s2-mlx/local_mlx/normalize_cs2764_checkpoint.py \
  checkpoints/fish-audio-s2-pro-8bit-mlx \
  checkpoints/fish-audio-s2-pro-8bit-mlx-normalized
```

Sanity-check the venv:

```bash
.venv-fish-tts/bin/python -c \
  "from mlx_audio.tts.models.fish_qwen3_omni.fish_speech import Model; print('ok')"
```

## Enable

In `.env`:

```
FISH_TTS_ENABLED=1
FISH_TTS_MAX_TOKENS=1024
# PREWARM_FISH_TTS=0   # load the ~7 GB model into the daemon at server startup
```

Then `npm start`, open the demo, pick **Fish S2 Pro**. The daemon loads the model on
first use (~a few seconds when cached); generation is slower than realtime.

## Performance notes

- Measured **RTF ≈ 1.6-1.9** on M5 Max — HQ/offline, **not** for live/streaming.
- Uses the **8-bit** build; do not switch to 4-bit conversions (they decode to noise).
- Cloning needs the reference **transcript** (the exact words spoken); references are
  decoded to 44.1 kHz mono before encoding.

## Max audio length and runaway handling

- `FISH_TTS_MAX_TOKENS` is the **token ceiling** (~21.5 semantic tokens/sec of audio).
  Default `2600` ≈ **~2 min** max. The real per-request cap scales down to the text
  length, so short prompts aren't affected. Raise/lower it to taste. (The daemon
  propagates this to the vendored server's `FISH_MLX_MAX_TOKENS`, whose own default
  of 256 would otherwise cap all output at ~11s.)
- Zero-shot cloning can intermittently "run away" (repeat words / emit non-speech
  filler until it hits the ceiling). The clone path detects a ceiling-hit without a
  natural stop and **retries with tighter sampling**; clean output returns on the
  first attempt with no extra cost. See `tests/fish_daemon_retry_test.py`.
- `(paren)` paralanguage cues (`(laugh)`, `(sigh)`) legitimately produce non-speech
  and can dominate output — use sparingly. The reliable `[bracket]` emotion tags are
  preferred; the UI only offers bracket chips.

## Remove

```bash
rm -rf .venv-fish-tts vendor/fish-s2-mlx checkpoints/fish-audio-s2-pro-8bit-mlx* fish_voice_clones
# set FISH_TTS_ENABLED=0 (or delete the block) in .env
```

Then remove the `fishTts` config block, `scripts/fish_tts_daemon.py`,
`src/services/fishTts.js`, `src/routes/fishTts.js`, the `fishTtsRoutes` +
`fishTtsService` wiring in `src/routes/index.js` and `src/index.js`, the `FishTTSError`
class, the setup.sh Fish block, and the Fish S2 UI in `public/index.html`.
