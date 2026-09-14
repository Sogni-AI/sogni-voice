import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { requestCancellation } from '../../../src/utils/requestCancellation.js';

function fixture() {
  return { raw: { req: new EventEmitter(), res: new EventEmitter() }, events: new EventEmitter() };
}

describe('requestCancellation', () => {
  it('keeps running when the uploaded body closes, but cancels an unfinished response', () => {
    const request = fixture();
    const cancellation = requestCancellation(request);
    request.raw.req.emit('close');
    expect(cancellation.signal.aborted).toBe(false);
    request.raw.res.emit('close');
    expect(cancellation.signal.aborted).toBe(true);
    cancellation.dispose();
  });

  it('ignores successful HTTP completion and removes both listeners', () => {
    const request = fixture();
    const cancellation = requestCancellation(request);
    request.raw.res.writableFinished = true;
    request.raw.res.emit('close');
    expect(cancellation.signal.aborted).toBe(false);
    cancellation.dispose();
    expect(request.events.listenerCount('disconnect')).toBe(0);
    expect(request.raw.res.listenerCount('close')).toBe(0);
  });

  it('cancels a request that disconnected before the handler started', () => {
    const request = fixture();
    request.raw.res.destroyed = true;
    const cancellation = requestCancellation(request);
    expect(cancellation.signal.aborted).toBe(true);
    cancellation.dispose();
  });

  it('also responds to Hapi disconnect events', () => {
    const request = fixture();
    const cancellation = requestCancellation(request);
    request.events.emit('disconnect');
    expect(cancellation.signal.aborted).toBe(true);
    cancellation.dispose();
  });
});
