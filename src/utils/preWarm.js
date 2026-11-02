import { setTimeout as delay } from 'node:timers/promises';

/**
 * Load a daemon in the background at startup. Never rejects: a daemon that fails
 * here can still start on its first request, and that mustn't stop the server.
 *
 * @param {string} name - Daemon name for the log
 * @param {() => Promise<void>} initialize - Starts the daemon
 * @param {{ retryAfterMs?: number }} [options] - Try once more after this long
 */
export const preWarmDaemon = async (name, initialize, { retryAfterMs } = {}) => {
  try {
    await initialize();
  } catch (error) {
    console.error(`${name} pre-warm failed:`, error);
    if (retryAfterMs) {
      await delay(retryAfterMs);
      await preWarmDaemon(name, initialize);
    }
  }
};
