import { expect, test, type Page } from '@playwright/test';

import { openInspect } from './inspect';

/**
 * Oracle úlohy P12 V2 T5 — **panel s koly opravy vstoupil do pravého sloupce**.
 *
 * ## Co tenhle soubor NEOVĚŘUJE a proč
 *
 * AC úlohy žádalo, aby se po zkažené větě objevila kola aspoň dvakrát a
 * poslední hlásilo certifikaci. **To v tomhle prostředí nastat nemůže.** Kola
 * vyrábí jedině `emitLocally()` z modelu na WebGPU, a Playwright jede přes
 * SwiftShader, kde probe skončí na `unavailable` a model se nespustí ani
 * jednou — ani po zkažené větě, ani po povedené. Vynutit je šlo dvěma
 * způsoby a oba jsou horší než tahle díra: přidat do produktu seam na
 * podstrčení stroje, tedy plochu, která existuje kvůli testu, nebo v testu
 * podvrhnout `navigator.gpu` i celý balík WebLLM, což by měřilo atrapu.
 *
 * Pravidlo „dvě kola a poslední certifikované" proto soudí
 * `src/components/__tests__/RepairRounds.test.ts` nad čistými funkcemi panelu
 * a **čitelnost průběhu ruční brána (HALT)** na stroji s GPU.
 *
 * ## Co ověřuje, a proč zrovna to
 *
 * Zbytek úlohy je rozvržení, a to je přesně místo, kde tenhle repozitář dvakrát
 * po sobě nechal několik dní ležet červenou sadu: nový panel si sáhl na vlastní
 * roh a lehl si na cizí. Levý dolní roh od té doby hlídá
 * `e2e/pipeline-panel.spec.ts`; **pravý roh takovou zkoušku neměl** a nový
 * panel jde právě do něj.
 *
 * **Od P13 vlny 0 T1 je ten pravý sloupec uvnitř Inspect zásuvky**
 * (`.ws-inspect-panels` v `src/app/theme.css`). Zavřená zásuvka panely
 * doopravdy odpojí, takže se musí nejdřív otevřít — a otázka zůstává tatáž.
 */

/** Věta mimo zmrazený korpus. Vede na náhradní místnost, tedy bez opravy modelem. */
const PROMPT = 'a room with a single lever that opens a gate';

async function submit(page: Page, text: string): Promise<void> {
  await page.getByTestId('prompt-input').fill(text);
  await page.getByTestId('prompt-submit').click();
  await page.waitForFunction(() => (window.__worldsmith?.entities().length ?? 0) > 0, undefined, { timeout: 60_000 });
}

test('bez opravy panel nestojí a roh nezabírá', async ({ page }) => {
  await page.goto('/classic');
  await openInspect(page);
  await expect(page.getByTestId('repair-rounds')).toHaveCount(0);

  await submit(page, PROMPT);

  // Prostředí bez WebGPU model nespustí, takže kolo neexistuje. Panel, který by
  // tu přesto stál, je stavový řádek — a ten roh nemá co zabírat.
  await expect(page.getByTestId('repair-rounds')).toHaveCount(0);
  await expect(page.getByTestId('repair-round')).toHaveCount(0);
});

/**
 * Pravý dolní roh si nesmí brát kliknutí navzájem.
 *
 * Táž zkouška, jakou má levý roh v `pipeline-panel.spec.ts`, a ze stejného
 * naměřeného důvodu: panel je vidět, ale `elementFromPoint` v jeho středu vrací
 * někoho jiného, takže tlačítko nejde kliknout. Okem se to nepozná.
 */
test('ovládání v pravém dolním rohu zůstane zásahové i s novým panelem', async ({ page }) => {
  await page.goto('/classic');
  await submit(page, PROMPT);
  await openInspect(page);

  const replay = page.getByTestId('witness-replay');
  if ((await replay.count()) > 0) {
    const owner = await replay.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return top === null ? null : (top.closest('[data-testid]')?.getAttribute('data-testid') ?? top.tagName);
    });
    expect(owner, 'přehrání vítězné cesty si bere jiný panel').toBe('witness-replay');
  }

  // Mezera mezi panely sloupce musí zůstat průchozí do plátna — jinak je to
  // neviditelný pruh, který polyká kliknutí.
  const gap = await page.evaluate(() => {
    const strip = document.querySelector('[data-testid="witness-preview"]');
    if (strip === null) return 'no-strip';
    const box = strip.getBoundingClientRect();
    const top = document.elementFromPoint(box.left + box.width / 2, box.bottom + 4);
    return top === null ? 'none' : (top.closest('[data-testid]')?.getAttribute('data-testid') ?? top.tagName);
  });
  expect(gap).not.toBe('repair-rounds');
});
