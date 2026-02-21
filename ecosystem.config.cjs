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
        PORT: 3000,
        HOST: '0.0.0.0',
        // ORT threading config: generateLock serializes requests, so we can allow
        // intra-op parallelism for faster single-inference performance
        OMP_NUM_THREADS: '4',
        ORT_INTRA_OP_NUM_THREADS: '4', // Parallelism within operations (matmul, etc)
        ORT_INTER_OP_NUM_THREADS: '1', // Keep sequential between operations
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        HOST: '0.0.0.0',
        // ORT threading config: generateLock serializes requests, so we can allow
        // intra-op parallelism for faster single-inference performance
        OMP_NUM_THREADS: '4',
        ORT_INTRA_OP_NUM_THREADS: '4', // Parallelism within operations (matmul, etc)
        ORT_INTER_OP_NUM_THREADS: '1', // Keep sequential between operations
      },
    },
  ],
};
