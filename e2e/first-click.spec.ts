import { expect, test, type Page, type Route } from '@playwright/test';

import { isWeightRequest } from '../src/model/local/capability';

/**
 * Stahování modelu nesmí stát mezi návštěvníkem a produktem (P11 T22).
 *
 * ## Co se měří
 *
 * Čas od navigace do okamžiku, kdy jde **doopravdy** psát a odeslat — a měří se
 * ve chvíli, kdy se model stahuje. To je celá otázka: hlavní cestou je
 * deterministický rozpoznávač tvarů, který model nepotřebuje, takže čekat na
 * skoro gigabajt vah by bylo čekání na doplněk.
 *
 * ## Jak se ta chvíle vyrobí, když e2e prohlížeč nemá WebGPU
 *
 * Dvěma nezávislými kroky, oba **v prohlížeči**, žádný v produkčním kódu:
 *
 *  1. `navigator.gpu` a `deviceMemory` se podstrčí `addInitScript`em, takže
 *     produkční `detectRuntime()` vyhodnotí větev `large` — rozhodnutí dělá
 *     pořád produkční funkce, jen dostane jiná fakta. (Opak dělá
 *     `webgpu-detect.spec.ts`, který stroj bez akcelerace vyrábí spouštěcími
 *     přepínači.)
 *  2. Balík WebLLM se na cestě **zdrží**. Bez toho by fáze `loading` trvala
 *     zlomek sekundy a „při probíhajícím stahování" by bylo tvrzení o okamžiku,
 *     který nikdo nestihne zahlédnout.
 *
 * Váhy se navíc zablokují úplně: kdyby některý požadavek prošel, test by táhl
 * stovky megabajtů kvůli aserci o třech sekundách.
 *
 * ## Kde přesně začínají ty tři sekundy — naměřená past
 *
 * `page.goto()` bez parametru čeká na událost `load`, tedy na **všechny**
 * podřízené požadavky. Zdržený balík modelu je jedním z nich, takže první měření
 * vrátilo 20 526 ms proti zdržení 20 000 ms: měřilo se vlastní zdržení, ne
 * dostupnost produktu. Navigace se proto čeká jen do `commit` (přišly hlavičky)
 * a zbytek času si vyžádá `fill()`, který sám počká, až je pole ovladatelné.
 *
 * ## Proč se klikne, a ne jen kouká
 *
 * Kliknutí je zároveň důkaz, že přes pole nic neleží: Playwright klik na
 * překrytý prvek odmítne. Celostránková bariéra by tenhle test shodila, aniž by
 * se na ni kdokoli musel ptát jménem.
 */

/** Doslovná věta, kterou rozpoznávač zná — svět z ní vznikne bez modelu. */
const SENTENCE = 'a puzzle room where I have to find three keys to open the exit door';

/** O kolik se zdrží balík modelu. Musí být delší než strop, jinak se nic neměří. */
const MODULE_DELAY_MS = 20_000;

/**
 * Od jaké délky zdrojového textu se skript považuje za balík modelu.
 *
 * **Naměřeno nad produkčním buildem 21. 8. 2026:** text `CreateMLCEngine` je
 * přesně ve dvou chuncích — v balíku WebLLM (6 028 192 B) a v našem vlastním
 * `app/page-*.js` (41 888 B), protože `engine.ts` tu funkci volá. Vzorek nad
 * obsahem samotný tedy zdrží i kód, na kterém stránka stojí: React nezhydratuje,
 * panel modelu zůstane ve fázi `probing` a test pak měří mrtvé HTML ze serveru
 * místo ovladatelného produktu.
 *
 * Odstup mezi 42 kB a 6 MB je stopadesátinásobný, takže mez uprostřed přežije
 * i podstatnou změnu bundlu. A kdyby ji přece jen přestala trefovat, test to
 * **pozná**, ne přehlédne: aserce na fázi `loading` projde jedině po hydrataci
 * (příliš široké zdržení ji zabije) a `stall.delayed` nesmí zůstat prázdné
 * (příliš úzké zdržení ji zabije taky).
 */
const MODEL_BUNDLE_MIN_SIZE = 1_000_000;

/** Strop z AC T22. */
const FIRST_CLICK_BUDGET_MS = 3_000;

/**
 * Vydává stroj za takový, který model utáhne.
 *
 * `requestAdapter()` vrací objekt, protože `probeEnvironment()` se ptá právě
 * jeho — a `null` by znamenalo „WebGPU tu není", tedy přesně ten stav, který
 * tenhle test vyrábět nechce. `requestDevice` schválně chybí: WebLLM se o něj
 * pokusí, nedostane ho a načítání skončí jako `unavailable`. To testu nevadí,
 * protože měřená chvíle nastane dřív.
 */
async function pretendCapableMachine(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: { requestAdapter: () => Promise.resolve({ info: { vendor: 'test', architecture: 'test' } }) },
    });
    Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 8 });
  });
}

interface Stall {
  /** Adresy, které si vyžádaly váhy. Musí zůstat prázdné. */
  readonly weightRequests: string[];
  /** Které skripty se zdržely. Prázdné pole znamená, že se nic nezdrželo. */
  readonly delayed: string[];
  /** Ukončí zdržování a odpojí routy. Volá se na konci testu. */
  readonly release: () => Promise<void>;
}

/**
 * Zdrží balík WebLLM a zablokuje váhy.
 *
 * Balík se pozná **podle obsahu a velikosti**, ne podle jména souboru: Next
 * chunky pojmenovává hashem, takže vzorek nad jménem by přestal platit při první
 * změně bundlu — a přestal by tiše, protože test by dál procházel, jen by neměřil,
 * co má. Proč k obsahu musí přibýt i velikost, stojí u `MODEL_BUNDLE_MIN_SIZE`.
 *
 * Zdržení se dá přerušit. Bez toho běží obsluha routy dál i po konci testu a
 * Playwright ohlásí `route.fetch: Test ended` jako chybu testu, který prošel.
 */
async function stallTheModel(page: Page): Promise<Stall> {
  const weightRequests: string[] = [];
  const delayed: string[] = [];
  let released = false;

  const waitOrRelease = async (): Promise<void> => {
    for (let waited = 0; waited < MODULE_DELAY_MS && !released; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  await page.route('**/*', async (route: Route) => {
    const url = route.request().url();

    if (isWeightRequest(url)) {
      weightRequests.push(url);
      await route.abort('blockedbyclient');
      return;
    }
    if (!url.endsWith('.js')) {
      await route.continue();
      return;
    }

    try {
      const response = await route.fetch();
      const body = await response.text();
      if (body.length > MODEL_BUNDLE_MIN_SIZE && body.includes('CreateMLCEngine')) {
        delayed.push(`${url} (${body.length} B)`);
        await waitOrRelease();
      }
      await route.fulfill({ response, body });
    } catch {
      // Test už skončil a spojení je zavřené. Není to nález o produktu.
    }
  });

  return {
    weightRequests,
    delayed,
    release: async () => {
      released = true;
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    },
  };
}

test('psát a odeslat jde dřív, než model dorazí', async ({ page }) => {
  test.setTimeout(120_000);

  await pretendCapableMachine(page);
  const stall = await stallTheModel(page);

  try {
    const started = Date.now();
    // `commit` = přišly hlavičky navigace. Cokoli delšího by do měření započítalo
    // zdržení, které si tenhle test sám vyrobil — viz hlavička.
    await page.goto('/', { waitUntil: 'commit' });

    // Tohle je „první možné kliknutí": pole drží napsaný text a tlačítko jde
    // stisknout. Čekání na plátno by měřilo WebGL přes SwiftShader, ne dostupnost
    // produktu. Že za tím stojí **živý React**, a ne mrtvé HTML ze serveru,
    // dokazuje až aserce na fázi `loading` níž — ta se bez hydratace nestane.
    const input = page.getByTestId('prompt-input');
    await input.fill(SENTENCE);
    await expect(input).toHaveValue(SENTENCE);
    await expect(page.getByTestId('prompt-submit')).toBeEnabled();
    const firstClickMs = Date.now() - started;

    console.log(`[first-click] ${firstClickMs} ms (strop ${FIRST_CLICK_BUDGET_MS} ms)`);

    // Model se v tu chvíli pořád stahuje. Bez téhle aserce by test klidně prošel
    // v prohlížeči, kde se nikdy nic nestahovalo — a neměřil by nic.
    await expect(page.getByTestId('model-progress')).toHaveAttribute('data-phase', 'loading');
    // Čeká se, protože zápis do `delayed` nastane až po **dotažení** šestimegového
    // chunku — fáze `loading` se překlopí dřív, než je co zdržovat. Naměřený čas
    // je už uložený výš, takže tohle čekání do měření nevstupuje.
    await expect
      .poll(() => stall.delayed.length, {
        message: 'balík modelu se vůbec nevyžádal, takže se nic nestahovalo',
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    console.log(`[first-click] zdrženo: ${stall.delayed.join(', ')}`);

    expect(firstClickMs, 'produkt se dal ovládat později než po třech sekundách').toBeLessThan(
      FIRST_CLICK_BUDGET_MS,
    );

    // Klik projde jen na prvek, který není ničím překrytý. Celostránková bariéra
    // je tím vyloučená měřením, ne prohlášením.
    await page.getByTestId('prompt-submit').click();

    expect(stall.weightRequests, 'test si stáhl váhy, ačkoli je měl zablokované').toEqual([]);
  } finally {
    await stall.release();
  }
});

test('panel modelu nechytá kurzor a nepřekrývá ovládání', async ({ page }) => {
  test.setTimeout(120_000);

  await pretendCapableMachine(page);
  const stall = await stallTheModel(page);

  try {
    await page.goto('/', { waitUntil: 'commit' });

    const panel = page.getByTestId('model-progress');
    await expect(panel).toHaveAttribute('data-phase', 'loading');

    // Druhá polovina „žádné bariéry", a jiná než ta výš: panel smí být vidět, ale
    // nesmí být na cestě. `pointer-events: none` je to jediné, co to zaručuje i
    // tehdy, když se s něčím překryje.
    await expect(panel).toHaveCSS('pointer-events', 'none');

    const box = await panel.boundingBox();
    const viewport = page.viewportSize();
    expect(box, 'panel modelu se nevykreslil').not.toBeNull();
    expect(viewport, 'test běží bez viewportu').not.toBeNull();
    // Roh, ne obrazovka. Čtvrtina plochy je velkorysý strop — jde o to vyloučit
    // překryv, ne předepsat rozměr.
    expect(box!.width * box!.height).toBeLessThan(viewport!.width * viewport!.height * 0.25);
  } finally {
    await stall.release();
  }
});

test('žádost o trvalé úložiště odejde jednou a její výsledek se zapíše', async ({ page }) => {
  test.setTimeout(120_000);

  // AC T22 žádá obojí: aby se `navigator.storage.persist()` zavolalo jednou a
  // aby výsledek byl vidět. Jednotkový test drží první půlku nad podstrčeným
  // rozhraním; tady se ptáme skutečného prohlížeče, jestli se ta cesta doopravdy
  // spustí, když se model načítá.
  const lines: string[] = [];
  page.on('console', (message) => {
    if (message.text().startsWith('[storage]')) lines.push(message.text());
  });

  await pretendCapableMachine(page);
  const stall = await stallTheModel(page);

  try {
    await page.goto('/', { waitUntil: 'commit' });
    await expect(page.getByTestId('model-progress')).toHaveAttribute('data-phase', 'loading');
    await expect.poll(() => lines.length, { timeout: 30_000 }).toBe(1);
    expect(lines[0]).toMatch(/persist\(\)/);
  } finally {
    await stall.release();
  }
});
