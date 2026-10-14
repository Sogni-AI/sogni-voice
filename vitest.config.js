import { configDefaults, defineConfig } from 'vitest/config';
import { resolveModelTestFilters } from './tests/utils/modelTestFilter.js';

const { excluded, warning } = resolveModelTestFilters();
if (warning) {
  console.warn(warning);
}

export default defineConfig({
  test: {
    // Keep vitest's defaults (node_modules, dist, ...) and skip agent worktrees,
    // which hold whole other checkouts of this repo.
    exclude: [...configDefaults.exclude, '.claude/**', ...excluded],
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
