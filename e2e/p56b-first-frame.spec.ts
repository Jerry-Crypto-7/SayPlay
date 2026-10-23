/**
 * Žádná černá obrazovka mezi kartou kroků a hrou (P56B T4).
 *
 * Audit 21. 10.: pomalé věty (09-astro 2,2 s, 12-ghost 3,1 s) ukázaly ve 2 s
 * černou plochu. `p32-first-seconds` hlídá jen úplně první snímek plátna; tahle
 * sonda jde skutečnými dveřmi „Make it!“ a od chvíle, kdy zmizí karta kroků
 * `.sp-steps`, vzorkuje každých 250 ms po 4 s plátno (dokud plátno není,
 * celou obrazovku). Žádný vzorek nesmí mít ≥ 90 % pixelů s jasem < 0,04.
 */

import { readFileSync } from 'node:fs';

import { devices, expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';

const SET = (JSON.parse(readFileSync('evals/play/p56b/sentences.json', 'utf8')) as { sentences: { id: string; text: string }[] }).sentences;
/** Dvě věty z auditu + čtyři další ze sady (noc, den, voda, jeskyně). */
const PICK = ['09-astro', '12-ghost', '02-zombie', '04-shark', '06-cat', '08-gems'];
/** Jas pod touto mezí je „černá“ (stejně jako `luma` v `scripts/play-look-shots.mjs`). */
const DARK = 0.04;
const MAX_DARK = 0.9;
const WINDOW_MS = 4_000;
const EVERY_MS = 250;

const { defaultBrowserType: _browser, ...PIXEL_7 } = devices['Pixel 7'];
const PROFILES = { desktop: { viewport: { width: 1280, height: 800 } }, phone: PIXEL_7 } as const;

/** Podíl pixelů s lumou Rec. 709 pod `DARK`. */
async function darkShare(png: Buffer): Promise<number> {
  const { data } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let dark = 0;
  for (let i = 0; i < data.length; i += 3) {
    if ((0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255 < DARK) dark += 1;
  }
  return dark / (data.length / 3);
}

const lumaOf = ([r, g, b]: readonly number[]): number => (0.2126 * r! + 0.7152 * g! + 0.0722 * b!) / 255;

/** První neprůhledné pozadí od rodiče plátna hry nahoru (jako `p32-first-seconds`). */
async function backdropUnderCanvas(page: Page): Promise<readonly number[]> {
  const canvas = page.getByTestId('arcade-stage').locator('canvas').first();
  await canvas.waitFor({ state: 'attached', timeout: 60_000 });
  return canvas.evaluate((element) => {
    for (let at = element.parentElement; at !== null; at = at.parentElement) {
      const parts = getComputedStyle(at).backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [];
      if (parts.length >= 3 && (parts[3] ?? 1) > 0) return parts.slice(0, 3);
    }
    return [255, 255, 255];
  });
}

interface Sample {
  readonly at: number;
  readonly what: 'canvas' | 'page';
  readonly dark: number;
}

/** Od zmizení karty kroků po `WINDOW_MS`: plátno, když už je, jinak celá obrazovka. */
async function samplesAfterSteps(page: Page): Promise<readonly Sample[]> {
  const steps = page.locator('.sp-steps');
  // Rychlá věta kartu kroků ukáže jen na okamžik; začíná se novou adresou hry bez karty.
  await expect(page).toHaveURL(/\/play\/[a-f0-9]+$/, { timeout: 60_000 });
  await expect(steps).toBeHidden({ timeout: 60_000 });
  const start = Date.now();
  const samples: Sample[] = [];
  while (Date.now() - start < WINDOW_MS) {
    const next = Date.now() + EVERY_MS;
    if (!(await steps.isVisible())) {
      // Snímek přes `clip` v CSS pixelech a JPEG: `locator.screenshot` čeká na stabilitu a na telefonu (DPR 2,6) trval přes 250 ms.
      const box = await page.locator('canvas').first().boundingBox({ timeout: 100 }).catch(() => null);
      const shot = await page.screenshot({ clip: box ?? undefined, scale: 'css', type: 'jpeg', quality: 60, animations: 'allow' });
      samples.push({ at: Date.now() - start, what: box === null ? 'page' : 'canvas', dark: Math.round((await darkShare(shot)) * 1000) / 1000 });
    }
    await page.waitForTimeout(Math.max(0, next - Date.now()));
  }
  return samples;
}

for (const [profile, options] of Object.entries(PROFILES)) {
  test.describe(`first frame (${profile})`, () => {
    test.use(options);
    for (const id of PICK) {
      const sentence = SET.find((entry) => entry.id === id);
      if (sentence === undefined) throw new Error(`${id} missing from evals/play/p56b/sentences.json`);
      test(`${id}: never black between the steps card and the game`, async ({ page }, info) => {
        test.setTimeout(120_000);
        // Pomalá síť jako v auditu: modely přijdou až po okně měření, scéna celé okno čeká v Suspense
        // a vidět je jen podklad pod plátnem (na rychlém GPU stroji by se jinak nic nenaměřilo).
        await page.route('**/assets/**', async (route) => {
          await new Promise((done) => setTimeout(done, WINDOW_MS + 1_000));
          await route.continue().catch(() => {});
        });
        await page.goto('/play');
        const field = page.getByTestId('play-sentence');
        await field.fill(sentence.text);
        await page.getByTestId('play-create').click();
        const samples = await samplesAfterSteps(page);
        // Do prvního snímku plátna (pomalý překlad shaderů: SwiftShader, slabý telefon) je vidět jen podklad pod ním.
        const backdrop = await backdropUnderCanvas(page);
        expect(lumaOf(backdrop), `backdrop rgb(${backdrop.join(',')}) under the canvas before its first frame`).toBeGreaterThanOrEqual(DARK);
        await info.attach('samples', { body: JSON.stringify(samples), contentType: 'application/json' });
        console.log(`${profile} ${id}: ${samples.map((sample) => `${String(sample.at)}ms ${sample.what} ${String(sample.dark)}`).join(' | ')}`);
        expect(samples.length).toBeGreaterThan(4);
        expect(
          samples.filter((sample) => sample.dark >= MAX_DARK),
          JSON.stringify(samples),
        ).toEqual([]);
      });
    }
  });
}
