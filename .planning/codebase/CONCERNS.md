# Codebase Concerns

**Analysis Date:** 2026-01-23

## Tech Debt

**Hardcoded Python binary paths:**
- Issue: Services assume `.venv/bin/python3` exists at a fixed relative path. If venv is created differently or moved, daemons will fail to start.
- Files: `src/services/transcription.js` (line 36), `src/services/tts.js` (line 36)
- Impact: Deployment failures in non-standard environments, CI/CD pipeline breakage, difficult local development setup variations
- Fix approach: Detect Python path via which/environment variables, or make it configurable with fallback to `python3` from PATH

**Daemon lifecycle not exposed:**
- Issue: Daemon state (daemonReady, daemonProcess, initPromise) is module-scoped private state with no way to query or control it from outside. Testing and monitoring are difficult.
- Files: `src/services/transcription.js` (lines 10-15), `src/services/tts.js` (lines 10-15)
- Impact: Tests rely on mocking, production monitoring can't verify daemon health, no graceful recovery without restart
- Fix approach: Expose daemon status via public methods (`isReady()`, `getStatus()`, `forceRestart()`), add health check endpoint

**Large model files stored without cleanup policy:**
- Issue: Models are auto-downloaded to disk (`models/kokoro-tts/`, `~/.cache/huggingface/`) with no cleanup or quota management. Combined with parakeet model (~2.5GB), disk usage becomes uncontrolled.
- Files: `scripts/tts_daemon.py` (lines 43-64), parakeet not shown but similar pattern
- Impact: Disk space exhaustion in long-running deployments, failed deployments on disk-limited systems
- Fix approach: Document model caching behavior, provide cleanup script, add configuration for model cache location

**Error messages too generic:**
- Issue: TranscriptionError and TTSError both convert to Boom.badImplementation() (HTTP 500), losing distinction between client errors, service errors, and daemon failures.
- Files: `src/utils/errors.js` (lines 10-12, 22-24)
- Impact: API clients can't distinguish retryable vs permanent failures, poor observability
- Fix approach: Use appropriate HTTP status codes (400 for validation, 503 for service unavailable, 500 for internal errors)

**Incomplete timestamps extraction:**
- Issue: Transcription timestamps extraction method `_extract_timestamps()` catches exceptions silently and returns empty array if parsing fails.
- Files: `scripts/parakeet_daemon.py` (lines 87-103)
- Impact: Timestamps silently missing without indication to caller, incomplete subtitle data without warning
- Fix approach: Return error indication or field in response to signal timestamp extraction failure

## Known Bugs

**Missing ffmpeg dependency handling:**
- Symptoms: TTS route calls ffmpeg without checking if it's installed, will crash if user hasn't installed ffmpeg
- Files: `src/routes/tts.js` (lines 74-80, 93-99)
- Trigger: Any TTS request with format='opus' or timestamps=true on system without ffmpeg
- Workaround: Pre-install ffmpeg (`brew install ffmpeg` on macOS)
- Fix approach: Check for ffmpeg availability on startup, return clear error message if missing

**Daemon process leak on shutdown timeout:**
- Symptoms: If daemon doesn't respond to shutdown within 5 seconds, SIGKILL is sent but process reference is kept
- Files: `src/services/transcription.js` (lines 186-190), `src/services/tts.js` (lines 225-230)
- Trigger: Slow daemon causing SIGKILL fallback during graceful shutdown
- Workaround: None, just exit and kill process from outside
- Fix approach: Clear process reference after SIGKILL to prevent double-kill attempts, add zombie process cleanup

**Health endpoint doesn't check daemon status:**
- Symptoms: `/health` returns 200 OK even if transcription/TTS daemons are dead
- Files: `src/routes/health.js` (lines 1-13)
- Trigger: Call `/health` while daemons have crashed or aren't initialized
- Workaround: Call `/transcribe` or `/tts` to discover real status
- Fix approach: Include daemon health in `/health` response

**Request ID counter can overflow:**
- Symptoms: After ~2 billion requests, requestIdCounter wraps around, colliding with old pending requests
- Files: `src/services/transcription.js` (line 14), `src/services/tts.js` (line 14)
- Trigger: Server running for months with high request volume
- Workaround: Restart server periodically
- Fix approach: Use UUID or timestamp-based request IDs instead of simple counter

**Command injection vulnerability in ffmpeg calls:**
- Symptoms: Text input isn't escaped before being passed to daemon, which writes it to audio. If specially crafted text contains escape sequences, could theoretically affect ffmpeg processing (though mlx-audio should handle this safely)
- Files: `src/routes/tts.js` (lines 74-80, 93-99) - execFileAsync uses array form which is safe, but `text` parameter comes from untrusted source
- Trigger: Unlikely with current mlx-audio implementation, but architectural issue
- Workaround: Current implementation is safe because execFileAsync uses array argument form
- Fix approach: Document that text is untrusted input, add validation layer

## Security Considerations

**Environment variables exposed in daemon spawn:**
- Risk: Full process.env is passed to daemon with `{ ...process.env, PYTHONUNBUFFERED: '1' }`. Any secrets in env are accessible to Python daemon.
- Files: `src/services/transcription.js` (line 39), `src/services/tts.js` (line 39)
- Current mitigation: CLAUDE.md restricts .env files, but no runtime enforcement
- Recommendations: Only pass whitelisted env vars to daemon; store secrets outside env if possible

**No request validation on audio file content:**
- Risk: Uploaded audio files aren't validated before processing. Malformed audio could crash daemon or trigger unexpected behavior.
- Files: `src/routes/transcribe.js` (lines 38-51)
- Current mitigation: File size limit (MAX_FILE_SIZE_MB), Hapi handles multipart parsing
- Recommendations: Add mime-type validation, verify audio file format before passing to daemon

**Model auto-download from internet without verification:**
- Risk: TTS daemon auto-downloads model from HuggingFace without integrity verification. MITM or compromised HF account could inject malicious model.
- Files: `scripts/tts_daemon.py` (lines 43-64)
- Current mitigation: snapshot_download() uses standard HTTPS, HF provides integrity checks (not explicitly verified in code)
- Recommendations: Pin model commit hash, add hash verification before loading, consider pre-downloading models

**Daemon input/output is unvalidated JSON:**
- Risk: Daemon processes untrusted text input in JSON, Python daemon parses untrusted JSON responses. Malformed JSON could crash daemon or trigger edge cases.
- Files: Both daemons use `json.loads()` without additional validation (handled gracefully), Node side uses `JSON.parse()` (line 62 in tts.js)
- Current mitigation: Error handling catches parse failures and responds with error, but parsing is still potential DoS vector
- Recommendations: Add JSON schema validation on both sides, set size limits on stdin/stdout

**No rate limiting or request throttling:**
- Risk: API can be flooded with requests, overwhelming daemons or exhausting resources
- Files: All routes in `src/routes/`
- Current mitigation: None
- Recommendations: Add Hapi rate limiting plugin, implement request queue with backpressure

## Performance Bottlenecks

**Single daemon per service under concurrent load:**
- Problem: Both transcription and TTS use single daemon with sequential processing. 100 concurrent requests will queue behind daemon capacity.
- Files: `src/services/transcription.js` (line 11, module-level singleton), `src/services/tts.js` (line 11, module-level singleton)
- Cause: Intentional design (models kept in memory), but no multi-daemon pooling
- Improvement path: Implement daemon pool/queue, or add multiple daemon processes with load balancing

**Model loading happens on first request:**
- Problem: First transcription/TTS request is very slow (~5-30 seconds) while model loads from disk, causing user-facing latency spike
- Files: `src/index.js` (lines 32-40) has pre-warming but requires config flags
- Cause: Lazy initialization, pre-warming disabled by default
- Improvement path: Make pre-warming mandatory or async-on-startup without blocking server start

**Large audio files processed entirely in memory:**
- Problem: Uploaded files are piped to temp disk, but daemon reads entire file into memory. 100MB+ files could OOM the Python process.
- Files: `src/routes/transcribe.js` (lines 49-51), `scripts/parakeet_daemon.py` (line 59, `model.transcribe(audio_path)`)
- Cause: Parakeet-mlx API expects file path, but loads whole file internally
- Improvement path: Add chunked processing or streaming, or limit max file size more aggressively

**ffmpeg re-encoding on every opus request:**
- Problem: Every TTS request with format='opus' or timestamps=true spawns new ffmpeg process to re-encode WAV->opus
- Files: `src/routes/tts.js` (lines 74-80, 93-99)
- Cause: Daemon only generates WAV, conversion is done per-request
- Improvement path: Cache encoded formats, extend daemon to generate opus directly, or make opus encoding optional

**No caching of transcription/TTS results:**
- Problem: Identical requests re-run full processing pipeline with no memoization
- Files: No caching layer in services or routes
- Cause: Stateless design, each request independent
- Improvement path: Add optional Redis/in-memory cache layer for identical inputs (careful with privacy implications)

## Fragile Areas

**Daemon restart logic on unexpected exit:**
- Files: `src/services/transcription.js` (lines 88-105), `src/services/tts.js` (lines 103-119)
- Why fragile: If daemon crashes mid-request, pending requests are rejected but service tries to restart on next request. If startup fails repeatedly, 120-second timeout blocks everything.
- Safe modification: Wrap _ensureDaemon() calls with exponential backoff, add circuit breaker pattern
- Test coverage: Only basic mocking in tests, no actual daemon crash simulation

**Temporary file cleanup on exception:**
- Files: `src/routes/transcribe.js` (lines 73-76), `src/routes/tts.js` (lines 119-122)
- Why fragile: If exception is thrown after tempDir is created but before cleanup, directory is orphaned. Some error paths might not reach finally block.
- Safe modification: Use try-finally consistently, add cleanup registry with periodic cleanup
- Test coverage: No explicit test for orphaned temp dirs

**Python daemon communication protocol (JSON lines over stdin/stdout):**
- Files: Both daemons use readline() to read JSON requests
- Why fragile: If daemon logs to stdout (accidentally or during imports), it corrupts the protocol. No framing, length-prefixing, or message boundaries.
- Safe modification: Use message framing (length-prefixed or delimited), or switch to socket-based IPC
- Test coverage: Not tested with noisy imports or concurrent requests

**Timestamps field presence inconsistent:**
- Files: `src/services/transcription.js` (lines 74-77), `src/services/tts.js` (lines 88-90)
- Why fragile: Response includes timestamps field only if present in daemon response, so callers can't reliably check `if (result.timestamps)`. Sometimes undefined, sometimes empty array.
- Safe modification: Normalize to always include `timestamps: []` or `timestamps: null`
- Test coverage: Only tests request/response, not field presence guarantees

## Scaling Limits

**Single Node process on single core:**
- Current capacity: 1 transcription / 1 TTS request at a time (queued concurrently)
- Limit: ~10-50 requests/second depending on model; server becomes bottleneck after that
- Scaling path: Run multiple PM2 instances on different ports, load balance with nginx/haproxy

**Daemon memory footprint:**
- Current capacity: Parakeet-mlx ~2-3GB, Kokoro TTS ~500MB-1GB in memory
- Limit: 4GB system can support one of each daemon plus Node
- Scaling path: Use smaller models, or dedicated machines per daemon type

**Temp directory disk space:**
- Current capacity: Can handle ~100MB default file size, creates new temp dir per request
- Limit: /tmp fills up quickly with high concurrent load (100 × 100MB = 10GB per second of requests)
- Scaling path: Periodic cleanup job, move to larger disk, or reduce file size limits

**HuggingFace API rate limits for model downloads:**
- Current capacity: First-run downloads work, but no retry or resume on failure
- Limit: Concurrent model downloads could hit HF rate limits in multi-server deployment
- Scaling path: Pre-download models in Docker image, cache on shared storage

## Dependencies at Risk

**parakeet-mlx (unmaintained risk):**
- Risk: Small community project, not backed by major organization. Dependency chain includes MLX which is Apple-only.
- Impact: If abandoned, bugs unfixed, no support for future hardware
- Migration plan: Evaluate alternatives (Whisper, Wave2Vec, Conformer), have fallback ready

**mlx-audio library maturity:**
- Risk: Relatively new library (2024), API may change, edge cases in Kokoro integration
- Impact: Breaking changes in minor versions, compatibility issues
- Migration plan: Pin exact versions, monitor releases, maintain vendor fork if critical

**ffmpeg external dependency:**
- Risk: System binary not guaranteed, version differences cause behavior changes
- Impact: Deployment failures, encoding failures with old ffmpeg versions
- Migration plan: Use Node ffmpeg wrapper library, or Docker image with pinned ffmpeg

**Python 3.12 compatibility:**
- Risk: Codebase uses Python 3.10+ but not tested against 3.13+
- Impact: May break on future Python versions, especially with HuggingFace/MLX
- Migration plan: Add CI testing for multiple Python versions, pin `python >=3.10,<3.13` in requirements

## Missing Critical Features

**No API authentication:**
- Problem: Anyone can call /transcribe and /tts endpoints, no API keys or auth
- Blocks: Production deployments, multi-tenant scenarios, usage billing
- Implementation: Add Hapi auth plugin (hapi-auth-bearer-token), validate against env var or database

**No request queuing/priority:**
- Problem: High-load requests can starve low-load requests, no SLA guarantees
- Blocks: Fair resource allocation, time-bounded guarantees
- Implementation: Add Bull/RabbitMQ queue, implement priority levels

**No observability/metrics:**
- Problem: No structured logging, no Prometheus metrics, no traces
- Blocks: Debugging production issues, capacity planning, SLA monitoring
- Implementation: Add pino logger, prometheus-client, opentelemetry instrumentation

**No dead letter queue/retry logic:**
- Problem: If daemon crashes during request, request is lost with no retry
- Blocks: Reliability guarantees, fault tolerance
- Implementation: Add persistent queue, retry with exponential backoff

**No webhook/callback support:**
- Problem: Long-running transcriptions block client indefinitely
- Blocks: Async processing use cases, mobile client integration
- Implementation: Add job ID system, webhook callbacks, polling endpoint

## Test Coverage Gaps

**Daemon crash recovery not tested:**
- What's not tested: If daemon dies mid-transcription, does service recover? Restart? Error gracefully?
- Files: `src/services/transcription.js`, `src/services/tts.js`
- Risk: Critical failure mode, could cause cascading failures in production
- Priority: High - add integration test that kills daemon and verifies recovery

**Concurrent request handling under load:**
- What's not tested: Multiple simultaneous transcribe/TTS requests, request ordering, memory leaks
- Files: All daemon communication code
- Risk: Race conditions, queue corruption, memory exhaustion under production load
- Priority: High - add load test with Apache Bench or k6

**Edge cases in daemon responses:**
- What's not tested: Malformed JSON, timeout responses, partial results, NaN values in audio
- Files: `src/services/transcription.js` (lines 50-86), `src/services/tts.js` (lines 50-100)
- Risk: Crashes on unexpected daemon behavior, silent data corruption
- Priority: Medium - add unit tests for edge case response parsing

**File system error handling:**
- What's not tested: /tmp full, permission denied on temp dir, symlink attacks
- Files: `src/utils/tempFile.js`, `src/routes/transcribe.js`, `src/routes/tts.js`
- Risk: Server crash on filesystem errors, security vulnerability
- Priority: Medium - add error injection tests

**ffmpeg failure modes:**
- What's not tested: ffmpeg not installed, invalid output path, encoding failure
- Files: `src/routes/tts.js` (lines 74-99)
- Risk: Unhandled promise rejection, dangling file handles
- Priority: Medium - test ffmpeg missing scenario, add stdin validation

**Long-running daemon stability:**
- What's not tested: Daemon running for hours/days, memory leaks, accumulated zombie processes
- Files: All daemon code
- Risk: Production server degradation over time, slow OOM
- Priority: Medium - add integration test with 1000+ requests per daemon

---

*Concerns audit: 2026-01-23*
