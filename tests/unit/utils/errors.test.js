import { describe, it, expect } from 'vitest';
import { TranscriptionError, TTSError, FileUploadError, MossTTSError } from '../../../src/utils/errors.js';

describe('TranscriptionError', () => {
  it('should set correct name and message', () => {
    const error = new TranscriptionError('Test message');
    expect(error.name).toBe('TranscriptionError');
    expect(error.message).toBe('Test message');
    expect(error.cause).toBe(null);
  });

  it('should store cause when provided', () => {
    const cause = new Error('Original error');
    const error = new TranscriptionError('Wrapper message', cause);
    expect(error.cause).toBe(cause);
    expect(error.message).toBe('Wrapper message');
  });

  it('should convert to Boom error with badImplementation (500)', () => {
    const error = new TranscriptionError('Transcription failed');
    const boom = error.toBoom();
    expect(boom.isBoom).toBe(true);
    expect(boom.output.statusCode).toBe(500);
    expect(boom.message).toBe('Transcription failed');
  });

  it('should be instanceof Error', () => {
    const error = new TranscriptionError('Test');
    expect(error instanceof Error).toBe(true);
    expect(error instanceof TranscriptionError).toBe(true);
  });
});

describe('TTSError', () => {
  it('should set correct name and message', () => {
    const error = new TTSError('TTS failed');
    expect(error.name).toBe('TTSError');
    expect(error.message).toBe('TTS failed');
    expect(error.cause).toBe(null);
  });

  it('should store cause when provided', () => {
    const cause = new Error('Model initialization failed');
    const error = new TTSError('TTS wrapper', cause);
    expect(error.cause).toBe(cause);
  });

  it('should convert to Boom error with badImplementation (500)', () => {
    const error = new TTSError('TTS generation failed');
    const boom = error.toBoom();
    expect(boom.isBoom).toBe(true);
    expect(boom.output.statusCode).toBe(500);
    expect(boom.message).toBe('TTS generation failed');
  });

  it('should be instanceof Error', () => {
    const error = new TTSError('Test');
    expect(error instanceof Error).toBe(true);
    expect(error instanceof TTSError).toBe(true);
  });
});

describe('FileUploadError', () => {
  it('should set correct name and message', () => {
    const error = new FileUploadError('File too large');
    expect(error.name).toBe('FileUploadError');
    expect(error.message).toBe('File too large');
  });

  it('should not have cause property (unlike other errors)', () => {
    const error = new FileUploadError('Invalid file');
    expect(error.cause).toBeUndefined();
  });

  it('should convert to Boom error with badRequest (400)', () => {
    const error = new FileUploadError('No file provided');
    const boom = error.toBoom();
    expect(boom.isBoom).toBe(true);
    expect(boom.output.statusCode).toBe(400);
    expect(boom.message).toBe('No file provided');
  });

  it('should be instanceof Error', () => {
    const error = new FileUploadError('Test');
    expect(error instanceof Error).toBe(true);
    expect(error instanceof FileUploadError).toBe(true);
  });
});

describe('MossTTSError', () => {
  it('keeps its cause and converts to a 500 Boom error', () => {
    const cause = new Error('backend');
    const error = new MossTTSError('MOSS failed', cause);
    expect(error.name).toBe('MossTTSError');
    expect(error.cause).toBe(cause);
    expect(error.toBoom().output.statusCode).toBe(500);
  });
});
