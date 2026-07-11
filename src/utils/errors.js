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

export class QwenASRError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'QwenASRError';
    this.cause = cause;
  }

  toBoom() {
    return Boom.badImplementation(this.message);
  }
}

export class MossTranscribeDiarizeError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'MossTranscribeDiarizeError';
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

export class PocketTTSError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'PocketTTSError';
    this.cause = cause;
  }

  toBoom() {
    return Boom.badImplementation(this.message);
  }
}

export class MossTTSError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'MossTTSError';
    this.cause = cause;
  }

  toBoom() {
    return Boom.badImplementation(this.message);
  }
}

export class QwenTTSError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'QwenTTSError';
    this.cause = cause;
  }

  toBoom() {
    return Boom.badImplementation(this.message);
  }
}

export class FishTTSError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'FishTTSError';
    this.cause = cause;
  }

  toBoom() {
    return Boom.badImplementation(this.message);
  }
}

export class DiarizationError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'DiarizationError';
    this.cause = cause;
  }

  toBoom() {
    return Boom.badImplementation(this.message);
  }
}
