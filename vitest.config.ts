import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Runs once per test file, in that file's worker — see the file for why.
    setupFiles: ['./test/setup-env.ts'],
  },
});
