# Codebase Structure

**Analysis Date:** 2026-01-23

## Directory Layout

```
sogni-voice/
├── src/                    # Application source code
│   ├── index.js           # Entry point, process handlers, server startup
│   ├── server.js          # Hapi server creation and initialization
│   ├── config/
│   │   └── index.js       # Environment configuration centralized
│   ├── routes/            # HTTP endpoint handlers (feature-based)
│   │   ├── index.js       # Route aggregation (spreads all route arrays)
│   │   ├── health.js      # GET /health endpoint
│   │   ├── transcribe.js  # POST /transcribe endpoint with handler
│   │   ├── tts.js         # POST /tts and GET /tts/voices endpoints
│   │   └── static.js      # GET /* catch-all for public/ directory
│   ├── services/          # Business logic and daemon coordination
│   │   ├── transcription.js # TranscriptionService: parakeet daemon lifecycle
│   │   └── tts.js         # TTSService: Kokoro TTS daemon lifecycle
│   ├── utils/             # Utility modules
│   │   ├── errors.js      # Custom error classes (TranscriptionError, TTSError, FileUploadError)
│   │   └── tempFile.js    # TempFileManager singleton for temp dir/file lifecycle
│   └── plugins/
│       └── index.js       # Hapi plugin registration (@hapi/inert for static files)
│
├── scripts/               # Python daemon processes
│   ├── parakeet_daemon.py # Long-running parakeet-mlx transcription daemon
│   └── tts_daemon.py      # Long-running Kokoro TTS generation daemon
│
├── tests/                 # Test suite organized by layer
│   ├── setup.js           # Vitest global setup (if needed)
│   ├── unit/              # Unit tests mirroring src/ structure
│   │   ├── config/
│   │   │   └── config.test.js
│   │   ├── services/
│   │   │   ├── transcription.test.js
│   │   │   └── tts.test.js
│   │   └── utils/
│   │       ├── errors.test.js
│   │       └── tempFile.test.js
│   └── integration/       # API endpoint tests using server.inject()
│       ├── health.test.js
│       ├── transcribe.test.js
│       └── tts.test.js
│
├── public/                # Static HTML files served by GET /*
│   ├── index.html
│   └── docs.html
│
├── models/                # ML model cache directory (auto-populated)
│   └── kokoro-tts/        # Kokoro model cached locally, downloaded from HuggingFace
│
├── .planning/             # GSD documentation
│   └── codebase/          # Output directory for mapping documents
│
├── .venv/                 # Python virtual environment
├── .env                   # Local environment variables (git-ignored)
├── .env.example           # Template for required env vars
├── .gitignore             # Excludes .venv, node_modules, .env
│
├── package.json           # Node dependencies and scripts
├── package-lock.json      # Locked dependency versions
├── vitest.config.js       # Vitest test runner configuration
├── ecosystem.config.cjs   # PM2 process manager configuration
│
├── README.md              # Project documentation
├── IMPLEMENTATION.md      # Implementation notes
├── CLAUDE.md              # Claude Code project-specific instructions
└── voice.sogni.ai.conf    # Nginx configuration (if deployed)
```

## Directory Purposes

**src/:**
- Purpose: All production Node.js code
- Contains: Hapi server setup, routes, services, utilities, configuration
- Key files: `index.js` (entry), `server.js` (Hapi setup), `config/index.js` (env loading)

**src/routes/:**
- Purpose: HTTP endpoint handlers grouped by feature
- Contains: Route definitions with Hapi method/path/handler, Joi validation, response formatting
- Key files: `transcribe.js` (audio processing), `tts.js` (speech generation), `health.js` (liveness)

**src/services/:**
- Purpose: Business logic and daemon process coordination
- Contains: Daemon spawning, stdin/stdout communication, pending request tracking
- Key files: `transcription.js` (parakeet coordination), `tts.js` (Kokoro coordination)

**src/utils/:**
- Purpose: Cross-cutting utilities and error handling
- Contains: Temp file management, custom error classes
- Key files: `errors.js` (custom errors with Boom), `tempFile.js` (lifecycle tracking)

**src/config/:**
- Purpose: Centralized environment variable loading and defaults
- Contains: Server config (port, host), service timeouts, upload limits
- Key files: `index.js` (loads dotenv, exports config object)

**scripts/:**
- Purpose: Python daemon processes running ML inference
- Contains: Model loading, request loop, audio processing
- Key files: `parakeet_daemon.py` (transcription), `tts_daemon.py` (TTS)

**tests/unit/:**
- Purpose: Unit tests for individual modules
- Contains: Service mocks, error scenarios, function behavior tests
- Pattern: Files mirror `src/` structure (tests/unit/services/transcription.test.js mirrors src/services/transcription.js)
- Tools: Vitest with mocking via `vi.mock()`, stream mocks for daemon testing

**tests/integration/:**
- Purpose: API endpoint tests using Hapi server.inject()
- Contains: Full request/response cycles with mocked services
- Pattern: Mocks lower layers (services), tests route handlers and validation
- Setup: Uses `initServer()` from server.js to initialize without starting

**public/:**
- Purpose: Static HTML served by catch-all GET /* route
- Contains: Browser UI files and documentation
- Served via: `@hapi/inert` plugin, route handler in `static.js`

**models/:**
- Purpose: Local ML model cache
- Contains: Downloaded Kokoro TTS model and config
- Generated: Yes (auto-downloaded from HuggingFace on first TTS daemon run)
- Committed: No (gitignored, large binary files)

## Key File Locations

**Entry Points:**
- `src/index.js`: Main entry point called by `npm start` or `node src/index.js`
- `src/server.js`: Server factory functions (createServer, initServer, startServer)
- `src/routes/index.js`: Route aggregation and registration

**Configuration:**
- `src/config/index.js`: All env vars loaded via dotenv, exported as config object
- `.env`: Local environment variables (git-ignored)
- `.env.example`: Template showing required vars

**Core Logic:**
- `src/services/transcription.js`: Transcription daemon lifecycle and message protocol
- `src/services/tts.js`: TTS daemon lifecycle and message protocol
- `src/routes/transcribe.js`: Audio upload handling and transcription endpoint
- `src/routes/tts.js`: Text-to-speech generation endpoint

**Testing:**
- `tests/integration/transcribe.test.js`: POST /transcribe endpoint tests
- `tests/integration/tts.test.js`: POST /tts endpoint tests
- `tests/unit/services/transcription.test.js`: TranscriptionService unit tests
- `tests/unit/services/tts.test.js`: TTSService unit tests

**Utilities:**
- `src/utils/errors.js`: Custom error classes
- `src/utils/tempFile.js`: Temporary file management
- `scripts/parakeet_daemon.py`: Transcription daemon
- `scripts/tts_daemon.py`: TTS daemon

## Naming Conventions

**Files:**
- Source files: lowercase with hyphens (e.g., `temp-file.js`) or camelCase (e.g., `tempFile.js`) - currently uses camelCase
- Route files: feature name (transcribe.js, tts.js, health.js)
- Test files: mirror source with `.test.js` suffix (transcription.test.js)
- Python scripts: snake_case (parakeet_daemon.py, tts_daemon.py)
- Config files: index.js in each directory that exports primary export

**Directories:**
- Feature grouping: lowercase (routes, services, utils, config)
- Layer directories: descriptive purpose (unit, integration)

**Variables & Imports:**
- Service singletons: camelCase (transcriptionService, ttsService, tempFileManager)
- Classes: PascalCase (TranscriptionService, TTSService, TempFileManager)
- Constants: SCREAMING_SNAKE_CASE (internal to modules only, none exported)

**Export Patterns:**
- Named exports for classes: `export class TranscriptionService {}`
- Default singleton exports: `export const transcriptionService = new TranscriptionService()`
- Route arrays: `export const transcribeRoutes = [{ ... }]`
- Aggregation via spread: `export const routes = [...healthRoutes, ...transcribeRoutes, ...]`

## Where to Add New Code

**New Feature (e.g., new endpoint):**
- Primary code: Create `src/routes/feature-name.js` with route array export
- Service layer: Create `src/services/feature-name.js` if needs daemon or business logic
- Tests: Create `tests/integration/feature-name.test.js` for endpoint, `tests/unit/services/feature-name.test.js` for service
- Integration: Import and spread routes in `src/routes/index.js`

**New Component/Module:**
- Implementation: Place in appropriate `src/` subdirectory (services, utils, config, plugins)
- Tests: Mirror structure in `tests/unit/` or `tests/integration/`
- Export pattern: Use named export for classes, default singleton for instances

**Utilities:**
- Shared helpers: Add to `src/utils/` as separate file or method in existing utility
- Cross-cutting: Place in `src/utils/` with clear responsibility

**Configuration:**
- Environment variables: Add to `src/config/index.js` with dotenv fallback
- Server settings: Add to config object structure in `src/config/index.js`

**Routes:**
- New endpoints: Add object to route array in corresponding `src/routes/feature.js` file
- Shared validation: Extract Joi schema to separate variable in route file or utils

## Special Directories

**node_modules/:**
- Purpose: NPM dependencies
- Generated: Yes (via npm install)
- Committed: No (gitignored)

**.git/:**
- Purpose: Git repository metadata
- Generated: Yes (via git init)
- Committed: Automatically managed by git

**.venv/:**
- Purpose: Python virtual environment with daemon dependencies
- Generated: Yes (via `python3 -m venv .venv` and `uv pip install`)
- Committed: No (gitignored)

**.env:**
- Purpose: Local environment configuration (secrets, API keys, timeouts)
- Generated: No (template provided as .env.example)
- Committed: No (gitignored for security)

**models/kokoro-tts/:**
- Purpose: Cached Kokoro TTS model downloaded from HuggingFace
- Generated: Yes (auto-downloaded by tts_daemon.py on first run)
- Committed: No (gitignored, ~300MB binary files)

**.planning/codebase/:**
- Purpose: GSD codebase analysis documents (ARCHITECTURE.md, STRUCTURE.md, etc.)
- Generated: Yes (created by /gsd:map-codebase)
- Committed: Yes (guides future phases and implementation)

**public/:**
- Purpose: Static HTML files for browser UI and documentation
- Generated: No (manually created)
- Committed: Yes (part of distribution)
