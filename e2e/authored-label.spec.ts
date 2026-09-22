import { expect, test } from '@playwright/test';

/**
 * **Porotce se doví, že tenhle svět je přehrávaný** (P15 `T45-honestlabel`).
 *
 * Model se pro tohle demo nekupuje (rozhodnutí `G2` z 5. 9. 2026), takže větu,
 * kterou sklad nezná, obslouží **nejbližší** dopředu autorovaný svět
 * (`T43-nearest`, `T46-routewire`). Bez viditelné věty by produkt tvrdil, že
 * tuhle větu napsal model teď — a je to nepravda, kterou porotce odhalí druhou
 * větou, protože dvě různé věty dostanou tentýž svět.
 *
 * ## Proč e2e, a ne jednotkový test
 *
 * Vlastnost zní „**je to vidět na obrazovce**", ne „komponenta by to vykreslila".
 * Popisek, který se vyrenderuje do zavřené zásuvky nebo pod dok, splní každý
 * jednotkový test a porotci neřekne nic. Sada se proto ptá skutečné stránky, kde
 * ten prvek stojí a jestli je vidět.
 */

/** Věta, kterou sklad zná přesně (`src/worldstream/authored-worlds.json`). */
const AUTHORED = 'A cathedral of stacked shipping containers around a light well.';

/** Věta, kterou nikdo nepředvídal. Nesmí být blízko ničemu ve skladu. */
const UNKNOWN = 'A greenhouse swallowed by a glacier, its panes still warm.';

const WORLD_BUDGET_MS = 90_000;

async function buildWorld(page: import('@playwright/test').Page, sentence: string): Promise<void> {
  await page.getByTestId('prompt-input').fill(sentence);
  await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('world-status')).toHaveAttribute('data-state', 'live', {
    timeout: WORLD_BUDGET_MS,
  });
}

test('věta mimo sklad dostane svět a produkt to řekne nahlas', async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto('/studio');
  await page.getByTestId('generation-mode').selectOption('prepared');
  await buildWorld(page, UNKNOWN);

  const notice = page.getByTestId('world-authored');
  await expect(notice).toBeVisible();

  // Text **jmenuje, co se stalo**, a neomlouvá se. Anglicky, protože viditelná
  // měď produktu je anglicky (`CLAUDE.md`, Konvence) — a protože se do pole
  // píšou anglické věty.
  // Druhá věta přibyla v `ec2163e` (14. 9. 2026): nejbližší svět nikdo
  // neporovnal s tím, co porotce napsal, a popisek to má říct.
  await expect(notice).toHaveText(
    'This is the closest world authored ahead of time. Relevance to your request has not been verified.',
  );

  // Popisek bydlí v doku, ne ve vlastním rohu (konvence rohů v `CLAUDE.md`).
  // Šestý absolutně kotvený box je přesně ta vada, kvůli které `.ws-shell`
  // vznikla — a okem se nevidí, protože každý ten box je průsvitný.
  expect(
    await notice.evaluate((node) => node.closest('.ws-dock') !== null),
    'popisek se ukotvil sám místo aby bydlel v doku',
  ).toBe(true);

  // A doopravdy stojí na obrazovce, ne za jejím okrajem.
  //
  // ⚠ **Zásahová zkouška `elementFromPoint` se sem nehodí a je to naměřené**
  // (6. 9. 2026): `.ws-provenance` má `pointer-events: none`, protože je to
  // sdělení, ne ovladač — úplně stejně jako `.ws-status`. Takový prvek
  // `elementFromPoint` **přeskočí**, takže by zkouška hlásila „někdo tě
  // překryl" nad popiskem, který nikdo nepřekryl. Měří se proto obdélník.
  const box = (await notice.boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.width, 'popisek má nulovou šířku').toBeGreaterThan(0);
  expect(box.y, 'popisek stojí pod spodní hranou okna').toBeLessThan(view.height);
  expect(box.x, 'popisek stojí za pravou hranou okna').toBeLessThan(view.width);
});

test('i věta, kterou sklad zná přesně, se přizná k uloženému světu', async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto('/studio');
  await page.getByTestId('generation-mode').selectOption('prepared');
  await buildWorld(page, AUTHORED);

  // ⚠ **Tenhle test do 7. 9. 2026 tvrdil pravý opak** (`toHaveCount(0)`)
  // s odůvodněním „nic se nenahrazovalo, není co přiznávat". Za tehdejšího
  // pořadí to byla pravda: sklad se hledal jedině bez klíče, takže přesná
  // shoda znamenala „sklad uměl právě tuhle větu".
  //
  // **Od `T14r-actone` to pravda není.** Uvařený svět vydávají i dveře, na
  // které nevyšel placený slot, takže přesná shoda znamená jen „tenhle svět je
  // uložený" — a uložený svět bez popisku je tvrzení, že ho model napsal teď.
  // Rozhodla debata Opus ↔ Codex 7. 9. 2026,
  // `.claude/debate/worldstream-twoacts-decision.md`, nález o popisku.
  const notice = page.getByTestId('world-authored');
  await expect(notice).toBeVisible();

  // **Jiná věta než u nejbližší shody, a to je celý smysl.** Kdyby přesná
  // shoda hlásila „closest", produkt by se omlouval za náhradu, ke které
  // nedošlo — a porotce, který tu větu uvidí u obou, ji přestane číst.
  await expect(notice).toHaveText('This world was authored ahead of time.');
});

test('prázdné plátno o původu mlčí', async ({ page }) => {
  await page.goto('/studio');
  await page.getByTestId('generation-mode').selectOption('prepared');
  await expect(page.getByTestId('world-status')).toHaveAttribute('data-state', 'empty');
  await expect(page.getByTestId('world-authored')).toHaveCount(0);
});
