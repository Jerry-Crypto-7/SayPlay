import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Bez tohohle si vitest vezme i `e2e/*.spec.ts`, což jsou Playwright testy —
// spadnou na "test() can only be called in a test file" a shodí celý `npm test`.
export default defineConfig({
  resolve: {
    // `@/` je v `tsconfig.json` a vitest o něm sám neví. Do 20. 8. 2026 to
    // nevadilo, protože testované moduly tímhle tvarem importovaly jen typy a
    // ty se při překladu zahodí. První hodnotový import (`@/kit`) spadl na
    // „Cannot find package". Jeden alias je levnější než druhé pravidlo o tom,
    // kde se smí psát `@/` a kde ne.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['src/**/*.test.ts', 'evals/**/*.test.ts', 'scripts/**/*.test.ts', 'ops/**/*.test.ts'],
    exclude: ['node_modules/**', 'e2e/**', '.next/**'],
    // Výchozích 5 s vitestu nestačí testům, které protáhnou celý zmrazený korpus
    // jedním `it` (25 editačních promptů endpointem) nebo spustí podproces.
    // Pod zátěží paralelních workerů padal pokaždé jiný z nich — zátěží podmíněná
    // vada sady, ne regrese. Nejpomalejší soubor jede ~30 s, takže 30 s na test
    // je strop s rezervou; skutečné zaseknutí pořád spadne.
    testTimeout: 30_000,
    /**
     * **Sada běží v jednom procesu a od P15 `T29-lambdadetect` to musí říct.**
     *
     * `ledgerFromEnv()` vydá knihu stropu v paměti jedině tam, kde je „jeden
     * proces" doložené známým `VERCEL_ENV`; jinak odmítá (`STORE_UNCONFIGURED`),
     * protože mlčící prostředí je přesně to, jak vypadá nasazení s vypnutým
     * přepínačem systémových proměnných. Bez tohohle řádku by každý test, který
     * projde placenou cestou, měřil zavřené selhání místo svého předmětu.
     *
     * ⚠ **Samotnou tu bránu tohle neoslepuje** — `spend-store.test.ts` volá
     * `ledgerFromEnv()` s vlastními objekty prostředí, takže na tuhle hodnotu
     * nesahá a odmítání měří dál.
     */
    env: { VERCEL_ENV: 'production' },
  },
});
