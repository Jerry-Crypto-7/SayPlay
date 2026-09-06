import { expect, test, type Page } from '@playwright/test';

/**
 * Oracle úlohy T19 — **od věty až do výhry, a nikdo do toho nesáhl**.
 *
 * Tohle je jediná sada, která projde celou cestu produktu naráz: věta → svět →
 * ovládání → výhra. Ostatní sady měří vždycky jeden článek; tady se měří, že na
 * sebe navazují.
 *
 * ## Proč věta mimo zmrazený korpus
 *
 * Offline generátor hledá **doslovnou shodu** promptu, takže korpusová věta by
 * jela přes zaznamenanou odpověď. Tahle věta v korpusu není, skončí jako
 * `NO_SOURCE` (HTTP 404) a obslouží ji deterministický rozpoznávač tvarů z T7 —
 * tedy přesně ta cesta, po které pojede porotce s vlastní větou, a bez modelu.
 *
 * Druhá číslovka ve větě by byla past: `countIn` čte první číslo, které najde,
 * takže „three keys and **one** locked door" postaví místnost s jediným klíčem.
 * Naměřeno v `src/game/__tests__/flow.test.ts`.
 */
const SENTENCE = 'a quiet cellar with three keys and a locked exit door';

/** Tik, ve kterém se porovnávají hashe. Dost daleko, aby běh nebyl na nule. */
const CHECKPOINT = 40;

async function build(page: Page): Promise<void> {
  await page.goto('/classic');
  await page.waitForFunction(() => window.__game !== undefined, undefined, { timeout: 60_000 });

  await page.getByTestId('prompt-input').fill(SENTENCE);
  await page.getByTestId('prompt-submit').click();
  await page.waitForFunction(() => window.__game!.targets().length > 0, undefined, { timeout: 60_000 });

  // Klávesy se nesmí psát do promptu — obsluha vstup schválně ignoruje, takže
  // bez odebrání zaměření by hra na stisky nereagovala a test by měřil ticho.
  await page.getByTestId('prompt-input').evaluate((input) => {
    (input as HTMLInputElement).blur();
  });

  // Čeká se, až je na co sahat. Dotaz na `state()` je zároveň to, co fázi zapíše do
  // záznamu — stránka si sama vzorkuje po snímcích a jeden snímek při softwarovém
  // vykreslování dožene celou dávku tiků, takže by `building` mohlo mezi dvěma snímky
  // zmizet. Tady se ptá každý snímek, takže se to stát nemůže.
  await page.waitForFunction(() => window.__game!.state() === 'playing', undefined, { timeout: 60_000 });
}

/** Dojde na tik `at` a vrátí hash stavu přesně tam. */
async function hashAt(page: Page, at: number): Promise<string> {
  await page.waitForFunction((tick) => (window.__worldsmith?.tick() ?? 0) >= tick, at, { timeout: 60_000 });
  return page.evaluate(() => window.__game!.hash());
}

/** Projde všechny cíle po pořadě: dojdi, seber, další. */
async function playToWin(page: Page): Promise<void> {
  const targets = await page.evaluate(() => window.__game!.targets());

  for (let at = 0; at < targets.length; at += 1) {
    await page.keyboard.press(String(at + 1));
    await page.waitForFunction(() => window.__game!.arrived(), undefined, { timeout: 60_000 });
    // Seber se mačká na každé zastávce. Na dveřích je to akce, na kterou žádné
    // pravidlo neposlouchá, tedy tichý no-op — ruka nemusí vědět, co je sběratelné.
    await page.keyboard.press('Space');
  }

  await page.waitForFunction(() => window.__game!.state() === 'won', undefined, { timeout: 60_000 });
}

test('od věty přes klávesy až do výhry, bez zásahu člověka', async ({ page }) => {
  test.setTimeout(240_000);

  await build(page);
  await playToWin(page);

  // Fáze se nečtou jednorázově, ale ze záznamu pořadí — jednorázové čtení by
  // `building` minulo, protože stavba trvá stovky milisekund a mezi dvěma dotazy
  // se stihne odbýt. Záznam se plní každý snímek, takže se ztratit nemůže.
  expect(await page.evaluate(() => window.__game!.seen())).toEqual(['building', 'playing', 'won']);

  // A vyhrálo se tím, co ruka zmáčkla. Stopa je zápis té hry, ne prázdno vedle ní.
  const played = await page.evaluate(() => window.__game!.inputs());
  expect(played.length).toBeGreaterThan(3);
  expect(played.every((input) => input.tick >= 0)).toBe(true);
  expect(new Set(played.map((input) => input.actionId))).toEqual(new Set(['moveTo', 'pickup']));
});

test('restart vrátí svět na začátek a hash sedí s prvním během', async ({ page }) => {
  test.setTimeout(240_000);

  await build(page);

  // 1. Nedotčená místnost stojí. Měří se to, protože porovnání níž bere hash
  //    "v nějakém tiku za čtyřicítkou" — kdyby se stav mezi tiky sám měnil,
  //    porovnávaly by se dva různé okamžiky a shoda ani rozdíl by neznamenaly nic.
  const before = await hashAt(page, CHECKPOINT);
  expect(await hashAt(page, CHECKPOINT * 2)).toBe(before);

  const playedTo = await page.evaluate(() => window.__worldsmith!.tick());
  await playToWin(page);

  await page.evaluate(() => {
    window.__game!.restart();
  });

  // 2. Nový běh se pozná tím, že tik spadl hluboko pod ten, na kterém se hrálo.
  //    Na fázi `building` se zvenčí čekat NEDÁ: po restartu se přestavuje celá
  //    scéna a fáze se stihne odbýt mezi dvěma snímky prohlížeče, takže dotaz
  //    zvenčí ji míjí (naměřeno — původní podoba testu na tom padala). Záznam
  //    fází se plní uvnitř stránky každý snímek, tak se čte odtamtud.
  await page.waitForFunction((tick) => window.__worldsmith!.tick() < tick / 2, playedTo, { timeout: 60_000 });
  await page.waitForFunction(
    () => window.__game!.seen().filter((phase) => phase === 'building').length >= 2,
    undefined,
    { timeout: 60_000 },
  );

  // 3. Prázdná stopa a týž stav, jako měl svět, než do něj kdokoli sáhl.
  expect(await page.evaluate(() => window.__game!.inputs())).toEqual([]);
  expect(await hashAt(page, CHECKPOINT)).toBe(before);
});
