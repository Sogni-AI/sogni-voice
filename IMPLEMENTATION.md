# Sogni Transcribe - Complete Implementation Guide

Run these steps in order to build the complete project.

## Step 1: Install Dependencies

```bash
npm install
```

---

## Step 2: Create Directory Structure

```bash
mkdir -p src/config src/plugins src/routes src/services src/utils
mkdir -p tests/unit/services tests/unit/utils tests/integration
```

---

## Step 3: Create Configuration Files

### `.env`
```bash
cat > .env << 'EOF'
# Server Configuration
PORT=3000
HOST=localhost

# TTS Configuration
TTS_MODEL_ID=onnx-community/Kokoro-82M-v1.0-ONNX
TTS_DTYPE=fp32
TTS_DEVICE=cpu
TTS_DEFAULT_VOICE=af_heart
TTS_DEFAULT_SPEED=1.0

# Transcription Configuration
TRANSCRIBE_TIMEOUT=300000

# File Upload Configuration
MAX_FILE_SIZE_MB=100
EOF
```

### `.env.example`
```bash
cat > .env.example << 'EOF'
# Server Configuration
PORT=3000
HOST=localhost

# TTS Configuration
TTS_MODEL_ID=onnx-community/Kokoro-82M-v1.0-ONNX
TTS_DTYPE=fp32
TTS_DEVICE=cpu
TTS_DEFAULT_VOICE=af_heart
TTS_DEFAULT_SPEED=1.0

# Transcription Configuration
TRANSCRIBE_TIMEOUT=300000

# File Upload Configuration
MAX_FILE_SIZE_MB=100
EOF
```

### `.gitignore`
```bash
cat > .gitignore << 'EOF'
node_modules/
.env
coverage/
*.log
.DS_Store
out/
*.wav
*.mp3
EOF
```

---

## Step 4: Create Source Files

### `src/config/index.js`
```javascript
import dotenv from 'dotenv';
dotenv.config();

export const config = {
  server: {
    port: parseInt(process.env.PORT, 10) || 3000,
    host: process.env.HOST || 'localhost',
  },
  tts: {
    modelId: process.env.TTS_MODEL_ID || 'onnx-community/Kokoro-82M-v1.0-ONNX',
    dtype: process.env.TTS_DTYPE || 'fp32',
    device: process.env.TTS_DEVICE || 'cpu',
    defaultVoice: process.env.TTS_DEFAULT_VOICE || 'af_heart',
    defaultSpeed: parseFloat(process.env.TTS_DEFAULT_SPEED) || 1.0,
  },
  transcription: {
    timeout: parseInt(process.env.TRANSCRIBE_TIMEOUT, 10) || 300000,
  },
  upload: {
    maxFileSizeBytes: (parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 100) * 1024 * 1024,
  },
};
```

### `src/utils/errors.js`
```javascript
import Boom from '@hapi/boom';

export class TranscriptionError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'TranscriptionError';
    this.cause = cause;
  }

  toBoom() {
    return Boom.badImplementation(this.message);
  }
}

export class TTSError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'TTSError';
    this.cause = cause;
  }

  toBoom() {
    return Boom.badImplementation(this.message);
  }
}

export class FileUploadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FileUploadError';
  }

  toBoom() {
    return Boom.badRequest(this.message);
  }
}
```

### `src/utils/tempFile.js`
```javascript
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import crypto from 'node:crypto';

export class TempFileManager {
  constructor() {
    this.tempDirs = new Set();
  }

  async createTempDir(prefix = 'sogni-') {
    const baseTmpDir = await realpath(tmpdir());
    const tempDir = await mkdtemp(join(baseTmpDir, prefix));
    this.tempDirs.add(tempDir);
    return tempDir;
  }

  async createTempFile(dir, extension, data = null) {
    const filename = `${crypto.randomBytes(8).toString('hex')}.${extension}`;
    const filepath = join(dir, filename);
    if (data) {
      await writeFile(filepath, data);
    }
    return filepath;
  }

  async cleanup(tempDir) {
    try {
      await rm(tempDir, { recursive: true, force: true });
      this.tempDirs.delete(tempDir);
    } catch (error) {
      console.error(`Failed to cleanup temp dir ${tempDir}:`, error.message);
    }
  }

  async cleanupAll() {
    const cleanupPromises = Array.from(this.tempDirs).map(dir => this.cleanup(dir));
    await Promise.allSettled(cleanupPromises);
  }
}

export const tempFileManager = new TempFileManager();
```

### `src/services/transcription.js`
```javascript
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { config } from '../config/index.js';
import { TranscriptionError } from '../utils/errors.js';

export class TranscriptionService {
  async transcribe(audioFilePath, options = {}) {
    const { outputFormat = 'txt' } = options;

    return new Promise((resolve, reject) => {
      const args = [
        'parakeet-mlx',
        audioFilePath,
        '--output-format', outputFormat,
      ];

      const child = spawn('uvx', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      const timeoutId = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new TranscriptionError('Transcription timed out'));
      }, config.transcription.timeout);

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('error', (error) => {
        clearTimeout(timeoutId);
        reject(new TranscriptionError(`Failed to spawn uvx: ${error.message}`, error));
      });

      child.on('close', async (code) => {
        clearTimeout(timeoutId);

        if (code !== 0) {
          reject(new TranscriptionError(
            `Transcription failed with exit code ${code}: ${stderr}`
          ));
          return;
        }

        try {
          // parakeet-mlx outputs to a .txt file with same base name
          const outputPath = audioFilePath.replace(/\.[^.]+$/, '.txt');
          const transcript = await readFile(outputPath, 'utf-8');
          resolve({ text: transcript.trim(), rawOutput: stdout });
        } catch (error) {
          // If no output file, try parsing stdout
          resolve({ text: stdout.trim(), rawOutput: stdout });
        }
      });
    });
  }
}

export const transcriptionService = new TranscriptionService();
```

### `src/services/tts.js`
```javascript
import { KokoroTTS } from 'kokoro-js';
import { config } from '../config/index.js';
import { TTSError } from '../utils/errors.js';

let ttsInstance = null;
let initPromise = null;

export class TTSService {
  async initialize() {
    if (ttsInstance) return ttsInstance;

    // Prevent multiple simultaneous initializations
    if (initPromise) return initPromise;

    initPromise = (async () => {
      try {
        console.log('Initializing TTS model (this may take a moment on first run)...');
        ttsInstance = await KokoroTTS.from_pretrained(config.tts.modelId, {
          dtype: config.tts.dtype,
          device: config.tts.device,
        });
        console.log('TTS model initialized successfully');
        return ttsInstance;
      } catch (error) {
        initPromise = null;
        throw new TTSError(`Failed to initialize TTS model: ${error.message}`, error);
      }
    })();

    return initPromise;
  }

  async generate(text, options = {}) {
    const {
      voice = config.tts.defaultVoice,
      speed = config.tts.defaultSpeed,
      outputPath,
    } = options;

    try {
      const tts = await this.initialize();

      const audio = await tts.generate(text, {
        voice,
        speed,
      });

      if (outputPath) {
        await audio.save(outputPath);
      }

      return {
        audio,
        voice,
        speed,
        outputPath,
      };
    } catch (error) {
      if (error instanceof TTSError) throw error;
      throw new TTSError(`TTS generation failed: ${error.message}`, error);
    }
  }

  listVoices() {
    return [
      'af_heart', 'af_alloy', 'af_aoede', 'af_bella', 'af_jessica',
      'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah',
      'af_sky', 'am_adam', 'am_echo', 'am_eric', 'am_fenrir',
      'am_liam', 'am_michael', 'am_onyx', 'am_puck', 'am_santa',
    ];
  }
}

export const ttsService = new TTSService();
```

### `src/plugins/index.js`
```javascript
import Inert from '@hapi/inert';

export const registerPlugins = async (server) => {
  await server.register([
    Inert,
  ]);
};
```

### `src/routes/health.js`
```javascript
export const healthRoutes = [
  {
    method: 'GET',
    path: '/health',
    handler: async (request, h) => {
      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      };
    },
  },
];
```

### `src/routes/transcribe.js`
```javascript
import Joi from 'joi';
import Boom from '@hapi/boom';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { config } from '../config/index.js';
import { transcriptionService } from '../services/transcription.js';
import { tempFileManager } from '../utils/tempFile.js';

export const transcribeRoutes = [
  {
    method: 'POST',
    path: '/transcribe',
    options: {
      payload: {
        output: 'stream',
        parse: true,
        multipart: true,
        maxBytes: config.upload.maxFileSizeBytes,
        allow: 'multipart/form-data',
      },
      validate: {
        payload: Joi.object({
          file: Joi.any().required().description('Audio file to transcribe'),
        }),
      },
      description: 'Transcribe an audio file to text',
      tags: ['api', 'transcription'],
    },
    handler: async (request, h) => {
      let tempDir = null;

      try {
        const { file } = request.payload;

        if (!file || !file.hapi) {
          throw Boom.badRequest('No audio file provided');
        }

        const { filename } = file.hapi;
        const extension = filename.split('.').pop() || 'mp3';

        // Create temp directory and file
        tempDir = await tempFileManager.createTempDir('transcribe-');
        const tempFilePath = await tempFileManager.createTempFile(tempDir, extension);

        // Write uploaded file to temp location
        const writeStream = createWriteStream(tempFilePath);
        await pipeline(file, writeStream);

        // Perform transcription
        const result = await transcriptionService.transcribe(tempFilePath);

        return {
          success: true,
          transcript: result.text,
          filename,
        };
      } catch (error) {
        if (error.isBoom) throw error;
        console.error('Transcription error:', error);
        throw Boom.badImplementation('Transcription failed');
      } finally {
        if (tempDir) {
          await tempFileManager.cleanup(tempDir);
        }
      }
    },
  },
];
```

### `src/routes/tts.js`
```javascript
import Joi from 'joi';
import Boom from '@hapi/boom';
import { readFile } from 'node:fs/promises';
import { config } from '../config/index.js';
import { ttsService } from '../services/tts.js';
import { tempFileManager } from '../utils/tempFile.js';

export const ttsRoutes = [
  {
    method: 'POST',
    path: '/tts',
    options: {
      validate: {
        payload: Joi.object({
          text: Joi.string().required().min(1).max(10000)
            .description('Text to convert to speech'),
          voice: Joi.string().default(config.tts.defaultVoice)
            .description('Voice to use for synthesis'),
          speed: Joi.number().min(0.5).max(2.0).default(config.tts.defaultSpeed)
            .description('Speech speed (0.5-2.0)'),
          format: Joi.string().valid('wav', 'buffer').default('wav')
            .description('Output format'),
        }),
      },
      description: 'Convert text to speech audio',
      tags: ['api', 'tts'],
    },
    handler: async (request, h) => {
      let tempDir = null;

      try {
        const { text, voice, speed, format } = request.payload;

        // Create temp directory for output
        tempDir = await tempFileManager.createTempDir('tts-');
        const outputPath = await tempFileManager.createTempFile(tempDir, 'wav');

        // Generate audio
        await ttsService.generate(text, {
          voice,
          speed,
          outputPath,
        });

        if (format === 'buffer') {
          const audioBuffer = await readFile(outputPath);
          return {
            success: true,
            audio: audioBuffer.toString('base64'),
            voice,
            speed,
            format: 'wav',
          };
        }

        // Return file as download
        const audioBuffer = await readFile(outputPath);

        return h.response(audioBuffer)
          .type('audio/wav')
          .header('Content-Disposition', 'attachment; filename="output.wav"');
      } catch (error) {
        if (error.isBoom) throw error;
        console.error('TTS error:', error);
        throw Boom.badImplementation('Text-to-speech generation failed');
      } finally {
        if (tempDir) {
          await tempFileManager.cleanup(tempDir);
        }
      }
    },
  },
  {
    method: 'GET',
    path: '/tts/voices',
    options: {
      description: 'List available TTS voices',
      tags: ['api', 'tts'],
    },
    handler: async (request, h) => {
      return {
        voices: ttsService.listVoices(),
        default: config.tts.defaultVoice,
      };
    },
  },
];
```

### `src/routes/index.js`
```javascript
import { healthRoutes } from './health.js';
import { transcribeRoutes } from './transcribe.js';
import { ttsRoutes } from './tts.js';

export const routes = [
  ...healthRoutes,
  ...transcribeRoutes,
  ...ttsRoutes,
];
```

### `src/server.js`
```javascript
import Hapi from '@hapi/hapi';
import { config } from './config/index.js';
import { registerPlugins } from './plugins/index.js';
import { routes } from './routes/index.js';

export const createServer = async () => {
  const server = Hapi.server({
    port: config.server.port,
    host: config.server.host,
    routes: {
      cors: true,
      validate: {
        failAction: async (request, h, err) => {
          throw err;
        },
      },
    },
  });

  await registerPlugins(server);
  server.route(routes);

  return server;
};

export const initServer = async () => {
  const server = await createServer();
  await server.initialize();
  return server;
};

export const startServer = async () => {
  const server = await createServer();
  await server.start();
  console.log(`Server running at: ${server.info.uri}`);
  return server;
};
```

### `src/index.js`
```javascript
import { startServer } from './server.js';
import { tempFileManager } from './utils/tempFile.js';

process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  await tempFileManager.cleanupAll();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nShutting down gracefully...');
  await tempFileManager.cleanupAll();
  process.exit(0);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
```

---

## Step 5: Create Test Files

### `vitest.config.js`
```javascript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'tests/'],
    },
  },
});
```

### `tests/setup.js`
```javascript
import { vi } from 'vitest';

// Global test setup
beforeEach(() => {
  vi.clearAllMocks();
});
```

### `tests/unit/utils/tempFile.test.js`
```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { TempFileManager } from '../../../src/utils/tempFile.js';

describe('TempFileManager', () => {
  let manager;

  beforeEach(() => {
    manager = new TempFileManager();
  });

  afterEach(async () => {
    await manager.cleanupAll();
  });

  describe('createTempDir', () => {
    it('should create a temporary directory', async () => {
      const tempDir = await manager.createTempDir('test-');
      expect(tempDir).toBeDefined();
      expect(existsSync(tempDir)).toBe(true);
    });

    it('should track created directories', async () => {
      const tempDir = await manager.createTempDir('test-');
      expect(manager.tempDirs.has(tempDir)).toBe(true);
    });
  });

  describe('createTempFile', () => {
    it('should create a temp file path with correct extension', async () => {
      const tempDir = await manager.createTempDir('test-');
      const filePath = await manager.createTempFile(tempDir, 'wav');
      expect(filePath).toMatch(/\.wav$/);
    });

    it('should write data when provided', async () => {
      const tempDir = await manager.createTempDir('test-');
      const data = Buffer.from('test data');
      const filePath = await manager.createTempFile(tempDir, 'txt', data);
      expect(existsSync(filePath)).toBe(true);
    });
  });

  describe('cleanup', () => {
    it('should remove directory and untrack it', async () => {
      const tempDir = await manager.createTempDir('test-');
      await manager.cleanup(tempDir);
      expect(existsSync(tempDir)).toBe(false);
      expect(manager.tempDirs.has(tempDir)).toBe(false);
    });
  });

  describe('cleanupAll', () => {
    it('should remove all tracked directories', async () => {
      const dir1 = await manager.createTempDir('test1-');
      const dir2 = await manager.createTempDir('test2-');
      await manager.cleanupAll();
      expect(existsSync(dir1)).toBe(false);
      expect(existsSync(dir2)).toBe(false);
      expect(manager.tempDirs.size).toBe(0);
    });
  });
});
```

### `tests/unit/services/transcription.test.js`
```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Mock child_process before importing the service
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { TranscriptionService } from '../../../src/services/transcription.js';

describe('TranscriptionService', () => {
  let service;

  beforeEach(() => {
    service = new TranscriptionService();
    vi.clearAllMocks();
  });

  describe('transcribe', () => {
    it('should successfully transcribe an audio file', async () => {
      const mockStdout = new EventEmitter();
      const mockStderr = new EventEmitter();
      const mockChild = new EventEmitter();
      mockChild.stdout = mockStdout;
      mockChild.stderr = mockStderr;

      spawn.mockReturnValue(mockChild);
      readFile.mockResolvedValue('This is the transcribed text.');

      const transcribePromise = service.transcribe('/path/to/audio.mp3');

      // Simulate successful completion
      setTimeout(() => {
        mockChild.emit('close', 0);
      }, 10);

      const result = await transcribePromise;
      expect(result.text).toBe('This is the transcribed text.');
    });

    it('should handle transcription failure', async () => {
      const mockStdout = new EventEmitter();
      const mockStderr = new EventEmitter();
      const mockChild = new EventEmitter();
      mockChild.stdout = mockStdout;
      mockChild.stderr = mockStderr;

      spawn.mockReturnValue(mockChild);

      const transcribePromise = service.transcribe('/path/to/audio.mp3');

      setTimeout(() => {
        mockStderr.emit('data', 'Error message');
        mockChild.emit('close', 1);
      }, 10);

      await expect(transcribePromise).rejects.toThrow('Transcription failed');
    });

    it('should handle spawn errors', async () => {
      const mockStdout = new EventEmitter();
      const mockStderr = new EventEmitter();
      const mockChild = new EventEmitter();
      mockChild.stdout = mockStdout;
      mockChild.stderr = mockStderr;

      spawn.mockReturnValue(mockChild);

      const transcribePromise = service.transcribe('/path/to/audio.mp3');

      setTimeout(() => {
        mockChild.emit('error', new Error('spawn failed'));
      }, 10);

      await expect(transcribePromise).rejects.toThrow('Failed to spawn uvx');
    });
  });
});
```

### `tests/unit/services/tts.test.js`
```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock kokoro-js before importing the service
vi.mock('kokoro-js', () => ({
  KokoroTTS: {
    from_pretrained: vi.fn(),
  },
}));

import { KokoroTTS } from 'kokoro-js';
import { TTSService } from '../../../src/services/tts.js';

describe('TTSService', () => {
  let service;
  let mockTTSInstance;

  beforeEach(() => {
    // Reset module state
    vi.resetModules();
    service = new TTSService();

    mockTTSInstance = {
      generate: vi.fn().mockResolvedValue({
        save: vi.fn().mockResolvedValue(undefined),
      }),
    };

    KokoroTTS.from_pretrained.mockResolvedValue(mockTTSInstance);
  });

  describe('initialize', () => {
    it('should initialize the TTS model', async () => {
      const result = await service.initialize();
      expect(KokoroTTS.from_pretrained).toHaveBeenCalled();
      expect(result).toBe(mockTTSInstance);
    });
  });

  describe('generate', () => {
    it('should generate audio with default options', async () => {
      const result = await service.generate('Hello world');

      expect(mockTTSInstance.generate).toHaveBeenCalledWith('Hello world', {
        voice: 'af_heart',
        speed: 1.0,
      });
      expect(result.voice).toBe('af_heart');
      expect(result.speed).toBe(1.0);
    });

    it('should generate audio with custom voice and speed', async () => {
      const result = await service.generate('Hello world', {
        voice: 'am_adam',
        speed: 1.5,
      });

      expect(mockTTSInstance.generate).toHaveBeenCalledWith('Hello world', {
        voice: 'am_adam',
        speed: 1.5,
      });
      expect(result.voice).toBe('am_adam');
      expect(result.speed).toBe(1.5);
    });

    it('should save to file when outputPath is provided', async () => {
      const mockAudio = {
        save: vi.fn().mockResolvedValue(undefined),
      };
      mockTTSInstance.generate.mockResolvedValue(mockAudio);

      await service.generate('Hello world', {
        outputPath: '/tmp/output.wav',
      });

      expect(mockAudio.save).toHaveBeenCalledWith('/tmp/output.wav');
    });
  });

  describe('listVoices', () => {
    it('should return available voices', () => {
      const voices = service.listVoices();
      expect(voices).toContain('af_heart');
      expect(voices).toContain('am_adam');
      expect(Array.isArray(voices)).toBe(true);
    });
  });
});
```

### `tests/integration/health.test.js`
```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initServer } from '../../src/server.js';

describe('GET /health', () => {
  let server;

  beforeAll(async () => {
    server = await initServer();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('should return healthy status', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.payload);
    expect(payload.status).toBe('healthy');
    expect(payload).toHaveProperty('timestamp');
    expect(payload).toHaveProperty('uptime');
  });
});
```

### `tests/integration/transcribe.test.js`
```javascript
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Readable } from 'node:stream';

// Mock the transcription service
vi.mock('../../src/services/transcription.js', () => ({
  transcriptionService: {
    transcribe: vi.fn().mockResolvedValue({
      text: 'This is a test transcript.',
      rawOutput: '',
    }),
  },
}));

import { initServer } from '../../src/server.js';

describe('POST /transcribe', () => {
  let server;

  beforeAll(async () => {
    server = await initServer();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('should transcribe an uploaded audio file', async () => {
    const audioContent = Buffer.from('fake audio content');

    const response = await server.inject({
      method: 'POST',
      url: '/transcribe',
      headers: {
        'content-type': 'multipart/form-data; boundary=----WebKitFormBoundary',
      },
      payload:
        '------WebKitFormBoundary\r\n' +
        'Content-Disposition: form-data; name="file"; filename="test.mp3"\r\n' +
        'Content-Type: audio/mpeg\r\n\r\n' +
        audioContent.toString() +
        '\r\n------WebKitFormBoundary--\r\n',
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.payload);
    expect(payload.success).toBe(true);
    expect(payload.transcript).toBe('This is a test transcript.');
  });

  it('should return 400 for missing file', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/transcribe',
      headers: {
        'content-type': 'multipart/form-data; boundary=----WebKitFormBoundary',
      },
      payload: '------WebKitFormBoundary--\r\n',
    });

    expect(response.statusCode).toBe(400);
  });
});
```

### `tests/integration/tts.test.js`
```javascript
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';

// Mock the TTS service
vi.mock('../../src/services/tts.js', () => ({
  ttsService: {
    generate: vi.fn().mockImplementation(async (text, options) => {
      // Create a fake WAV file
      if (options.outputPath) {
        await writeFile(options.outputPath, Buffer.from('RIFF fake wav'));
      }
      return {
        audio: {},
        voice: options.voice || 'af_heart',
        speed: options.speed || 1.0,
        outputPath: options.outputPath,
      };
    }),
    listVoices: vi.fn().mockReturnValue([
      'af_heart', 'af_alloy', 'am_adam',
    ]),
  },
}));

import { initServer } from '../../src/server.js';

describe('TTS Routes', () => {
  let server;

  beforeAll(async () => {
    server = await initServer();
  });

  afterAll(async () => {
    await server.stop();
  });

  describe('POST /tts', () => {
    it('should generate audio from text', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/tts',
        payload: {
          text: 'Hello world',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('audio/wav');
    });

    it('should return base64 when format is buffer', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/tts',
        payload: {
          text: 'Hello world',
          format: 'buffer',
        },
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.success).toBe(true);
      expect(payload.audio).toBeDefined();
    });

    it('should return 400 for empty text', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/tts',
        payload: {
          text: '',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /tts/voices', () => {
    it('should return list of voices', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/tts/voices',
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.voices).toContain('af_heart');
      expect(payload.default).toBe('af_heart');
    });
  });
});
```

---

## Step 6: Create README

### `README.md`
```markdown
# Sogni Transcribe API

A REST API for audio transcription and text-to-speech synthesis.

## Features

- **Audio Transcription**: Upload audio files and get text transcripts using parakeet-mlx
- **Text-to-Speech**: Convert text to natural-sounding speech using Kokoro TTS
- **Multiple Voices**: 20+ voices available for TTS
- **Fast**: Optimized for Apple Silicon with MLX

## Prerequisites

- Node.js 18+
- Python 3.8+ with uvx (`pip install uvx`)
- ffmpeg (required by parakeet-mlx)

### Install ffmpeg (macOS)
```bash
brew install ffmpeg
```

### Install uvx (for parakeet-mlx)
```bash
pip install uvx
```

## Installation

```bash
npm install
```

## Configuration

Copy `.env.example` to `.env` and adjust settings if needed:

```bash
cp .env.example .env
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3000 | Server port |
| HOST | localhost | Server host |
| TTS_MODEL_ID | onnx-community/Kokoro-82M-v1.0-ONNX | Kokoro model ID |
| TTS_DEFAULT_VOICE | af_heart | Default TTS voice |
| TTS_DEFAULT_SPEED | 1.0 | Default speech speed |
| MAX_FILE_SIZE_MB | 100 | Max upload file size |

## Running the Server

### Development
```bash
npm run dev
```

### Production
```bash
npm start
```

## API Endpoints

### Health Check
```bash
curl http://localhost:3000/health
```

### Transcribe Audio
```bash
curl -X POST http://localhost:3000/transcribe \
  -F "file=@audio.mp3"
```

Response:
```json
{
  "success": true,
  "transcript": "The transcribed text...",
  "filename": "audio.mp3"
}
```

### Text-to-Speech
```bash
# Download WAV file
curl -X POST http://localhost:3000/tts \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world"}' \
  --output output.wav

# Get base64-encoded audio
curl -X POST http://localhost:3000/tts \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world", "format": "buffer"}'
```

#### TTS Options
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| text | string | required | Text to convert |
| voice | string | af_heart | Voice name |
| speed | number | 1.0 | Speed (0.5-2.0) |
| format | string | wav | Output format (wav, buffer) |

### List Voices
```bash
curl http://localhost:3000/tts/voices
```

## Testing

```bash
# Run tests in watch mode
npm test

# Run tests once
npm run test:run

# Run with coverage
npm run test:coverage
```

## First Run Notes

- First transcription will download ~2.5GB parakeet-mlx model
- First TTS request will download the Kokoro model (~300MB)
- Subsequent requests will be much faster

## Available Voices

**Female voices (af_*):**
- af_heart (default, Grade A)
- af_alloy, af_aoede, af_bella, af_jessica
- af_kore, af_nicole, af_nova, af_river
- af_sarah, af_sky

**Male voices (am_*):**
- am_adam, am_echo, am_eric, am_fenrir
- am_liam, am_michael, am_onyx, am_puck, am_santa

## License

ISC
```

---

## Quick Setup Script

You can run this all-in-one setup script:

```bash
#!/bin/bash
set -e

echo "Setting up Sogni Transcribe API..."

# Create directories
mkdir -p src/config src/plugins src/routes src/services src/utils
mkdir -p tests/unit/services tests/unit/utils tests/integration

# Install dependencies
npm install

echo "Setup complete! Run 'npm run dev' to start the server."
```

---

## Verification Checklist

After setup, verify everything works:

1. **Run tests:**
   ```bash
   npm run test:run
   ```

2. **Start server:**
   ```bash
   npm run dev
   ```

3. **Test health endpoint:**
   ```bash
   curl http://localhost:3000/health
   ```

4. **Test TTS:**
   ```bash
   curl -X POST http://localhost:3000/tts \
     -H "Content-Type: application/json" \
     -d '{"text":"Hello world"}' \
     --output test.wav
   ```

5. **Test transcription (with an audio file):**
   ```bash
   curl -X POST http://localhost:3000/transcribe \
     -F "file=@your-audio.mp3"
   ```
