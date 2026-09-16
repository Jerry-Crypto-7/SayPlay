import { expect, test, type Page } from '@playwright/test';

import { openInspect } from './inspect';

/**
 * **Hlavní stránka staví worldstreamový svět, ne starou herní scénu**
 * (P15 `T21b`, odblokováno `T47-t21bunblock`).
 *
 * Do 6. 9. 2026 byl kořen starou herní scénou nad lokální emisí. Ta se
 * přestěhovala na `/classic` i s celou svojí sadou; kořen je od té chvíle
 * cesta, o které je design book: věta → relace → blueprint → `ProxyWorld` →
 * `WorldstreamStage`.
 *
 * ## Proč je tohle jediná sada nad kořenem
 *
 * `worldstream-hot-swap` a `worldstream-resilience` zůstávají nad
 * `/dev/worldstream` a je to **rozhodnutí, ne opomenutí** (`T21b`, 6. 9. 2026):
 * stojí na tlačítkách harnessu (`materialize`, `materialize-overrun`,
 * `materialize-race`), a ta na produkční stránku nepatří. Pustit je nad
 * kořenem by znamenalo ten harness do produktu dopsat, tedy rozbít přesně to,
 * co měří.
 *
 * ## Bez `.env` to pořád musí projít
 *
 * Model se nekupuje (rozhodnutí `G2` z 5. 9. 2026), takže `cloudEmitter()`
 * vrátí `null` a relaci obslouží sklad dopředu autorovaných světů
 * (`T46-routewire`). Věty níž jsou proto **z toho skladu** — sada nesmí měřit,
 * jestli je zrovna nakonfigurovaný klíč.
 */

/** Věta, kterou sklad zná přesně (`src/worldstream/authored-worlds.json`). */
const AUTHORED = 'A cathedral of stacked shipping containers around a light well.';

/** Rozpočet na relaci a mešování hrubého světa na SwiftShaderu. */
const WORLD_BUDGET_MS = 90_000;

/**
 * Napíše větu a počká na svět **na scéně**, ne na stav v paměti.
 *
 * `world-status` je React; `__worldstreamStage.frames()` je renderer. Mezi tím
 * je celé odhalení, a rozpočet „od věty po první snímek" se o ten rozdíl opírá
 * celý — proto se čeká na obojí.
 */
async function buildWorld(page: Page, sentence: string): Promise<void> {
  await page.getByTestId('prompt-input').fill(sentence);
  await page.getByTestId('prompt-submit').click();

  await expect(page.getByTestId('world-status')).toHaveAttribute('data-state', 'live', {
    timeout: WORLD_BUDGET_MS,
  });
  await page.waitForFunction(
    () => (window.__worldstreamStage?.slots().length ?? 0) > 0,
    undefined,
    { timeout: WORLD_BUDGET_MS },
  );
}

test('kořen je worldstreamové plátno, ne stará herní scéna', async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto('/');
  await expect(page.getByTestId('worldstream-canvas')).toHaveCount(1);

  // Stará scéna tu **není**, a je to celý smysl přestěhování. `stage-canvas`
  // i `window.__worldsmith` publikuje `Stage`, tedy komponenta, která zůstala
  // na `/classic`. Kdyby se sem některá z nich vrátila, běžely by na kořeni
  // dva renderery a porotce by viděl ten, který se namountoval druhý.
  await expect(page.getByTestId('stage-canvas')).toHaveCount(0);
  expect(await page.evaluate(() => window.__worldsmith === undefined)).toBe(true);

  // Plátno drží **volnou plochu** okna, ne celé okno.
  //
  // ⚠ **Do 16. 9. 2026 tu stálo „plátno drží celý viewport"** a byla to pravda
  // tehdejšího rozvržení: svět kreslil pod dok, ovládání i panely. P18 T2 to
  // obrací — dolní pruh patří rozhraní a svět do něj nesahá (`theme.css`,
  // „Volná plocha plátna"). Zavřená zásuvka nic neubírá zprava, takže šířka
  // zůstává celá; výšku ukrajuje pruh, a přesně to se tu měří.
  const view = page.viewportSize()!;
  const canvas = (await page.getByTestId('worldstream-canvas').boundingBox())!;
  expect(canvas.width, 'plátno nezabírá celou šířku okna').toBeGreaterThanOrEqual(view.width - 1);
  expect(canvas.y, 'plátno nezačíná u horní hrany okna').toBeLessThanOrEqual(1);
  expect(canvas.height, 'plátno se scvrklo na proužek').toBeGreaterThan(view.height * 0.5);
  expect(
    canvas.y + canvas.height,
    'plátno sahá až pod dolní pruh, kde stojí rozhraní',
  ).toBeLessThan(view.height);

  // Dokud nepřišla věta, produkt nic nepředstírá.
  await expect(page.getByTestId('world-status')).toHaveAttribute('data-state', 'empty');
  expect(await page.evaluate(() => window.__worldstreamStage?.slots().length ?? 0)).toBe(0);
});

test('věta postaví svět a ten dojde až na plátno', async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto('/');
  await buildWorld(page, AUTHORED);

  // **Sloty, ne jeden objekt.** Prázdný slot v hrubém světě neexistuje
  // (`proxy.ts`), takže každý objekt blueprintu musí mít svoji podobu — i kdyby
  // to byla hlína.
  const probe = await page.evaluate(() => {
    const stage = window.__worldstreamStage!;
    return { ready: stage.ready(), slots: stage.slots().length, builds: stage.builds() };
  });
  expect(probe.ready, 'scéna se z hrubého světa nepostavila').toBe(true);
  expect(probe.slots, 'svět nemá jediný slot').toBeGreaterThan(0);
  expect(probe.builds, 'scéna se nepostavila ani jednou').toBeGreaterThan(0);

  // Snímek se scénou, ne jenom data v paměti: bez tohohle by sada prošla nad
  // světem, který na GPU nikdy nedošel.
  await page.waitForFunction(() => (window.__worldstreamStage?.frames() ?? 0) > 0, undefined, {
    timeout: 30_000,
  });
});

test('Inspect nad hlavní cestou vypisuje sloty, ne panely staré scény', async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto('/');
  await buildWorld(page, AUTHORED);
  await openInspect(page);

  // Panely staré stránky stojí nad lokální emisí a `WorldDocRuntime`, tedy nad
  // systémem, který na `/classic` zůstal celý. Na hlavní cestě nemají zdroj.
  for (const id of ['pipeline-panel', 'timeline', 'witness-preview', 'repair-rounds', 'model-progress']) {
    await expect(page.getByTestId(id), `${id} je na hlavní cestě bez zdroje`).toHaveCount(0);
  }

  const slots = page.getByTestId('world-facts-slot');
  await expect(slots.first()).toBeVisible();
  const rungs = await slots.evaluateAll((nodes) => nodes.map((node) => node.dataset.rung));
  // Uzavřený seznam příček hrubého světa (`ROUGH_RUNGS` v `proxy.ts`). Nová
  // příčka se sem má **dopsat**, ne se v produktu objevit sama.
  for (const rung of rungs) expect(['g3-reduced', 'g2-rich', 'semantic-clay']).toContain(rung);
});

/**
 * Věta, kterou sklad nezná, **taky musí skončit světem** — jen nejbližším.
 *
 * Je to poloviční důkaz `T46-routewire` viděný z prohlížeče: bez `.env` relace
 * nesmí skončit `session.failed`, protože porotce má právo zkoušet vlastní věty
 * (`RULES.md` §3.3). Že to produkt **řekne nahlas**, měří `T45-honestlabel`;
 * tady se soudí jen to, že svět vznikne.
 */
test('věta, kterou nikdo nepředvídal, dostane svět, ne prázdno', async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto('/');
  await buildWorld(page, 'A greenhouse swallowed by a glacier, its panes still warm.');

  expect(await page.evaluate(() => window.__worldstreamStage!.slots().length)).toBeGreaterThan(0);
  await expect(page.getByTestId('world-broken')).toHaveCount(0);
});
