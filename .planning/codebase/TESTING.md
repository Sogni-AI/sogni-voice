# Testing Patterns

**Analysis Date:** 2026-01-23

## Test Framework

**Runner:**
- Vitest 3.0.4
- Config: `vitest.config.js`

**Assertion Library:**
- Vitest built-in assertions (expect API)

**Run Commands:**
```bash
npm test              # Run tests in watch mode (vitest)
npm run test:run      # Run tests once (vitest run)
npm run test:coverage # Run tests with coverage (vitest run --coverage)
```

## Test File Organization

**Location:**
- Unit tests: `tests/unit/{feature}/` mirroring source structure
- Integration tests: `tests/integration/{feature}.test.js`
- Setup file: `tests/setup.js` (global beforeEach hook)

**Naming:**
- `{module}.test.js` (e.g., `transcription.test.js`, `errors.test.js`, `health.test.js`)

**Structure:**
```
tests/
├── unit/
│   ├── config/
│   │   └── config.test.js
│   ├── services/
│   │   ├── transcription.test.js
│   │   └── tts.test.js
│   └── utils/
│       ├── errors.test.js
│       └── tempFile.test.js
├── integration/
│   ├── health.test.js
│   ├── transcribe.test.js
│   └── tts.test.js
└── setup.js
```

## Test Structure

**Suite Organization:**
```javascript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('TranscriptionService', () => {
  let service;

  beforeEach(async () => {
    // Setup
    vi.clearAllMocks();
    vi.resetModules();
    service = new TranscriptionService();
  });

  afterEach(async () => {
    // Teardown
    await service.shutdown();
  });

  describe('initialize', () => {
    it('should start daemon and wait for ready signal', async () => {
      // Arrange
      const initPromise = service.initialize();

      // Act
      setTimeout(() => {
        mockStdout.push('{"status":"ready"}\n');
      }, 10);

      // Assert
      await initPromise;
      expect(service.isReady()).toBe(true);
    });
  });
});
```

**Patterns:**
- `describe()` blocks group related tests by method/feature
- `beforeEach()` resets mocks and creates fresh service instance
- `afterEach()` cleans up resources (daemon shutdown)
- Nested `describe()` blocks for method grouping
- Async tests use `async ()`
- Fake timers with `vi.useFakeTimers()` and `vi.advanceTimersByTime()`
- Reset to real timers with `vi.useRealTimers()`

## Mocking

**Framework:** Vitest's `vi` module (vi.mock, vi.spyOn, vi.fn)

**Patterns:**
```javascript
// Mock entire module before importing
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

// Re-import after module reset
const { spawn } = await import('node:child_process');
freshSpawn.mockReturnValue(mockProcess);

// Spy on console
const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
consoleSpy.mockRestore();
```

**What to Mock:**
- External dependencies: `node:child_process` (daemon spawning)
- Framework features that would complicate tests
- Daemon responses (use mock stdout/stderr streams)
- Service dependencies in integration tests (e.g., `transcriptionService` mocked in route tests)

**What NOT to Mock:**
- Error classes (test real error behavior)
- Config loading (test with real env)
- File operations in utils tests (test real fs behavior)
- Route handlers (test with `server.inject()`)

## Fixtures and Factories

**Test Data:**
```javascript
// Mock streams created per test
mockStdin = new Writable({
  write(chunk, encoding, callback) {
    mockStdin.lastWrite = chunk.toString();
    callback();
  }
});
mockStdout = new Readable({ read() {} });

// Mock process with EventEmitter
mockProcess = new EventEmitter();
mockProcess.stdin = mockStdin;
mockProcess.stdout = mockStdout;
mockProcess.stderr = mockStderr;
mockProcess.kill = vi.fn();
```

**Location:**
- Fixtures created in `beforeEach()` hooks within test files
- No shared fixture files; each test suite sets up its own mocks
- Minimal test data passed as inline objects

## Coverage

**Requirements:**
- No enforced coverage requirements in vitest.config.js
- Coverage reporter configured: `['text', 'json', 'html']`

**View Coverage:**
```bash
npm run test:coverage
# Generates HTML report (path configurable, default in coverage/)
```

## Test Types

**Unit Tests:**
- Scope: Individual services, utilities, error classes
- Approach: Mock external dependencies, test single class/function behavior
- Location: `tests/unit/{category}/{module}.test.js`
- Examples: `transcription.test.js` tests TranscriptionService methods with mocked daemon
- Examples: `errors.test.js` tests custom error classes, toBoom() conversion
- Examples: `tempFile.test.js` tests TempFileManager class methods
- Examples: `config.test.js` tests config loading and parsing

**Integration Tests:**
- Scope: API endpoints, service integration
- Approach: Use `server.inject()` to test full request/response flow
- Mock only external services (daemons), not internal dependencies
- Location: `tests/integration/{endpoint}.test.js`
- Examples: `transcribe.test.js` tests POST /transcribe endpoint, mocks transcriptionService
- Examples: `health.test.js` tests GET /health endpoint without mocks
- Examples: `tts.test.js` tests TTS endpoints

**E2E Tests:**
- Framework: Not used
- Rationale: Daemon processes would require actual Python environment; integration tests sufficient

## Common Patterns

**Async Testing:**
```javascript
it('should successfully transcribe', async () => {
  const transcribePromise = service.transcribe('/path/to/audio.mp3');

  // Wait a bit, then emit mock response
  await new Promise(resolve => setTimeout(resolve, 10));
  const request = JSON.parse(mockStdin.lastWrite);
  mockStdout.push(`{"id":"${request.id}","success":true,"text":"Transcribed"}\n`);

  const result = await transcribePromise;
  expect(result.text).toBe('Transcribed');
});

// Using fake timers
it('should timeout if daemon unresponsive', async () => {
  vi.useFakeTimers();

  const shutdownPromise = service.shutdown();
  vi.advanceTimersByTime(6000);

  await shutdownPromise;
  expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL');

  vi.useRealTimers();
});
```

**Error Testing:**
```javascript
it('should reject if daemon fails to start', async () => {
  const initPromise = service.initialize();

  setTimeout(() => {
    mockProcess.emit('error', new Error('spawn failed'));
  }, 10);

  await expect(initPromise).rejects.toThrow('Failed to spawn daemon');
});

it('should handle transcription errors', async () => {
  const transcribePromise = service.transcribe('/path/to/audio.mp3');

  await new Promise(resolve => setTimeout(resolve, 10));
  const request = JSON.parse(mockStdin.lastWrite);

  // Simulate daemon error
  mockStdout.push(`{"id":"${request.id}","success":false,"error":"Audio file not found"}\n`);

  await expect(transcribePromise).rejects.toThrow('Audio file not found');
});
```

**Module Reset Pattern:**
```javascript
beforeEach(async () => {
  vi.clearAllMocks();
  // Reset modules to clear singleton state (daemonReady, daemonProcess, etc.)
  vi.resetModules();

  // Re-mock after reset
  vi.doMock('node:child_process', () => ({
    spawn: vi.fn(),
  }));

  // Import fresh copy
  const module = await import('../../../src/services/transcription.js');
  TranscriptionService = module.TranscriptionService;
  service = new TranscriptionService();
});
```

**Server Injection Pattern (Integration Tests):**
```javascript
describe('POST /transcribe', () => {
  let server;

  beforeAll(async () => {
    // Initialize server without starting (for tests)
    server = await initServer();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('should transcribe uploaded file', async () => {
    // Use server.inject() to test without HTTP
    const response = await server.inject({
      method: 'POST',
      url: '/transcribe',
      headers: { 'content-type': 'multipart/form-data; boundary=----...' },
      payload: '------...\r\nContent-Disposition: form-data; name="file"...',
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.payload);
    expect(payload.success).toBe(true);
  });
});
```

**Global Setup:**
File: `tests/setup.js`
```javascript
import { vi } from 'vitest';

// Clear mocks between tests
beforeEach(() => {
  vi.clearAllMocks();
});
```

## Vitest Configuration Details

File: `vitest.config.js`
```javascript
export default defineConfig({
  test: {
    globals: true,                    // describe, it, expect available without imports
    environment: 'node',              // Node.js test environment
    setupFiles: ['./tests/setup.js'], // Global setup hook
    coverage: {
      provider: 'v8',                 // V8 coverage provider
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'tests/'],
    },
  },
});
```

---

*Testing analysis: 2026-01-23*
