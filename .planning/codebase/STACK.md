# Technology Stack

**Analysis Date:** 2026-01-23

## Languages

**Primary:**
- JavaScript (ES modules) - REST API and server logic
- Python 3.10+ - ML model daemon processes

**Secondary:**
- Shell - Build and deployment scripts

## Runtime

**Environment:**
- Node.js 18.0.0+ (per `package.json` engines requirement)
- Python 3.10+ with virtual environment at `.venv/`

**Package Manager:**
- npm - JavaScript/Node.js dependencies
- uv - Python package runner (`brew install uv`)

## Frameworks

**Core:**
- Hapi.js 21.3.12 - REST API framework
  - Entry point: `src/index.js` → `src/server.js`
  - Request validation via Joi
  - Error handling via @hapi/boom
  - Static file serving via @hapi/inert

**Testing:**
- Vitest 3.0.4 - Unit and integration test runner
  - Config: `vitest.config.js`
  - Coverage provider: v8
  - Node environment

**Build/Dev:**
- Node --watch - Development hot reload (`npm run dev`)
- PM2 - Production process management
  - Config: `ecosystem.config.cjs`
  - Single fork instance with autorestart

## Key Dependencies

**Critical:**
- @hapi/hapi 21.3.12 - HTTP server framework
- @hapi/boom 10.0.1 - HTTP error responses
- @hapi/inert 7.1.0 - Static file/stream support
- joi 17.13.3 - Request/payload validation
- dotenv 16.4.7 - Environment variable loading

**Infrastructure:**
- parakeet-mlx - Audio transcription model (MLX backend)
  - Auto-downloads ~2.5GB model on first run
  - Repository: `mlx-community/parakeet-tdt-0.6b-v3`
- mlx-audio - TTS synthesis library with Kokoro support
  - Model: `mlx-community/Kokoro-82M-bf16`
  - Auto-downloads ~300MB model to `models/kokoro-tts/`
- huggingface_hub - Model download management
  - Used by TTS daemon for model fetching
- soundfile - WAV file writing
- numpy - Audio processing

**Development:**
- @vitest/coverage-v8 3.0.4 - Test coverage reporting

## Configuration

**Environment:**
- Configuration loaded via `dotenv` from `.env` file
- Config centralized in `src/config/index.js`
- Key configs: server port/host, TTS model ID, voice/speed defaults, timeouts, file size limits

**Build:**
- PM2 configuration: `ecosystem.config.cjs`
- Vitest configuration: `vitest.config.js`
- Test setup file: `tests/setup.js`

**Environment Variables (from .env.example):**
```
PORT=3000
HOST=0.0.0.0
TTS_MODEL_ID=mlx-community/Kokoro-82M-bf16
TTS_DEFAULT_VOICE=af_heart
TTS_DEFAULT_SPEED=1.0
TTS_TIMEOUT=60000
TTS_DAEMON_STARTUP_TIMEOUT=60000
PREWARM_TTS=true
TRANSCRIBE_TIMEOUT=300000
DAEMON_STARTUP_TIMEOUT=120000
PREWARM_TRANSCRIPTION=true
MAX_FILE_SIZE_MB=100
```

## System Requirements

**Development:**
- Apple Silicon Mac (M1/M2/M3/M4+) required for MLX acceleration
- FFmpeg (`brew install ffmpeg`) - Audio format conversion (opus encoding)
- uv (`brew install uv`) - Python package runner
- Python 3.10+ virtual environment at `.venv/`

**Production:**
- Apple Silicon Mac only (MLX is Apple Silicon exclusive)
- Deployment via PM2
- Sufficient RAM for model loading (~3GB for both transcription and TTS models)

## Threading & Parallelism

**ORT Configuration (via ecosystem.config.cjs):**
- `OMP_NUM_THREADS=4` - OpenMP threads
- `ORT_INTRA_OP_NUM_THREADS=4` - Parallelism within operations (matmul, etc.)
- `ORT_INTER_OP_NUM_THREADS=1` - Sequential between operations (daemon serializes requests)

This configuration allows intra-op parallelism for faster single-inference performance while keeping inter-op sequential due to serialized request handling.

---

*Stack analysis: 2026-01-23*
