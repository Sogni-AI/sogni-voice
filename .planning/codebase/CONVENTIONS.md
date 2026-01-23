# Coding Conventions

**Analysis Date:** 2026-01-23

## Naming Patterns

**Files:**
- kebab-case: `transcribe.js`, `temp-file.js`, `parakeet_daemon.py`
- Route files: `{feature}.js` (e.g., `transcribe.js`, `tts.js`, `health.js`)
- Service files: `{service-name}.js` (e.g., `transcription.js`, `tts.js`)
- Test files: `{module}.test.js` (e.g., `transcription.test.js`, `errors.test.js`)
- Utility files: descriptive names in `src/utils/` (e.g., `tempFile.js`, `errors.js`)

**Functions:**
- camelCase: `createServer()`, `startServer()`, `initServer()`, `transcribe()`, `generate()`, `listVoices()`
- Private/internal functions: prefixed with `_`: `_startDaemon()`, `_ensureDaemon()`
- Class methods: camelCase instance methods, same prefix convention: `initialize()`, `shutdown()`, `isReady()`
- Handler functions: `handler: async (request, h) => { ... }`

**Variables:**
- camelCase: `daemonProcess`, `daemonReady`, `initPromise`, `requestIdCounter`, `pendingRequests`
- Constants/singletons: camelCase instances: `transcriptionService`, `ttsService`, `tempFileManager`
- Module-level state: camelCase with descriptive names

**Types/Classes:**
- PascalCase for class names: `TranscriptionService`, `TTSService`, `TempFileManager`, `TranscriptionError`, `TTSError`, `FileUploadError`
- Class exports: both class and instance singleton (e.g., `export class TranscriptionService { }` and `export const transcriptionService = new TranscriptionService()`)

## Code Style

**Formatting:**
- No linter/formatter config found in project
- 2-space indentation observed
- Semicolons used consistently
- Single quotes for strings where Boom/Joi not required

**Linting:**
- No ESLint/Biome configuration detected
- Code follows conventional JavaScript patterns (Node.js idiomatic style)

## Import Organization

**Order:**
1. Node.js built-in modules (using `node:` prefix): `import { spawn } from 'node:child_process'`
2. Third-party dependencies: `import Hapi from '@hapi/hapi'`, `import Joi from 'joi'`, `import Boom from '@hapi/boom'`
3. Local application modules: `import { config } from '../config/index.js'`, `import { transcriptionService } from '../services/transcription.js'`
4. Blank line between groups

**Path Aliases:**
- No path aliases configured
- Relative imports used throughout: `../config/index.js`, `../../src/server.js`
- Absolute imports for Node.js builtins with `node:` prefix

## Error Handling

**Patterns:**
- Custom error classes extend `Error` with `name` property set: `this.name = 'TranscriptionError'`
- Custom errors include optional `cause` property for wrapped exceptions
- Error classes include `toBoom()` method to convert to Hapi Boom errors for HTTP responses
- `FileUploadError.toBoom()` returns `Boom.badRequest()` (400)
- `TranscriptionError.toBoom()` and `TTSError.toBoom()` return `Boom.badImplementation()` (500)
- Errors thrown in handlers checked with `error.isBoom` before re-throwing
- Sync errors wrapped in try/catch, async errors in try/catch with finally cleanup
- Errors logged to console.error() with context before re-throwing

## Logging

**Framework:** console (console.log, console.error)

**Patterns:**
- Lifecycle events logged with `console.log()`: daemon startup, readiness, shutdown
- Daemon output prefixed with `[daemon-name]`: `console.log('[parakeet-daemon] ...')`, `console.log('[tts-daemon] ...')`
- Errors logged with context: `console.error('Transcription error:', error)`
- Non-JSON daemon output filtered and logged but not spam console: check `if (!line.startsWith('{'))` before parsing JSON

## Comments

**When to Comment:**
- JSDoc-style comments for public methods with parameters/return types documented
- Inline comments for non-obvious logic (e.g., "// stdin may already be closed")
- Comments explaining why (not what) the code does
- State machine transitions documented (e.g., "// Daemon not available, attempting to start...")

**JSDoc/TSDoc:**
- Used consistently for public methods in services
- Format: `/** @param {type} name - description **/` and `@returns {type} description`
- Example from `transcription.js`:
```javascript
/**
 * Transcribe an audio file
 * @param {string} audioFilePath - Path to the audio file
 * @param {object} options - Transcription options
 * @param {boolean} options.timestamps - Include word/segment timestamps
 * @returns {Promise<{text: string, rawOutput: string, timestamps?: Array}>}
 */
async transcribe(audioFilePath, options = {}) {
```

## Function Design

**Size:**
- Mostly focused functions with single responsibility
- Service methods 20-40 lines (transcribe, generate)
- Internal methods like `_startDaemon()` 60-80 lines (justified by complex daemon setup)
- Route handlers 30-50 lines including validation and cleanup

**Parameters:**
- Explicit required parameters first
- Options object as second parameter with destructuring: `async transcribe(audioFilePath, options = {})`
- Destructure options with defaults: `const { timestamps = false } = options;`

**Return Values:**
- Promises for all async operations: `Promise<{text: string, rawOutput: string}>`
- Objects with consistent shape for service responses (e.g., transcription returns `{ text, rawOutput, timestamps? }`)
- Routes return JSON objects: `{ success: true, transcript, filename }` or `{ status: 'healthy', timestamp, uptime }`
- Errors thrown rather than returning error objects

## Module Design

**Exports:**
- Named exports for functions and classes
- Singleton instance exported as named export: `export const transcriptionService = new TranscriptionService()`
- Route arrays exported as named exports: `export const transcribeRoutes = [...]`
- Config object exported as named export: `export const config = { ... }`

**Barrel Files:**
- Used for route aggregation: `src/routes/index.js` imports all route arrays and exports combined array
- Used for plugin registration: `src/plugins/index.js` (pattern established, not shown)
- Not used for service/utility imports (direct imports preferred)

## Request ID Pattern

- Unique request ID generation: `const requestId = \`req-${++requestIdCounter}\``
- Incremental counter: `let requestIdCounter = 0` at module scope
- IDs used for matching daemon responses to pending requests in Map: `pendingRequests.set(requestId, { resolve, reject })`

## Daemon Communication Protocol

**Request Format:**
- JSON-line protocol (one JSON object per line)
- Request ID included: `{ id: requestId, ... }`
- Snake_case for daemon-specific fields: `audio_path`, `output_path` (JavaScript uses camelCase, daemon uses snake_case)
- Shutdown command: `{ command: 'shutdown' }`

**Response Format:**
- Status signals: `{ status: 'ready' }`, `{ status: 'error', error: '...' }`
- Success response: `{ id: requestId, success: true, text: '...', timestamps?: [...] }`
- Error response: `{ id: requestId, success: false, error: '...' }`

## Configuration

**Loading:**
- Environment variables loaded via `dotenv.config()` at startup in `src/config/index.js`
- Config object created as singleton with all parsed values
- Type conversions: `parseInt(process.env.PORT, 10)`, `parseFloat(process.env.TTS_DEFAULT_SPEED)`
- Defaults provided: `process.env.PORT || 3000`, `process.env.HOST || '0.0.0.0'`
- Negation defaults: `process.env.PREWARM_TTS !== 'false'` (defaults to true)

---

*Convention analysis: 2026-01-23*
