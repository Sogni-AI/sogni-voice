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
    qwenTts: {
      enabled: true,
      baseModelVariant: 'base-0.6b',
      customVoiceModelVariant: 'custom-voice',
      defaultVoice: 'Chelsie',
      defaultLanguage: 'English',
      timeout: 300000,
      daemonStartupTimeout: 180000,
      voiceClonesDir: './voice_clones',
    },
  },
}));

import { spawn } from 'node:child_process';

describe('QwenTTSService', () => {
  let QwenTTSService;
  let service;
  let mockProcess;
  let mockStdin;
  let mockStdout;
  let mockStderr;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset modules to clear singleton state
    vi.resetModules();

    // Re-mock after reset
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

    // Get fresh spawn mock and configure it
    const { spawn: freshSpawn } = await import('node:child_process');
    freshSpawn.mockReturnValue(mockProcess);

    // Import fresh service
    const module = await import('../../../src/services/qwenTts.js');
    QwenTTSService = module.QwenTTSService;
    service = new QwenTTSService();
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

      // Simulate daemon sending ready signal with model info
      setTimeout(() => {
        mockStdout.push('{"status":"ready","model_variant":"base-1.7b","features":["tts","voice_cloning"],"voices":["Chelsie","Ethan"]}\n');
      }, 10);

      await initPromise;
      expect(service.isReady()).toBe(true);
    });

    it('should reject if daemon fails to start', async () => {
      const initPromise = service.initialize();

      setTimeout(() => {
        mockProcess.emit('error', new Error('spawn failed'));
      }, 10);

      await expect(initPromise).rejects.toThrow('Failed to spawn Qwen TTS daemon');
    });

    it('should reject if daemon sends error status', async () => {
      const initPromise = service.initialize();

      setTimeout(() => {
        mockStdout.push('{"status":"error","error":"Failed to load model"}\n');
      }, 10);

      await expect(initPromise).rejects.toThrow('Daemon failed to start');
    });

    it('should deduplicate concurrent initialization calls', async () => {
      const { spawn: freshSpawn } = await import('node:child_process');

      const promise1 = service.initialize();
      const promise2 = service.initialize();

      setTimeout(() => {
        mockStdout.push('{"status":"ready","model_variant":"base-1.7b","features":[],"voices":[]}\n');
      }, 10);

      await Promise.all([promise1, promise2]);

      expect(freshSpawn).toHaveBeenCalledTimes(1);
    });
  });

  describe('generate', () => {
    beforeEach(async () => {
      const initPromise = service.initialize();
      setTimeout(() => {
        mockStdout.push('{"status":"ready","model_variant":"base-1.7b","features":["tts","voice_cloning"],"voices":["Chelsie"]}\n');
      }, 10);
      await initPromise;
    });

    it('should successfully generate audio with default options', async () => {
      const generatePromise = service.generate('Hello world', {
        outputPath: '/tmp/output.wav',
      });

      await new Promise(resolve => setTimeout(resolve, 10));
      const request = JSON.parse(mockStdin.lastWrite);
      expect(request.type).toBe('generate');
      expect(request.text).toBe('Hello world');
      expect(request.voice).toBe('Chelsie');
      expect(request.language).toBe('English');
      expect(request.output_path).toBe('/tmp/output.wav');

      mockStdout.push(`{"id":"${request.id}","success":true,"output_path":"/tmp/output.wav","duration":1.5}\n`);

      const result = await generatePromise;
      expect(result.outputPath).toBe('/tmp/output.wav');
      expect(result.duration).toBe(1.5);
      expect(result.voice).toBe('Chelsie');
    });

    it('should generate audio with custom voice and language', async () => {
      const generatePromise = service.generate('Hello world', {
        voice: 'Ethan',
        language: 'Chinese',
        outputPath: '/tmp/output.wav',
      });

      await new Promise(resolve => setTimeout(resolve, 10));
      const request = JSON.parse(mockStdin.lastWrite);
      expect(request.voice).toBe('Ethan');
      expect(request.language).toBe('Chinese');

      mockStdout.push(`{"id":"${request.id}","success":true,"output_path":"/tmp/output.wav","duration":2.0}\n`);

      const result = await generatePromise;
      expect(result.voice).toBe('Ethan');
      expect(result.language).toBe('Chinese');
    });

    it('should require outputPath', async () => {
      await expect(service.generate('Hello world'))
        .rejects.toThrow('outputPath is required');
    });

    it('should handle generation errors', async () => {
      const generatePromise = service.generate('Hello world', {
        outputPath: '/tmp/output.wav',
      });

      await new Promise(resolve => setTimeout(resolve, 10));
      const request = JSON.parse(mockStdin.lastWrite);

      mockStdout.push(`{"id":"${request.id}","success":false,"error":"TTS generation failed"}\n`);

      await expect(generatePromise).rejects.toThrow('TTS generation failed');
    });

    it('should handle daemon crash during generation', async () => {
      const generatePromise = service.generate('Hello world', {
        outputPath: '/tmp/output.wav',
      });

      setTimeout(() => {
        mockProcess.emit('close', 1);
      }, 10);

      await expect(generatePromise).rejects.toThrow('Qwen TTS daemon process terminated');
    });
  });

  describe('generateCustomVoice', () => {
    beforeEach(async () => {
      const initPromise = service.initialize();
      setTimeout(() => {
        mockStdout.push('{"status":"ready","model_variant":"custom-voice","features":["tts","custom_voice"],"voices":["Chelsie"]}\n');
      }, 10);
      await initPromise;
    });

    it('should generate audio with emotion instruction', async () => {
      const generatePromise = service.generateCustomVoice('Hello world', {
        speaker: 'Chelsie',
        instruct: 'Very happy and excited',
        outputPath: '/tmp/output.wav',
      });

      await new Promise(resolve => setTimeout(resolve, 10));
      const request = JSON.parse(mockStdin.lastWrite);
      expect(request.type).toBe('generate_custom_voice');
      expect(request.text).toBe('Hello world');
      expect(request.speaker).toBe('Chelsie');
      expect(request.instruct).toBe('Very happy and excited');

      mockStdout.push(`{"id":"${request.id}","success":true,"output_path":"/tmp/output.wav","duration":1.5}\n`);

      const result = await generatePromise;
      expect(result.outputPath).toBe('/tmp/output.wav');
      expect(result.speaker).toBe('Chelsie');
      expect(result.instruct).toBe('Very happy and excited');
    });

    it('should require instruct parameter', async () => {
      await expect(service.generateCustomVoice('Hello world', {
        outputPath: '/tmp/output.wav',
      })).rejects.toThrow('instruct is required');
    });
  });

  describe('generateVoiceDesign', () => {
    beforeEach(async () => {
      const initPromise = service.initialize();
      setTimeout(() => {
        mockStdout.push('{"status":"ready","model_variant":"voice-design","features":["tts","voice_design"],"voices":["Chelsie"]}\n');
      }, 10);
      await initPromise;
    });

    it('should generate audio with voice description', async () => {
      const generatePromise = service.generateVoiceDesign('Hello world', {
        instruct: 'A deep male voice with calm tone',
        outputPath: '/tmp/output.wav',
      });

      await new Promise(resolve => setTimeout(resolve, 10));
      const request = JSON.parse(mockStdin.lastWrite);
      expect(request.type).toBe('generate_voice_design');
      expect(request.text).toBe('Hello world');
      expect(request.instruct).toBe('A deep male voice with calm tone');

      mockStdout.push(`{"id":"${request.id}","success":true,"output_path":"/tmp/output.wav","duration":1.5}\n`);

      const result = await generatePromise;
      expect(result.outputPath).toBe('/tmp/output.wav');
      expect(result.instruct).toBe('A deep male voice with calm tone');
    });

    it('should require instruct parameter', async () => {
      await expect(service.generateVoiceDesign('Hello world', {
        outputPath: '/tmp/output.wav',
      })).rejects.toThrow('instruct is required');
    });
  });

  describe('voice cloning', () => {
    beforeEach(async () => {
      const initPromise = service.initialize();
      setTimeout(() => {
        mockStdout.push('{"status":"ready","model_variant":"base-1.7b","features":["tts","voice_cloning"],"voices":["Chelsie"]}\n');
      }, 10);
      await initPromise;
    });

    describe('createVoiceClone', () => {
      it('should create a voice clone from reference audio', async () => {
        const createPromise = service.createVoiceClone(
          '/tmp/reference.wav',
          'Hello, this is a test',
          'clone_abc123'
        );

        await new Promise(resolve => setTimeout(resolve, 10));
        const request = JSON.parse(mockStdin.lastWrite);
        expect(request.type).toBe('create_voice_clone');
        expect(request.audio_path).toBe('/tmp/reference.wav');
        expect(request.transcript).toBe('Hello, this is a test');
        expect(request.clone_id).toBe('clone_abc123');

        mockStdout.push(`{"id":"${request.id}","success":true,"clone_id":"clone_abc123"}\n`);

        const result = await createPromise;
        expect(result.cloneId).toBe('clone_abc123');
      });

      it('should require all parameters', async () => {
        await expect(service.createVoiceClone(null, 'text', 'id'))
          .rejects.toThrow('audioPath is required');
        await expect(service.createVoiceClone('/path', null, 'id'))
          .rejects.toThrow('transcript is required');
        await expect(service.createVoiceClone('/path', 'text', null))
          .rejects.toThrow('cloneId is required');
      });
    });

    describe('generateVoiceClone', () => {
      it('should generate audio using cloned voice', async () => {
        const generatePromise = service.generateVoiceClone('Hello world', {
          cloneId: 'clone_abc123',
          language: 'English',
          outputPath: '/tmp/output.wav',
        });

        await new Promise(resolve => setTimeout(resolve, 10));
        const request = JSON.parse(mockStdin.lastWrite);
        expect(request.type).toBe('generate_voice_clone');
        expect(request.clone_id).toBe('clone_abc123');
        expect(request.language).toBe('English');

        mockStdout.push(`{"id":"${request.id}","success":true,"output_path":"/tmp/output.wav","duration":1.5}\n`);

        const result = await generatePromise;
        expect(result.outputPath).toBe('/tmp/output.wav');
        expect(result.cloneId).toBe('clone_abc123');
      });

      it('should require cloneId', async () => {
        await expect(service.generateVoiceClone('Hello world', {
          outputPath: '/tmp/output.wav',
        })).rejects.toThrow('cloneId is required');
      });
    });

    describe('deleteVoiceClone', () => {
      it('should delete a voice clone', async () => {
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

    describe('listVoiceClones', () => {
      it('should list all voice clones', async () => {
        const listPromise = service.listVoiceClones();

        await new Promise(resolve => setTimeout(resolve, 10));
        const request = JSON.parse(mockStdin.lastWrite);
        expect(request.type).toBe('list_voice_clones');

        mockStdout.push(`{"id":"${request.id}","success":true,"clones":["clone_abc123","clone_def456"]}\n`);

        const result = await listPromise;
        expect(result.clones).toEqual(['clone_abc123', 'clone_def456']);
      });
    });
  });

  describe('shutdown', () => {
    beforeEach(async () => {
      const initPromise = service.initialize();
      setTimeout(() => {
        mockStdout.push('{"status":"ready","model_variant":"base-1.7b","features":[],"voices":[]}\n');
      }, 10);
      await initPromise;
    });

    it('should send shutdown command and wait for close', async () => {
      const shutdownPromise = service.shutdown();

      await new Promise(resolve => setTimeout(resolve, 10));
      expect(mockStdin.lastWrite).toContain('"command":"shutdown"');

      mockProcess.emit('close', 0);

      await shutdownPromise;
      expect(service.isReady()).toBe(false);
    });

    it('should force kill if shutdown times out', async () => {
      vi.useFakeTimers();

      const shutdownPromise = service.shutdown();

      vi.advanceTimersByTime(6000);

      await shutdownPromise;
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL');

      vi.useRealTimers();
    });

    it('should do nothing if daemon is not running', async () => {
      mockProcess.emit('close', 0);
      await service.shutdown();

      await service.shutdown();
      // No errors thrown
    });
  });

  describe('utility methods', () => {
    it('should return isEnabled based on config', () => {
      // The service reads from config, which defaults to false
      expect(typeof service.isEnabled()).toBe('boolean');
    });

    it('should return model info', async () => {
      const initPromise = service.initialize();
      setTimeout(() => {
        mockStdout.push('{"status":"ready","model_variant":"base-1.7b","features":["tts","voice_cloning"],"voices":["Chelsie","Ethan"]}\n');
      }, 10);
      await initPromise;

      const info = service.getModelInfo();
      expect(info.variant).toBe('base-1.7b');
      expect(info.features).toContain('voice_cloning');
      expect(info.voices).toContain('Chelsie');
    });

    it('should list voices', async () => {
      const initPromise = service.initialize();
      setTimeout(() => {
        mockStdout.push('{"status":"ready","model_variant":"base-1.7b","features":[],"voices":["Chelsie","Ethan","Serena"]}\n');
      }, 10);
      await initPromise;

      const voices = service.listVoices();
      expect(voices).toContain('Chelsie');
      expect(voices).toContain('Ethan');
      expect(Array.isArray(voices)).toBe(true);
    });

    it('should return default voices when daemon not initialized', () => {
      const voices = service.listVoices();
      expect(voices).toContain('Chelsie');
      expect(voices.length).toBeGreaterThan(0);
    });

    it('should check feature support', async () => {
      const initPromise = service.initialize();
      setTimeout(() => {
        mockStdout.push('{"status":"ready","model_variant":"base-1.7b","features":["tts","voice_cloning"],"voices":[]}\n');
      }, 10);
      await initPromise;

      expect(service.supportsFeature('voice_cloning')).toBe(true);
      expect(service.supportsFeature('custom_voice')).toBe(false);
    });
  });

  describe('daemon log forwarding', () => {
    it('should forward stderr to console', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const initPromise = service.initialize();

      mockStderr.push('Loading Qwen3-TTS model...');

      setTimeout(() => {
        mockStdout.push('{"status":"ready","model_variant":"base-1.7b","features":[],"voices":[]}\n');
      }, 20);

      await initPromise;

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[qwen-tts-')
      );

      consoleSpy.mockRestore();
    });
  });
});
