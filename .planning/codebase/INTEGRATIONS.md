# External Integrations

**Analysis Date:** 2026-01-23

## APIs & External Services

**HuggingFace Hub:**
- Used for ML model downloads and management
- TTS daemon automatically downloads Kokoro model on first run
- Transcription daemon downloads parakeet-mlx model on first run
- Implementation: `huggingface_hub.snapshot_download()` in Python daemons

**FFmpeg:**
- External process for audio format conversion
- Used by TTS endpoint to convert WAV to Opus codec (32k bitrate)
- Invoked via Node.js `execFile()` in `src/routes/tts.js`
- Required system dependency: `brew install ffmpeg`

## Data Storage

**Databases:**
- None - stateless REST API

**File Storage:**
- Local filesystem only
  - Model cache: `models/kokoro-tts/` (auto-created, ~300MB)
  - Temporary files: Created per-request in system temp directories
  - Managed by `src/utils/tempFile.js` with automatic cleanup
- No cloud storage integrations

**Caching:**
- Model caching via HuggingFace Hub locally (automatically by parakeet-mlx and mlx-audio libraries)
- No distributed cache (Redis, Memcached, etc.)
- In-memory daemon state for request/response matching via `Map<requestId, promise>`

## Authentication & Identity

**Auth Provider:**
- None - API is unauthenticated
- No API key requirement
- No session/token management

**CORS:**
- Enabled globally: `cors: true` in `src/server.js`
- Accessible from any origin

## Monitoring & Observability

**Error Tracking:**
- None - no external error tracking service

**Logs:**
- Console logs to stdout/stderr
- Daemon stderr output forwarded to Node process: `daemonProcess.stderr.on('data', ...)`
- No external log aggregation

**Performance Logging:**
- TTS endpoint logs request duration: `TTS request completed in ${durationMs}ms`
- Transcription and TTS services log daemon initialization and shutdown

## CI/CD & Deployment

**Hosting:**
- Self-hosted on Apple Silicon Mac
- PM2 process manager for production (config: `ecosystem.config.cjs`)
- Graceful shutdown on SIGTERM/SIGINT with daemon cleanup

**CI Pipeline:**
- None detected - no GitHub Actions, GitLab CI, or similar

**Environment Configuration:**
- Loaded from `.env` file via dotenv
- Separate dev and production PM2 profiles via `env` and `env_production`

## Webhooks & Callbacks

**Incoming:**
- None - synchronous REST API only

**Outgoing:**
- None - no external service callbacks

## ML Model Sources

**Transcription Model:**
- Repository: `mlx-community/parakeet-tdt-0.6b-v3`
- Auto-downloads from HuggingFace on first run (~2.5GB)
- Backend: parakeet-mlx library
- Loaded by `scripts/parakeet_daemon.py`

**TTS Model:**
- Repository: `mlx-community/Kokoro-82M-bf16`
- Auto-downloads from HuggingFace to `models/kokoro-tts/` on first run (~300MB)
- Backend: mlx-audio library
- Loaded by `scripts/tts_daemon.py`
- Language-aware voices: American English (af_*, am_*), British English (bf_*, bm_*), Japanese (jf_*, jm_*), Chinese (zf_*, zm_*)

## Inter-Process Communication

**Daemon Protocol:**
- Both Python daemons communicate with Node.js via stdin/stdout JSON-line protocol
- Request format: `{"id": "unique-id", "audio_path": "...", ...}`
- Response format: `{"id": "unique-id", "success": true, ...}` or `{"id": "unique-id", "success": false, "error": "..."}`
- Services track pending requests via `Map<requestId, {resolve, reject}>`

**Process Management:**
- Daemons spawned from Node.js: `spawn(pythonPath, [daemonPath])`
- Python paths: `.venv/bin/python3`
- Graceful shutdown: Send JSON shutdown command to stdin
- Forced kill timeout: 5 seconds before SIGKILL
- Auto-restart if daemon dies unexpectedly

## Audio Processing

**Audio Input:**
- Formats supported: Any format ffmpeg can handle (uploaded as multipart file)
- Size limit: Configurable via `MAX_FILE_SIZE_MB` (default 100MB)
- Stored temporarily during processing, auto-cleaned up after request

**Audio Output (TTS):**
- Default format: WAV (sample rate: 24000 Hz)
- Optional conversion to Opus via ffmpeg
- Optional base64-encoded JSON response with timestamps
- Formats: `wav`, `opus`, `buffer` (base64 WAV)

## Required Environment Configuration

**Critical env vars:**
- `PORT` - Server port (default 3000)
- `HOST` - Server host (default 0.0.0.0)
- `TTS_MODEL_ID` - HuggingFace model ID for TTS (default: mlx-community/Kokoro-82M-bf16)
- `TTS_DEFAULT_VOICE` - Default voice for TTS (default: af_heart)
- `MAX_FILE_SIZE_MB` - Max upload file size (default: 100)

**Optional env vars:**
- `TTS_TIMEOUT` - TTS generation timeout in ms (default 60000)
- `TRANSCRIBE_TIMEOUT` - Transcription timeout in ms (default 300000)
- `PREWARM_TTS` - Pre-load TTS model on startup (default: true)
- `PREWARM_TRANSCRIPTION` - Pre-load transcription model on startup (default: true)
- `DAEMON_STARTUP_TIMEOUT` - Max time for daemon to start (default 120000)
- `TTS_DAEMON_STARTUP_TIMEOUT` - Max time for TTS daemon to start (default 60000)

**Secrets location:**
- Environment variables via `.env` file (not committed to git)
- No API keys or secrets required (API is public)

---

*Integration audit: 2026-01-23*
