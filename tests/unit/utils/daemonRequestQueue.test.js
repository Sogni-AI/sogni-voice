import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { DaemonRequestQueue } from '../../../src/utils/daemonRequestQueue.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const outcome = (promise) => promise.catch((error) => error);

function fixture() {
  const pendingRequests = new Map();
  const processes = [];
  let current;
  const ensureDaemon = vi.fn(async () => {
    if (current) return;
    const child = new EventEmitter();
    child.requests = [];
    child.stdin = new EventEmitter();
    child.stdin.write = vi.fn((line) => child.requests.push(JSON.parse(line)));
    child.kill = vi.fn(() => true);
    child.on('close', () => {
      current = null;
      for (const pending of pendingRequests.values()) pending.reject(new Error('daemon exited'));
    });
    processes.push(child);
    current = child;
  });
  const queue = new DaemonRequestQueue({
    ensureDaemon,
    getProcess: () => current,
    pendingRequests,
    createError: (message) => new Error(message),
  });
  const reply = (child, result = 'audio') => pendingRequests.get(child.requests.at(-1).id).resolve(result);
  return { queue, processes, pendingRequests, ensureDaemon, reply };
}

afterEach(() => vi.useRealTimers());

describe('DaemonRequestQueue', () => {
  it('rejects an already cancelled request without loading the model', async () => {
    const { queue, ensureDaemon } = fixture();
    await expect(queue.request({}, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(ensureDaemon).not.toHaveBeenCalled();
  });

  it('removes queued cancellation without interrupting the active request', async () => {
    const { queue, processes, reply } = fixture();
    const first = queue.request({ text: 'first' });
    const controller = new AbortController();
    const cancelled = outcome(queue.request({ text: 'cancel' }, { signal: controller.signal }));
    const last = queue.request({ text: 'last' });
    controller.abort();
    expect(await cancelled).toMatchObject({ name: 'AbortError' });
    await flush();
    expect(processes[0].kill).not.toHaveBeenCalled();
    expect(processes[0].requests).toHaveLength(1);
    reply(processes[0]);
    await first;
    await flush();
    expect(processes[0].requests.map((request) => request.text)).toEqual(['first', 'last']);
    reply(processes[0]);
    await last;
  });

  it('waits for process close before rejecting, cleaning files, or dispatching queued work', async () => {
    const { queue, processes, reply } = fixture();
    const controller = new AbortController();
    const cleanup = vi.fn();
    const cancelled = outcome(queue.request({ text: 'cancel' }, { signal: controller.signal }).finally(cleanup));
    const next = queue.request({ text: 'next' });
    await flush();
    controller.abort();
    expect(processes[0].kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    // A buffered response can arrive after kill was sent, before close.
    reply(processes[0]);
    await flush();
    expect(cleanup).not.toHaveBeenCalled();
    expect(processes).toHaveLength(1);
    processes[0].emit('close', null, 'SIGKILL');
    expect(await cancelled).toMatchObject({ name: 'AbortError' });
    await flush();
    expect(processes).toHaveLength(2);
    expect(processes[1].requests[0].text).toBe('next');
    reply(processes[1]);
    await next;
  });

  it('interrupts active generation on timeout and preserves later requests', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { queue, processes, reply } = fixture();
    const timedOut = outcome(queue.request({ text: 'slow' }, { timeout: 100 }));
    const next = queue.request({ text: 'next' }, { timeout: 1000 });
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    expect(processes[0].kill).toHaveBeenCalledWith('SIGKILL');
    processes[0].emit('close');
    expect((await timedOut).message).toMatch(/timed out/);
    await flush();
    reply(processes[1]);
    await next;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires queued requests without sending or killing anything for them', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { queue, processes, reply } = fixture();
    const first = queue.request({ text: 'first' });
    const expired = outcome(queue.request({ text: 'expire' }, { timeout: 100 }));
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    expect((await expired).message).toMatch(/timed out/);
    expect(processes[0].kill).not.toHaveBeenCalled();
    reply(processes[0]);
    await first;
    await flush();
    expect(processes[0].requests).toHaveLength(1);
  });

  it('cancels during shared model loading and never starts that inference', async () => {
    const { queue, ensureDaemon, processes, reply } = fixture();
    let finishLoading;
    const loading = new Promise((resolve) => { finishLoading = resolve; });
    const original = ensureDaemon.getMockImplementation();
    ensureDaemon.mockImplementationOnce(async () => { await loading; await original(); });
    const controller = new AbortController();
    const cancelled = outcome(queue.request({ text: 'cancel' }, { signal: controller.signal }));
    const next = queue.request({ text: 'next' });
    controller.abort();
    expect(await cancelled).toMatchObject({ name: 'AbortError' });
    finishLoading();
    await flush();
    expect(processes).toHaveLength(1);
    expect(processes[0].requests.map((request) => request.text)).toEqual(['next']);
    reply(processes[0]);
    await next;
  });

  it('keeps the startup budget separate from the generation timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { queue, ensureDaemon, processes } = fixture();
    let finishLoading;
    const loading = new Promise((resolve) => { finishLoading = resolve; });
    const original = ensureDaemon.getMockImplementation();
    ensureDaemon.mockImplementationOnce(async () => { await loading; await original(); });
    const settled = vi.fn();
    const request = outcome(queue.request({}, { timeout: 100 }).finally(settled));
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).not.toHaveBeenCalled();
    finishLoading();
    await flush();
    expect(processes[0].requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(processes[0].kill).toHaveBeenCalledWith('SIGKILL');
    processes[0].emit('close');
    expect((await request).message).toMatch(/timed out/);
  });

  it('does not interrupt a voice mutation on timeout or overlap its successor', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { queue, processes, reply } = fixture();
    const mutation = outcome(queue.request({ type: 'rename' }, { timeout: 100, interruptOnTimeout: false }));
    const next = queue.request({ text: 'next' });
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    expect((await mutation).message).toMatch(/timed out/);
    expect(processes[0].kill).not.toHaveBeenCalled();
    expect(processes[0].requests).toHaveLength(1);
    reply(processes[0]);
    await flush();
    reply(processes[0]);
    await next;
  });

  it('ignores cancellation after a completed response and removes timers/listeners', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { queue, processes, reply, pendingRequests } = fixture();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const request = queue.request({}, { signal: controller.signal, timeout: 100 });
    await flush();
    reply(processes[0]);
    await request;
    controller.abort();
    expect(processes[0].kill).not.toHaveBeenCalled();
    expect(pendingRequests.size).toBe(0);
    expect(remove).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers the queue after initialization fails', async () => {
    const { queue, processes, ensureDaemon, reply } = fixture();
    ensureDaemon.mockRejectedValueOnce(new Error('load failed'));
    const failure = outcome(queue.request({}));
    const next = queue.request({});
    expect((await failure).message).toBe('load failed');
    await flush();
    reply(processes[0]);
    await next;
  });

  it('does not kill a worker whose response arrived just before cancellation', async () => {
    const { queue, processes, reply } = fixture();
    const controller = new AbortController();
    const request = outcome(queue.request({}, { signal: controller.signal }));
    await flush();
    reply(processes[0]);
    controller.abort();
    expect(await request).toMatchObject({ name: 'AbortError' });
    expect(processes[0].kill).not.toHaveBeenCalled();
  });

  it('rejects queued work on shutdown without restarting after the active request', async () => {
    const { queue, processes, reply, ensureDaemon } = fixture();
    const active = queue.request({});
    const queued = outcome(queue.request({}));
    await flush();
    queue.cancelWaiting(new Error('shutting down'));
    expect((await queued).message).toBe('shutting down');
    reply(processes[0]);
    await active;
    await flush();
    expect(ensureDaemon).toHaveBeenCalledTimes(1);
    expect(processes[0].requests).toHaveLength(1);
  });

  it('handles an EPIPE while a cancelled worker is closing', async () => {
    const { queue, processes, pendingRequests } = fixture();
    const controller = new AbortController();
    const request = outcome(queue.request({}, { signal: controller.signal }));
    await flush();
    controller.abort();
    processes[0].stdin.emit('error', new Error('EPIPE'));
    processes[0].emit('close');
    expect(await request).toMatchObject({ name: 'AbortError' });
    expect(pendingRequests.size).toBe(0);
    expect(processes[0].stdin.listenerCount('error')).toBe(0);
  });

  it('reports kill failures while keeping later work out of the occupied daemon', async () => {
    const { queue, processes, reply } = fixture();
    const controller = new AbortController();
    const request = outcome(queue.request({}, { signal: controller.signal }));
    const next = queue.request({ text: 'next' });
    await flush();
    processes[0].kill.mockImplementation(() => {
      processes[0].emit('error', new Error('permission denied'));
      return false;
    });
    controller.abort();
    expect((await request).message).toMatch(/Failed to stop/);
    expect(processes[0].requests).toHaveLength(1);
    reply(processes[0]);
    await flush();
    reply(processes[0]);
    await next;
  });
});
