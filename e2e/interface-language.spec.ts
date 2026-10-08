import { expect, test, type Page } from '@playwright/test';

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
