import { expect, test, type Page, type Response } from '@playwright/test';

import { isWeightRequest } from '../src/model/local/capability';

/**
 * Produkt je ovladatelný hned a **model se odsud nestahuje** (P11 T22, T22q).
 *
 * ## Co se změnilo a proč tenhle soubor vypadá jinak než v T22
 *
 * V T22 se měřilo „dá se hrát, **zatímco** se model stahuje". Rozhodnutím T22q
 * z 21. 8. 2026 se model z hlavní stránky odpojil, protože ho nikdo nepoužíval:
 * stahoval se skoro gigabajt vah a hotový engine nikam nevedl. Test proto
 * přestal měřit „stahování na pozadí" a měří **jeho nepřítomnost** — což je
 * tvrzení, které jde porušit jediným nedopatřeným importem, takže se hlídat
 * musí.
 *
 * ## Proč se stroj pořád vydává za schopný, když se nic nestahuje
 *
 * To je celý ten test. Playwrightí Chromium WebGPU nedostane, takže by
 * `detectRuntime()` sám od sebe vrátil větev bez modelu a **nula stažených
 * bajtů by byla pravda z nudného důvodu** — model by se nespustil ani tehdy,
 * kdyby ho stránka poctivě zapojila. `navigator.gpu` se proto podstrčí a stroj
 * se tváří jako takový, který model utáhne. Když se za těch podmínek pořád nic
 * nestáhne, je to vlastnost produktu, ne prostředí.
 *
 * ## Jak se pozná balík modelu
 *
 * Podle obsahu **a velikosti**. Text `CreateMLCEngine` je v produkčním buildu ve
 * dvou chuncích — v knihovně WebLLM (6 028 192 B) a v našem vlastním
 * `app/page-*.js` (41 888 B), protože ho `engine.ts` volá. Vzorek nad obsahem
 * samotný by tedy hlásil poplach nad kódem, který se nahrát má. Odstup mezi
 * 42 kB a 6 MB je stopadesátinásobný.
 *
 * Těla odpovědí se čtou **až po odměření**, ne v obsluze routy. Kdyby se
 * provoz zdržoval kvůli měření, měřilo by se to zdržení — přesně ta past, která
 * v T22 vrátila 20 526 ms proti stropu 3 000 ms.
 *
 * ## Kde přesně začínají ty tři sekundy
 *
 * `page.goto()` bez parametru čeká na `load`, tedy na všechny podřízené
 * požadavky. Navigace se proto čeká jen do `commit` (přišly hlavičky) a zbytek
 * času si vyžádá `fill()`, který sám počká, až je pole ovladatelné.
 *
 * Číslo je čas, kdy jde **ovládat vstup**. Že za tím stojí živý React, a ne
 * mrtvé HTML ze serveru, dokazuje až postavený svět na konci: `fill()` projde
 * i nad serverovým HTML, kdežto svět z odeslané věty bez hydratace nevznikne.
 */

/** Doslovná věta ze zmrazeného korpusu (`C01`) — svět z ní vznikne. */
const SENTENCE = 'a puzzle room where I have to find three keys to open the exit door';

/** Strop z AC T22. */
const FIRST_CLICK_BUDGET_MS = 3_000;

/** Od jaké délky zdrojového textu je skript balíkem modelu. Viz hlavička. */
const MODEL_BUNDLE_MIN_SIZE = 1_000_000;

/**
 * Vydává stroj za takový, který model utáhne.
 *
 * `requestAdapter()` vrací objekt, protože `probeEnvironment()` se ptá právě
 * jeho — `null` by znamenalo „WebGPU tu není", tedy přesně ten stav, který
 * tenhle test vyrábět nechce.
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

test('produkt je ovladatelný do tří sekund a model se nestahuje vůbec', async ({ page }) => {
  test.setTimeout(120_000);

  await pretendCapableMachine(page);

  const weightRequests: string[] = [];
  const scripts: Response[] = [];
  page.on('request', (request) => {
    if (isWeightRequest(request.url())) weightRequests.push(request.url());
  });
  page.on('response', (response) => {
    if (response.url().endsWith('.js')) scripts.push(response);
  });

  const started = Date.now();
  await page.goto('/', { waitUntil: 'commit' });

  const input = page.getByTestId('prompt-input');
  await input.fill(SENTENCE);
  await expect(input).toHaveValue(SENTENCE);
  await expect(page.getByTestId('prompt-submit')).toBeEnabled();
  const firstClickMs = Date.now() - started;

  console.log(`[first-click] ${firstClickMs} ms (strop ${FIRST_CLICK_BUDGET_MS} ms)`);
  expect(firstClickMs, 'produkt se dal ovládat později než po třech sekundách').toBeLessThan(
    FIRST_CLICK_BUDGET_MS,
  );

  // Klik projde jen na prvek, který není ničím překrytý — celostránková bariéra
  // je tím vyloučená měřením, ne prohlášením. A postavený svět je zároveň důkaz,
  // že stránka doopravdy žije.
  await page.getByTestId('prompt-submit').click();
  await page.waitForFunction(() => window.__worldsmith !== undefined, undefined, { timeout: 60_000 });
  await page.waitForFunction(() => window.__worldsmith!.entities().length > 0, undefined, {
    timeout: 60_000,
  });

  // 1. Ukazatel stahování na stránce vůbec není. To je to rozhodnutí samo.
  await expect(page.getByTestId('model-progress')).toHaveCount(0);

  // 2. Váhy si nikdo nevyžádal. Sama o sobě je to slabá aserce — v tomhle
  //    prohlížeči se WebGPU zařízení nedostane, takže by platila i pro stránku,
  //    která se model stáhnout POKOUŠÍ. Silná je až s bodem 3.
  expect(weightRequests, 'stránka si vyžádala váhy modelu').toEqual([]);

  // 3. Balík WebLLM se nenačetl. Tohle je ta aserce, která rozhodnutí hlídá:
  //    kdyby se `ModelProgress` vrátilo do stromu stránky, chunk se stáhne dřív,
  //    než se zjistí, že zařízení není.
  const heavy: string[] = [];
  for (const response of scripts) {
    const body = await response.body().catch(() => Buffer.alloc(0));
    if (body.length > MODEL_BUNDLE_MIN_SIZE && body.includes('CreateMLCEngine'))
      heavy.push(`${response.url()} (${body.length} B)`);
  }
  expect(heavy, 'stránka načetla balík WebLLM, ačkoli ho nemá k čemu použít').toEqual([]);
});
