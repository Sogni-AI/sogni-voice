import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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
        cwd: dirname(audioFilePath),
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
