import Boom from '@hapi/boom';
import { basename } from 'node:path';

export const ALLOWED_AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'mp4', 'webm', 'ogg', 'flac'];

const MAX_FILENAME_LENGTH = 255;

export function getExtension(filename) {
  if (typeof filename !== 'string' || filename.length === 0) return '';
  const safe = basename(filename).toLowerCase();
  const dot = safe.lastIndexOf('.');
  if (dot < 0 || dot === safe.length - 1) return '';
  return safe.slice(dot + 1);
}

export function sanitizeEchoFilename(filename) {
  if (typeof filename !== 'string') return '';
  return basename(filename).slice(0, MAX_FILENAME_LENGTH);
}

export function sniffAudioFormat(buf) {
  if (!buf || buf.length < 12) return null;

  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'mp3';
  if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) return 'mp3';

  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45
  ) {
    return 'wav';
  }

  if (
    buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70
  ) {
    const brand = String.fromCharCode(buf[8], buf[9], buf[10], buf[11]);
    // mp4 / m4a / m4b all use the ISO Base Media File Format with the same
    // ftyp box. Audio-only brands (M4A , M4B ) get tagged 'm4a'; generic and
    // video-capable brands (isom, iso2, mp41, mp42, dash, M4V ) get 'mp4'.
    // The validator's equivalents map allows either extension for either tag.
    const audioOnlyBrands = ['M4A ', 'M4B '];
    const mp4Brands = ['isom', 'iso2', 'mp41', 'mp42', 'dash', 'M4V ', 'avc1'];
    if (audioOnlyBrands.includes(brand)) return 'm4a';
    if (mp4Brands.includes(brand)) return 'mp4';
  }

  if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return 'webm';

  if (buf[0] === 0x4F && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return 'ogg';

  if (buf[0] === 0x66 && buf[1] === 0x4C && buf[2] === 0x61 && buf[3] === 0x43) return 'flac';

  return null;
}

export function validateAudioUpload({ filename, headBytes }) {
  const extension = getExtension(filename);
  if (!extension || !ALLOWED_AUDIO_EXTENSIONS.includes(extension)) {
    throw Boom.unsupportedMediaType(
      `Unsupported file extension. Allowed: ${ALLOWED_AUDIO_EXTENSIONS.join(', ')}`,
    );
  }

  const detected = sniffAudioFormat(headBytes);
  if (!detected) {
    throw Boom.unsupportedMediaType('File content is not a recognized audio format');
  }

  // m4a/mp4 share the same on-disk container (ISO BMFF), so accept either
  // extension for either detected brand. Parakeet/torchcodec extracts the
  // audio track regardless.
  const equivalents = {
    mp3: ['mp3'],
    wav: ['wav'],
    m4a: ['m4a', 'mp4'],
    mp4: ['mp4', 'm4a'],
    webm: ['webm'],
    ogg: ['ogg', 'oga', 'opus'],
    flac: ['flac'],
  };
  const allowedExtsForDetected = equivalents[detected] || [detected];
  if (!allowedExtsForDetected.includes(extension)) {
    throw Boom.unsupportedMediaType(
      `File extension .${extension} does not match detected format (${detected})`,
    );
  }

  return detected;
}
