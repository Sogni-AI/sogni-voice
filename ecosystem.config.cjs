require('dotenv').config();

const port = parseInt(process.env.PORT, 10) || 3000;
const host = process.env.HOST || '127.0.0.1';
const corsOrigins = process.env.CORS_ORIGINS || 'local';
const networkWorkerEnabled = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.SOGNI_NETWORK_WORKER || '').trim().toLowerCase(),
);

module.exports = {
  apps: [
    {
      name: 'sogni-voice',
      script: 'src/index.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      cron_restart: '0 0 * * *', // Restart once every 24 hours (midnight)
      // max_memory_restart: '1G', // Disabled - TTS model needs more memory
      env: {
        NODE_ENV: 'development',
        PORT: port,
        HOST: host,
        CORS_ORIGINS: corsOrigins,
        // ORT threading config: generateLock serializes requests, so we can allow
        // intra-op parallelism for faster single-inference performance
        OMP_NUM_THREADS: '4',
        ORT_INTRA_OP_NUM_THREADS: '4', // Parallelism within operations (matmul, etc)
        ORT_INTER_OP_NUM_THREADS: '1', // Keep sequential between operations
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: port,
        HOST: host,
        CORS_ORIGINS: corsOrigins,
        // ORT threading config: generateLock serializes requests, so we can allow
        // intra-op parallelism for faster single-inference performance
        OMP_NUM_THREADS: '4',
        ORT_INTRA_OP_NUM_THREADS: '4', // Parallelism within operations (matmul, etc)
        ORT_INTER_OP_NUM_THREADS: '1', // Keep sequential between operations
      },
    },
    // Keep the optional paid-network worker out of the PM2 app list unless it
    // was explicitly enabled. This preserves the historical behavior of
    // `pm2 start ecosystem.config.cjs` for standalone REST API installations.
    ...(networkWorkerEnabled ? [{
      name: 'sogni-speech-worker',
      script: 'src/network/index.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      // No cron_restart: a scheduled bounce would abort paid in-flight jobs.
      // Must exceed SPEECH_WORKER_DRAIN_TIMEOUT_MS so PM2 lets the drain finish.
      kill_timeout: 130000,
      // 102 is "the broker rejected our API key" (AUTH_FAILURE_EXIT_CODE in
      // src/network/socketClient.js). Every restart would be rejected the same
      // way, so PM2 must stop the app and leave the reason in the log instead of
      // burning a restart loop against the broker. Requires PM2 >= 5.2.0
      // (silently ignored on older PM2 — verify with `pm2 --version` on the host).
      stop_exit_codes: [102],
      env: {
        NODE_ENV: 'development',
        SOGNI_NETWORK_WORKER: 'true',
      },
      env_production: {
        NODE_ENV: 'production',
        SOGNI_NETWORK_WORKER: 'true',
      },
    }] : []),
  ],
};
