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
- Services in `src/services/` encapsulate external tool integration:
  - `tts.js`: Uses kokoro-js library for text-to-speech (lazy-initialized singleton)
  - `transcription.js`: Spawns `uvx parakeet-mlx` as child process for audio transcription
- Custom errors in `src/utils/errors.js` have a `toBoom()` method for Hapi error responses
- Config loaded from env vars via `src/config/index.js`

**Testing structure**:
- `tests/unit/` - Unit tests organized by source directory (config, services, utils)
- `tests/integration/` - API endpoint tests using Hapi's `server.inject()`
- Uses `initServer()` for tests (initializes without starting) vs `startServer()` for production

## External Dependencies

- **parakeet-mlx**: Audio transcription via `uvx parakeet-mlx` CLI (requires Python's uvx)
- **kokoro-js**: TTS via npm package (ONNX model, ~300MB download on first use)
- **ffmpeg**: Required for audio processing
