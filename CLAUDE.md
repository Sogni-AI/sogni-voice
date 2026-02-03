# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Sogni Transcribe is a REST API for audio transcription and text-to-speech synthesis, built specifically for **Apple Silicon Macs** using MLX for ML acceleration.

## Commands

```bash
# Development
npm run dev          # Start server with hot reload (node --watch)
npm start            # Start server without hot reload

# Testing
npm test             # Run tests in watch mode
npm run test:run     # Run tests once
npm run test:coverage # Run tests with coverage report

# Run a single test file
npx vitest run tests/unit/services/tts.test.js

# PM2 production management
npm run pm2:start    # Start with PM2
npm run pm2:stop     # Stop the service
npm run pm2:restart  # Restart the service
npm run pm2:logs     # View logs
```

## Architecture

This is a Hapi.js REST API with ES modules (`"type": "module"`).

**Server setup flow**: `src/index.js` → `src/server.js` (createServer/initServer/startServer)

**Key patterns**:
- Routes are organized by feature in `src/routes/` and aggregated in `src/routes/index.js`
- Services in `src/services/` encapsulate external tool integration via Python daemons
- Custom errors in `src/utils/errors.js` have a `toBoom()` method for Hapi error responses
- Config loaded from env vars via `src/config/index.js`

**Daemon architecture** (all three services use the same pattern):
- Python daemons in `scripts/` load ML models once and stay resident in memory
- Node.js services communicate via stdin/stdout JSON-line protocol
- Request/response matching via unique request IDs stored in `pendingRequests` Map
- Lazy initialization on first request (or on server start with `PREWARM_*=true`)
- Graceful shutdown for all daemons handled in `src/index.js`
- Auto-restart if daemon dies unexpectedly

**Services**:
- `transcription.js` → `scripts/parakeet_daemon.py`: Uses Parakeet TDT (parakeet-mlx) for transcription
  - Supports sentence-level and word-level timestamp extraction
- `tts.js` → `scripts/tts_daemon.py`: Uses mlx-audio library with Kokoro model for TTS
  - Model stored locally at `models/kokoro-tts/`, auto-downloaded from HuggingFace on first run
  - 32 voices across 4 languages (American English, British English, Japanese, Chinese)
- `qwenTts.js` → `scripts/qwen_tts_daemon.py`: Qwen3-TTS with PyTorch/MPS backend
  - Multiple model variants (Base, CustomVoice, VoiceDesign)
  - Voice cloning from reference audio (Base models)
  - Emotion/style instruction control (CustomVoice)
  - Voice design from descriptions (VoiceDesign)
  - 11 languages supported

**Testing structure**:
- `tests/unit/` - Unit tests organized by source directory (config, services, utils)
- `tests/integration/` - API endpoint tests using Hapi's `server.inject()`
- Uses `initServer()` for tests (initializes without starting) vs `startServer()` for production

## API Endpoints

**Health**: `GET /health`

**Transcription**: `POST /transcribe`
- Parameters: `file` (required), `timestamps`, `wordTimestamps`

**Kokoro TTS**:
- `POST /tts` - Generate speech (params: text, voice, speed, format, timestamps)
- `GET /tts/voices` - List available voices

**Qwen3-TTS** (when `QWEN_TTS_ENABLED=true`):
- `POST /qwen-tts` - Standard TTS generation
- `POST /qwen-tts/custom-voice` - Emotion/style controlled speech
- `POST /qwen-tts/voice-design` - Create voice from description
- `POST /qwen-tts/voices/clone` - Create voice clone from reference audio
- `POST /qwen-tts/voices/clone/{cloneId}/generate` - Generate with cloned voice
- `GET /qwen-tts/voices` - List voices, clones, and capabilities
- `DELETE /qwen-tts/voices/clone/{cloneId}` - Delete voice clone
- `GET /qwen-tts/voices/clone/{cloneId}/download` - Download voice clone as ZIP
- `POST /qwen-tts/voices/clone/import` - Import voice clone from ZIP

## Configuration

**Server**: `PORT` (3000), `HOST` (0.0.0.0)

**Transcription**:
- `TRANSCRIBE_TIMEOUT` (300000ms), `DAEMON_STARTUP_TIMEOUT` (120000ms)
- `PREWARM_TRANSCRIPTION` (true)

**Kokoro TTS**:
- `TTS_MODEL_ID` (mlx-community/Kokoro-82M-bf16)
- `TTS_DEFAULT_VOICE` (af_heart), `TTS_DEFAULT_SPEED` (1.0)
- `TTS_TIMEOUT` (60000ms), `TTS_DAEMON_STARTUP_TIMEOUT` (60000ms)
- `PREWARM_TTS` (true)

**Qwen TTS**:
- `QWEN_TTS_ENABLED` (false - set to 'true' to enable)
- `QWEN_TTS_MODEL_VARIANT` (base-0.6b) - Options: base-0.6b, base-1.7b, custom-voice-0.6b, custom-voice, voice-design
- `QWEN_TTS_DEFAULT_VOICE` (Chelsie), `QWEN_TTS_DEFAULT_LANGUAGE` (English)
- `QWEN_TTS_TIMEOUT` (300000ms), `QWEN_TTS_DAEMON_STARTUP_TIMEOUT` (180000ms)
- `PREWARM_QWEN_TTS` (false)
- `QWEN_TTS_VOICE_CLONES_DIR` (./voice_clones)

**Upload**: `MAX_FILE_SIZE_MB` (100)

## External Dependencies

- **Python 3.10+** with virtual environment at `.venv/`
- **Parakeet TDT** (parakeet-mlx): Audio transcription (~2.5GB model, auto-downloads on first use)
- **mlx-audio**: TTS via Kokoro model (~300MB, auto-downloads to `models/kokoro-tts/`)
- **qwen-tts**: Qwen3-TTS for advanced features (optional, enabled via `QWEN_TTS_ENABLED`)
- **ffmpeg**: Required for audio processing (`brew install ffmpeg`)
- **uv**: Python package runner (`brew install uv`)

## Directory Structure

```
sogni-voice/
├── scripts/
│   ├── parakeet_daemon.py     # Transcription daemon
│   ├── tts_daemon.py          # Kokoro TTS daemon
│   └── qwen_tts_daemon.py     # Qwen3-TTS daemon
├── src/
│   ├── index.js               # Entry point & shutdown handler
│   ├── server.js              # Hapi server configuration
│   ├── config/                # Configuration management
│   ├── plugins/               # Hapi plugin registration
│   ├── routes/                # API route handlers
│   │   ├── health.js, transcribe.js, tts.js, qwenTts.js, static.js
│   ├── services/              # Daemon integration services
│   │   ├── transcription.js, tts.js, qwenTts.js
│   └── utils/                 # Error classes, temp file management
├── models/kokoro-tts/         # Kokoro model (auto-downloaded)
├── voice_clones/              # Voice clone storage (Qwen TTS)
├── public/                    # Static files (demo UI)
└── tests/                     # Unit and integration tests
```
