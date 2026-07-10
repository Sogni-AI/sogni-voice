# Sogni Voice TTS & STT API

![Sogni Voice Banner](https://voice.sogni.ai/sogni-voice-banner.jpg)

A REST API and configuration for running cutting-edge, open-source text-to-speech and speech-to-text models locally—no third-party API dependencies required. OpenClaw setup steps in [llm.txt](llm.txt)!

> **Apple Silicon Only**: This project uses [MLX](https://github.com/ml-explore/mlx) for ML acceleration and is designed specifically for **Apple Silicon Macs** (M1/M2/M3/M4). It will not work on Intel Macs or other platforms.

## Model Comparison

### Release Timeline

| Model | Release Date | Notes |
|-------|--------------|-------|
| Kokoro TTS | Dec 25, 2024 (v0.19) → Jan 27, 2025 (v1.0) | First to market |
| Pocket TTS | Jan 13, 2026 (v1.0.3) | ~1 year after Kokoro |
| Qwen3-TTS | Jan 21-22, 2026 | ~8 days after Pocket |
| MOSS-TTS-Nano | Apr 10, 2026 | 100M multilingual reference-voice model |

### Licensing

| Model | Software License | Model Weights | Commercial Use |
|-------|------------------|---------------|----------------|
| Pocket TTS | MIT | CC-BY-4.0 | ✅ Permitted |
| Kokoro TTS | Apache 2.0 | Apache 2.0 | ✅ Permitted |
| Qwen3-TTS | Apache 2.0 | Apache 2.0 | ✅ Permitted |
| Qwen3-ASR + ForcedAligner | Apache 2.0 | Apache 2.0 | ✅ Permitted |
| MOSS-TTS-Nano | Apache 2.0 | Apache 2.0 | ✅ Permitted |

### Feature Comparison

| Feature | Pocket TTS | Kokoro TTS | Qwen3-TTS | MOSS-TTS-Nano |
|---------|------------|------------|-----------|----------------|
| Parameters | 100M | 82M | 0.6B / 1.7B | 100M |
| Languages | English only | 4 (EN, JA, ZH) | 11 languages | 20 languages |
| Built-in Voices | 8 | 32 | 8 | None; reference voice required |
| Output | 24 kHz mono | 24 kHz mono | 24 kHz mono | 48 kHz stereo |
| Voice Cloning | ✅ (5s audio) | ❌ | ✅ (3s audio) | ✅ (1-30s audio) |
| Emotion Control | ❌ | ❌ | ✅ (CustomVoice) | ❌ |
| Voice Design | ❌ | ❌ | ✅ (VoiceDesign) | ❌ |
| Hardware | CPU (2-core) | MLX (Apple Silicon) | MPS (Apple Silicon) | MLX (Apple Silicon) |
| Best For | CPU-only setups, English | Multi-language, variety | Advanced features, quality | Small multilingual cloned voices |

## Features

- **Audio Transcription**: Upload audio files and get text transcripts using [parakeet-mlx](https://github.com/senstella/parakeet-mlx)
  - Sentence-level timestamps for subtitle generation
  - Word-level timestamps for precise timing
  - Optional speaker identification with [pyannote Community-1](https://huggingface.co/pyannote/speaker-diarization-community-1)
- **Multilingual Transcription + Alignment**: Optional [Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR) MLX backend
  - 0.6B 8-bit model with auto detection across 30 languages
  - Sentence or word timings generated with Qwen3 ForcedAligner
  - Explicit supplied-transcript alignment for captions and dubbing
  - Isolated `.venv-qwen-asr` keeps MLX-Audio 0.4.x separate from existing TTS dependencies
- **Text-to-Speech (Kokoro)**: Convert text to natural-sounding speech using [Kokoro TTS](https://github.com/hexgrad/kokoro)
  - 32 voices across 4 languages (American English, British English, Japanese, Chinese)
  - Word-level timestamp support
  - WAV and Opus output formats
- **Text-to-Speech (Pocket TTS)**: Compact, CPU-friendly TTS with voice cloning (optional)
  - 8 built-in English voices
  - Voice cloning from 5-10 second audio samples
  - ~200ms latency, 100M parameters, CPU-only
- **Text-to-Speech (Qwen3-TTS)**: Advanced TTS with [Qwen3-TTS](https://huggingface.co/Qwen/Qwen3-TTS) (optional)
  - Voice cloning from reference audio
  - Emotion/style control with custom voice models
  - Voice design from text descriptions
  - 11 languages supported
- **Text-to-Speech (MOSS-TTS-Nano)**: 100M multilingual [MOSS-TTS-Nano](https://github.com/OpenMOSS/MOSS-TTS-Nano) through MLX-Audio (optional)
  - Reference-voice synthesis from a 1-30 second sample; no transcript required
  - 20 advertised languages and 48 kHz stereo output
  - Persistent reference profiles with prompt codes cached in memory
  - Isolated `.venv-moss-tts`; current MLX backend is non-streaming
- **Fast**: Optimized for Apple Silicon with MLX and MPS backends

## Quick Start

```bash
# 1. Install system dependencies
brew install ffmpeg uv

# 2. Install Node.js dependencies
npm install

# 3. Run interactive setup (recommended)
./setup.sh

# (Setup can optionally predownload all selected models to avoid first-request downloads)

# OR manually copy environment config
cp .env.example .env

# 4. Start the server (test)
npm run dev

# 4. Start the server (prod)
pm2 start ecosystem.config.cjs
```

The server will be available at `http://localhost:3000`.

## Requirements

### System Requirements

- **macOS** on Apple Silicon (M1/M2/M3/M4)
- **uv** (Python package runner for parakeet-mlx)
- **ffmpeg** for audio processing

### Install System Dependencies

```bash
# Install ffmpeg (audio processing) and uv (Python package runner)
brew install ffmpeg uv
```

> **Note**: `uv` provides the `uvx` command used to run parakeet-mlx for transcription.

## Installation

```bash
npm install
```

## Configuration (Optional)

Copy `.env.example` to `.env` to customize settings:

```bash
cp .env.example .env
```

Examples for local-only, allowlist, and public `CORS_ORIGINS=*` setups are in `examples/README.md`.

### Environment Variables

#### Server
| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3000 | Server port |
| HOST | 127.0.0.1 | Server host (loopback-only by default) |
| CORS_ORIGINS | local | `local` allows loopback browser origins only. Set `*` for any origin, `off` to disable, or use a comma-separated allowlist. |
| MAX_FILE_SIZE_MB | 100 | Max upload file size |

#### Transcription
| Variable | Default | Description |
|----------|---------|-------------|
| TRANSCRIPTION_ENABLED | 1 | Enable the Parakeet transcription endpoint |
| TRANSCRIBE_TIMEOUT | 300000 | Transcription timeout (ms) |
| DAEMON_STARTUP_TIMEOUT | 120000 | Daemon startup timeout (ms) |
| PREWARM_TRANSCRIPTION | 1 | Pre-load model on server start |

#### Speaker Diarization (Optional)
| Variable | Default | Description |
|----------|---------|-------------|
| DIARIZATION_ENABLED | 0 | Enable local speaker identification on `/transcribe` |
| DIARIZATION_MODEL_ID | pyannote/speaker-diarization-community-1 | Hugging Face diarization model |
| HF_TOKEN | (cached login) | Optional token for headless installs; `uvx hf auth login` is also supported |
| DIARIZATION_TIMEOUT | 600000 | Diarization timeout (ms) |
| DIARIZATION_DAEMON_STARTUP_TIMEOUT | 180000 | Model startup timeout (ms) |
| PREWARM_DIARIZATION | 0 | Pre-load the diarization model on server start |

Before enabling diarization, accept the gated [Community-1 model terms](https://huggingface.co/pyannote/speaker-diarization-community-1) and run `uvx hf auth login`, or provide `HF_TOKEN` on a headless server. `./setup.sh` walks through both steps.

#### Qwen3-ASR + ForcedAligner (Optional)
| Variable | Default | Description |
|----------|---------|-------------|
| QWEN_ASR_ENABLED | 0 | Enable Qwen3-ASR as an additional `/transcribe` engine |
| QWEN_ASR_MODEL_ID | mlx-community/Qwen3-ASR-0.6B-8bit | MLX speech-recognition model |
| QWEN_ASR_ALIGNER_MODEL_ID | mlx-community/Qwen3-ForcedAligner-0.6B-8bit | MLX forced-alignment model |
| QWEN_ASR_PYTHON_PATH | ./.venv-qwen-asr/bin/python3 | Isolated backend interpreter |
| QWEN_ASR_DEFAULT_LANGUAGE | auto | Language name/code, or automatic detection |
| QWEN_ASR_TIMEOUT | 300000 | Transcription/alignment timeout (ms) |
| QWEN_ASR_DAEMON_STARTUP_TIMEOUT | 300000 | Initial model-load timeout (ms) |
| PREWARM_QWEN_ASR | 0 | Load Qwen3-ASR on server start; the aligner remains lazy |

Select Qwen3-ASR in `./setup.sh` to create the isolated environment, install MLX-Audio 0.4.x plus Japanese/Korean tokenizers, and optionally predownload both models. Parakeet remains the default engine.

#### Kokoro TTS (Optional)
| Variable | Default | Description |
|----------|---------|-------------|
| TTS_ENABLED | 1 | Enable Kokoro TTS (set to '1'). If disabled, /tts routes are unavailable and Kokoro will not pre-warm/download. |
| TTS_MODEL_ID | mlx-community/Kokoro-82M-bf16 | Kokoro model ID |
| TTS_DEFAULT_VOICE | af_heart | Default TTS voice |
| TTS_DEFAULT_SPEED | 1.0 | Default speech speed |
| TTS_TIMEOUT | 60000 | TTS generation timeout (ms) |
| TTS_DAEMON_STARTUP_TIMEOUT | 60000 | Daemon startup timeout (ms) |
| PREWARM_TTS | 1 | Pre-load model on server start |

#### Pocket TTS (Optional)
| Variable | Default | Description |
|----------|---------|-------------|
| POCKET_TTS_ENABLED | 0 | Enable Pocket TTS (set to '1') |
| POCKET_TTS_DEFAULT_VOICE | alba | Default TTS voice |
| POCKET_TTS_TIMEOUT | 60000 | TTS generation timeout (ms) |
| POCKET_TTS_DAEMON_STARTUP_TIMEOUT | 60000 | Daemon startup timeout (ms) |
| PREWARM_POCKET_TTS | 0 | Pre-load model on server start |
| POCKET_TTS_VOICE_CLONES_DIR | ./pocket_voice_clones | Voice clone storage directory |

#### MOSS-TTS-Nano (Optional)
| Variable | Default | Description |
|----------|---------|-------------|
| MOSS_TTS_ENABLED | 0 | Enable MOSS-TTS-Nano endpoints |
| MOSS_TTS_MODEL_ID | mlx-community/MOSS-TTS-Nano-100M | MLX model ID |
| MOSS_TTS_PYTHON_PATH | ./.venv-moss-tts/bin/python3 | Isolated backend interpreter |
| MOSS_TTS_DEFAULT_VOICE | (none) | Optional saved reference-voice ID used when `voice` is omitted |
| MOSS_TTS_TIMEOUT | 300000 | Minimum generation/profile-operation timeout (ms) |
| MOSS_TTS_TIMEOUT_PER_CHAR_MS | 120 | Long-text timeout budget per character |
| MOSS_TTS_TIMEOUT_MAX | 1800000 | Maximum scaled generation timeout (ms) |
| MOSS_TTS_DAEMON_STARTUP_TIMEOUT | 300000 | Initial model-load timeout (ms) |
| PREWARM_MOSS_TTS | 0 | Load the model on server start |
| MOSS_TTS_VOICES_DIR | ./moss_voice_clones | Saved reference-profile directory |

Select MOSS-TTS-Nano in `./setup.sh` to create `.venv-moss-tts`, install MLX-Audio 0.4.x, and optionally predownload the model plus its audio tokenizer (~360 MB total).

#### Qwen3-TTS (Optional)
| Variable | Default | Description |
|----------|---------|-------------|
| QWEN_TTS_ENABLED | 0 | Enable Qwen3-TTS (set to '1') |
| QWEN_TTS_MODEL_VARIANT | base-0.6b | Model variant (see below) |
| QWEN_TTS_DEFAULT_VOICE | Chelsie | Default voice |
| QWEN_TTS_DEFAULT_LANGUAGE | English | Default language |
| QWEN_TTS_TIMEOUT | 300000 | Request timeout (ms) |
| QWEN_TTS_DAEMON_STARTUP_TIMEOUT | 180000 | Daemon startup timeout (ms) |
| PREWARM_QWEN_TTS | 0 | Pre-load model on server start |
| QWEN_TTS_VOICE_CLONES_DIR | ./voice_clones | Voice clone storage directory |

#### Authentication (Optional)
| Variable | Default | Description |
|----------|---------|-------------|
| AUTH_ENABLED | 0 | Enable API key authentication |
| AUTH_API_KEY | (none) | API key for authenticating requests |
| DANGEROUSLY_ALLOW_IMPORTS | 0 | Allow voice clone imports without API key authentication |
| DANGEROUSLY_ALLOW_VOICE_CLONING | 0 | Allow clone creation, generation, download, rename, and deletion without API key authentication |

**Qwen3-TTS Model Variants:**
- `base-0.6b` - Basic TTS + voice cloning (smaller, faster)
- `base-1.7b` - Basic TTS + voice cloning (larger, higher quality)
- `custom-voice-0.6b` - Emotion/style control (smaller)
- `custom-voice` - Emotion/style control (larger)
- `voice-design` - Create voices from descriptions

## Running the Server

### Development
```bash
npm run dev
```

### Production
```bash
npm start
```

### Production with PM2

[PM2](https://pm2.keymetrics.io/) is recommended for production deployments. It provides process management, auto-restart, and log management.

```bash
# Install PM2 globally (one-time)
npm install -g pm2

# Start the service
npm run pm2:start

# View logs
npm run pm2:logs

# Check status
npm run pm2:status

# Restart the service
npm run pm2:restart

# Stop the service
npm run pm2:stop

# Remove from PM2
npm run pm2:delete
```

To start on system boot:
```bash
pm2 startup
pm2 save
```

### Using with ClawdBot

Sogni Voice enables ClawdBot to use text-to-speech and speech-to-text without any third-party API dependencies. Install on the same Mac Mini as your ClawdBot instance for the lowest latency and simplest configuration.

```bash
# Start Sogni Voice with PM2
npm run pm2:start
```

ClawdBot can then access the API at `http://localhost:3000`:

- **Transcription**: `POST http://localhost:3000/transcribe`
- **Text-to-Speech**: `POST http://localhost:3000/tts`
- **Health Check**: `GET http://localhost:3000/health`

For authenticated deployments, set `AUTH_ENABLED=1` and provide the API key in ClawdBot's configuration.

## Authentication

The API supports optional API key authentication, which is **disabled by default** for local installations.

Security defaults:
- The server binds to `127.0.0.1` by default. To expose it on a network interface, set `HOST` explicitly and enable `AUTH_ENABLED=1` with `AUTH_API_KEY`.
- CORS defaults to `CORS_ORIGINS=local`, which only allows browser origins from `localhost`, `127.0.0.1`, and `::1`. Set `CORS_ORIGINS=*` for any origin, `off` to disable CORS entirely, or a comma-separated allowlist for specific sites.
- Voice clone operations are protected even when global API auth is off. To use clone create/generate/download/delete/rename routes without an API key in local development, set `DANGEROUSLY_ALLOW_VOICE_CLONING=1`.

### Enabling Authentication

Set the following environment variables:

```bash
# .env
AUTH_ENABLED=1
AUTH_API_KEY=sk_your_secret_key_here
```

To generate a secure API key:
```bash
openssl rand -hex 32
```

### Making Authenticated Requests

When authentication is enabled, include your API key using one of these methods:

**X-API-Key Header (recommended):**
```bash
curl -X POST http://localhost:3000/tts \
  -H "X-API-Key: sk_your_secret_key_here" \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world"}'
```

**Authorization Bearer Header:**
```bash
curl -X POST http://localhost:3000/tts \
  -H "Authorization: Bearer sk_your_secret_key_here" \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world"}'
```

### Public Endpoints

These endpoints are always accessible without authentication:
- `GET /health` - Health check for monitoring
- `GET /auth/status` - Check if authentication is enabled
- `GET /{static files}` - Demo site and static files

Voice clone import endpoints are separate: when `DANGEROUSLY_ALLOW_IMPORTS` is not set, imports either require `AUTH_API_KEY` or are fully blocked if no API key is configured.

### Check Auth Status

```bash
curl http://localhost:3000/auth/status
```

Response:
```json
{
  "authEnabled": true,
  "apiKeyConfigured": true,
  "dangerouslyAllowImports": false,
  "voiceCloneImports": {
    "enabled": true,
    "mode": "api_key"
  }
}
```

`voiceCloneImports.mode` can be:
- `public` - imports are open because `DANGEROUSLY_ALLOW_IMPORTS=1`
- `api_key` - imports require `X-API-Key` / `Authorization: Bearer`
- `blocked` - imports are disabled until the server sets `AUTH_API_KEY` or `DANGEROUSLY_ALLOW_IMPORTS=1`

## API Endpoints

### Health Check
```bash
curl http://localhost:3000/health
```

Response:
```json
{
  "status": "healthy",
  "timestamp": "2025-01-15T12:00:00.000Z",
  "uptime": 123.456
}
```

### Transcribe Audio
```bash
curl -X POST http://localhost:3000/transcribe \
  -F "file=@audio.mp3"
```

Response:
```json
{
  "success": true,
  "transcript": "The transcribed text...",
  "filename": "audio.mp3"
}
```

#### With Sentence Timestamps
```bash
curl -X POST http://localhost:3000/transcribe \
  -F "file=@audio.mp3" \
  -F "timestamps=true"
```

Response:
```json
{
  "success": true,
  "timestamps": [
    { "start": 0.00, "end": 2.34, "text": "Hello and welcome" },
    { "start": 2.34, "end": 5.67, "text": "to our presentation" }
  ],
  "filename": "audio.mp3"
}
```

#### With Word-Level Timestamps
```bash
curl -X POST http://localhost:3000/transcribe \
  -F "file=@audio.mp3" \
  -F "wordTimestamps=true"
```

Response:
```json
{
  "success": true,
  "timestamps": [
    { "start": 0.00, "end": 0.45, "text": "Hello" },
    { "start": 0.45, "end": 0.62, "text": "and" },
    { "start": 0.62, "end": 1.10, "text": "welcome" }
  ],
  "filename": "audio.mp3"
}
```

#### With Speaker Identification

Speaker identification runs locally with pyannote Community-1. Request sentence or word timestamps to receive a `speaker` label on every matching segment:

```bash
curl -X POST http://localhost:3000/transcribe \
  -F "file=@conversation.mp3" \
  -F "timestamps=true" \
  -F "diarize=true" \
  -F "minSpeakers=2" \
  -F "maxSpeakers=4"
```

```json
{
  "success": true,
  "timestamps": [
    { "start": 0.0, "end": 1.4, "text": "Welcome.", "speaker": "SPEAKER_00" },
    { "start": 1.5, "end": 2.8, "text": "Thank you.", "speaker": "SPEAKER_01" }
  ],
  "diarization": { "available": true, "numSpeakers": 2 },
  "speakers": [
    { "speaker": "SPEAKER_00", "segmentCount": 1, "totalSeconds": 1.4 },
    { "speaker": "SPEAKER_01", "segmentCount": 1, "totalSeconds": 1.3 }
  ]
}
```

Use `numSpeakers` for an exact count, or `minSpeakers` and `maxSpeakers` for a range. Values must be between 1 and 20.

#### Qwen3-ASR Multilingual Transcription

Use `engine=qwen3` to select Qwen3-ASR. Omit `language` or send `auto` for detection. When sentence or word timestamps are requested, the ForcedAligner runs after transcription; alignment is available in Chinese, English, Cantonese, French, German, Italian, Japanese, Korean, Portuguese, Russian, and Spanish.

```bash
curl -X POST http://localhost:3000/transcribe \
  -F "file=@speech.m4a" \
  -F "engine=qwen3" \
  -F "language=auto" \
  -F "wordTimestamps=true" \
  -F "diarize=false"
```

```json
{
  "success": true,
  "engine": "qwen3",
  "language": "English",
  "model": "mlx-community/Qwen3-ASR-0.6B-8bit",
  "timestampLevel": "word",
  "timestamps": [
    { "text": "Hello", "start": 0.0, "end": 0.4 },
    { "text": "world", "start": 0.4, "end": 0.8 }
  ]
}
```

List configured recognition providers and their language capabilities:

```bash
curl http://localhost:3000/transcription/models
```

#### Align a Known Transcript

`POST /qwen-asr/align` aligns supplied text to audio without transcribing it first. Audio is limited to 5 minutes by the upstream aligner.

```bash
curl -X POST http://localhost:3000/qwen-asr/align \
  -F "file=@speech.wav" \
  -F "text=The exact words spoken in the recording." \
  -F "language=English"
```

### Text-to-Speech (Kokoro)

#### Download WAV file
```bash
curl -X POST http://localhost:3000/tts \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world"}' \
  --output output.wav
```

#### Download Opus file
```bash
curl -X POST 'http://localhost:3000/tts?format=opus' \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world"}' \
  --output output.opus
```

You can still send `format` in the JSON body, but the top-level TTS endpoints also accept `?format=opus` in the query string. If both are provided, the query string wins.

#### Get base64-encoded audio with timestamps
```bash
curl -X POST http://localhost:3000/tts \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world", "format": "buffer", "timestamps": true}'
```

Response:
```json
{
  "success": true,
  "audio": "<base64-encoded-wav>",
  "voice": "af_heart",
  "speed": 1.0,
  "format": "wav",
  "timestamps": [
    { "word": "Hello", "start": 0.0, "end": 0.32 },
    { "word": "world", "start": 0.32, "end": 0.65 }
  ]
}
```

#### TTS Options

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| text | string | required | Text to convert (max 10000 chars) |
| voice | string | af_heart | Voice name |
| speed | number | 1.0 | Speed (0.5-2.0) |
| format | string | wav | Output format (wav, opus, buffer). Top-level TTS routes also accept `?format=` in the query string. |
| timestamps | boolean | false | Include word-level timestamps |

### List Kokoro Voices
```bash
curl http://localhost:3000/tts/voices
```

Response:
```json
{
  "voices": ["af_heart", "af_alloy", "af_bella", ...],
  "default": "af_heart"
}
```

### Qwen3-TTS Endpoints

> **Note**: Qwen3-TTS must be enabled with `QWEN_TTS_ENABLED=1`

#### List Voices and Capabilities

```bash
curl http://localhost:3000/qwen-tts/voices
```

Response:
```json
{
  "voices": ["Chelsie", "Ethan", "Serena", "Vivian", "Ryan", "Aiden", "Eric", "Dylan"],
  "clones": ["my-voice", "customer-voice"],
  "default": "Chelsie",
  "defaultLanguage": "English",
  "modelVariants": {
    "base": "base-0.6b",
    "customVoice": "custom-voice"
  },
  "features": ["tts", "voice_cloning", "custom_voice"]
}
```

| Field | Description |
|-------|-------------|
| voices | Standard Qwen TTS speaker voices |
| clones | Custom cloned voices (varies by instance) |
| default | Default voice if none specified |
| defaultLanguage | Default language for synthesis |
| modelVariants | Active model variants (dual-daemon mode) |
| features | Available features based on loaded models |

#### Standard TTS

Generate speech with a standard voice:

```bash
curl -X POST http://localhost:3000/qwen-tts \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world", "voice": "Chelsie"}' \
  --output output.wav
```

Download Opus with query-string format override:

```bash
curl -X POST 'http://localhost:3000/qwen-tts?format=opus' \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world", "voice": "Chelsie"}' \
  --output output.opus
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| text * | string | - | Text to convert to speech |
| voice | string | Chelsie | Speaker voice name |
| language | string | English | Language for synthesis |
| format | string | wav | Output format (wav, opus, buffer). Also accepted as `?format=` on this endpoint. |

#### Custom Voice (Emotion/Style Control)

Generate speech with emotion and style instructions. This feature uses the CustomVoice model to control how the speech is delivered.

```bash
curl -X POST http://localhost:3000/qwen-tts/custom-voice \
  -H "Content-Type: application/json" \
  -d '{"text": "I am so excited!", "speaker": "Chelsie", "instruct": "Speak with excitement and joy"}' \
  --output output.wav
```

To get Opus instead:

```bash
curl -X POST 'http://localhost:3000/qwen-tts/custom-voice?format=opus' \
  -H "Content-Type: application/json" \
  -d '{"text": "I am so excited!", "speaker": "Chelsie", "instruct": "Speak with excitement and joy"}' \
  --output output.opus
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| text * | string | - | Text to convert to speech |
| speaker | string | Chelsie | Speaker voice name |
| instruct | string | - | Style/emotion instruction (e.g., "Speak softly with a gentle tone") |
| format | string | wav | Output format (wav, opus, buffer). Also accepted as `?format=` on this endpoint. |

**Example style instructions:**
- "Speak with excitement and enthusiasm"
- "Use a calm, soothing voice"
- "Sound professional and confident"
- "Speak slowly and clearly, as if explaining to a child"
- "Express sadness and disappointment"

**JavaScript Example:**
```javascript
const response = await fetch('http://localhost:3000/qwen-tts/custom-voice', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    text: 'Welcome to our presentation!',
    speaker: 'Serena',
    instruct: 'Speak with warmth and professionalism'
  })
});

const audioBlob = await response.blob();
const audioUrl = URL.createObjectURL(audioBlob);
const audio = new Audio(audioUrl);
audio.play();
```

**Python Example:**
```python
import requests

response = requests.post(
    'http://localhost:3000/qwen-tts/custom-voice',
    json={
        'text': 'Welcome to our presentation!',
        'speaker': 'Serena',
        'instruct': 'Speak with warmth and professionalism'
    }
)

with open('output.wav', 'wb') as f:
    f.write(response.content)
```

#### Voice Cloning

Create a voice clone from reference audio (3-10 seconds recommended):

> **Authentication required by default:** clone create/generate/download/delete/rename routes require a valid API key unless you explicitly set `DANGEROUSLY_ALLOW_VOICE_CLONING=1`.

```bash
curl -X POST http://localhost:3000/qwen-tts/voices/clone \
  -F "audio=@reference.wav" \
  -F "transcript=Hello, this is my voice sample" \
  -F "cloneId=my-voice"
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| audio * | file | - | Reference audio file (WAV, MP3, etc.) |
| transcript * | string | - | Exact transcript of the reference audio |
| cloneId | string | auto-generated | Custom ID for the voice clone |

Generate speech with a cloned voice:

```bash
curl -X POST http://localhost:3000/qwen-tts/voices/clone/my-voice/generate \
  -H "Content-Type: application/json" \
  -d '{"text": "This will sound like the cloned voice"}' \
  --output output.wav
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| text * | string | - | Text to convert to speech |
| language | string | English | Language for synthesis |

Delete a voice clone:

```bash
curl -X DELETE http://localhost:3000/qwen-tts/voices/clone/my-voice
```

#### Download Voice Clone

Download a voice clone as a ZIP file for backup or transfer to another system:

```bash
curl http://localhost:3000/qwen-tts/voices/clone/my-voice/download \
  --output my-voice.zip
```

The ZIP file contains:
- `{cloneId}.safetensors` - The voice embedding in safetensors format (safe, no code execution possible)
- `metadata.json` - Clone metadata (ID, creation date, service info)

#### Import Voice Clone

Import a previously exported voice clone from a ZIP file. If `voiceCloneImports.mode` is `api_key`, provide a valid API key via `X-API-Key` or `Authorization: Bearer`. If it is `blocked`, the server must set `AUTH_API_KEY` or `DANGEROUSLY_ALLOW_IMPORTS=1` before imports will work:

```bash
curl -X POST http://localhost:3000/qwen-tts/voices/clone/import \
  -H "X-API-Key: sk_your_secret_key_here" \
  -F "file=@my-voice.zip" \
  -F "cloneId=imported-voice"
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| file * | file | - | ZIP file containing the voice clone |
| cloneId | string | from metadata/filename | Custom ID for the imported clone |

> Voice clones use the [safetensors](https://github.com/huggingface/safetensors) format, which stores only tensor data and cannot execute code.
> Pickle-based voice clones are intentionally rejected. Convert or recreate old clones as `.safetensors` before importing them.
>
> **Security note:** Voice clone imports are configured separately from global API auth. When `AUTH_ENABLED=0`, imports can still be API-key-only or fully blocked. To allow unauthenticated imports (e.g., for local development), set `DANGEROUSLY_ALLOW_IMPORTS=1`.

#### Voice Design (Create Voice from Description)

Requires `voice-design` model variant:

```bash
curl -X POST http://localhost:3000/qwen-tts/voice-design \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello there!", "instruct": "A warm, friendly female voice with a slight British accent"}' \
  --output output.wav
```

To get Opus instead:

```bash
curl -X POST 'http://localhost:3000/qwen-tts/voice-design?format=opus' \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello there!", "instruct": "A warm, friendly female voice with a slight British accent"}' \
  --output output.opus
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| text * | string | - | Text to convert to speech |
| instruct * | string | - | Description of the desired voice characteristics |
| format | string | wav | Output format (wav, opus, buffer). Also accepted as `?format=` on this endpoint. |

### Pocket TTS Endpoints

> **Note**: Pocket TTS must be enabled with `POCKET_TTS_ENABLED=1`

#### List Voices

```bash
curl http://localhost:3000/pocket-tts/voices
```

Response:
```json
{
  "voices": ["alba", "marius", "javert", "jean", "fantine", "cosette", "eponine", "azelma"],
  "clones": ["my-voice"],
  "default": "alba"
}
```

| Field | Description |
|-------|-------------|
| voices | Built-in Pocket TTS voices |
| clones | Custom cloned voices (varies by instance) |
| default | Default voice if none specified |

#### Generate Speech

Download WAV file:
```bash
curl -X POST http://localhost:3000/pocket-tts \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world", "voice": "alba"}' \
  --output output.wav
```

Download Opus file:
```bash
curl -X POST 'http://localhost:3000/pocket-tts?format=opus' \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world", "voice": "alba"}' \
  --output output.opus
```

Get base64-encoded audio:
```bash
curl -X POST http://localhost:3000/pocket-tts \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world", "voice": "alba", "format": "buffer"}'
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| text * | string | - | Text to convert to speech (max 10000 chars) |
| voice | string | alba | Voice name |
| format | string | wav | Output format (wav, opus, buffer). Also accepted as `?format=` on this endpoint. |

**JavaScript Example:**
```javascript
const response = await fetch('http://localhost:3000/pocket-tts', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    text: 'Welcome to Pocket TTS!',
    voice: 'marius'
  })
});

const audioBlob = await response.blob();
const audioUrl = URL.createObjectURL(audioBlob);
const audio = new Audio(audioUrl);
audio.play();
```

**Python Example:**
```python
import requests

response = requests.post(
    'http://localhost:3000/pocket-tts',
    json={
        'text': 'Welcome to Pocket TTS!',
        'voice': 'marius'
    }
)

with open('output.wav', 'wb') as f:
    f.write(response.content)
```

#### Voice Cloning

Create a voice clone from reference audio (5-10 seconds recommended):

> **Authentication required by default:** clone create/generate/download/delete/rename routes require a valid API key unless you explicitly set `DANGEROUSLY_ALLOW_VOICE_CLONING=1`.

```bash
curl -X POST http://localhost:3000/pocket-tts/voices/clone \
  -F "audio=@reference.wav" \
  -F "cloneId=my-voice"
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| audio * | file | - | Reference audio file (WAV, MP3, OGG) |
| cloneId | string | auto-generated | Custom ID for the voice clone |

Generate speech with a cloned voice:

```bash
curl -X POST http://localhost:3000/pocket-tts/voices/clone/my-voice/generate \
  -H "Content-Type: application/json" \
  -d '{"text": "This will sound like the cloned voice"}' \
  --output output.wav
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| text * | string | - | Text to convert to speech (max 10000 chars) |
| format | string | wav | Output format (wav, opus, buffer) |

Delete a voice clone:

```bash
curl -X DELETE http://localhost:3000/pocket-tts/voices/clone/my-voice
```

### MOSS-TTS-Nano Endpoints

> **Note**: Enable with `MOSS_TTS_ENABLED=1`. MOSS has no built-in voices: create a reference profile first. Clone creation, synthesis, rename, and deletion require a valid API key unless `DANGEROUSLY_ALLOW_VOICE_CLONING=1` is explicitly set.

#### List Capabilities and Reference Voices

```bash
curl http://localhost:3000/moss-tts/voices \
  -H "X-API-Key: your_api_key_here"
```

The response includes saved `voices`, the model ID, 20 language entries, 48 kHz sample rate, reference-audio limits, and `"streaming": false`. Listing capabilities does not load the model; voice IDs are hidden from callers without clone access.

#### Create a Reference Voice

No transcript is needed. A clean 5-10 second sample is recommended; the accepted range is 1-30 seconds.

```bash
curl -X POST http://localhost:3000/moss-tts/voices/clone \
  -H "X-API-Key: your_api_key_here" \
  -F "audio=@reference.wav" \
  -F "voiceId=my_voice"
```

Accepted uploads are MP3, WAV, M4A, MP4, WebM, OGG, and FLAC. The server validates the file content and freezes a normalized 48 kHz PCM reference at `MOSS_TTS_VOICES_DIR/<voiceId>/reference.wav`.

#### Generate Speech

```bash
curl -X POST http://localhost:3000/moss-tts \
  -H "X-API-Key: your_api_key_here" \
  -H "Content-Type: application/json" \
  -d '{"text":"Hola, esta voz funciona en varios idiomas.","voice":"my_voice"}' \
  --output output.wav
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| text * | string | - | Text to synthesize (max 10,000 characters) |
| voice | string | `MOSS_TTS_DEFAULT_VOICE` | Saved reference-voice ID; required when no default is configured |
| format | string | wav | `wav`, `opus`, or `buffer`; also accepted as `?format=` |

The `buffer` response includes base64 WAV audio plus duration, processing time, real-time factor, sample rate, channels, and model ID. The current MLX implementation is intentionally exposed as non-streaming because upstream `mlx-audio` does not implement MOSS streaming yet.

#### Rename or Delete a Reference Voice

```bash
curl -X PATCH http://localhost:3000/moss-tts/voices/clone/my_voice \
  -H "X-API-Key: your_api_key_here" \
  -H "Content-Type: application/json" \
  -d '{"newVoiceId":"narrator"}'

curl -X DELETE http://localhost:3000/moss-tts/voices/clone/narrator \
  -H "X-API-Key: your_api_key_here"
```

## Testing

```bash
# Run tests in watch mode
npm test

# Run tests once
npm run test:run

# Run with coverage
npm run test:coverage
```

## First Run Notes

On first use, ML models are downloaded automatically:

| Feature | Model Size | Download Time |
|---------|-----------|---------------|
| Transcription | ~2.5 GB (parakeet-mlx) | 2-5 minutes |
| Qwen3-ASR + ForcedAligner | ~2.2 GB total | 2-5 minutes |
| Speaker identification | ~70 MB (pyannote Community-1) | 1-3 minutes |
| Kokoro TTS | ~300 MB | 30-60 seconds |
| Pocket TTS | ~200 MB | 30-60 seconds |
| Qwen3-TTS | 1.5-4 GB (varies by variant) | 2-5 minutes |
| MOSS-TTS-Nano + audio tokenizer | ~360 MB | 30-90 seconds |

Models are cached locally after the first download. Subsequent requests will be much faster.
Only enabled services will download models. For example, if you only use Pocket TTS, set `TTS_ENABLED=0` to avoid Kokoro downloads.

If you ran `./setup.sh`, you can opt to predownload models during setup to avoid downloads on first request.

## Performance

### Daemon Architecture

All services use persistent Python daemons that keep ML models loaded in memory:

- **First request**: Model loads (varies by model size), then processes
- **Subsequent requests**: 2-5x faster (no model loading overhead)

Daemons start automatically when the server starts and shut down gracefully with the server. To disable pre-loading (lazy load on first request instead), set:
- `PREWARM_TRANSCRIPTION=0`
- `PREWARM_QWEN_ASR=0`
- `PREWARM_DIARIZATION=0`
- `PREWARM_TTS=0`
- `PREWARM_POCKET_TTS=0`
- `PREWARM_QWEN_TTS=0`
- `PREWARM_MOSS_TTS=0`

## Available Voices

### Kokoro Voices (32 total)

#### American English Female (af_*)
- **af_heart** (default)
- af_alloy, af_aoede, af_bella, af_jessica
- af_kore, af_nicole, af_nova, af_river
- af_sarah, af_sky, af_sage

#### American English Male (am_*)
- am_adam, am_echo, am_eric, am_fenrir
- am_liam, am_michael, am_onyx, am_puck

#### British English Female (bf_*)
- bf_emma, bf_isabella, bf_alice, bf_lily

#### British English Male (bm_*)
- bm_george, bm_lewis, bm_daniel, bm_fable

#### Japanese Female (jf_*)
- jf_alpha, jf_gongitsune

#### Japanese Male (jm_*)
- jm_kumo

#### Chinese Female (zf_*)
- zf_xiaobei, zf_xiaoni, zf_xiaoxuan

#### Chinese Male (zm_*)
- zm_yunjian, zm_yunxi, zm_yunyang

### Pocket TTS Voices

#### Built-in Voices (8 total)
- **alba** (default) - English female voice
- marius - English male voice
- javert - English male voice
- jean - English male voice
- fantine - English female voice
- cosette - English female voice
- eponine - English female voice
- azelma - English female voice

#### Voice Cloning
Custom voices can be created from 5-10 second audio samples using the voice cloning endpoint.

### Qwen3-TTS Voices

For CustomVoice models: Chelsie, Ethan, Serena, Vivian, Ryan, Aiden, Eric, Dylan

For Base models: Use voice cloning to create custom voices from reference audio.

### Qwen3-TTS Languages

auto, Chinese, English, French, German, Italian, Japanese, Korean, Portuguese, Russian, Spanish

### MOSS-TTS-Nano Reference Voices and Languages

MOSS-TTS-Nano has no built-in speakers. Create named reference profiles from 1-30 second samples; 5-10 seconds of clean, single-speaker audio is recommended. The model metadata lists Chinese, English, German, Spanish, French, Japanese, Italian, Hebrew, Korean, Russian, Persian, Arabic, Polish, Portuguese, Czech, Danish, Swedish, Hungarian, Greek, and Turkish.

## Project Structure

```
sogni-voice/
├── scripts/
│   ├── parakeet_daemon.py     # Transcription daemon
│   ├── qwen_asr_daemon.py     # Qwen3-ASR + ForcedAligner daemon
│   ├── tts_daemon.py          # Kokoro TTS daemon
│   ├── pocket_tts_daemon.py   # Pocket TTS daemon
│   ├── qwen_tts_daemon.py     # Qwen3-TTS daemon
│   └── moss_tts_daemon.py     # MOSS-TTS-Nano MLX daemon
├── src/
│   ├── index.js               # Entry point
│   ├── server.js              # Hapi server setup
│   ├── config/
│   │   └── index.js           # Configuration loader
│   ├── plugins/
│   │   └── index.js           # Hapi plugins
│   ├── routes/
│   │   ├── index.js           # Route aggregator
│   │   ├── health.js          # GET /health
│   │   ├── transcribe.js      # POST /transcribe
│   │   ├── qwenAsr.js         # POST /qwen-asr/align
│   │   ├── tts.js             # Kokoro TTS endpoints
│   │   ├── pocketTts.js       # Pocket TTS endpoints
│   │   ├── qwenTts.js         # Qwen3-TTS endpoints
│   │   ├── mossTts.js         # MOSS-TTS-Nano endpoints
│   │   └── static.js          # Static file serving
│   ├── services/
│   │   ├── transcription.js   # Parakeet daemon integration
│   │   ├── qwenAsr.js          # Qwen3-ASR daemon integration
│   │   ├── tts.js             # Kokoro TTS integration
│   │   ├── pocketTts.js       # Pocket TTS integration
│   │   ├── qwenTts.js         # Qwen3-TTS integration
│   │   └── mossTts.js         # MOSS-TTS-Nano integration
│   └── utils/
│       ├── tempFile.js        # Temp file management
│       └── errors.js          # Custom error classes
├── models/
│   └── kokoro-tts/            # Kokoro model (auto-downloaded)
├── .venv-qwen-asr/            # Isolated MLX-Audio 0.4.x environment
├── .venv-moss-tts/            # Isolated MOSS MLX-Audio environment
├── voice_clones/              # Qwen TTS voice clone storage
├── pocket_voice_clones/       # Pocket TTS voice clone storage
├── moss_voice_clones/         # MOSS reference-profile storage
├── public/                    # Static files (demo UI)
└── tests/
    ├── unit/                  # Unit tests
    └── integration/           # Integration tests
```

## License

ISC
