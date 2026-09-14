const abortError = () => new DOMException('TTS request cancelled', 'AbortError');

/**
 * Keep work in Node until its daemon is idle. A cancelled generation can then
 * stop its process without losing other callers' requests in the stdin pipe.
 */
export class DaemonRequestQueue {
  constructor({ ensureDaemon, getProcess, pendingRequests, createError, idPrefix = 'req' }) {
    Object.assign(this, { ensureDaemon, getProcess, pendingRequests, createError, idPrefix });
    this.waiting = [];
    this.active = null;
    this.nextId = 0;
  }

  request(payload, { signal, timeout, interruptOnTimeout = true } = {}) {
    if (signal?.aborted) return Promise.reject(abortError());

    return new Promise((resolve, reject) => {
      const job = {
        payload, signal, resolve, reject, timeout, interruptOnTimeout,
        id: `${this.idPrefix}-${++this.nextId}`,
      };
      job.onAbort = () => this.cancel(job, abortError(), true);
      signal?.addEventListener('abort', job.onAbort, { once: true });
      if (this.getProcess()) this.startTimer(job);
      this.waiting.push(job);
      void this.drain();
    });
  }

  startTimer(job) {
    if (!job.timeout || job.timer || job.settled || job.cancelError) return;
    job.timer = setTimeout(() => {
      this.cancel(job, this.createError('TTS request timed out'), job.interruptOnTimeout);
    }, job.timeout);
  }

  settle(job, error, result) {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.onAbort);
    if (error) job.reject(error);
    else job.resolve(result);
  }

  cancel(job, error, interrupt) {
    if (job.settled || job.cancelError) return;
    job.cancelError = error;
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.onAbort);

    if (!job.process || job.responded || !interrupt) {
      // Also covers model loading: finish that shared initialization, but never
      // send this request to Python. No output files have been handed off yet.
      this.waiting = this.waiting.filter((entry) => entry !== job);
      this.settle(job, error);
      return;
    }

    // These backends have no safe per-request interrupt. SIGTERM only sets a
    // shutdown flag checked after inference; SIGKILL actually releases compute.
    // Wait for close before cleaning files or starting a replacement daemon.
    const child = job.process;
    let onClose;
    const onStopError = (cause) => {
      child.removeListener('close', onClose);
      child.removeListener('error', onStopError);
      onClose();
      job.cancelError = this.createError(`Failed to stop TTS daemon: ${cause.message}`);
      // Keep the queue occupied until the original request actually returns.
      this.settle(job, job.cancelError);
    };
    job.stopping = new Promise((resolve) => {
      onClose = () => {
        child.removeListener('error', onStopError);
        resolve();
      };
      child.once('close', onClose);
      child.once('error', onStopError);
    });
    try {
      child.kill('SIGKILL');
    } catch (cause) {
      onStopError(cause);
    }
  }

  cancelWaiting(error) {
    for (const job of [...this.waiting]) this.cancel(job, error, false);
    if (this.active && !this.active.process) this.cancel(this.active, error, false);
  }

  async drain() {
    if (this.active) return;
    const job = this.waiting.shift();
    if (!job) return;
    this.active = job;

    try {
      await this.ensureDaemon();
      // Preserve the separate startup budget. Once loaded, time waiting behind
      // another request counts, and a worker restart never resets that budget.
      this.startTimer(job);
      for (const waiting of this.waiting) this.startTimer(waiting);
      if (job.cancelError) return;
      const child = this.getProcess();
      if (!child) throw this.createError('TTS daemon not available');
      job.process = child;

      const result = await new Promise((resolve, reject) => {
        const complete = (error, response) => {
          job.responded = true;
          this.pendingRequests.delete(job.id);
          if (error) reject(error);
          else resolve(response);
        };
        this.pendingRequests.set(job.id, {
          resolve: (response) => complete(null, response),
          reject: (error) => complete(error),
        });
        job.onWriteError = (error) => complete(this.createError(`Failed to write to daemon: ${error.message}`));
        child.stdin.on('error', job.onWriteError);
        try {
          child.stdin.write(`${JSON.stringify({ ...job.payload, id: job.id })}\n`, (error) => {
            if (error) job.onWriteError(error);
          });
        } catch (error) {
          job.onWriteError(error);
        }
      });
      if (job.stopping) await job.stopping;
      this.settle(job, job.cancelError, result);
    } catch (error) {
      if (job.stopping) await job.stopping;
      this.settle(job, job.cancelError || error);
    } finally {
      if (job.onWriteError) job.process.stdin.removeListener('error', job.onWriteError);
      this.pendingRequests.delete(job.id);
      this.active = null;
      void this.drain();
    }
  }
}
