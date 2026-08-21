import { expect, test, type Page } from '@playwright/test';

/**
 * Oracle úlohy T14 — **vidět, co model napsal, a co se druhou větou změnilo**.
 *
 * Panel je celá polovina teze: svět vlevo, jeho zdroj vpravo. Test se proto ptá
 * na tři věci, a každá kryje jinou vadu:
 *  - panel po první větě ukazuje **věty**, ne nastrouhaný dokument;
 *  - po druhé větě ukazuje **rozdíl** proti první, ne nový výpis. Kdyby se jen
 *    překreslil, informace „co se změnilo" — ta jediná, kvůli které živá editace
 *    dává smysl — by zmizela a nikdo by si toho nevšiml;
 *  - jde **sbalit**, protože na demu se přepíná mezi světem a jeho zdrojem.
 *
 * **Obě věty jsou doslovné texty ze zmrazeného korpusu, a musí být.** Offline
 * větev hledá `record.prompt === call.prompt`, tedy přesnou shodu; vymyšlená
 * věta by skončila poctivým `NO_SOURCE` a test by měřil chybovou cestu.
 */

/** `C01` — místnost se třemi klíči. */
const FIRST_PROMPT = 'a puzzle room where I have to find three keys to open the exit door';

/** `C02` — ponorka, která se zaplavuje. Jiný tvar světa, tedy jistě jiné řádky. */
const SECOND_PROMPT = 'an escape room in a submarine that floods slowly, I have 60 seconds';

async function sentence(page: Page, text: string): Promise<void> {
  await page.getByTestId('prompt-input').fill(text);
  await page.getByTestId('prompt-submit').click();
  await page.waitForFunction(() => window.__worldsmith!.entities().length > 0, undefined, { timeout: 60_000 });
}

/** Texty řádků panelu, v pořadí, ve kterém stojí. */
async function lines(page: Page): Promise<string[]> {
  return page.getByTestId('pipeline-line').allInnerTexts();
}

test('panel ukáže program, po druhé větě rozdíl, a jde sbalit', async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto('/');
  await page.waitForFunction(() => window.__worldsmith !== undefined, undefined, { timeout: 60_000 });

  // Dokud nepadla věta, panel nic nepředstírá.
  await expect(page.getByTestId('pipeline-panel')).toHaveCount(0);

  await sentence(page, FIRST_PROMPT);

  // 1. Panel stojí a mluví ve větách. Sekce jsou všechny tři.
  await expect(page.getByTestId('pipeline-panel')).toBeVisible();
  await expect(page.getByTestId('pipeline-section-stavba')).toBeVisible();
  await expect(page.getByTestId('pipeline-section-pravidla')).toBeVisible();
  await expect(page.getByTestId('pipeline-section-cil')).toBeVisible();

  const first = await lines(page);
  expect(first.length).toBeGreaterThan(3);
  // Ani jeden řádek nesmí vypadat jako vypsaný dokument.
  expect(first.some((line) => line.includes('{') || line.includes('"'))).toBe(false);
  // Cíl je věta o výhře, ne o tom, že nějaká existuje.
  expect(first.some((line) => line.startsWith('Vyhraješ, když '))).toBe(true);

  // 2. První svět není samá novinka — porovnávat nebylo s čím.
  expect(await page.getByTestId('pipeline-line').evaluateAll((nodes) =>
    nodes.every((node) => node.getAttribute('data-change') === 'same'),
  )).toBe(true);

  await sentence(page, SECOND_PROMPT);

  // 3. Druhá věta ukáže ROZDÍL: aspoň jeden řádek je jinak než minule.
  const marks = await page
    .getByTestId('pipeline-line')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-change')));

  expect(marks.length).toBeGreaterThan(3);
  expect(marks.some((mark) => mark !== 'same')).toBe(true);
  // A pořád je to týž panel, ne dva vedle sebe.
  await expect(page.getByTestId('pipeline-panel')).toHaveCount(1);

  const second = await lines(page);
  expect(second).not.toEqual(first);

  // 4. Sbalí se a rozbalí.
  await page.getByTestId('pipeline-toggle').click();
  await expect(page.getByTestId('pipeline-body')).toHaveCount(0);
  await expect(page.getByTestId('pipeline-panel')).toHaveAttribute('data-open', 'false');

  await page.getByTestId('pipeline-toggle').click();
  await expect(page.getByTestId('pipeline-body')).toBeVisible();
});
