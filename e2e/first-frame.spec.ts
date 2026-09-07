import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * **Za jak dlouho porotce doopravdy uvidí prostor** (P15 `T14r-actone`).
 *
 * Slib zní „prostor do tří sekund". Živá cloudová cesta ho neplní o dva řády
 * (`T14r-latency`: medián 146 s, p95 214 s), a rozhodnutí uživatele ze
 * 7. 9. 2026 zní vydat napřed uvařený svět. Tohle měří, co ta cesta stojí —
 * **v prohlížeči, od stisku po svět na plátně**, ne na serveru.
 *
 * ## Proč zrovna `world-status = live`
 *
 * `buildProxyWorldFrom()` mele hrdiny **sériově a s `await`** ještě než svět
 * vrátí (`src/worldstream/proxy.ts:630–635`), a stránka nastaví svět teprve
 * za ním (`src/app/page.tsx:226–236`). Přechod na `live` je tedy první okamžik,
 * kdy je co ukázat — včetně meshingu, který podle `T14r-meshbudget` sám o sobě
 * stojí u tří hrdinů ≈ 11,4 s. Měřit odpověď serveru by měřilo něco, co porotce
 * nevidí.
 *
 * ## Co tenhle soubor NEDĚLÁ
 *
 * **Nedokazuje tři sekundy.** Je to měřidlo s regresním stropem: vydá číslo a
 * spadne, když se to číslo výrazně zhorší. Jestli se slib přepíše podle
 * naměřeného, nebo se cesta zrychlí, je rozhodnutí uživatele v `T14r-latency`,
 * ne věc testu.
 *
 * ⚠ **`e2e/authored-label.spec.ts` na tohle není** — má strop 90 s, takže by
 * prošel i nad minutou a půl.
 */

/** Věta, kterou sklad zná přesně (`src/worldstream/authored-worlds.json`). */
const EXACT = 'A cathedral of stacked shipping containers around a light well.';

/** Věta, kterou nikdo nepředvídal — dostane nejbližší uvařený svět. */
const NEAREST = 'A greenhouse swallowed by a glacier, its panes still warm.';

/**
 * Regresní strop, ne slib.
 *
 * **Naměřeno 7. 9. 2026** na tomhle stroji, systémové Chrome, uvařená cesta
 * bez nakonfigurovaného modelu: **přesná shoda 3 468 ms, nejbližší 16 444 ms**
 * (`evals/worldstream/first-frame.json`).
 *
 * **Ten rozdíl není náhoda a není v síti** — obě věty čte sklad z paměti.
 * Je to meshing hrdinů v prohlížeči: `buildProxyWorldFrom()` je mele sériově,
 * takže těžší svět stojí násobně víc (`T14r-meshbudget`). Kdo bude zkracovat
 * cestu k prvnímu snímku, zkracuje **tohle**, ne odpověď serveru.
 *
 * Strop je nad naměřeným maximem s rezervou ~50 % na rozptyl stroje; kdo ho
 * posune, **napíše k tomu proč a nové číslo**, přesně jako u připíchnutých
 * čísel v `offline-chain` (`CLAUDE.md`, Konvence).
 */
const FIRST_FRAME_CEILING_MS = 25_000;

const REPORT = 'evals/worldstream/first-frame.json';

async function measure(page: import('@playwright/test').Page, sentence: string): Promise<number> {
  await page.goto('/');
  await expect(page.getByTestId('world-status')).toHaveAttribute('data-state', 'empty');

  await page.getByTestId('prompt-input').fill(sentence);
  const started = Date.now();
  await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('world-status')).toHaveAttribute('data-state', 'live', {
    timeout: FIRST_FRAME_CEILING_MS,
  });
  return Date.now() - started;
}

test('uvařený svět dojde na plátno a měří se, jak dlouho to trvalo', async ({ page }) => {
  test.setTimeout(180_000);

  const exactMs = await measure(page, EXACT);
  const nearestMs = await measure(page, NEAREST);

  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(
    REPORT,
    `${JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        note: 'submit -> world on canvas, cooked path, includes hero meshing in the browser',
        ceilingMs: FIRST_FRAME_CEILING_MS,
        exact: { sentence: EXACT, ms: exactMs },
        nearest: { sentence: NEAREST, ms: nearestMs },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  // **Jediné, co se soudí, je regrese.** Čísla samotná jsou vstup do rozhodnutí
  // o headline, ne jeho výsledek.
  expect(exactMs, 'přesná shoda přestala docházet na plátno').toBeLessThan(FIRST_FRAME_CEILING_MS);
  expect(nearestMs, 'nejbližší shoda přestala docházet na plátno').toBeLessThan(
    FIRST_FRAME_CEILING_MS,
  );
});
