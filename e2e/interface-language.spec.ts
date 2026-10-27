import { expect, test, type Page } from '@playwright/test';

import { ALL_ABILITY_WORDS } from '../src/play/draft/controls';

import { HUD_COUNTER_LABELS, counterLabelsFor } from './hud-labels';

/**
 * Oracle T27r — **rozhraní na demo cestě je anglicky.**
 *
 * Do 24. 8. 2026 deklaroval `layout.tsx` `lang="en"`, ale veškerá viditelná měď
 * byla česky. Porotce, který neumí česky, by neviděl nic z toho, co projekt
 * umí. Demo cesta je od 7. 10. 2026 jen `/play`: úvodní obrazovka a hra z věty.
 *
 * ## Proč to hlídá test, a ne jenom jedna revize
 *
 * Protože čeština se sem vrátí po jednom řetězci. Každý další panel, hláška
 * nebo popisek se píše zvlášť a autor je Čech — bez strojové kontroly je návrat
 * otázkou týdnů a nikdo si toho nevšimne dřív než porotce.
 *
 * ## Co se přesně měří
 *
 * Vyrenderovaná stránka, ne zdroják: viditelný text a popisky, které čte
 * odečítač obrazovky (`aria-label`, `placeholder`, `title`, `alt`). Hodnotu
 * pole s větou píše návštěvník, takže se nepočítá.
 *
 * Rozhoduje **diakritika**, protože žádné anglické slovo nenese `ě š č ř ž ů ň
 * ť ď` ani `á í é ú ý ó` v běžné mědi. K tomu jde krátký seznam českých slov
 * **bez** diakritiky, která v rozhraní doopravdy stála.
 */

/** Věta z `play-create.spec.ts` — vede na hru bez klíčů. */
const SENTENCE = 'Collect five glowing mushrooms then open a portal.';

/** Věta s počtem (P61 T5): sběr tří klíčů, počítadlo HUD nese slovo věty. */
const COUNTED = 'A knight must collect three keys in a haunted castle';

/** Písmena, která v anglické mědi nemají co dělat. */
const CZECH_LETTERS = /[ěščřžýáíéúůňťďóĚŠČŘŽÝÁÍÉÚŮŇŤĎÓ]/u;

/**
 * Česká slova bez diakritiky, která na obrazovce doopravdy stála. Seznam je
 * krátký schválně — je to doplněk k diakritice, ne slovník češtiny.
 */
const CZECH_WORDS = [
  'stavba',
  'pravidla',
  'cil',
  'tik',
  'stav',
  'nic',
  'hrac',
  'svet',
  'spojitou',
  'dynamiku',
  'hybnost',
];

function findCzech(text: string): readonly string[] {
  const found: string[] = [];
  for (const word of text.split(/[^\p{L}]+/u)) {
    if (word === '') continue;
    if (CZECH_LETTERS.test(word) || CZECH_WORDS.includes(word.toLowerCase())) found.push(word);
  }
  return [...new Set(found)];
}

/** Viditelný text stránky a popisky pro odečítač, bez hodnot formulářových polí. */
async function visibleCopy(page: Page): Promise<string> {
  return page.evaluate(() => {
    const labels = [...document.querySelectorAll('[aria-label], [placeholder], [title], img[alt]')].map((node) =>
      ['aria-label', 'placeholder', 'title', 'alt'].map((name) => node.getAttribute(name) ?? '').join(' '),
    );
    return `${document.body.innerText}\n${labels.join('\n')}`;
  });
}

async function expectEnglish(page: Page, what: string): Promise<void> {
  expect(await page.locator('html').getAttribute('lang'), `${what}: lang neodpovídá mědi`).toBe('en');
  expect(findCzech(await visibleCopy(page)), `${what} nese české řetězce`).toEqual([]);
}

test('úvodní obrazovka /play mluví anglicky', async ({ page }) => {
  await page.goto('/play');
  await expect(page.locator('.play-hero')).toBeVisible();
  await expectEnglish(page, '/play');
});

test('hra z věty mluví anglicky', async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto('/play');
  await page.getByLabel('Say it in one sentence').fill(SENTENCE);
  await page.getByTestId('play-create').click();
  await expect(page).toHaveURL(/\/play\/[a-f0-9]+$/);
  // Kdyby se hra nevykreslila, test by prošel tím, že neměří nic.
  await expect(page.locator('.play-shell')).toBeVisible({ timeout: 60_000 });

  await expectEnglish(page, 'hra');
});

/**
 * Počítadlo cíle věty s počtem (P61 T5) nese podstatné jméno věty (`keys 0/3`) – text, který píše věta,
 * ne autor rozhraní. Smí jen tohle slovo navíc k uzavřenému seznamu `HUD_COUNTER_LABELS`.
 */
test('počítadlo cíle nese slovo věty, ostatní popisky jsou z uzavřeného seznamu', async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto('/play');
  await page.getByLabel('Say it in one sentence').fill(COUNTED);
  await page.getByTestId('play-create').click();
  await expect(page).toHaveURL(/\/play\/[a-f0-9]+$/);
  const counter = page.getByTestId('hud-counter-keys');
  await expect(counter).toBeVisible({ timeout: 60_000 });
  await expect(counter).toContainText('keys 0/3');

  const shown = await page.locator('[data-testid^="hud-counter-"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')!.slice('hud-counter-'.length)));
  const allowed = counterLabelsFor(COUNTED);
  for (const label of shown) expect(allowed, `${label} mimo seznam`).toContain(label);
  expect(allowed.filter((label) => !HUD_COUNTER_LABELS.includes(label))).toEqual(['keys']);
  await expectEnglish(page, 'hra s počítadlem věty');
});

/**
 * Sloveso věty na tlačítku akce (P47B T10) je text, který píše věta, ne autor rozhraní – proto
 * uzavřený seznam `ABILITY_WORDS`: na tlačítko smí jen anglické slovo z něj.
 */
test('tlačítko akce nese anglické sloveso věty z uzavřeného seznamu', async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto('/play');
  await page.getByLabel('Say it in one sentence').fill('A squirrel runs and dodges falling acorns');
  await page.getByTestId('play-create').click();
  await expect(page).toHaveURL(/\/play\/[a-f0-9]+$/);
  const buttons = page.locator('[data-testid^="arcade-ability-"]');
  await expect(buttons.first()).toBeVisible({ timeout: 60_000 });

  const words = await buttons.allInnerTexts();
  expect(words).toContain('Dodge');
  for (const word of words) expect(ALL_ABILITY_WORDS as readonly string[], `${word} mimo seznam`).toContain(word.trim());
  await expectEnglish(page, 'hra s tlačítkem akce');
});
