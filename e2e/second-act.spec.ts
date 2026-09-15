import { expect, test, type Page, type Response } from '@playwright/test';

/**
 * **Dějství II: model píše svou verzi a nabídne ji** (P15 `T14r-acttwo`,
 * debata Opus ↔ Codex 7. 9. 2026).
 *
 * První větu obsluhuje sklad uvařených světů, protože stojí nula a je na
 * plátně za tři vteřiny. Model píše **druhou relaci** a její výsledek se buď
 * vymění sám, nebo se nabídne — podle toho, jestli porotce mezitím do světa
 * zasáhl.
 *
 * ## Proč tady stojí `page.route`, když ho většina sad zakazuje
 *
 * Dějství II je z definice **placené volání modelu**. Bez klíče se do prohlížeče
 * nedostane a s klíčem by jeden běh sady stál peníze a dvě a půl minuty. To, co
 * se tu soudí, ale placené není: **doputuje druhý blueprint na plátno a vymění
 * se svět, adresa relace i popisek naráz?** To je vlastnost klienta, a nález F1
 * debaty říká, proč se musí měřit na skutečné stránce — `firstBlueprint()` se
 * plní právě jednou, takže dokonalé dějství II ze serveru **porotce nikdy
 * neuvidí**, a jednotkový test tuhle vadu neuvidí taky.
 *
 * Scriptovaný je proto **jediný kus: proud dějství II**. Dějství I jede přes
 * skutečnou route a skutečný sklad, a blueprint, kterým se dějství II plní, je
 * ten jeho — přečtený ze snapshotu relace. Není to výmysl testu: je to jediný
 * platný blueprint, který se v tomhle běhu dá bez modelu získat.
 */

/** Věta, kterou sklad zná přesně (`src/worldstream/authored-worlds.json`). */
const AUTHORED = 'A bridge town: houses hanging under a single span over a dry canyon.';

/** Authored shape edit. The historical prompt also asks for sway, which this
 * renderer/runtime does not implement and this test does not certify. */
const REFINE = 'Make the hanging houses bigger and let them sway.';

/** Relace dějství II. Vlastní id je celý smysl: dějství I se ho nesmí dotknout. */
const ACT_TWO = '11111111-2222-3333-4444-555555555555';

const WORLD_BUDGET_MS = 90_000;

interface Acts {
  /** Pustí proud dějství II. Do zavolání model „pořád píše". */
  readonly release: () => void;
  /** Pustí potvrzení změny. Do zavolání commit visí na drátě. */
  readonly releaseCommit: () => void;
  /** Od téhle chvíle commit visí, dokud ho `releaseCommit` nepustí. */
  readonly hold: () => void;
  /** Adresy, na které stránka poslala požadavek. */
  readonly urls: readonly string[];
}

/** `failure` pošle místo blueprintu `session.failed` s tímhle důvodem. */
async function scriptSecondAct(page: Page, failure?: string): Promise<Acts> {
  let firstSession: string | null = null;
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const urls: string[] = [];
  page.on('request', (request) => urls.push(request.url()));

  // **Potvrzení změny se dá zdržet, a to je celé měřidlo závodu.** Commit trvá
  // v provozu vteřiny a dějství II se do toho okna vejde; bez brány by se ten
  // okamžik trefoval náhodou.
  let releaseCommit = (): void => {};
  const commitGate = new Promise<void>((resolve) => {
    releaseCommit = resolve;
  });
  let holdCommit = false;
  await page.route('**/changes/*/commit', async (route) => {
    if (holdCommit) await commitGate;
    return route.fallback();
  });

  // Dějství I projde na skutečný server; zapamatuje se jen adresa jeho relace.
  // Odpověď je proud, který sám neskončí (P16 `T8-stream404`), takže se id čte
  // z hlavičky při jejím příchodu — `route.fetch()` by na jejím těle visel.
  page.on('response', (response) => {
    const id = response.headers()['x-worldstream-session'];
    if (id !== undefined && id !== ACT_TWO) firstSession = id;
  });
  await page.route('**/api/worldstream/sessions', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { live?: boolean };
    if (body.live !== true) return route.fallback();
    return route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        requestId: 'act-two',
        sessionId: ACT_TWO,
        events: `/api/worldstream/sessions/${ACT_TWO}/events`,
        snapshot: `/api/worldstream/sessions/${ACT_TWO}`,
      }),
    });
  });

  // Vzor míří **jen** na relaci dějství II. Proud dějství I je dlouhoživotný a
  // sám nikdy neskončí, takže protáhnout ho přes `route.fetch()` by ho zaseklo.
  await page.route(`**/api/worldstream/sessions/${ACT_TWO}/events*`, async (route) => {
    await gate;
    const frame = (sequence: number, type: string, payload: unknown): string =>
      `data: ${JSON.stringify({ sessionId: ACT_TWO, sequence, type, at: '1970-01-01T00:00:00.000Z', payload })}\n\n`;
    if (failure !== undefined)
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: frame(1, 'session.failed', { reason: failure }) });
    const snapshot = await page.request.get(`/api/worldstream/sessions/${firstSession!}`);
    const { blueprint } = (await snapshot.json()) as { blueprint: unknown };

    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: frame(1, 'blueprint.ready', { blueprint }) + frame(2, 'session.complete', {}),
    });
  });

  return {
    release,
    releaseCommit: () => {
      holdCommit = false;
      releaseCommit();
    },
    hold: () => {
      holdCommit = true;
    },
    urls,
  };
}

async function buildWorld(page: Page, sentence: string): Promise<void> {
  await page.getByTestId('prompt-input').fill(sentence);
  await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('world-status')).toHaveAttribute('data-state', 'live', {
    timeout: WORLD_BUDGET_MS,
  });
}

async function shapeIdentity(page: Page) {
  return page.evaluate(() => window.__worldstreamStage!.slots().find(slot => slot.stableId === 'hangingHouses')!.representationId);
}

/** Assert the actual accepted shape and its displayed geometry, not disappearance
 * of a preview (which also happens when postcommit display recovery is needed).
 * This does not claim that the authored sway declaration is implemented. */
async function acceptedShape(page: Page, response: Promise<Response>, previous: string | null) {
  const received = await response;
  expect(received.ok()).toBe(true);
  const result = await received.json();
  expect(result, JSON.stringify(result)).toMatchObject({ outcome: 'COMMITTED', stableId: 'hangingHouses' });
  expect(result.representation).not.toBeNull();
  expect(result.representation).toBeDefined();
  await expect.poll(() => shapeIdentity(page), { timeout: WORLD_BUDGET_MS }).not.toBe(previous);
  const slot = await page.evaluate(() => window.__worldstreamStage!.slots().find(entry => entry.stableId === 'hangingHouses')!);
  expect(slot.representationId).not.toBeNull();
  expect(slot.rung).not.toBe('semantic-clay');
  expect(slot.failure).toBeNull();
  expect(slot.triangles).toBeGreaterThan(0);
  await expect(page.getByTestId('change-recovery')).toHaveCount(0);
}

test('dokud porotce nic nezměnil, dějství II svět vymění samo — i s adresou relace', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const acts = await scriptSecondAct(page);

  await page.goto('/');
  await buildWorld(page, AUTHORED);

  // Dějství I: uvařený svět, přiznaný nahlas. Model mezitím píše svůj.
  await expect(page.getByTestId('world-authored')).toBeVisible();
  await expect(page.getByTestId('second-act-writing')).toBeVisible();

  acts.release();

  // **Zmizelý popisek je důkaz výměny.** `setProvenance(null)` znamená „tenhle
  // svět napsal model teď" a je to jediné místo v produktu, kde to je pravda.
  await expect(page.getByTestId('world-authored')).toHaveCount(0, { timeout: WORLD_BUDGET_MS });
  await expect(page.getByTestId('second-act-writing')).toHaveCount(0);
  await expect(page.getByTestId('world-status')).toHaveAttribute('data-state', 'live');
  const measurements = await page.evaluate(() => window.__worldstreamMetrics!.snapshot());
  expect(measurements.runs[0].provenance).toBe('prepared');
  expect(measurements.runs[0].outcome).toBe('cancelled');
  expect(measurements.currentRunId).toBeNull();

  // **A tohle je ta atomicita.** Svět bez své relace by vypadal správně a druhá
  // věta by pořád mířila do relace dějství I — tedy na jiný svět, než jaký
  // porotce vidí. Vidět to není; poznat to jde jedině na adrese požadavku.
  await page.getByTestId('refine-input').fill(REFINE);
  await page.getByTestId('refine-submit').click();
  await expect
    .poll(() => acts.urls.some((url) => url.includes(`${ACT_TWO}/changes`)), {
      timeout: 30_000,
    })
    .toBe(true);
});

/**
 * **Nedoručené dějství II svět nechá, ale řekne proč** (P16 `T8-silentlive`).
 * Do 15. 9. 2026 tu zmizelo jen „is writing" a nic víc — porotce to četl jako
 * „pořád tentýž svět" a z produkce se nedalo poznat, co selhalo.
 */
test('dějství II, které nedorazí, to řekne a svět nechá', async ({ page }) => {
  test.setTimeout(180_000);
  const acts = await scriptSecondAct(page, 'the model wrote a world that did not pass the checks');
  await page.goto('/');
  await buildWorld(page, AUTHORED);
  await expect(page.getByTestId('second-act-writing')).toBeVisible();

  acts.release();

  await expect(page.getByTestId('second-act-missed')).toContainText('did not pass the checks', { timeout: WORLD_BUDGET_MS });
  await expect(page.getByTestId('second-act-writing')).toHaveCount(0);
  await expect(page.getByTestId('world-authored')).toBeVisible();
});

test('visitor input protects the running world from a late second act', async ({ page }) => {
  test.setTimeout(180_000);
  const acts = await scriptSecondAct(page);
  await page.goto('/');
  // This authored scene exposes visitor actions; the shape-edit bridge fixture
  // used by the commit races has none.
  await buildWorld(page, 'A cathedral of stacked shipping containers around a light well.');
  await expect(page.getByTestId('second-act-writing')).toBeVisible();
  await expect(page.getByTestId('runtime-act')).toBeEnabled();
  await page.getByTestId('runtime-act').click();
  await expect(page.getByTestId('runtime-input-result')).toContainText('Input at tick');
  acts.release();
  await expect(page.getByTestId('second-act-offer')).toBeVisible({ timeout: WORLD_BUDGET_MS });
  await expect(page.getByTestId('world-authored')).toBeVisible();
  await expect(page.getByTestId('runtime-input-result')).toContainText('Input at tick');
});

test('když porotce změnu commitnul, dějství II se jen nabídne', async ({ page }) => {
  test.setTimeout(180_000);
  const acts = await scriptSecondAct(page);

  await page.goto('/');
  await buildWorld(page, AUTHORED);
  await expect(page.getByTestId('second-act-writing')).toBeVisible();

  // Porotce sáhne do světa: plán a jeho potvrzení. Od téhle chvíle je na plátně
  // něco, co udělal on.
  await page.getByTestId('refine-input').fill(REFINE);
  await page.getByTestId('refine-submit').click();
  await expect(page.getByTestId('change-preview')).toHaveAttribute('data-kind', 'preview', {
    timeout: WORLD_BUDGET_MS,
  });
  const previousShape = await shapeIdentity(page);
  const commitResponse = page.waitForResponse(response => response.url().endsWith('/commit'));
  await page.getByTestId('change-apply').click();
  await acceptedShape(page, commitResponse, previousShape);
  await expect(page.getByTestId('change-preview')).toHaveCount(0, { timeout: WORLD_BUDGET_MS });

  acts.release();

  // **Nabídka, ne výměna.** Automaticky přepsat svět, do kterého porotce
  // zasáhl, nemá žádné produktové odůvodnění.
  await expect(page.getByTestId('second-act-offer')).toBeVisible({ timeout: WORLD_BUDGET_MS });
  await expect(page.getByTestId('world-authored'), 'svět se vyměnil pod rukama').toBeVisible();

  // Teprve tlačítko svět vymění — a jeho stisk je jediná cesta.
  await page.getByTestId('second-act-show').click();
  await expect(page.getByTestId('world-authored')).toHaveCount(0);
  await expect(page.getByTestId('second-act-offer')).toHaveCount(0);
});

test('dějství II, které dorazí uprostřed potvrzování změny, svět nepřepíše', async ({ page }) => {
  test.setTimeout(180_000);
  const acts = await scriptSecondAct(page);

  await page.goto('/');
  await buildWorld(page, AUTHORED);
  await expect(page.getByTestId('second-act-writing')).toBeVisible();

  await page.getByTestId('refine-input').fill(REFINE);
  await page.getByTestId('refine-submit').click();
  await expect(page.getByTestId('change-preview')).toHaveAttribute('data-kind', 'preview', {
    timeout: WORLD_BUDGET_MS,
  });

  // **Tohle je ten závod, a byl to blokující nález nezávislé revize commitu
  // `b0b95da`.** Porotce klikne na potvrzení, commit odejde na server — a
  // dějství II dorazí dřív, než se vrátí. Dokud se vlajka „porotce zasáhl"
  // zvedala až za odpovědí, dějství II tady četlo `false`, svět vyměnilo pod
  // rozdělaným commitem a na plátně skončil svět jedné relace, v poli druhé
  // věty adresa druhé a popisek původu třetí pravda.
  acts.hold();
  const previousShape = await shapeIdentity(page);
  const commitResponse = page.waitForResponse(response => response.url().endsWith('/commit'));
  await page.getByTestId('change-apply').click();
  await expect
    .poll(() => acts.urls.some((url) => url.includes('/commit')), { timeout: 30_000 })
    .toBe(true);
  acts.release();

  // Nabídka, ne výměna — přestože v tuhle chvíli ještě žádný commit nedoběhl.
  await expect(page.getByTestId('second-act-offer')).toBeVisible({ timeout: WORLD_BUDGET_MS });

  acts.releaseCommit();
  await acceptedShape(page, commitResponse, previousShape);

  // A commit doběhne do svého vlastního světa, ne do toho od modelu.
  await expect(page.getByTestId('change-preview')).toHaveCount(0, { timeout: WORLD_BUDGET_MS });
  await expect(page.getByTestId('world-authored'), 'svět se vyměnil pod rukama').toBeVisible();
});

test('nová věta během potvrzování změny odemkne úpravy nového světa', async ({ page }) => {
  test.setTimeout(180_000);
  const acts = await scriptSecondAct(page);

  await page.goto('/');
  await buildWorld(page, AUTHORED);
  await page.getByTestId('refine-input').fill(REFINE);
  await page.getByTestId('refine-submit').click();
  await expect(page.getByTestId('change-preview')).toHaveAttribute('data-kind', 'preview', {
    timeout: WORLD_BUDGET_MS,
  });

  acts.hold();
  await page.getByTestId('change-apply').click();
  await expect.poll(() => acts.urls.some((url) => url.includes('/commit'))).toBe(true);

  // Nová relace invaliduje starý commit. Jeho finally už nesmí zapisovat do UI,
  // takže odemknutí musí patřit začátku nové relace, ne staré odpovědi.
  await buildWorld(page, AUTHORED);
  await expect(page.getByTestId('refine-submit')).toBeEnabled();
  acts.releaseCommit();

  // Ověříme i skutečnou další operaci; samotný vzhled tlačítka není důkaz,
  // že requestChange používá nový svět a že jej stará odpověď nepřepsala.
  await page.getByTestId('refine-input').fill(REFINE);
  await page.getByTestId('refine-submit').click();
  await expect(page.getByTestId('change-preview')).toHaveAttribute('data-kind', 'preview', {
    timeout: WORLD_BUDGET_MS,
  });
});
