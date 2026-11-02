import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { preWarmDaemon } from '../../../src/utils/preWarm.js';

describe('preWarmDaemon', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads once when the first attempt works', async () => {
    const initialize = vi.fn().mockResolvedValue();

    await preWarmDaemon('Test daemon', initialize, { retryAfterMs: 1 });

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('retries once after a failed load', async () => {
    const initialize = vi.fn()
      .mockRejectedValueOnce(new Error('CUDA error: out of memory'))
      .mockResolvedValueOnce();

    await preWarmDaemon('Test daemon', initialize, { retryAfterMs: 1 });

    expect(initialize).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('waits before retrying', async () => {
    const initialize = vi.fn()
      .mockRejectedValueOnce(new Error('CUDA error: out of memory'))
      .mockResolvedValueOnce();

    const started = Date.now();
    await preWarmDaemon('Test daemon', initialize, { retryAfterMs: 50 });

    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });

  it('stops after the retry fails, and never rejects', async () => {
    const initialize = vi.fn().mockRejectedValue(new Error('CUDA error: out of memory'));

    await expect(
      preWarmDaemon('Test daemon', initialize, { retryAfterMs: 1 }),
    ).resolves.toBeUndefined();

    expect(initialize).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledTimes(2);
  });

  it('does not retry unless asked to', async () => {
    const initialize = vi.fn().mockRejectedValue(new Error('missing model'));

    await preWarmDaemon('Test daemon', initialize);

    expect(initialize).toHaveBeenCalledTimes(1);
  });
});
