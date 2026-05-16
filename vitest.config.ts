import { defineConfig } from 'vitest/config';

/**
 * Default suite includes only unit tests under `src/`. Integration tests
 * under `tests/integration/` require a live geas-server and are opt-in via:
 *
 *   npx vitest run --config vitest.integration.config.ts
 *
 * — or by editing this include list.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
  },
});
