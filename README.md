# Sogni Transcribe API

A REST API for audio transcription and text-to-speech synthesis.

> **Apple Silicon Only**: This project uses [MLX](https://github.com/ml-explore/mlx) for ML acceleration and is designed specifically for **Apple Silicon Macs** (M1/M2/M3/M4). It will not work on Intel Macs or other platforms.

## Features

- **Audio Transcription**: Upload audio files and get text transcripts using [parakeet-mlx](https://github.com/senstella/parakeet-mlx)
- **Text-to-Speech**: Convert text to natural-sounding speech using [Kokoro TTS](https://github.com/hexgrad/kokoro)
- **Multiple Voices**: 20+ voices available for TTS
- **Fast**: Optimized for Apple Silicon with MLX backend

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

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3000 | Server port |
| HOST | 0.0.0.0 | Server host (listens on all interfaces) |
| TTS_MODEL_ID | onnx-community/Kokoro-82M-v1.0-ONNX | Kokoro model ID |
| TTS_DEFAULT_VOICE | af_heart | Default TTS voice |
| TTS_DEFAULT_SPEED | 1.0 | Default speech speed |
| MAX_FILE_SIZE_MB | 100 | Max upload file size |

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

### Text-to-Speech

#### Download WAV file
```bash
curl -X POST http://localhost:3000/tts \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world"}' \
  --output output.wav
```

#### Get base64-encoded audio
```bash
curl -X POST http://localhost:3000/tts \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world", "format": "buffer"}'
```

Response:
```json
{
  "success": true,
  "audio": "<base64-encoded-wav>",
  "voice": "af_heart",
  "speed": 1.0,
  "format": "wav"
}
```

#### TTS Options

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| text | string | required | Text to convert (max 10000 chars) |
| voice | string | af_heart | Voice name |
| speed | number | 1.0 | Speed (0.5-2.0) |
| format | string | wav | Output format (wav, buffer) |

### List Voices
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
| TTS | ~300 MB (Kokoro) | 30-60 seconds |

Models are cached locally after the first download. Subsequent requests will be much faster.

## Available Voices

### Female voices (af_*)
- **af_heart** (default, Grade A)
- af_alloy, af_aoede, af_bella, af_jessica
- af_kore, af_nicole, af_nova, af_river
- af_sarah, af_sky

### Male voices (am_*)
- am_adam, am_echo, am_eric, am_fenrir
- am_liam, am_michael, am_onyx, am_puck, am_santa

## Project Structure

```
sogni-transcribe/
├── src/
│   ├── index.js              # Entry point
│   ├── server.js             # HAPI server setup
│   ├── config/
│   │   └── index.js          # Configuration loader
│   ├── plugins/
│   │   └── index.js          # HAPI plugins
│   ├── routes/
│   │   ├── index.js          # Route aggregator
│   │   ├── health.js         # GET /health
│   │   ├── transcribe.js     # POST /transcribe
│   │   └── tts.js            # POST /tts, GET /tts/voices
│   ├── services/
│   │   ├── transcription.js  # parakeet-mlx integration
│   │   └── tts.js            # kokoro-js integration
│   └── utils/
│       ├── tempFile.js       # Temp file management
│       └── errors.js         # Custom error classes
└── tests/
    ├── setup.js
    ├── unit/
    └── integration/
```

## License

ISC
