import { expect, test, type Locator } from '@playwright/test';

/**
 * Oracle T27r — **rozhraní na demo cestě je anglicky.**
 *
 * Do 24. 8. 2026 deklaroval `layout.tsx` `lang="en"`, ale veškerá viditelná měď
 * byla česky: „Postav svět", „Co model napsal", „Čas", „Jak to systém vyhrál".
 * Vstupní věty se přitom píšou anglicky a rozpoznávač je z anglických
 * regulárních výrazů, takže `lang` lhal a porotce, který neumí česky, neviděl
 * ani jednu ze čtyř vlastností, které projekt vykazuje.
 *
 * ## Proč to hlídá test, a ne jenom jedna revize
 *
 * Protože čeština se sem vrátí po jednom řetězci. Každý další panel, hláška
 * nebo popisek se píše zvlášť a autor je Čech — bez strojové kontroly je návrat
 * otázkou týdnů a nikdo si toho nevšimne dřív než porotce.
 *
 * ## Co se přesně měří
 *
 * Vyrenderované HTML panelů, ne zdroják. Řetězec ve zdroji ještě nemusí být
 * vidět a řetězec na obrazovce může vzniknout složením — měřit se proto musí to,
 * co doopravdy stojí v dokumentu.
 *
 * Rozhoduje **diakritika**, protože žádné anglické slovo nenese `ě š č ř ž ů ň
 * ť ď` ani `á í é ú ý ó` v běžné mědi. K tomu jde krátký seznam českých slov
 * **bez** diakritiky, která tady doopravdy stála (`stavba`, `pravidla`, `cil`,
 * `tik`, `stav`, `nic`) — ta by jinak prošla, a přesně ony byly identifikátory
 * sekcí panelu překladu, tedy text v `data-line-id` i v `data-testid`.
 *
 * Prompt se do měření **nezapočítává**: píše ho návštěvník a diakritiku v něm
 * mít smí. Test proto čte panely, ne celé tělo stránky, a vstupní pole vynechá.
 */

/** Doslovný text `C03` ze zmrazeného korpusu — svět s postavou, která chodí. */
const FROZEN_PROMPT = 'a stealth level where guards patrol and see me if I stand in the light';

/** Písmena, která v anglické mědi nemají co dělat. */
const CZECH_LETTERS = /[ěščřžýáíéúůňťďóĚŠČŘŽÝÁÍÉÚŮŇŤĎÓ]/u;

/**
 * Česká slova bez diakritiky, která na téhle obrazovce doopravdy stála.
 * Seznam je krátký schválně — je to doplněk k diakritice, ne slovník češtiny.
 */
const CZECH_WORDS = ['stavba', 'pravidla', 'cil', 'tik', 'stav', 'nic', 'hrac', 'svet'];

function findCzech(html: string): readonly string[] {
  const found: string[] = [];
  for (const word of html.split(/[^\p{L}]+/u)) {
    if (word === '') continue;
    if (CZECH_LETTERS.test(word) || CZECH_WORDS.includes(word.toLowerCase())) found.push(word);
  }
  return [...new Set(found)];
}

async function expectEnglish(panel: Locator, what: string): Promise<void> {
  const html = await panel.evaluate((node) => node.outerHTML);
  expect(findCzech(html), `panel ${what} nese české řetězce`).toEqual([]);
}

test('žádný panel na demo cestě nemluví česky', async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto('/');
  await page.waitForFunction(() => window.__worldsmith !== undefined, undefined, { timeout: 60_000 });

  // 1. `lang` odpovídá skutečnosti. Do 24. 8. 2026 tvrdil `en` nad českým UI.
  expect(await page.locator('html').getAttribute('lang')).toBe('en');

  // 2. Prázdná obrazovka — první věc, kterou porotce uvidí.
  await expectEnglish(page.getByTestId('first-run'), 'first-run');

  await page.getByTestId('prompt-input').fill(FROZEN_PROMPT);
  await page.getByTestId('prompt-submit').click();
  await page.waitForFunction(() => window.__worldsmith!.entities().length > 0, undefined, {
    timeout: 60_000,
  });

  // 3. Panely, na kterých stojí celé demo. Kdyby některý chyběl, test by prošel
  //    tím, že neměří nic — proto se nejdřív počká, až budou vidět.
  const panels: readonly (readonly [string, Locator])[] = [
    ['pipeline-panel', page.getByTestId('pipeline-panel')],
    ['timeline', page.getByTestId('timeline')],
    ['witness-preview', page.getByTestId('witness-preview')],
    ['game-controls', page.getByTestId('game-controls')],
  ];

  for (const [what, panel] of panels) {
    await expect(panel, `panel ${what} se nevykreslil, takže se neměří`).toBeVisible({
      timeout: 30_000,
    });
    await expectEnglish(panel, what);
  }

  // 4. Tlačítka pole na prompt. Samotný vstup se vynechá — jeho hodnotu píše
  //    návštěvník a diakritiku v ní mít smí.
  await expectEnglish(page.getByTestId('prompt-submit'), 'prompt-submit');
});

/**
 * Druhá půlka: hláška, kterou porotce uvidí, když napíše vlastní větu mimo
 * zmrazený korpus — tedy ten nejpravděpodobnější první pokus. Do 24. 8. 2026
 * byla celá česky včetně nabídky záložní větve.
 */
test('náhradní místnost i nabídka záložní větve mluví anglicky', async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto('/');
  await page.waitForFunction(() => window.__worldsmith !== undefined, undefined, { timeout: 60_000 });

  await page.getByTestId('prompt-input').fill('a world that the frozen corpus has never heard of');
  await page.getByTestId('prompt-submit').click();

  await expect(page.getByTestId('prompt-substitute')).toBeVisible({ timeout: 60_000 });
  await expectEnglish(page.getByTestId('prompt-substitute'), 'prompt-substitute');
  await expectEnglish(page.getByTestId('prompt-error'), 'prompt-error');
});
