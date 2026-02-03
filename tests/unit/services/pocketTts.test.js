import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

// Mock child_process before importing the service
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

// Mock config to ensure consistent test values
vi.mock('../../../src/config/index.js', () => ({
  config: {
    pocketTts: {
      enabled: true,
      defaultVoice: 'alba',
      timeout: 60000,
      daemonStartupTimeout: 60000,
      preWarmDaemon: false,
      voiceClonesDir: './pocket_voice_clones',
    },
  },
}));

import { spawn } from 'node:child_process';

describe('PocketTTSService', () => {
  let PocketTTSService;
  let service;
  let mockProcess;
  let mockStdin;
  let mockStdout;
  let mockStderr;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    vi.doMock('node:child_process', () => ({
      spawn: vi.fn(),
    }));

    // Create mock streams
    mockStdin = new Writable({
      write(chunk, encoding, callback) {
        mockStdin.lastWrite = chunk.toString();
        callback();
      }
    });
    mockStdin.lastWrite = '';

    mockStdout = new Readable({ read() {} });
    mockStderr = new Readable({ read() {} });

    // Create mock process
    mockProcess = new EventEmitter();
    mockProcess.stdin = mockStdin;
    mockProcess.stdout = mockStdout;
    mockProcess.stderr = mockStderr;
    mockProcess.kill = vi.fn();

    const { spawn: freshSpawn } = await import('node:child_process');
    freshSpawn.mockReturnValue(mockProcess);

    const module = await import('../../../src/services/pocketTts.js');
    PocketTTSService = module.PocketTTSService;
    service = new PocketTTSService();
  });

  afterEach(async () => {
    try {
      await service.shutdown();
    } catch (e) {
      // Ignore shutdown errors in tests
    }
  });

  describe('initialize', () => {
    it('should start daemon and wait for ready signal', async () => {
      const initPromise = service.initialize();

      setTimeout(() => {
        mockStdout.push('{"status":"ready","voices":["alba","marius"],"features":[]}\n');
      }, 10);

      await initPromise;
      expect(service.isReady()).toBe(true);
    });

    it('should reject if daemon fails to start', async () => {
      const initPromise = service.initialize();

      setTimeout(() => {
        mockProcess.emit('error', new Error('spawn failed'));
      }, 10);

      await expect(initPromise).rejects.toThrow('Failed to spawn Pocket TTS daemon');
    });
  });

  describe('renameVoiceClone', () => {
    beforeEach(async () => {
      const initPromise = service.initialize();
      setTimeout(() => {
        mockStdout.push('{"status":"ready","voices":["alba"],"features":[]}\n');
      }, 10);
      await initPromise;
    });

    it('should send rename request to daemon', async () => {
      const renamePromise = service.renameVoiceClone('old_clone', 'new_clone');

      await new Promise(resolve => setTimeout(resolve, 10));
      const request = JSON.parse(mockStdin.lastWrite);
      expect(request.type).toBe('rename_voice_clone');
      expect(request.old_clone_id).toBe('old_clone');
      expect(request.new_clone_id).toBe('new_clone');

      mockStdout.push(`{"id":"${request.id}","success":true,"old_clone_id":"old_clone","new_clone_id":"new_clone"}\n`);

      const result = await renamePromise;
      expect(result.oldCloneId).toBe('old_clone');
      expect(result.newCloneId).toBe('new_clone');
    });

    it('should require oldCloneId', async () => {
      await expect(service.renameVoiceClone(null, 'new_clone'))
        .rejects.toThrow('oldCloneId is required');
    });

    it('should require newCloneId', async () => {
      await expect(service.renameVoiceClone('old_clone', null))
        .rejects.toThrow('newCloneId is required');
    });

    it('should handle not found error', async () => {
      const renamePromise = service.renameVoiceClone('nonexistent', 'new_clone');

      await new Promise(resolve => setTimeout(resolve, 10));
      const request = JSON.parse(mockStdin.lastWrite);

      mockStdout.push(`{"id":"${request.id}","success":false,"error":"Voice clone 'nonexistent' not found"}\n`);

      await expect(renamePromise).rejects.toThrow("Voice clone 'nonexistent' not found");
    });

    it('should handle already exists error', async () => {
      const renamePromise = service.renameVoiceClone('old_clone', 'existing_clone');

      await new Promise(resolve => setTimeout(resolve, 10));
      const request = JSON.parse(mockStdin.lastWrite);

      mockStdout.push(`{"id":"${request.id}","success":false,"error":"Voice clone 'existing_clone' already exists"}\n`);

      await expect(renamePromise).rejects.toThrow("Voice clone 'existing_clone' already exists");
    });
  });

  describe('deleteVoiceClone', () => {
    beforeEach(async () => {
      const initPromise = service.initialize();
      setTimeout(() => {
        mockStdout.push('{"status":"ready","voices":["alba"],"features":[]}\n');
      }, 10);
      await initPromise;
    });

    it('should send delete request to daemon', async () => {
      const deletePromise = service.deleteVoiceClone('clone_abc123');

      await new Promise(resolve => setTimeout(resolve, 10));
      const request = JSON.parse(mockStdin.lastWrite);
      expect(request.type).toBe('delete_voice_clone');
      expect(request.clone_id).toBe('clone_abc123');

      mockStdout.push(`{"id":"${request.id}","success":true,"clone_id":"clone_abc123"}\n`);

      const result = await deletePromise;
      expect(result.cloneId).toBe('clone_abc123');
    });

    it('should require cloneId', async () => {
      await expect(service.deleteVoiceClone(null))
        .rejects.toThrow('cloneId is required');
    });
  });

  describe('createVoiceClone', () => {
    beforeEach(async () => {
      const initPromise = service.initialize();
      setTimeout(() => {
        mockStdout.push('{"status":"ready","voices":["alba"],"features":[]}\n');
      }, 10);
      await initPromise;
    });

    it('should send create request to daemon', async () => {
      const createPromise = service.createVoiceClone('/tmp/reference.wav', 'my_clone');

      await new Promise(resolve => setTimeout(resolve, 10));
      const request = JSON.parse(mockStdin.lastWrite);
      expect(request.type).toBe('create_voice_clone');
      expect(request.audio_path).toBe('/tmp/reference.wav');
      expect(request.clone_id).toBe('my_clone');

      mockStdout.push(`{"id":"${request.id}","success":true,"clone_id":"my_clone"}\n`);

      const result = await createPromise;
      expect(result.cloneId).toBe('my_clone');
    });

    it('should require audioPath', async () => {
      await expect(service.createVoiceClone(null, 'id'))
        .rejects.toThrow('audioPath is required');
    });

    it('should require cloneId', async () => {
      await expect(service.createVoiceClone('/path', null))
        .rejects.toThrow('cloneId is required');
    });
  });

  describe('generate', () => {
    beforeEach(async () => {
      const initPromise = service.initialize();
      setTimeout(() => {
        mockStdout.push('{"status":"ready","voices":["alba"],"features":[]}\n');
      }, 10);
      await initPromise;
    });

    it('should send generate request to daemon', async () => {
      const generatePromise = service.generate('Hello world', {
        voice: 'alba',
        outputPath: '/tmp/output.wav',
      });

      await new Promise(resolve => setTimeout(resolve, 10));
      const request = JSON.parse(mockStdin.lastWrite);
      expect(request.type).toBe('generate');
      expect(request.text).toBe('Hello world');
      expect(request.voice).toBe('alba');
      expect(request.output_path).toBe('/tmp/output.wav');

      mockStdout.push(`{"id":"${request.id}","success":true,"output_path":"/tmp/output.wav","duration":1.5}\n`);

      const result = await generatePromise;
      expect(result.outputPath).toBe('/tmp/output.wav');
      expect(result.duration).toBe(1.5);
    });

    it('should require outputPath', async () => {
      await expect(service.generate('Hello world'))
        .rejects.toThrow('outputPath is required');
    });
  });

  describe('utility methods', () => {
    it('should return isEnabled based on config', () => {
      expect(typeof service.isEnabled()).toBe('boolean');
    });

    it('should return built-in voices', () => {
      const voices = service.getBuiltInVoices();
      expect(Array.isArray(voices)).toBe(true);
      expect(voices.length).toBeGreaterThan(0);
    });

    it('should return voice clone path', () => {
      const path = service.getVoiceClonePath('my_clone');
      expect(path).toContain('my_clone');
      expect(path).toContain('pocket_voice_clones');
    });
  });
});
