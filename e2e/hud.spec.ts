import { expect, test } from '@playwright/test';

import { openInspect } from './inspect';
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

/**
 * Věta, kterou sklad autorovaných světů zná přesně
 * (`src/worldstream/authored-worlds.json`). Model se pro demo nekupuje, takže
 * tahle sada nesmí měřit, jestli je zrovna nakonfigurovaný klíč.
 */
const SHELL_PROMPT = 'A cathedral of stacked shipping containers around a light well.';

/** Obdélníky, které se s plátnem nesmí protnout. */
const SHELL_BOXES = ['.ws-dock', '.ws-controls', '.ws-inspect-panels'] as const;

/**
 * Oracle úlohy P18 T2 — **rozhraní se přes svět nekreslí**.
 *
 * Mřížka `.ws-shell` od P13 vlny 0 zaručovala, že se dok, ovládání a zásuvka
 * neperou **mezi sebou**. Se scénou se ale pral pořád každý z nich: plátno bylo
 * celý viewport a rozhraní leželo na něm. Je to tatáž vada, kterou mřížka
 * zavírala uvnitř rozhraní, jen o patro níž — a stejně neviditelná, protože
 * všechny ty boxy jsou průsvitné.
 *
 * Měří se **obdélníky za běhu**, ne zdrojový CSS: plocha plátna vzniká až ze
 * skutečných sloupců mřížky a z výšky pruhu, a přesně ta se dá spočítat správně
 * a přitom napsat do jiného místa, než kde plátno doopravdy končí.
 *
 * **Dvě pojistky proti testu, který projde nad ničím.** Prázdný obdélník se
 * neprotne s čímkoli, takže se nejdřív měří, že všechny tři boxy nějakou plochu
 * mají — a plátno scvrklé na proužek by taky prošlo, takže má vlastní spodní
 * mez. Proto to celé stojí nad **postaveným** světem s **otevřenou** zásuvkou:
 * ovládání se objeví teprve se světem a panely se do DOM dostanou teprve
 * otevřením (`e2e/inspect.ts`).
 */
test('rozhraní nekreslí přes plátno: dok, ovládání ani panely se s ním neprotnou', async ({
  page,
}) => {
  test.setTimeout(180_000);

  await page.goto('/');
  await page.getByTestId('generation-mode').selectOption('prepared');
  // Zásuvka se otevírá **před** větou: zavřená panely doopravdy odpojuje.
  await openInspect(page);

  await page.getByTestId('prompt-input').fill(SHELL_PROMPT);
  await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('world-status')).toHaveAttribute('data-state', 'live', {
    timeout: 90_000,
  });

  const measured = await page.evaluate((selectors) => {
    const rect = (selector: string) => {
      const node = document.querySelector(selector);
      if (node === null) return { selector, missing: true, width: 0, height: 0,
        left: 0, top: 0, right: 0, bottom: 0 };
      const box = node.getBoundingClientRect();
      return { selector, missing: false, width: box.width, height: box.height,
        left: box.left, top: box.top, right: box.right, bottom: box.bottom };
    };
    return {
      canvas: rect('[data-testid="worldstream-canvas"]'),
      shell: selectors.map(rect),
      view: { width: window.innerWidth, height: window.innerHeight },
    };
  }, [...SHELL_BOXES]);

  expect(
    measured.shell.filter((box) => box.missing || box.width === 0 || box.height === 0),
    `nad nulovým obdélníkem se nedá nic dokázat: ${JSON.stringify(measured.shell)}`,
  ).toEqual([]);
  expect(measured.canvas.width, 'plátno se scvrklo na proužek').toBeGreaterThan(
    measured.view.width * 0.5,
  );
  expect(measured.canvas.height, 'plátno se scvrklo na proužek').toBeGreaterThan(
    measured.view.height * 0.5,
  );

  const canvas = measured.canvas;
  const overlaps = measured.shell.filter(
    (box) =>
      box.left < canvas.right &&
      box.right > canvas.left &&
      box.top < canvas.bottom &&
      box.bottom > canvas.top,
  );
  expect(
    overlaps,
    `rozhraní leží na plátně ${JSON.stringify(canvas)}: ${JSON.stringify(overlaps)}`,
  ).toEqual([]);
});
