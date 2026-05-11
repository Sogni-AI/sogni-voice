require('dotenv').config();

const port = parseInt(process.env.PORT, 10) || 3000;
const host = process.env.HOST || '127.0.0.1';
const corsOrigins = process.env.CORS_ORIGINS || 'local';

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
  ],
};
