import { expect, test } from '@playwright/test';

import { UI_TOKENS, UI_TOKENS_CVD } from '../src/kit/palettes';

/**
 * Oracle úlohy T9 — **HUD bere barvy z jednoho tématu, a to téma má variantu.**
 *
 * Ptá se `getComputedStyle` v běžícím prohlížeči, ne zdrojáku. Rozdíl je
 * podstatný: HUD může mít správnou třídu a přesto být bílý, když se `theme.css`
 * do stránky vůbec nedostane — a to je přesně vada, kterou přechod z inline
 * stylů na téma umožňuje. Grep by ji neviděl.
 *
 * **Stav hry se dotahuje falešnými hodinami, ne čekáním.** Herní smyčka
 * fallbacku běží na `setInterval`, takže `page.clock` ji umí přetočit; bez toho
 * by se barva prohry dala ověřit jedině tak, že test opravdu prosedí časový
 * limit hry. Barva výhry pokrytá není — vyhrát se musí odehrát.
 */

/** `#rrggbb` na tvar, v jakém barvu vrací `getComputedStyle`. */
function rgbOf(hex: string): string {
  const value = hex.replace('#', '');
  const channel = (at: number): number => parseInt(value.slice(at, at + 2), 16);
  return `rgb(${channel(0)}, ${channel(2)}, ${channel(4)})`;
}

const PROMPT = 'collect three keys and reach the gate before the timer runs out';

test('HUD kreslí partii v barvách tématu a umí variantu pro barvoslepé', async ({ page }) => {
  test.setTimeout(120_000);

  await page.clock.install();
  await page.goto(`/fallback/play?prompt=${encodeURIComponent(PROMPT)}`);

  const hud = page.getByTestId('fallback-hud');
  await expect(hud).toBeVisible();

  // Co AC jmenuje: cíl, počítadla, čas, stav.
  await expect(page.getByTestId('hud-goal')).not.toBeEmpty();
  await expect(page.getByTestId('hud-time')).toBeVisible();
  expect(await page.locator('[data-testid^="hud-counter-"]').count()).toBeGreaterThan(0);

  // Sjednocená paleta: text i druhotný text sedí na tokenech kitu.
  await expect(page.getByTestId('hud-goal')).toHaveCSS('color', rgbOf(UI_TOKENS.text));
  await expect(page.locator('.ws-hud-row')).toHaveCSS('color', rgbOf(UI_TOKENS.muted));

  // Žádná barva nezůstala v atributu `style` — to je ta vlastnost, kterou
  // přechod na téma sliboval, a jediná, kterou by tichý návrat k inline stylu
  // porušil, aniž by cokoli jiného zčervenalo.
  const inline = await hud.evaluate((root) =>
    Array.from(root.querySelectorAll<HTMLElement>('*'))
      .concat(root as HTMLElement)
      .map((node) => node.getAttribute('style'))
      .filter((style): style is string => style !== null && /color|background/i.test(style)),
  );
  expect(inline).toEqual([]);

  // Časový limit dojede na falešných hodinách. `hud-time` říká, kolik zbývá.
  const label = (await page.getByTestId('hud-time').textContent()) ?? '';
  const seconds = Number(/(\d+)/.exec(label)?.[1] ?? '0');
  expect(seconds, `z „${label}" nejde přečíst zbývající čas`).toBeGreaterThan(0);

  // `runFor`, ne `fastForward`: skok hodin vpřed vyvolá každý časovač nejvýš
  // jednou, takže interval herní smyčky by odtikal jediný tik místo všech.
  await page.clock.runFor((seconds + 2) * 1000);
  await page.waitForFunction(() => window.__fallback?.phase() === 'lost', undefined, {
    timeout: 30_000,
  });

  const banner = page.getByTestId('hud-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute('data-phase', 'lost');
  await expect(banner).toHaveCSS('color', rgbOf(UI_TOKENS.negative));

  // Varianta pro barvoslepé mění právě tuhle barvu, a mění ji v běžícím DOM.
  await page.evaluate(() => document.documentElement.setAttribute('data-palette', 'cvd'));
  await expect(banner).toHaveCSS('color', rgbOf(UI_TOKENS_CVD.negative));
  expect(UI_TOKENS_CVD.negative).not.toBe(UI_TOKENS.negative);
});
