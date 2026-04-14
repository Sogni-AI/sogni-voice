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

### Licensing

| Model | Software License | Model Weights | Commercial Use |
|-------|------------------|---------------|----------------|
| Pocket TTS | MIT | CC-BY-4.0 | ✅ Permitted |
| Kokoro TTS | Apache 2.0 | Apache 2.0 | ✅ Permitted |
| Qwen3-TTS | Apache 2.0 | Apache 2.0 | ✅ Permitted |

### Feature Comparison

| Feature | Pocket TTS | Kokoro TTS | Qwen3-TTS |
|---------|------------|------------|-----------|
| Parameters | 100M | 82M | 0.6B / 1.7B |
| Languages | English only | 4 (EN, JA, ZH) | 11 languages |
| Built-in Voices | 8 | 32 | 8 |
| Latency | ~200ms | Fast | 97ms |
| Voice Cloning | ✅ (5s audio) | ❌ | ✅ (3s audio) |
| Emotion Control | ❌ | ❌ | ✅ (CustomVoice) |
| Voice Design | ❌ | ❌ | ✅ (VoiceDesign) |
| Hardware | CPU (2-core) | MLX (Apple Silicon) | MPS (Apple Silicon) |
| Best For | CPU-only setups, English | Multi-language, variety | Advanced features, quality |

## Features

- **Audio Transcription**: Upload audio files and get text transcripts using [parakeet-mlx](https://github.com/senstella/parakeet-mlx)
  - Sentence-level timestamps for subtitle generation
  - Word-level timestamps for precise timing
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

### Environment Variables

#### Server
| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3000 | Server port |
| HOST | 127.0.0.1 | Server host (loopback-only by default) |
| CORS_ORIGINS | (empty) | Comma-separated CORS allowlist. CORS is disabled when unset. |
| MAX_FILE_SIZE_MB | 100 | Max upload file size |

#### Transcription
| Variable | Default | Description |
|----------|---------|-------------|
| TRANSCRIBE_TIMEOUT | 300000 | Transcription timeout (ms) |
| DAEMON_STARTUP_TIMEOUT | 120000 | Daemon startup timeout (ms) |
| PREWARM_TRANSCRIPTION | 1 | Pre-load model on server start |

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
| QWEN_TTS_ALLOW_LEGACY_PICKLE_CLONES | 0 | Temporarily allow legacy `.pkl` voice clone migration. Leave disabled in production. |

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
- CORS is disabled by default. Set `CORS_ORIGINS=https://app.example.com` (comma-separated for multiple origins) only when you need browser access from other origins.
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

### Check Auth Status

```bash
curl http://localhost:3000/auth/status
```

Response:
```json
{
  "authEnabled": true
}
```

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

Import a previously exported voice clone from a ZIP file. **Requires authentication** — you must provide a valid API key (via `X-API-Key` or `Authorization: Bearer` header) or set `DANGEROUSLY_ALLOW_IMPORTS=1`:

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
> Legacy `.pkl` imports are disabled by default. For a one-time migration of trusted old clones, set `QWEN_TTS_ALLOW_LEGACY_PICKLE_CLONES=1`, import/migrate them, then turn it back off.
>
> **Security note:** Voice clone imports are always gated by authentication, even when global API authentication (`AUTH_ENABLED`) is disabled. To allow unauthenticated imports (e.g., for local development), set `DANGEROUSLY_ALLOW_IMPORTS=1`.

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
| Kokoro TTS | ~300 MB | 30-60 seconds |
| Pocket TTS | ~200 MB | 30-60 seconds |
| Qwen3-TTS | 1.5-4 GB (varies by variant) | 2-5 minutes |

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
- `PREWARM_TTS=0`
- `PREWARM_POCKET_TTS=0`
- `PREWARM_QWEN_TTS=0`

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

## Project Structure

```
sogni-voice/
├── scripts/
│   ├── parakeet_daemon.py     # Transcription daemon
│   ├── tts_daemon.py          # Kokoro TTS daemon
│   ├── pocket_tts_daemon.py   # Pocket TTS daemon
│   └── qwen_tts_daemon.py     # Qwen3-TTS daemon
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
│   │   ├── tts.js             # Kokoro TTS endpoints
│   │   ├── pocketTts.js       # Pocket TTS endpoints
│   │   ├── qwenTts.js         # Qwen3-TTS endpoints
│   │   └── static.js          # Static file serving
│   ├── services/
│   │   ├── transcription.js   # Parakeet daemon integration
│   │   ├── tts.js             # Kokoro TTS integration
│   │   ├── pocketTts.js       # Pocket TTS integration
│   │   └── qwenTts.js         # Qwen3-TTS integration
│   └── utils/
│       ├── tempFile.js        # Temp file management
│       └── errors.js          # Custom error classes
├── models/
│   └── kokoro-tts/            # Kokoro model (auto-downloaded)
├── voice_clones/              # Qwen TTS voice clone storage
├── pocket_voice_clones/       # Pocket TTS voice clone storage
├── public/                    # Static files (demo UI)
└── tests/
    ├── unit/                  # Unit tests
    └── integration/           # Integration tests
```

## License

ISC
