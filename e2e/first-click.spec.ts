import { expect, test, type Page, type Response } from '@playwright/test';

import { isWeightRequest } from '../src/model/local/capability';

import { openInspect } from './inspect';

/**
 * Produkt je ovladatelný hned a capability gate předchází stahování modelu
 * (P11 T22, P12 V1 T9).
 *
 * ## Co se změnilo a proč tenhle soubor vypadá jinak než v T22
 *
 * Rozhodnutím T22q z 21. 8. 2026 se model dočasně odpojil, protože hotový engine
 * nikam nevedl. T9 ho vrací spolu se skutečným volajícím, ale zachovává levnou
 * hranici: nejdřív se ověří použitelný WebGPU adaptér, teprve potom se smí
 * stáhnout WebLLM a váhy.
 *
 * ## Proč se tady WebGPU nepodstrkuje
 *
 * Playwrightí Chromium běží přes SwiftShader kvůli WebGL scéně, ale použitelný
 * WebGPU adaptér nemá. Právě to je reálná záporná větev capability gate:
 * `ModelProgress` musí dojít do `unavailable`, svět musí vzniknout a jediný
 * bajt vah nesmí odejít. Kladnou větev nad systémovým Chrome a skutečným GPU
 * měří samostatně `e2e/model-wired.spec.ts`.
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

test('produkt je ovladatelný do tří sekund a stroj bez WebGPU nestáhne váhy', async ({ page }) => {
  test.setTimeout(120_000);

  const weightRequests: string[] = [];
  const scripts: Response[] = [];
  page.on('request', (request) => {
    if (isWeightRequest(request.url())) weightRequests.push(request.url());
  });
  page.on('response', (response) => {
    if (response.url().endsWith('.js')) scripts.push(response);
  });

  const started = Date.now();
  await page.goto('/classic', { waitUntil: 'commit' });

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

  // 1. Stavový uzel je skutečně vyrenderovaný a levný probe pravdivě uzavřel
  //    větev bez modelu. Není to záměrně odpojený komponent.
  //
  //    Od P13 vlny 0 T1 bydlí panel v Inspect zásuvce a ta je zavřená. **Motor
  //    modelu tím ale odpojený není** — probe běží od načtení stránky a
  //    `visible` řídí jenom vykreslení. Aserce nad `data-phase` po otevření je
  //    proto pořád tatáž otázka: doběhl probe, a doběhl pravdivě?
  await openInspect(page);
  await expect(page.getByTestId('model-progress')).toHaveAttribute('data-phase', 'unavailable', {
    timeout: 20_000,
  });

  // 2. Váhy si nikdo nevyžádal. Spolu s bodem 1 to dokazuje pořadí probe →
  //    případný download; pouhá absence síťového provozu by neřekla, zda je
  //    komponent vůbec zapojený.
  expect(weightRequests, 'stránka si vyžádala váhy modelu').toEqual([]);

  // 3. Balík WebLLM se nenačetl. Capability modul a naše malá obálka se načíst
  //    smějí; šestimegabajtový runtime až po kladném probe.
  const heavy: string[] = [];
  for (const response of scripts) {
    const body = await response.body().catch(() => Buffer.alloc(0));
    if (body.length > MODEL_BUNDLE_MIN_SIZE && body.includes('CreateMLCEngine'))
      heavy.push(`${response.url()} (${body.length} B)`);
  }
  expect(heavy, 'stránka načetla balík WebLLM bez použitelného WebGPU').toEqual([]);
});
