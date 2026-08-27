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
 *
 * Fyzikální trojice přibyla 24. 8. 2026. `NO_FIT` na větu o odrazu a hybnosti
 * vypisoval „I cannot do spojitou dynamiku a hybnost" a brána nad tou hláškou
 * svítila zeleně: ani jedno z těch tří slov nenese diakritiku.
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

/**
 * Popisky počítadel v HUD fallbacku — uzavřená množina, ne volný text.
 *
 * Vlastní kontrola, protože seznam nahoře na ně nedosáhne. Popisek `pole` (z A3)
 * je **anglické slovo**, takže do seznamu českých slov nepatří: dopsat ho tam jde
 * jen za cenu falešného poplachu na každém příštím anglickém „pole". A `chyby`
 * (z A2) diakritiku nemá. Obojí prošlo diakritickou branou beze škrtnutí a stálo
 * na obrazovce od 20. do 24. 8. 2026.
 *
 * Popisek jde i do `data-testid`, takže se čte přesně a nemusí se hádat z textu.
 * Uzavřená množina je tu na místě: tři archetypy jich mají dohromady šest a nový
 * popisek se má do seznamu dopsat, ne detekovat.
 */
const HUD_COUNTER_LABELS = ['collected', 'gate', 'placed', 'mistakes', 'tools', 'step'];

async function expectEnglishCounters(hud: Locator, what: string): Promise<void> {
  const labels = await hud
    .locator('[data-testid^="hud-counter-"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => (node.getAttribute('data-testid') ?? '').replace('hud-counter-', '')),
    );

  expect(labels.length, `HUD ${what} nevykreslil ani jedno počítadlo`).toBeGreaterThan(0);
  expect(
    labels.filter((label) => !HUD_COUNTER_LABELS.includes(label)),
    `HUD ${what} nese popisek počítadla mimo anglický slovník`,
  ).toEqual([]);
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

/**
 * Třetí obrazovka, a ta nejsnáz zapomenutá: **záložní větev**. Vede do ní odkaz
 * přímo z demo cesty a je to nejpravděpodobnější druhé kliknutí porotce, který
 * napsal vlastní větu — takže česká měď v ní ruší tutéž vlastnost, kvůli které
 * T27r vznikla. Sama větev je architektonicky nezávislá (P2 T204), ale jazyk je
 * vlastnost produktu, ne modulu.
 *
 * ## Proč tři věty, a ne jedna
 *
 * Do 24. 8. 2026 se měřila jediná věta a ta vedla na `collect_unlock` — tedy na
 * jediný archetyp, který byl přeložený. Zbylé dva měly v HUD český popisek
 * (`chyby` v A2, `pole` v A3) a brána o nich nevěděla, protože je nikdy
 * nevykreslila. Věty níž jsou naměřené routerem, ne odhadnuté; `route-archetype`
 * to v testu potvrdí, aby se ta trojice nerozpadla tiše, až se lexikon pohne.
 */
const FALLBACK_ARCHETYPE_PROMPTS: readonly (readonly [string, string])[] = [
  ['collect_unlock', 'i want arcade jumping game'],
  ['sort_match', 'a puzzle where I sort coloured blocks into the right bins'],
  ['guide_avoid', 'guide the walker to the exit by placing tools on the grid'],
];

for (const [archetype, prompt] of FALLBACK_ARCHETYPE_PROMPTS) {
  test(`záložní větev mluví anglicky taky — ${archetype}`, async ({ page }) => {
    test.setTimeout(180_000);

    await page.goto(`/fallback/play?prompt=${encodeURIComponent(prompt)}`);

    await expect(page.getByTestId('route-reason')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('route-kind')).toHaveText('archetype');
    await expect(
      page.getByTestId('route-archetype'),
      `věta už nevede na ${archetype}, takže se měří jiná obrazovka`,
    ).toHaveText(archetype);

    await expectEnglish(page.getByTestId('route-reason'), `route-reason (${archetype})`);

    const hud = page.getByTestId('fallback-hud');
    await expect(hud, 'HUD fallbacku se nevykreslil, takže se neměří').toBeVisible({
      timeout: 60_000,
    });
    await expectEnglish(hud, `fallback-hud (${archetype})`);
    await expectEnglishCounters(hud, archetype);
  });
}

/**
 * Čtvrtá obrazovka: **přiznané `NO_FIT`**. Porotce ji uvidí nejspíš dřív než
 * kterýkoli archetyp — je to odpověď na větu, kterou si vymyslí sám, a fyzika je
 * první věc, na kterou u 3D světa přijde řeč.
 *
 * Text hlášky se skládá z tabulky `TOKEN_SENTENCES`, takže jeden neanglický
 * řádek té tabulky projde do dvou míst naráz: do `route-reason` v hlavičce a do
 * panelu nad scénou. Měří se obě, protože se vykreslují nezávisle na sobě.
 */
test('odmítnutí NO_FIT mluví anglicky', async ({ page }) => {
  test.setTimeout(180_000);

  // Naměřeno sondou 24. 8. 2026: router z téhle věty udělá `NO_FIT` na
  // `STATE_CONTINUOUS`, tedy na řádek tabulky, který byl do té doby česky.
  const prompt = 'a ball that bounces with momentum and gravity';
  await page.goto(`/fallback/play?prompt=${encodeURIComponent(prompt)}`);

  await expect(page.getByTestId('route-kind')).toHaveText('no_fit');
  await expectEnglish(page.getByTestId('route-reason'), 'route-reason (no_fit)');

  const notice = page.getByTestId('fallback-no-fit');
  await expect(notice, 'panel NO_FIT se nevykreslil, takže se neměří').toBeVisible({
    timeout: 60_000,
  });
  await expectEnglish(notice, 'fallback-no-fit');
});
