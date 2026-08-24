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

/**
 * Napíše větu a počká, až na plátně stojí **svět z téhle věty**.
 *
 * ## Naměřená past, kvůli které byl tenhle soubor od T15 červený
 *
 * Původní čekání znělo `entities().length > 0`. To je po **první** větě splněné
 * pořád, takže druhé volání nečekalo vůbec na nic — vrátilo se okamžitě a
 * aserce pod ním závodily s přestavbou světa. Podle toho, kdo závod vyhrál,
 * umíral test pokaždé jinde (jednou na značkách rozdílu, jednou na rozbalení
 * panelu), což je přesně ten pohyblivý symptom, který se v plánu popisoval.
 *
 * ## Proč zrovna `snapshotHash`
 *
 * Je to hash zabaleného stavu v tiku výhry, tedy identita **světa**, ne jeho
 * vykreslení. Čeká se na to, až se změní proti hodnotě před odesláním — tím se
 * čeká na tenhle konkrétní svět, a ne na „nějaký". Počet entit ani počet řádků
 * panelu by to nesvedly: obojí může u dvou různých světů vyjít stejně, a řádky
 * panelu jsou navíc to, co se pod tím teprve měří — čekat na ně by znamenalo
 * ověřovat aserci sebou samou.
 */
async function sentence(page: Page, text: string): Promise<void> {
  const before = await page.evaluate(() => window.__pipeline?.certificate()?.snapshotHash ?? null);

  await page.getByTestId('prompt-input').fill(text);
  await page.getByTestId('prompt-submit').click();

  await page.waitForFunction(
    (was) => {
      const now = window.__pipeline?.certificate()?.snapshotHash ?? null;
      return now !== null && now !== was && window.__worldsmith!.entities().length > 0;
    },
    before,
    { timeout: 60_000 },
  );
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
  await expect(page.getByTestId('pipeline-section-build')).toBeVisible();
  await expect(page.getByTestId('pipeline-section-rules')).toBeVisible();
  await expect(page.getByTestId('pipeline-section-goal')).toBeVisible();

  const first = await lines(page);
  expect(first.length).toBeGreaterThan(3);
  // Ani jeden řádek nesmí vypadat jako vypsaný dokument.
  expect(first.some((line) => line.includes('{') || line.includes('"'))).toBe(false);
  // Cíl je věta o výhře, ne o tom, že nějaká existuje.
  expect(first.some((line) => line.startsWith('You win when '))).toBe(true);

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
