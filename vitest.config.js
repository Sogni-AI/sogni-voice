import { defineConfig } from 'vitest/config';
import { resolveModelTestFilters } from './tests/utils/modelTestFilter.js';

const { excluded, warning } = resolveModelTestFilters();
if (warning) {
  console.warn(warning);
}

export default defineConfig({
  test: {
    exclude: excluded,
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'tests/'],
    },
  },
});
