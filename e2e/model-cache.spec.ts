import { join } from 'node:path';

import { chromium, expect, test } from '@playwright/test';

import { isWeightRequest } from '../src/model/local/capability';

/**
 * Podruhé se váhy nestahují (P11 T22).
 *
 * ## Proč je tenhle test `@measure`, a co to znamená
 *
 * Aby se dalo tvrdit „podruhé se nestahuje", musí poprvé **doopravdy stáhnout** —
 * 979 MB vah do Cache API. To se nedá zkrátit ani podvrhnout: mezipaměť naplněná
 * vymyšlenými bajty by WebLLM odmítl a druhé načtení by je stahovalo znovu, tedy
 * přesně opak toho, co se má dokázat.
 *
 * `npm run test:e2e` proto tenhle soubor vynechává (`--grep-invert @measure`) a
 * pouští ho `npm run measure:cache`. Za studena je to desítky minut, za tepla
 * pár minut.
 *
 * ## Proč vlastní prohlížeč, a ne `page` z fixture
 *
 * Dvě věci, obě naměřené v T5 (`e2e/local-model-grammar.spec.ts`):
 *
 *  1. Chromium, které vozí Playwright, **WebGPU zařízení nedostane**
 *     (`dxil.dll Windows Error: 87`), takže by se model nikdy nenačetl a nulový
 *     provoz by byl pravdivý z nudného důvodu. Systémové Chrome zařízení vrátí.
 *  2. Cache API bydlí **v profilu prohlížeče**, a Playwright dělá na každý běh
 *     profil nový. Bez `launchPersistentContext` by mezi prvním a druhým
 *     načtením nezbylo nic — test by neměřil mezipaměť, ale její nepřítomnost.
 *
 * Profil je týž adresář jako u měření gramatiky, takže se váhy stahují na tomhle
 * stroji jednou pro obě měření.
 *
 * ## Proti vakuóznímu zelenému běhu
 *
 * „Nula požadavků na váhy" je pravda i v prohlížeči, kde se model vůbec
 * nespustil. Test proto **napřed** čeká, až panel modelu dojde do `ready` — a
 * teprve nad tím tvrdí, že se přitom nesáhlo na síť. Bez toho pořadí by šlo
 * projít tím, že se nestane nic.
 */

/** Týž profil jako `local-model-grammar.spec.ts`. `tmp-*` je v `.gitignore`. */
const PROFILE_DIR = join(process.cwd(), 'tmp-webllm-profile');

/** Za studena se táhne skoro gigabajt a nahrává se do GPU. */
const COLD_LOAD_TIMEOUT_MS = 45 * 60 * 1000;

/** Za tepla se jen čte z disku, ale nahrání do GPU pořád trvá. */
const WARM_LOAD_TIMEOUT_MS = 10 * 60 * 1000;

test('@measure druhé načtení nesáhne na doménu vah ani jednou', async () => {
  test.setTimeout(COLD_LOAD_TIMEOUT_MS + WARM_LOAD_TIMEOUT_MS);

  const baseURL = test.info().project.use.baseURL;
  expect(baseURL, 'projekt nemá baseURL — bez ní není kam se připojit').toBeTruthy();

  // Prázdné `args` přepíší zděděné `--use-angle=swiftshader` z konfigurace.
  // Softwarový renderer WebGPU adaptér nevrátí a model by se nespustil — celé
  // odůvodnění je v hlavičce `local-model-grammar.spec.ts`.
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: true,
    args: [],
  });

  try {
    const warmUp = context.pages()[0] ?? (await context.newPage());
    await warmUp.goto(baseURL as string);
    await expect(warmUp.getByTestId('model-progress'), 'model se nenačetl ani napoprvé').toHaveAttribute(
      'data-phase',
      'ready',
      { timeout: COLD_LOAD_TIMEOUT_MS },
    );
    await warmUp.close();

    // Druhé načtení, nová karta, týž profil — tedy táž Cache API.
    const second = await context.newPage();
    const weightRequests: string[] = [];
    second.on('request', (request) => {
      if (isWeightRequest(request.url())) weightRequests.push(request.url());
    });

    await second.goto(baseURL as string);
    await expect(second.getByTestId('model-progress'), 'model se nenačetl napodruhé').toHaveAttribute(
      'data-phase',
      'ready',
      { timeout: WARM_LOAD_TIMEOUT_MS },
    );

    expect(
      weightRequests,
      `podruhé odešly požadavky na váhy: ${weightRequests.slice(0, 5).join(', ')}`,
    ).toEqual([]);
  } finally {
    await context.close();
  }
});
