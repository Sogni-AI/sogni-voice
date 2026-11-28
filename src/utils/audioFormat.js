import { execFile } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const AUDIO_FORMAT_SPECS = {
  wav: {
    extension: 'wav',
    contentType: 'audio/wav',
    ffmpegArgs: null,
  },
  mp3: {
    extension: 'mp3',
    contentType: 'audio/mpeg',
    ffmpegArgs: ['-c:a', 'libmp3lame', '-q:a', '0'],
  },
  flac: {
    extension: 'flac',
    contentType: 'audio/flac',
    ffmpegArgs: ['-c:a', 'flac'],
  },
  opus: {
    extension: 'opus',
    contentType: 'audio/opus',
    ffmpegArgs: ['-c:a', 'libopus', '-b:a', '64k'],
  },
};

export function getAudioContentType(format = 'wav') {
  const normalized = String(format || 'wav').toLowerCase();
  if (normalized === 'json') return 'application/json';
  return AUDIO_FORMAT_SPECS[normalized]?.contentType || 'audio/wav';
}

/**
 * Convert a generated WAV file into one of Sogni's supported audio output formats.
 * When `format === 'wav'`, returns `wavPath` without invoking `ffmpeg`.
 */
export async function convertWavFile(
  wavPath,
  format = 'wav',
  {
    outputPath = null,
    signal = undefined,
    timeoutMs = 300000,
    execFileImpl = execFileAsync,
  } = {},
) {
  const normalized = String(format || 'wav').toLowerCase();
  const spec = AUDIO_FORMAT_SPECS[normalized];
  if (!spec) {
    throw new Error(`Unsupported audio output format: "${format}"`);
  }
  if (!spec.ffmpegArgs) {
    return {
      outputPath: wavPath,
      contentType: spec.contentType,
      extension: spec.extension,
    };
  }

  const resolvedInputPath = resolvePath(wavPath);
  const resolvedTargetPath = resolvePath(
    outputPath || wavPath.replace(/\.[^./\\]+$/, `.${spec.extension}`),
  );
  await execFileImpl('ffmpeg', [
    '-nostdin',
    '-y',
    '-loglevel',
    'error',
    '-protocol_whitelist',
    'file,pipe',
    '-i',
    resolvedInputPath,
    ...spec.ffmpegArgs,
    '--',
    resolvedTargetPath,
  ], { timeout: timeoutMs, signal });

  return {
    outputPath: resolvedTargetPath,
    contentType: spec.contentType,
    extension: spec.extension,
  };
}

/**
 * Synthesize a deterministic 16-bit mono PCM WAV buffer in memory (default 2s @ 16kHz)
 * for Sogni Supernet `isTest === true` worker validation jobs without network downloads.
 */
export function createSyntheticTestWavBuffer({
  durationSeconds = 2,
  sampleRate = 16000,
  frequencyHz = 220,
} = {}) {
  const numSamples = Math.max(1, Math.round(durationSeconds * sampleRate));
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // Mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // Byte rate
  buffer.writeUInt16LE(2, 32); // Block align
  buffer.writeUInt16LE(16, 34); // Bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  const fadeSamples = Math.min(Math.floor(sampleRate * 0.05), Math.floor(numSamples / 4));
  for (let i = 0; i < numSamples; i += 1) {
    let envelope = 1.0;
    if (fadeSamples > 0 && i < fadeSamples) {
      envelope = i / fadeSamples;
    } else if (fadeSamples > 0 && i > numSamples - fadeSamples) {
      envelope = (numSamples - i) / fadeSamples;
    }
    const t = i / sampleRate;
    const sample = 0.2 * envelope * (
      Math.sin(2 * Math.PI * frequencyHz * t)
      + 0.5 * Math.sin(2 * Math.PI * frequencyHz * 2 * t)
    );
    const pcm = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
    buffer.writeInt16LE(pcm, 44 + i * 2);
  }

  return buffer;
}
