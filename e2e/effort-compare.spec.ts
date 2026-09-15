import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { classifyOutcome, hasOutcome, recordOutcome, type Observation } from '../evals/worldstream/effort-outcome';

/**
 * P16 T2 – tatáž věta do každé varianty, fotka světa, který od modelu dorazil.
 *
 * Běží proti serverům z `scripts/effort-servers.mjs --start`, přes
 * `npm run measure:effort` (`playwright.effort.ts`). Výsledek každého případu
 * jde do `results.json` hned, a případ, který tam už je, se přeskočí – běh
 * přerušený limitem předplatného se tak jen pustí znovu.
 *
 * `WORLDSMITH_EFFORT_ONLY=luna:t1,sol` omezí běh na dvojice varianta:věta;
 * samotná varianta znamená všech osm vět.
 */
const DIR = join(process.cwd(), 'evals', 'worldstream', 'effort');
const RESULTS = join(DIR, 'results.json');

interface Variant { readonly id: string; readonly model: string; readonly effort?: string; readonly port: number }
interface Sentence { readonly id: string; readonly prompt: string }

const variants = (JSON.parse(readFileSync(join(DIR, 'variants.json'), 'utf8')) as { variants: Variant[] }).variants;
const sentences = (JSON.parse(readFileSync(join(DIR, 'sentences.json'), 'utf8')) as { sentences: Sentence[] }).sentences;

/** Do kdy musí dějství II začít psát – první dějství plus otevření druhé relace. */
const START_WINDOW_MS = 90_000;
/** Strop na výsledek od odeslání; server sám volá model s timeoutem 600 s. */
const RESULT_WINDOW_MS = 660_000;
/** Svět se po výměně ještě domeshuje a kamera doletí. */
const SETTLE_MS = 5_000;

function selected(variant: string, sentence: string): boolean {
  const only = process.env.WORLDSMITH_EFFORT_ONLY?.trim();
  if (!only) return true;
  return only.split(',').map((pair) => pair.trim().split(':')).some(([v, s]) => v === variant && (s === undefined || s === sentence));
}

/**
 * Hydratace smaže text napsaný do ~3 s po načtení. Hodnota proto musí vydržet
 * dvě kontroly po sobě, jinak se píše znovu.
 */
async function fillStable(page: Page, input: Locator, prompt: string): Promise<void> {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    if ((await input.inputValue()) !== prompt) await input.fill(prompt);
    await page.waitForTimeout(1_000);
    if ((await input.inputValue()) !== prompt) continue;
    await page.waitForTimeout(1_000);
    if ((await input.inputValue()) === prompt) return;
  }
  throw new Error('the prompt input kept losing the sentence');
}

/** Sleduje značky stránky, dokud nerozhodnou; `ms` je u výměny čas do živého světa. */
async function watch(page: Page): Promise<{ observation: Observation; ms: number }> {
  const writing = page.getByTestId('second-act-writing');
  const live = page.getByTestId('world-live-origin');
  const started = Date.now();
  const observation = { sawWriting: false, writingGone: false, sawLive: false };
  while (Date.now() - started < RESULT_WINDOW_MS) {
    if ((await live.count()) > 0) { observation.sawLive = true; break; }
    if ((await writing.count()) > 0) observation.sawWriting = true;
    else if (observation.sawWriting) {
      // Výměna a zhasnutí hlášky jdou v jednom renderu; jedna kontrola navíc
      // zajistí, že se výměna nepočítá jako tiché selhání kvůli pořadí dotazů.
      await page.waitForTimeout(1_000);
      observation.sawLive = (await live.count()) > 0;
      observation.writingGone = !observation.sawLive;
      break;
    } else if (Date.now() - started > START_WINDOW_MS) break;
    await page.waitForTimeout(500);
  }
  return { observation, ms: Date.now() - started };
}

/**
 * Plátno je přes celou stránku a vstup, ovládání i Inspect leží na něm – fotka
 * by hodnotila rozhraní, ne svět. Kamera se zarámuje na scénu a všechno kromě
 * vrstvy s plátnem se skryje; stránka se po fotce zavírá, takže se nic nevrací.
 */
async function frameWorld(page: Page): Promise<void> {
  const frame = page.getByTestId('camera-reset');
  if ((await frame.count()) > 0) {
    await frame.click();
    await page.waitForTimeout(2_000);
  }
  await page.addStyleTag({ content: 'main[data-testid="worldstream"] > :not(:has(canvas)) { visibility: hidden !important; }' });
}

for (const variant of variants) {
  const cases = sentences.filter((sentence) => selected(variant.id, sentence.id));
  if (cases.length === 0) continue;

  test(`${variant.id} builds ${cases.length} worlds @measure`, async ({ browser }) => {
    test.setTimeout(cases.length * (RESULT_WINDOW_MS + 120_000));
    mkdirSync(join(DIR, variant.id), { recursive: true });

    for (const sentence of cases) {
      if (hasOutcome(RESULTS, variant.id, sentence.id)) continue;
      const page = await browser.newPage();
      try {
        await page.goto(`http://127.0.0.1:${variant.port}/`);
        await page.waitForLoadState('networkidle');
        const input = page.getByTestId('prompt-input');
        await fillStable(page, input, sentence.prompt);
        const submitted = new Date().toISOString();
        await page.getByTestId('prompt-submit').click();

        // Odeslání se musí projevit. Ztracená věta není výsledek modelu – případ
        // spadne a nezapíše se, místo aby se připsal variantě jako `no-start`.
        await expect(
          page.getByTestId('world-authored')
            .or(page.getByTestId('world-live-origin'))
            .or(page.getByTestId('second-act-writing'))
            .or(page.getByTestId('prompt-submit').filter({ hasText: 'Building' }))
            .first(),
        ).toBeVisible({ timeout: 30_000 });

        const { observation, ms } = await watch(page);
        const outcome = classifyOutcome(observation);
        if (outcome === 'swap') await page.waitForTimeout(SETTLE_MS);
        await frameWorld(page);
        const photo = `${variant.id}/${sentence.id}.jpg`;
        await page.locator('canvas').first().screenshot({ path: join(DIR, photo), type: 'jpeg', quality: 70 });

        recordOutcome(RESULTS, {
          variant: variant.id, model: variant.model, effort: variant.effort ?? null,
          id: sentence.id, outcome, ms, photo, submitted,
        });
      } finally {
        await page.close();
      }
    }
  });
}
