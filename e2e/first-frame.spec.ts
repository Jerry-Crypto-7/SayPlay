import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * **Za jak dlouho porotce doopravdy uvidí prostor** (P15 `T14r-actone`).
 *
 * Slib zní „prostor do tří sekund". Živá cloudová cesta ho neplní o dva řády
 * (`T14r-latency`: medián 146 s, p95 214 s), a rozhodnutí uživatele ze
 * 7. 9. 2026 zní vydat napřed uvařený svět. Tohle měří, co ta cesta stojí —
 * **v prohlížeči, od stisku po svět na plátně**, ne na serveru.
 *
 * ## Proč zrovna `world-status = live`
 *
 * `buildProxyWorldFrom()` mele hrdiny **sériově a s `await`** ještě než svět
 * vrátí (`src/worldstream/proxy.ts:630–635`), a stránka nastaví svět teprve
 * za ním (`src/app/page.tsx:226–236`). Přechod na `live` je tedy první okamžik,
 * kdy je co ukázat — včetně meshingu, který podle `T14r-meshbudget` sám o sobě
 * stojí u tří hrdinů ≈ 11,4 s. Měřit odpověď serveru by měřilo něco, co porotce
 * nevidí.
 *
 * ## Co tenhle soubor NEDĚLÁ
 *
 * **Nedokazuje tři sekundy.** Je to měřidlo s regresním stropem: vydá číslo a
 * spadne, když se to číslo výrazně zhorší. Jestli se slib přepíše podle
 * naměřeného, nebo se cesta zrychlí, je rozhodnutí uživatele v `T14r-latency`,
 * ne věc testu.
 *
 * ⚠ **`e2e/authored-label.spec.ts` na tohle není** — má strop 90 s, takže by
 * prošel i nad minutou a půl.
 */

/** Věta, kterou sklad zná přesně (`src/worldstream/authored-worlds.json`). */
const EXACT = 'A cathedral of stacked shipping containers around a light well.';

/** Věta, kterou nikdo nepředvídal — dostane nejbližší uvařený svět. */
const NEAREST = 'A greenhouse swallowed by a glacier, its panes still warm.';

/**
 * Regresní strop, ne slib.
 *
 * ⚠ **Do 9. 9. 2026 tu stála čísla, která commitnutý artefakt vyvrací** —
 * nález nezávislé revize. Docblock tvrdil „přesná shoda 3 468 ms, nejbližší
 * 16 444 ms" a stavěl na tom příběh o tom, že těžší svět stojí násobně víc;
 * `evals/worldstream/first-frame.json` přitom drží **2 545 ms** a **1 608 ms**,
 * tedy nejbližší svět **rychlejší** než přesná shoda. Odsud se citují čísla
 * z toho souboru, protože ten je výstupem tohohle testu.
 *
 * **Co z těch dvou čísel plyne a co ne.** Jsou to dva uložené běhy na jednom
 * stroji, ne p95 — a rozdíl mezi nimi je menší než rozptyl, takže se z nich
 * o ceně meshingu nesmí odvozovat nic. Že meshing na téhle cestě dominuje,
 * je měřené jinde (`T14r-meshbudget`), ne tady.
 *
 * **Strop je trojnásobek naměřeného maxima**, tedy mez, která pozná
 * pětinásobné zhoršení. Předtím tu bylo 25 000 ms odvozených od těch
 * fantomových 16 444 — desetinásobek skutečnosti, tedy strop, který
 * nepropustil jedině úplné zaseknutí. Kdo ho posune, **napíše k tomu proč
 * a nové číslo**, přesně jako u připíchnutých čísel v `offline-chain`
 * (`CLAUDE.md`, Konvence).
 */
const FIRST_FRAME_CEILING_MS = 8_000;

/**
 * Kolik se na svět **čeká**, než se vzdá.
 *
 * Schválně řádově víc než strop: čekat jen do stropu znamená, že pomalý stroj
 * spadne na timeoutu locatoru a číslo se nedozvíme. Takhle test doměří i běh,
 * který strop překročí, a spadne až na aserci — s naměřenou hodnotou v hlášce.
 */
const FIRST_FRAME_WAIT_MS = 60_000;

const REPORT = 'evals/worldstream/first-frame.json';

async function measure(page: import('@playwright/test').Page, sentence: string): Promise<number> {
  await page.goto('/');
  await expect(page.getByTestId('world-status')).toHaveAttribute('data-state', 'empty');

  await page.getByTestId('prompt-input').fill(sentence);
  const started = Date.now();
  await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('world-status')).toHaveAttribute('data-state', 'live', {
    timeout: FIRST_FRAME_WAIT_MS,
  });
  return Date.now() - started;
}

/**
 * Do kdy musí být vidět, co model z věty přečetl (P18 T5).
 *
 * Třicet sekund je **strop, ne cíl**: planner odpovídá v mediánu 16,7 s a
 * compiler za ním píše dalších 103 s (`evals/worldstream/latency-report.json`).
 * Smysl toho čísla je, že porotce nečeká celý compiler na první známku, že se
 * jeho věta vůbec pochopila.
 */
const INTENT_CEILING_MS = 30_000;

/** Jak dlouho tenhle test drží blueprint, aby mezera mezi čtením a světem byla měřitelná. */
const INTENT_HOLD_MS = 3_000;

/** Relace, pod kterou se přehrává rozdělený proud. */
const SPLIT_SESSION = 'p18-t5-split';

/** Rámec na drátě přesně v tom tvaru, v jakém ho píše server (`sessions.ts`). */
function frame(sequence: number, type: string, payload: unknown): string {
  return `data: ${JSON.stringify({
    sessionId: SPLIT_SESSION,
    sequence,
    type,
    at: '1970-01-01T00:00:00.000Z',
    payload,
  })}\n\n`;
}

/**
 * Skutečný svět skutečné relace — ne vymyšlená data.
 *
 * ⚠ **Tělo POSTu se nečte, a nesmí.** Naměřeno 16. 9. 2026: `page.request.post()`
 * nad těmihle dveřmi nikdy nedoběhne, protože proud relace je dlouhoživotný a
 * sám se nezavírá (server vrací `transfer-encoding: chunked` a drží spojení).
 * Playwright si tělo bufferuje celé, takže čekání skončí až timeoutem testu.
 * Varuje před tím i `second-act.spec.ts:99-100`. Relaci proto otevře **stránka**
 * svojí vlastní cestou a číslo relace se sebere z hlavičky odpovědi.
 *
 * Blueprint vydá snapshot, který je obyčejný JSON a zavře se. **Záměr v něm
 * není** — `ClientSnapshot` pole `intent` nemá (`reducer.ts:359-370`) — a nemusí:
 * server ho kopíruje beze změny z uvařené emise (`sessions.ts:952-957`), takže
 * sklad je jeho pravdivý zdroj, ne náhražka.
 */
async function harvest(
  page: import('@playwright/test').Page,
): Promise<{ intent: unknown; blueprint: unknown }> {
  let sessionId: string | undefined;
  page.on('response', (response) => {
    sessionId ??= response.headers()['x-worldstream-session'];
  });

  await page.goto('/');
  await page.getByTestId('prompt-input').fill(EXACT);
  await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('world-status')).toHaveAttribute('data-state', 'live', {
    timeout: FIRST_FRAME_WAIT_MS,
  });
  expect(sessionId, 'server relaci nepojmenoval').toBeDefined();

  const snapshot = await page.request.get(`/api/worldstream/sessions/${sessionId!}`);
  expect(snapshot.ok(), `snapshot nedorazil: HTTP ${String(snapshot.status())}`).toBeTruthy();
  const blueprint = ((await snapshot.json()) as { blueprint?: unknown }).blueprint;
  expect(blueprint, 'snapshot nenese blueprint').toBeDefined();

  const store = JSON.parse(readFileSync('src/worldstream/authored-worlds.json', 'utf8')) as {
    worlds: { prompt: string; planner: { intent: Record<string, unknown> } }[];
  };
  const source = store.worlds.find((world) => world.prompt === EXACT)?.planner.intent;
  expect(source, 'sklad tuhle větu nezná').toBeDefined();

  // Čtyři pole, ta a jen ta, co posílá server. Zbytek plannerovy emise (`mood`,
  // `actors`, `interactions`) se na drát nedostane a nesmí se dostat ani sem.
  return {
    intent: {
      setting: source!.setting,
      spatialThesis: source!.spatialThesis,
      heroObjects: source!.heroObjects,
      unsupported: source!.unsupported,
    },
    blueprint,
  };
}

/**
 * **Modelovo čtení věty je na obrazovce dřív než jeho svět** (P18 T5).
 *
 * Server rámec `intent.ready` posílá hned po planneru (`sessions.ts:952`) a nese
 * čtyři pole; klient si z nich do T5 bral dvě a zbytek zahazoval v `intentOf()`.
 * Vada té třídy je neviditelná: stránka, které rámec nikdy nedorazil, vypadá
 * úplně stejně jako stránka, která ho zahodila.
 *
 * ## Proč se proud rozděluje, a co je na něm pravé
 *
 * **Naměřeno 16. 9. 2026, a je to důvod existence téhle konstrukce.** Na uvařené
 * cestě dorazí `intent.ready` a `blueprint.ready` v jednom chunku (`client.ts:341`
 * je zpracuje v jedné synchronní smyčce) a hrubá stavba světa běží s prázdnou
 * meshovací smyčkou (`proxy.ts:759`), takže mezi čtením a světem neuplyne nic.
 * Sonda s `MutationObserver` ukázala **dva stavy DOM za celý běh** — `building`
 * bez záměru v 49 ms a `live` v 878 ms. React tedy snímek se samotným záměrem
 * nevydal, a to ani necommitnutý: na uvařené cestě žádný takový okamžik
 * neexistuje. Není to vada renderu a `flushSync` by ji neopravil, jen by na dvě
 * milisekundy blikl text, který porotce nepřečte.
 *
 * Vlastnost, kterou T5 slibuje, je vlastnost **živé** cesty, kde planner
 * odpovídá 103 s před compilerem. Test ji proto přehraje: rámce jsou **skutečné**
 * (sklidí je `harvest()` z opravdové relace), vymyšlená je jen mezera mezi nimi.
 * První čtení dostane `intent.ready` a proud se zavře; `followSession()` naváže
 * dotazem `?since=1` (`client.ts:295-300`) a ten se podrží o `INTENT_HOLD_MS`.
 * Žádná část klienta se přitom neobchází — jede se jeho vlastní cestou obnovení.
 *
 * ⚠ **`world-live-origin` z AC se tu neměří, a je to vědomá odchylka.** Ten
 * popisek se kreslí jedině nad světem od živého modelu (`provenance === null`,
 * `page.tsx:916`); v repu není `.env`, jen `.env.example`, takže lokální běh
 * žádný živý endpoint nemá a ta aserce by nešla splnit ani po dokonalé
 * implementaci. Měří se vlastnost, kterou AC popisuje prózou: **čtení dojde na
 * obrazovku dřív než svět** — a protože mezeru drží test, dá se na ni sáhnout
 * obyčejným locatorem místo pozorovatele snímků.
 */
test('modelovo čtení věty je na obrazovce dřív než jeho svět', async ({ page }) => {
  test.setTimeout(180_000);

  const real = await harvest(page);

  await page.route('**/api/worldstream/sessions', (route) =>
    route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        sessionId: SPLIT_SESSION,
        events: `/api/worldstream/sessions/${SPLIT_SESSION}/events`,
        snapshot: `/api/worldstream/sessions/${SPLIT_SESSION}`,
      }),
    }),
  );

  // Druhé čtení pozná podle `since`: první jde od nuly, navazující od jedničky.
  await page.route(`**/api/worldstream/sessions/${SPLIT_SESSION}/events*`, async (route) => {
    const since = new URL(route.request().url()).searchParams.get('since') ?? '0';
    if (since === '0')
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: frame(1, 'intent.ready', real.intent),
      });

    await new Promise((resolve) => setTimeout(resolve, INTENT_HOLD_MS));
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      // **Obálka `{ blueprint }` je povinná**, ne ozdoba: reducer čte
      // `fields.blueprint` (`reducer.ts:302`), takže holý blueprint v payloadu
      // nechá `state.blueprint` na `null` a čekání na svět nikdy neskončí.
      body:
        frame(2, 'blueprint.ready', { blueprint: real.blueprint }) +
        frame(3, 'session.complete', {}),
    });
  });

  await page.goto('/');
  const status = page.getByTestId('world-status');
  await expect(status).toHaveAttribute('data-state', 'empty');
  await page.getByTestId('prompt-input').fill(EXACT);

  const started = Date.now();
  await page.getByTestId('prompt-submit').click();

  // Čtení stojí na obrazovce, **a svět v tu chvíli ještě není** — to je celý
  // slib úlohy. Obojí se soudí, dokud mezera trvá.
  await expect(page.getByTestId('world-intent')).toBeVisible({ timeout: INTENT_CEILING_MS });
  const intentMs = Date.now() - started;
  await expect(status).toHaveAttribute('data-state', 'building');

  // A jsou to **modelova slova**, ne prázdný rámeček: teze i hrdinové pocházejí
  // z plannerovy emise uvařené k téhle větě (`authored-worlds.json`, `c01`).
  await expect(page.getByTestId('world-intent')).toContainText('light well');
  await expect(page.getByTestId('world-intent-heroes')).toContainText('Building:');

  await expect(status).toHaveAttribute('data-state', 'live', { timeout: FIRST_FRAME_WAIT_MS });
  const liveMs = Date.now() - started;

  expect(intentMs, `čtení dorazilo až se světem: ${String(intentMs)} proti ${String(liveMs)} ms`)
    .toBeLessThan(liveMs);
  expect(intentMs).toBeLessThan(INTENT_CEILING_MS);

  // Nad hotovým světem už čtení nestojí: svět mluví sám za sebe.
  await expect(page.getByTestId('world-intent')).toHaveCount(0);
});

test('uvařený svět dojde na plátno a měří se, jak dlouho to trvalo', async ({ page }) => {
  test.setTimeout(180_000);

  const exactMs = await measure(page, EXACT);
  const nearestMs = await measure(page, NEAREST);

  // **Soudí se DŘÍV, než se píše** — nález nezávislé revize 9. 9. 2026.
  // Opačné pořadí znamenalo, že běh, který strop prorazí, nejdřív přepíše
  // commitnutou baseline svými špatnými čísly a teprve pak spadne; příště se
  // pak regrese poměřuje proti sobě samé. Čísla nese hláška, takže se běh,
  // který spadl, nemusí číst z artefaktu.
  expect(exactMs, `přesná shoda přestala docházet na plátno: ${String(exactMs)} ms`).toBeLessThan(
    FIRST_FRAME_CEILING_MS,
  );
  expect(
    nearestMs,
    `nejbližší shoda přestala docházet na plátno: ${String(nearestMs)} ms`,
  ).toBeLessThan(FIRST_FRAME_CEILING_MS);

  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(
    REPORT,
    `${JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        note: 'submit -> world on canvas, cooked path, includes hero meshing in the browser',
        ceilingMs: FIRST_FRAME_CEILING_MS,
        exact: { sentence: EXACT, ms: exactMs },
        nearest: { sentence: NEAREST, ms: nearestMs },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

});
