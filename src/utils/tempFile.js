import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    this.tempDirs.delete(tempDir);
    try {
      await rm(tempDir, { recursive: true, force: true });
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
