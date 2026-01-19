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

**Daemon architecture** (both transcription and TTS use the same pattern):
- Python daemons in `scripts/` load ML models once and stay resident in memory
- Node.js services communicate via stdin/stdout JSON-line protocol
- Request/response matching via unique request IDs stored in `pendingRequests` Map
- Lazy initialization on first request (or on server start with `PREWARM_TRANSCRIPTION=true` / `PREWARM_TTS=true`)
- Graceful shutdown for both daemons handled in `src/index.js`
- Auto-restart if daemon dies unexpectedly

**Services**:
- `transcription.js` → `scripts/parakeet_daemon.py`: Uses parakeet-mlx for transcription
- `tts.js` → `scripts/tts_daemon.py`: Uses mlx-audio library with Kokoro model for TTS
  - Model stored locally at `models/kokoro-tts/`, auto-downloaded from HuggingFace on first run

**Testing structure**:
- `tests/unit/` - Unit tests organized by source directory (config, services, utils)
- `tests/integration/` - API endpoint tests using Hapi's `server.inject()`
- Uses `initServer()` for tests (initializes without starting) vs `startServer()` for production

## External Dependencies

- **Python 3.10+** with virtual environment at `.venv/`
- **parakeet-mlx**: Audio transcription (~2.5GB model, auto-downloads on first use)
- **mlx-audio**: TTS via Kokoro model (~300MB, auto-downloads to `models/kokoro-tts/`)
- **ffmpeg**: Required for audio processing (`brew install ffmpeg`)
- **uv**: Python package runner (`brew install uv`)
