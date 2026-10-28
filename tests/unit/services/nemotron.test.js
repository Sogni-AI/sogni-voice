import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

describe('Nemotron daemon lifecycle', () => {
  let service;
  let spawn;
  const children = [];
  const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(async () => {
    vi.resetModules();
    children.length = 0;
    spawn = vi.fn(() => {
      const child = new EventEmitter();
      Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      child.requests = [];
      child.stdin.on('data', (data) => child.requests.push(JSON.parse(data.toString())));
      child.kill = vi.fn(() => { child.emit('close', 0); return true; });
      children.push(child);
      return child;
    });
    vi.doMock('node:child_process', () => ({ spawn }));
    vi.doMock('../../../src/config/index.js', () => ({ config: { nemotron: {
      backend: 'mlx', pythonPath: './.venv-nemotron/bin/python3', modelId: 'nvidia/test',
      modelRevision: 'pinned', mlxBits: 4, url: 'http://127.0.0.1:8003',
      maxNewTokens: 16384, timeout: 10000, daemonStartupTimeout: 10000,
    } } }));
    const { NemotronService } = await import('../../../src/services/nemotron.js');
    service = new NemotronService();
  });

  afterEach(async () => { await service.shutdown(); });

  function respond(child, response) { child.stdout.write(`${JSON.stringify(response)}\n`); }

  it('shares model startup and serializes concurrent uploads', async () => {
    const first = service.transcribe('/tmp/first.wav');
    const second = service.transcribe('/tmp/second.wav');
    expect(spawn).toHaveBeenCalledTimes(1);
    respond(children[0], { status: 'ready' });
    await nextTurn();
    expect(children[0].requests).toHaveLength(1);
    const reply = (id) => ({ id, success: true, text: 'Hello', segments: [], finish_reason: 'stop' });
    respond(children[0], reply(children[0].requests[0].id));
    expect(await first).toMatchObject({ text: 'Hello', complete: true, backend: 'mlx' });
    await nextTurn();
    expect(children[0].requests).toHaveLength(2);
    expect(children[0].requests[1].audio_path).toBe('/tmp/second.wav');
    respond(children[0], reply(children[0].requests[1].id));
    await second;
  });

  it('rejects a crashed request and loads a fresh daemon for the next upload', async () => {
    const first = service.transcribe('/tmp/first.wav');
    const rejected = expect(first).rejects.toThrow('Nemotron daemon exited');
    respond(children[0], { status: 'ready' });
    await nextTurn();
    children[0].emit('close', 1);
    await rejected;
    const second = service.transcribe('/tmp/second.wav');
    expect(spawn).toHaveBeenCalledTimes(2);
    respond(children[1], { status: 'ready' });
    await nextTurn();
    respond(children[1], {
      id: children[1].requests[0].id, success: true, text: 'Partial', segments: [], finish_reason: 'length',
    });
    expect(await second).toMatchObject({ text: 'Partial', complete: false, finishReason: 'length' });
  });

  it('returns bad-input errors from the decoder without marking them successful', async () => {
    const result = service.transcribe('/tmp/too-long.wav');
    const rejected = expect(result).rejects.toMatchObject({ output: { statusCode: 400 } });
    respond(children[0], { status: 'ready' });
    await nextTurn();
    respond(children[0], {
      id: children[0].requests[0].id, success: false, invalid_input: true,
      error: 'Nemotron requires nonempty audio up to 60 minutes',
    });
    await rejected;
  });
});
