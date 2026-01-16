module.exports = {
  apps: [
    {
      name: 'sogni-transcribe',
      script: 'src/index.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      // max_memory_restart: '1G', // Disabled - TTS model needs more memory
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
        HOST: '0.0.0.0',
        // Force ONNX Runtime single-threaded to prevent mutex errors on Apple Silicon
        OMP_NUM_THREADS: '1',
        ORT_INTRA_OP_NUM_THREADS: '1',
        ORT_INTER_OP_NUM_THREADS: '1',
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        HOST: '0.0.0.0',
        // Force ONNX Runtime single-threaded to prevent mutex errors on Apple Silicon
        OMP_NUM_THREADS: '1',
        ORT_INTRA_OP_NUM_THREADS: '1',
        ORT_INTER_OP_NUM_THREADS: '1',
      },
    },
  ],
};
