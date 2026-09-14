import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { DaemonRequestQueue } from '../../../src/utils/daemonRequestQueue.js';

it('kills a real busy subprocess and completes queued work in its replacement', async () => {
  const pendingRequests = new Map();
  const children = [];
  let current;
  let started;
  const busy = new Promise((resolve) => { started = resolve; });
  const worker = `
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      if (request.text === 'busy') {
        console.log(JSON.stringify({ started: true }));
        // No cooperative cancellation: just like a long native model call.
        while (true) {}
      }
      console.log(JSON.stringify({ id: request.id, audio: 'done' }));
    });
    console.log(JSON.stringify({ ready: true }));
  `;
  const queue = new DaemonRequestQueue({
    pendingRequests,
    createError: (message) => new Error(message),
    getProcess: () => current,
    ensureDaemon: async () => {
      if (current) return;
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', worker], { stdio: ['pipe', 'pipe', 'pipe'] });
        current = child;
        children.push(child);
        const lines = createInterface({ input: child.stdout });
        child.once('error', reject);
        child.once('close', () => {
          current = null;
          lines.close();
          for (const pending of pendingRequests.values()) pending.reject(new Error('exited'));
        });
        lines.on('line', (line) => {
          const result = JSON.parse(line);
          if (result.ready) resolve();
          else if (result.started) started();
          else pendingRequests.get(result.id)?.resolve(result.audio);
        });
      });
    },
  });
  try {
    const controller = new AbortController();
    const cancelled = queue.request({ text: 'busy' }, { signal: controller.signal }).catch((error) => error);
    const next = queue.request({ text: 'next' });
    await busy;
    controller.abort();
    expect(await cancelled).toMatchObject({ name: 'AbortError' });
    expect(children[0].signalCode).toBe('SIGKILL');
    expect(await next).toBe('done');
    expect(children).toHaveLength(2);
    expect(pendingRequests.size).toBe(0);
  } finally {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
    }
  }
});
