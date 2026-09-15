/**
 * Stroj bez akcelerace: rozhodnutí padne správně a **nestáhne se jediný bajt vah**.
 *
 * Běží jen v projektu `no-acceleration` (viz `playwright.config.ts`) — tam, kde
 * Chromium startuje s `--disable-gpu --disable-features=WebGPU`.
 *
 * ## Proč se prostředí čte v prohlížeči a rozhoduje v Node
 *
 * `detectRuntime()` je čistá funkce nad tím, co prohlížeč o sobě řekne. Fakta
 * (`navigator.gpu`, `navigator.deviceMemory`) proto pochází ze **skutečného
 * Chromia bez GPU** a rozhodnutí dělá **produkční funkce**, ne její opis v testu.
 * Zabalit modul do stránky by znamenalo sáhnout na `src/app/page.tsx`, což je
 * mimo rozsah téhle úlohy — a stálo by to novou cestu v bundlu jen kvůli testu.
 *
 * Druhá polovina testu je nezávislá a měří přímo: odposlouchává **všechny**
 * odchozí požadavky stránky a tvrdí, že mezi nimi není ani jeden na doménu vah.
 * Tuhle aserci by neprošla ani bezvadná detekce, kdyby modul někde sahal na síť.
 */

import { expect, test } from '@playwright/test';

import { detectRuntime, isWeightRequest, type RuntimeEnvironment } from '../src/model/local/capability';

test('bez akcelerace nevyjde large', async ({ page }) => {
  await page.goto('/classic');

  const environment = await page.evaluate(
    async (): Promise<{ gpuObjectPresent: boolean; hasWebGpu: boolean; deviceMemoryGb: number | undefined }> => {
      const nav = navigator as Navigator & {
        gpu?: { requestAdapter(): Promise<unknown | null> };
        deviceMemory?: number;
      };
      let adapter: unknown | null = null;
      if (nav.gpu) {
        try {
          adapter = await nav.gpu.requestAdapter();
        } catch {
          adapter = null;
        }
      }
      return {
        gpuObjectPresent: nav.gpu !== undefined && nav.gpu !== null,
        hasWebGpu: adapter !== null && adapter !== undefined,
        deviceMemoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : undefined,
      };
    },
  );

  const env: RuntimeEnvironment = {
    hasWebGpu: environment.hasWebGpu,
    deviceMemoryGb: environment.deviceMemoryGb,
    cloudConfigured: false,
  };
  const runtime = detectRuntime(env);

  expect(
    runtime,
    `prostředí hlásí ${JSON.stringify(environment)}, a přesto z toho vyšlo large`,
  ).not.toBe('large');
  expect(['small', 'cloud', 'none']).toContain(runtime);

  // Naměřený důvod, proč detekce nesmí stát na přítomnosti objektu: Chromium
  // spuštěné s `--disable-gpu --disable-features=WebGPU` `navigator.gpu`
  // pořád vystavuje. Kdyby tahle aserce zčervenala, znamená to, že prohlížeč
  // změnil chování a levná synchronní cesta začala být použitelná — ne že je
  // něco rozbité. Přečti si tehdy `readEnvironment()`, ne tenhle test.
  expect(
    environment.gpuObjectPresent && !environment.hasWebGpu,
    'objekt navigator.gpu tu není, takže se rozdíl mezi přítomností a použitelností neměří',
  ).toBe(true);
});

test('bez akcelerace neodejde jediný požadavek na doménu vah', async ({ page }) => {
  const weightRequests: string[] = [];
  page.on('request', (request) => {
    if (isWeightRequest(request.url())) weightRequests.push(request.url());
  });

  await page.goto('/classic');
  // Detekce má být hotová dřív, než by cokoli začalo stahovat. Pět sekund je
  // schválně víc, než kolik trvá první snímek — kdyby se váhy tahaly opožděně,
  // tenhle test je má stihnout zahlédnout.
  await page.waitForTimeout(5_000);

  expect(weightRequests, `odešly požadavky na váhy: ${weightRequests.join(', ')}`).toEqual([]);
});
