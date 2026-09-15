import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * **Konfigurace pro měření, která utrácí peníze nebo trvá minuty.**
 *
 * Existuje kvůli jedné vlastnosti: `vitest.config.mts` sbírá `*.test.ts`,
 * takže cokoli s tou příponou běží při každém `npm test`. Placené měření pod
 * takovou příponou by se pouštělo pořád — a přesně takhle si `npm test`
 * přepisoval commitnutý `evals/hostile-report.json`.
 *
 * Přípona `.measure.ts` do výchozího `include` nepatří, takže tudy vede
 * **jediná** cesta ke spuštění: `npm run measure:*`. Není to obrana proti
 * omylu v kódu, je to obrana proti omylu v příkazu.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['evals/**/*.measure.ts'],
    exclude: ['node_modules/**', 'e2e/**', '.next/**'],
    // Měření běží v jednom procesu a po jedné větě: paralelní soubory by si
    // sáhly na týž strop utrácení a na týž report.
    fileParallelism: false,
    // Vlastní strop si nastavuje každé měření samo — tohle je jen pojistka,
    // aby zaseknuté volání nedrželo proces do rána.
    testTimeout: 60 * 60_000,
  },
});
