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
