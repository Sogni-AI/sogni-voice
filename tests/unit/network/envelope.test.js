import { describe, it, expect } from 'vitest';
import { encodeFrame, decodeFrame } from '../../../src/network/envelope.js';

describe('envelope', () => {
  it('encodes type and base64 JSON data', () => {
    const raw = encodeFrame('workerInfo', { maxConcurrentJobs: 2 });
    const parsed = JSON.parse(raw);

    expect(parsed.type).toBe('workerInfo');
    expect(JSON.parse(Buffer.from(parsed.data, 'base64').toString('utf-8')))
      .toEqual({ maxConcurrentJobs: 2 });
  });

  it('round-trips through decodeFrame', () => {
    const job = { jobID: 'job-1', jobType: 'speech', task: 'stt', modelID: 'parakeet-tdt' };
    expect(decodeFrame(encodeFrame('jobRequest', job))).toEqual({ type: 'jobRequest', data: job });
  });

  it('decodes a Buffer payload', () => {
    const buffer = Buffer.from(encodeFrame('authenticated', { ok: true }), 'utf-8');
    expect(decodeFrame(buffer)).toEqual({ type: 'authenticated', data: { ok: true } });
  });

  it('decodes a frame with no data field as null data', () => {
    expect(decodeFrame(JSON.stringify({ type: 'ping' }))).toEqual({ type: 'ping', data: null });
  });

  it('throws when the frame has no string type', () => {
    expect(() => decodeFrame(JSON.stringify({ data: 'e30=' }))).toThrow(/missing a string "type"/);
  });

  it('throws on non-JSON input', () => {
    expect(() => decodeFrame('not json')).toThrow();
  });
});
