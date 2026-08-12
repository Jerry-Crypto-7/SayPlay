import { defineConfig } from 'vitest/config';

// Bez tohohle si vitest vezme i `e2e/*.spec.ts`, což jsou Playwright testy —
// spadnou na "test() can only be called in a test file" a shodí celý `npm test`.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'evals/**/*.test.ts'],
    exclude: ['node_modules/**', 'e2e/**', '.next/**'],
  },
});
