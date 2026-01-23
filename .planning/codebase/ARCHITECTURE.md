# Architecture

**Analysis Date:** 2026-01-23

## Pattern Overview

**Overall:** Layered REST API with child process daemon architecture for ML model serving

**Key Characteristics:**
- Hapi.js HTTP server handles request/response lifecycle
- Long-running Python daemon processes maintain model state in memory
- JSON-line protocol over stdin/stdout for inter-process communication
- Stateless request processing with request ID matching for async correlation
- Graceful shutdown coordination across multiple subsystems

## Layers

**HTTP Request Layer:**
- Purpose: Handle incoming HTTP requests, validate payloads, coordinate responses
- Location: `src/routes/` (transcribe.js, tts.js, health.js, static.js)
- Contains: Route handlers with Joi validation, Hapi error handling, response formatting
- Depends on: Service layer for processing, TempFileManager for file handling
- Used by: External clients, browser UI

**Service Layer:**
- Purpose: Manage daemon lifecycle and request/response coordination
- Location: `src/services/` (transcription.js, tts.js)
- Contains: Daemon spawning, message protocol, pending request tracking, error handling
- Depends on: Python daemon processes, Config for timeouts/paths
- Used by: Route handlers for core business logic

**Daemon Layer (Python):**
- Purpose: Load and maintain ML models in memory, perform actual inference
- Location: `scripts/` (parakeet_daemon.py, tts_daemon.py)
- Contains: Model loading, inference loops, audio processing
- Depends on: MLX libraries (parakeet-mlx, mlx-audio), system ffmpeg
- Used by: Node services via JSON-line protocol

**Utility Layer:**
- Purpose: Cross-cutting concerns for file management, errors, configuration
- Location: `src/utils/` (tempFile.js, errors.js), `src/config/` (index.js)
- Contains: Temp file lifecycle management, custom error classes with Boom integration, env config
- Depends on: Node.js stdlib, dotenv
- Used by: All layers

## Data Flow

**Transcription Request Flow:**

1. Client uploads audio file via multipart POST to `/transcribe`
2. Route handler (`transcribe.js`) validates payload using Joi schema
3. Audio file written to temporary directory via `TempFileManager.createTempDir()`
4. `transcriptionService.transcribe(audioFilePath)` called with options
5. Service ensures daemon running via `_ensureDaemon()` → `initialize()` if needed
6. Service creates unique request ID, stores pending Promise in `Map<requestId, {resolve, reject}>`
7. JSON request sent to daemon stdin: `{id: "req-X", audio_path: "...", timestamps: false}`
8. Service sets timeout (default 300s) for request completion
9. Daemon processes audio, writes JSON response to stdout: `{id: "req-X", success: true, text: "...", timestamps: [...]}`
10. Service parses response, resolves Promise, returns result to handler
11. Handler formats response (with/without timestamps) and returns JSON or error
12. Finally block cleans up temp directory via `tempFileManager.cleanup(tempDir)`
13. On error, Boom error thrown to Hapi for error response formatting

**TTS Request Flow:**

1. Client sends JSON POST to `/tts` with text, voice, speed, format parameters
2. Route handler validates via Joi schema
3. Creates temp directory for output audio file
4. `ttsService.generate(text, options)` called with voice/speed/outputPath
5. Service ensures daemon running, creates request ID, stores pending Promise
6. JSON request sent: `{id: "req-Y", text: "...", voice: "...", speed: 1.0, output_path: "...", timestamps: false}`
7. Daemon generates audio to specified path, sends JSON response: `{id: "req-Y", success: true, output_path: "...", duration: 5.2, timestamps: [...]}`
8. Service resolves Promise with outputPath and duration
9. Handler reads generated WAV file from disk
10. Based on format parameter: return as WAV binary, convert to Opus (via ffmpeg), or return base64 in JSON
11. Finally block cleans up temp directory
12. On error, Boom error thrown

**Daemon Startup Flow:**

1. `initialize()` called on first request or during server prewarming
2. Check if already ready or initialization in progress (prevents race conditions)
3. `_startDaemon()` spawns Python process at `scripts/parakeet_daemon.py` or `scripts/tts_daemon.py`
4. Python process loads model (can take 30-120 seconds)
5. Service listens to daemon stdout for JSON responses
6. When daemon outputs `{status: "ready"}`, service resolves initialization Promise
7. If error response or timeout occurs, service rejects with `TranscriptionError` or `TTSError`
8. If daemon exits unexpectedly, all pending requests rejected with error
9. Future requests detect daemon down and attempt restart

**Graceful Shutdown Flow:**

1. Process receives SIGINT or SIGTERM
2. `gracefulShutdown()` in `src/index.js` called
3. Parallel Promise.all of:
   - `tempFileManager.cleanupAll()` removes all temp directories
   - `transcriptionService.shutdown()` sends shutdown command to daemon, waits 5s, kills if needed
   - `ttsService.shutdown()` sends shutdown command to daemon, waits 5s, kills if needed
4. All pending requests rejected with error
5. Process exits with code 0

## Key Abstractions

**Daemon Service Pattern (TranscriptionService, TTSService):**
- Purpose: Abstract daemon lifecycle, message protocol, and request matching
- Examples: `src/services/transcription.js`, `src/services/tts.js`
- Pattern:
  - Module-level singleton state (daemonProcess, daemonReady, pendingRequests Map)
  - `initialize()` with deduplication (returns same Promise if already initializing)
  - `_ensureDaemon()` auto-restart capability
  - `transcribe()`/`generate()` return Promises with timeout protection
  - `shutdown()` graceful termination with fallback to SIGKILL

**Custom Error Classes:**
- Purpose: Provide domain-specific errors with Hapi integration
- Examples: `TranscriptionError`, `TTSError`, `FileUploadError`
- Pattern: Extend Error, implement `toBoom()` method for automatic Hapi error conversion

**Temp File Manager:**
- Purpose: Track and clean up temporary files and directories
- Examples: `src/utils/tempFile.js`
- Pattern: Set-based tracking of all created temp dirs, bulk cleanup on shutdown

**Route Aggregation:**
- Purpose: Centralize all routes for easy registration
- Examples: `src/routes/index.js`
- Pattern: Spread operator combines route arrays from feature modules

## Entry Points

**Server Startup:**
- Location: `src/index.js`
- Triggers: `npm start` or `npm run dev` or PM2
- Responsibilities:
  - Import startServer from server.js
  - Set up process signal handlers for graceful shutdown
  - Handle unhandled rejections
  - Optional daemon prewarming based on env config
  - Call startServer() and await

**Server Creation:**
- Location: `src/server.js`
- Triggers: Called by index.js
- Responsibilities:
  - Create Hapi server instance with config (port/host from env)
  - Register plugins (currently @hapi/inert for static file serving)
  - Register all routes from routes/index.js
  - Provide three exports: createServer (config only), initServer (initialized, not started), startServer (started, listening)

**HTTP Routes:**
- Location: `src/routes/` modules
- Triggers: Hapi routes array registration in server.js
- Responsibilities:
  - Parse and validate request payloads with Joi schemas
  - Call service methods with parsed data
  - Format responses (JSON or binary)
  - Handle and convert errors to Boom responses

## Error Handling

**Strategy:** Layered error conversion with custom error classes

**Patterns:**
- Services throw custom errors (`TranscriptionError`, `TTSError`) with optional cause
- Routes catch errors and either throw Boom (if isBoom already) or wrap in `Boom.badImplementation()`
- Daemon responses with `success: false` trigger service error rejection
- Daemon exit/timeout trigger pending request rejection with error
- File operations throw native Node errors, caught and converted to Boom in routes
- Validation errors caught by Hapi, converted to 400 by validation handler

## Cross-Cutting Concerns

**Logging:** Console.log calls throughout
- Startup events logged in services (_startDaemon, daemon ready)
- Daemon stderr piped to console (prefixed with daemon name)
- Performance timing logged after TTS requests (duration in seconds)
- Errors logged with context (error type, file/operation)
- Graceful shutdown logged with signal received

**Validation:** Joi schemas in route options
- Transcribe: file (required), timestamps (optional string 'true'/'false')
- TTS: text (required, 1-10000 chars), voice (string), speed (0.5-2.0), format (wav/opus/buffer), timestamps (boolean)
- Joi failAction throws error immediately, caught by route error handler

**Authentication:** Not implemented
- Server runs with CORS enabled (routes.cors: true in Hapi config)
- No auth middleware or token validation in routes
- Suitable for internal/private API or WebUI consumption
