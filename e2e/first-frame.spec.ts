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
 * ⚠ **Do 9. 9. 2026 tu stála čísla, která commitnutý artefakt vyvrací** —
 * nález nezávislé revize. Docblock tvrdil „přesná shoda 3 468 ms, nejbližší
 * 16 444 ms" a stavěl na tom příběh o tom, že těžší svět stojí násobně víc;
 * `evals/worldstream/first-frame.json` přitom drží **2 545 ms** a **1 608 ms**,
 * tedy nejbližší svět **rychlejší** než přesná shoda. Odsud se citují čísla
 * z toho souboru, protože ten je výstupem tohohle testu.
 *
 * **Co z těch dvou čísel plyne a co ne.** Jsou to dva uložené běhy na jednom
 * stroji, ne p95 — a rozdíl mezi nimi je menší než rozptyl, takže se z nich
 * o ceně meshingu nesmí odvozovat nic. Že meshing na téhle cestě dominuje,
 * je měřené jinde (`T14r-meshbudget`), ne tady.
 *
 * **Strop je trojnásobek naměřeného maxima**, tedy mez, která pozná
 * pětinásobné zhoršení. Předtím tu bylo 25 000 ms odvozených od těch
 * fantomových 16 444 — desetinásobek skutečnosti, tedy strop, který
 * nepropustil jedině úplné zaseknutí. Kdo ho posune, **napíše k tomu proč
 * a nové číslo**, přesně jako u připíchnutých čísel v `offline-chain`
 * (`CLAUDE.md`, Konvence).
 */
const FIRST_FRAME_CEILING_MS = 8_000;

/**
 * Kolik se na svět **čeká**, než se vzdá.
 *
 * Schválně řádově víc než strop: čekat jen do stropu znamená, že pomalý stroj
 * spadne na timeoutu locatoru a číslo se nedozvíme. Takhle test doměří i běh,
 * který strop překročí, a spadne až na aserci — s naměřenou hodnotou v hlášce.
 */
const FIRST_FRAME_WAIT_MS = 60_000;

const REPORT = 'evals/worldstream/first-frame.json';

async function measure(page: import('@playwright/test').Page, sentence: string): Promise<number> {
  await page.goto('/');
  await expect(page.getByTestId('world-status')).toHaveAttribute('data-state', 'empty');

  await page.getByTestId('prompt-input').fill(sentence);
  const started = Date.now();
  await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('world-status')).toHaveAttribute('data-state', 'live', {
    timeout: FIRST_FRAME_WAIT_MS,
  });
  return Date.now() - started;
}

test('uvařený svět dojde na plátno a měří se, jak dlouho to trvalo', async ({ page }) => {
  test.setTimeout(180_000);

  const exactMs = await measure(page, EXACT);
  const nearestMs = await measure(page, NEAREST);

  // **Soudí se DŘÍV, než se píše** — nález nezávislé revize 9. 9. 2026.
  // Opačné pořadí znamenalo, že běh, který strop prorazí, nejdřív přepíše
  // commitnutou baseline svými špatnými čísly a teprve pak spadne; příště se
  // pak regrese poměřuje proti sobě samé. Čísla nese hláška, takže se běh,
  // který spadl, nemusí číst z artefaktu.
  expect(exactMs, `přesná shoda přestala docházet na plátno: ${String(exactMs)} ms`).toBeLessThan(
    FIRST_FRAME_CEILING_MS,
  );
  expect(
    nearestMs,
    `nejbližší shoda přestala docházet na plátno: ${String(nearestMs)} ms`,
  ).toBeLessThan(FIRST_FRAME_CEILING_MS);

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

});
