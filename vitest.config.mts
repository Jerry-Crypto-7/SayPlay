import { defineConfig } from 'vitest/config';

// Bez tohohle si vitest vezme i `e2e/*.spec.ts`, což jsou Playwright testy —
// spadnou na "test() can only be called in a test file" a shodí celý `npm test`.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'evals/**/*.test.ts', 'scripts/**/*.test.ts', 'ops/**/*.test.ts'],
    exclude: ['node_modules/**', 'e2e/**', '.next/**'],
    // Výchozích 5 s vitestu nestačí testům, které protáhnou celý zmrazený korpus
    // jedním `it` (25 editačních promptů endpointem) nebo spustí podproces.
    // Pod zátěží paralelních workerů padal pokaždé jiný z nich — zátěží podmíněná
    // vada sady, ne regrese. Nejpomalejší soubor jede ~30 s, takže 30 s na test
    // je strop s rezervou; skutečné zaseknutí pořád spadne.
    testTimeout: 30_000,
  },
});
