# Sogni Transcribe API

![Sogni Voice Banner](https://voice.sogni.ai/sogni-voice-banner.jpg)

A REST API for audio transcription and text-to-speech synthesis.

> **Apple Silicon Only**: This project uses [MLX](https://github.com/ml-explore/mlx) for ML acceleration and is designed specifically for **Apple Silicon Macs** (M1/M2/M3/M4). It will not work on Intel Macs or other platforms.

## Features

- **Audio Transcription**: Upload audio files and get text transcripts using [parakeet-mlx](https://github.com/senstella/parakeet-mlx)
  - Sentence-level timestamps for subtitle generation
  - Word-level timestamps for precise timing
- **Text-to-Speech (Kokoro)**: Convert text to natural-sounding speech using [Kokoro TTS](https://github.com/hexgrad/kokoro)
  - 32 voices across 4 languages (American English, British English, Japanese, Chinese)
  - Word-level timestamp support
  - WAV and Opus output formats
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

# 3. Copy environment config (optional)
cp .env.example .env

# 4. Start the server
npm run dev
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
| HOST | 0.0.0.0 | Server host (listens on all interfaces) |
| MAX_FILE_SIZE_MB | 100 | Max upload file size |

#### Transcription
| Variable | Default | Description |
|----------|---------|-------------|
| TRANSCRIBE_TIMEOUT | 300000 | Transcription timeout (ms) |
| DAEMON_STARTUP_TIMEOUT | 120000 | Daemon startup timeout (ms) |
| PREWARM_TRANSCRIPTION | true | Pre-load model on server start |

#### Kokoro TTS
| Variable | Default | Description |
|----------|---------|-------------|
| TTS_MODEL_ID | mlx-community/Kokoro-82M-bf16 | Kokoro model ID |
| TTS_DEFAULT_VOICE | af_heart | Default TTS voice |
| TTS_DEFAULT_SPEED | 1.0 | Default speech speed |
| TTS_TIMEOUT | 60000 | TTS generation timeout (ms) |
| TTS_DAEMON_STARTUP_TIMEOUT | 60000 | Daemon startup timeout (ms) |
| PREWARM_TTS | true | Pre-load model on server start |

#### Qwen3-TTS (Optional)
| Variable | Default | Description |
|----------|---------|-------------|
| QWEN_TTS_ENABLED | false | Enable Qwen3-TTS (set to 'true') |
| QWEN_TTS_MODEL_VARIANT | base-0.6b | Model variant (see below) |
| QWEN_TTS_DEFAULT_VOICE | Chelsie | Default voice |
| QWEN_TTS_DEFAULT_LANGUAGE | English | Default language |
| QWEN_TTS_TIMEOUT | 300000 | Request timeout (ms) |
| QWEN_TTS_DAEMON_STARTUP_TIMEOUT | 180000 | Daemon startup timeout (ms) |
| PREWARM_QWEN_TTS | false | Pre-load model on server start |
| QWEN_TTS_VOICE_CLONES_DIR | ./voice_clones | Voice clone storage directory |

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
curl -X POST http://localhost:3000/tts \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world", "format": "opus"}' \
  --output output.opus
```

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
| format | string | wav | Output format (wav, opus, buffer) |
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

> **Note**: Qwen3-TTS must be enabled with `QWEN_TTS_ENABLED=true`

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

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| text * | string | - | Text to convert to speech |
| voice | string | Chelsie | Speaker voice name |
| language | string | English | Language for synthesis |

#### Custom Voice (Emotion/Style Control)

Generate speech with emotion and style instructions. This feature uses the CustomVoice model to control how the speech is delivered.

```bash
curl -X POST http://localhost:3000/qwen-tts/custom-voice \
  -H "Content-Type: application/json" \
  -d '{"text": "I am so excited!", "speaker": "Chelsie", "instruct": "Speak with excitement and joy"}' \
  --output output.wav
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| text * | string | - | Text to convert to speech |
| speaker | string | Chelsie | Speaker voice name |
| instruct | string | - | Style/emotion instruction (e.g., "Speak softly with a gentle tone") |

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

#### Voice Design (Create Voice from Description)

Requires `voice-design` model variant:

```bash
curl -X POST http://localhost:3000/qwen-tts/voice-design \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello there!", "instruct": "A warm, friendly female voice with a slight British accent"}' \
  --output output.wav
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| text * | string | - | Text to convert to speech |
| instruct * | string | - | Description of the desired voice characteristics |

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
| Qwen3-TTS | 1.5-4 GB (varies by variant) | 2-5 minutes |

Models are cached locally after the first download. Subsequent requests will be much faster.

## Performance

### Daemon Architecture

All services use persistent Python daemons that keep ML models loaded in memory:

- **First request**: Model loads (varies by model size), then processes
- **Subsequent requests**: 2-5x faster (no model loading overhead)

Daemons start automatically when the server starts and shut down gracefully with the server. To disable pre-loading (lazy load on first request instead), set:
- `PREWARM_TRANSCRIPTION=false`
- `PREWARM_TTS=false`
- `PREWARM_QWEN_TTS=false`

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
│   │   ├── qwenTts.js         # Qwen3-TTS endpoints
│   │   └── static.js          # Static file serving
│   ├── services/
│   │   ├── transcription.js   # Parakeet daemon integration
│   │   ├── tts.js             # Kokoro TTS integration
│   │   └── qwenTts.js         # Qwen3-TTS integration
│   └── utils/
│       ├── tempFile.js        # Temp file management
│       └── errors.js          # Custom error classes
├── models/
│   └── kokoro-tts/            # Kokoro model (auto-downloaded)
├── voice_clones/              # Voice clone storage
├── public/                    # Static files (demo UI)
└── tests/
    ├── unit/                  # Unit tests
    └── integration/           # Integration tests
```

## License

ISC
