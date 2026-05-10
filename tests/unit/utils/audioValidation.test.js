import { describe, it, expect } from 'vitest';
import {
  ALLOWED_AUDIO_EXTENSIONS,
  getExtension,
  sanitizeEchoFilename,
  sniffAudioFormat,
  validateAudioUpload,
} from '../../../src/utils/audioValidation.js';

const head = (...bytes) => {
  const buf = Buffer.alloc(16);
  bytes.forEach((b, i) => { buf[i] = b; });
  return buf;
};

const mp3Id3 = head(0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0, 0, 0);
const mp3Sync = head(0xFF, 0xFB, 0x90, 0x00);
const wav = head(0x52, 0x49, 0x46, 0x46, 0x24, 0x08, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45);
const m4aIsom = head(0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x6D);
const m4aBrand = head(0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4D, 0x34, 0x41, 0x20);
const webm = head(0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x86, 0x81, 0x01);
const ogg = head(0x4F, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
const flac = head(0x66, 0x4C, 0x61, 0x43, 0x00, 0x00, 0x00, 0x22);
const png = head(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A);
const html = head(0x3C, 0x21, 0x44, 0x4F, 0x43, 0x54, 0x59, 0x50, 0x45);

describe('getExtension', () => {
  it('returns lowercase extension', () => {
    expect(getExtension('clip.MP3')).toBe('mp3');
    expect(getExtension('a.b.c.WAV')).toBe('wav');
  });

  it('strips path components (defense against traversal)', () => {
    expect(getExtension('../../etc/passwd.mp3')).toBe('mp3');
    expect(getExtension('/tmp/x.wav')).toBe('wav');
  });

  it('returns empty string for missing/invalid input', () => {
    expect(getExtension('')).toBe('');
    expect(getExtension('noext')).toBe('');
    expect(getExtension('trailing.')).toBe('');
    expect(getExtension(null)).toBe('');
    expect(getExtension(undefined)).toBe('');
  });
});

describe('sanitizeEchoFilename', () => {
  it('strips path components and caps length', () => {
    expect(sanitizeEchoFilename('../../evil.mp3')).toBe('evil.mp3');
    expect(sanitizeEchoFilename('/tmp/foo.wav')).toBe('foo.wav');
  });

  it('caps length at 255 chars', () => {
    const longName = 'a'.repeat(500) + '.mp3';
    expect(sanitizeEchoFilename(longName).length).toBe(255);
  });

  it('handles non-string input', () => {
    expect(sanitizeEchoFilename(null)).toBe('');
    expect(sanitizeEchoFilename(undefined)).toBe('');
  });
});

describe('sniffAudioFormat', () => {
  it('detects mp3 (ID3 tag)', () => expect(sniffAudioFormat(mp3Id3)).toBe('mp3'));
  it('detects mp3 (raw MPEG sync)', () => expect(sniffAudioFormat(mp3Sync)).toBe('mp3'));
  it('detects wav', () => expect(sniffAudioFormat(wav)).toBe('wav'));
  it('detects m4a (isom brand)', () => expect(sniffAudioFormat(m4aIsom)).toBe('m4a'));
  it('detects m4a (M4A brand)', () => expect(sniffAudioFormat(m4aBrand)).toBe('m4a'));
  it('detects webm (EBML)', () => expect(sniffAudioFormat(webm)).toBe('webm'));
  it('detects ogg', () => expect(sniffAudioFormat(ogg)).toBe('ogg'));
  it('detects flac', () => expect(sniffAudioFormat(flac)).toBe('flac'));

  it('returns null for non-audio formats', () => {
    expect(sniffAudioFormat(png)).toBe(null);
    expect(sniffAudioFormat(html)).toBe(null);
  });

  it('returns null for too-short buffer', () => {
    expect(sniffAudioFormat(Buffer.alloc(4))).toBe(null);
    expect(sniffAudioFormat(null)).toBe(null);
  });
});

describe('validateAudioUpload', () => {
  it('accepts each allowlisted format with matching content', () => {
    expect(validateAudioUpload({ filename: 'a.mp3', headBytes: mp3Id3 })).toBe('mp3');
    expect(validateAudioUpload({ filename: 'a.wav', headBytes: wav })).toBe('wav');
    expect(validateAudioUpload({ filename: 'a.m4a', headBytes: m4aIsom })).toBe('m4a');
    expect(validateAudioUpload({ filename: 'a.webm', headBytes: webm })).toBe('webm');
    expect(validateAudioUpload({ filename: 'a.ogg', headBytes: ogg })).toBe('ogg');
    expect(validateAudioUpload({ filename: 'a.flac', headBytes: flac })).toBe('flac');
  });

  it('rejects disallowed extensions', () => {
    expect(() => validateAudioUpload({ filename: 'evil.exe', headBytes: mp3Id3 }))
      .toThrow(/Unsupported file extension/);
    expect(() => validateAudioUpload({ filename: 'page.html', headBytes: html }))
      .toThrow(/Unsupported file extension/);
    expect(() => validateAudioUpload({ filename: 'noext', headBytes: mp3Id3 }))
      .toThrow(/Unsupported file extension/);
  });

  it('rejects spoofed extension (mp3 filename, png content)', () => {
    expect(() => validateAudioUpload({ filename: 'fake.mp3', headBytes: png }))
      .toThrow(/not a recognized audio format/);
  });

  it('rejects mismatched extension vs content (mp3 filename, wav content)', () => {
    expect(() => validateAudioUpload({ filename: 'lie.mp3', headBytes: wav }))
      .toThrow(/does not match detected format/);
  });

  it('rejects path-traversal-style filenames with bad extension', () => {
    expect(() => validateAudioUpload({ filename: '../../etc/passwd', headBytes: mp3Id3 }))
      .toThrow(/Unsupported file extension/);
  });

  it('allows path-traversal-style filename when extension+content valid (validation is content-based)', () => {
    expect(validateAudioUpload({ filename: '../../etc/passwd.mp3', headBytes: mp3Id3 })).toBe('mp3');
  });
});

describe('ALLOWED_AUDIO_EXTENSIONS', () => {
  it('does not include video-only or executable formats', () => {
    expect(ALLOWED_AUDIO_EXTENSIONS).not.toContain('mp4');
    expect(ALLOWED_AUDIO_EXTENSIONS).not.toContain('exe');
    expect(ALLOWED_AUDIO_EXTENSIONS).not.toContain('html');
    expect(ALLOWED_AUDIO_EXTENSIONS).not.toContain('js');
  });
});
