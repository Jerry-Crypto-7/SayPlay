import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type APIRequestContext, expect, test } from '@playwright/test';

import { compileGenre, readGenreSpec } from '../src/play/genre/index';
import { runnerGenre } from '../src/play/genre/runner';
import type { GameSpecV1 } from '../src/play/spec';
import { openPause } from './play-start';

/**
 * Zakřivená trať běžce (P46D T3): dvě věty měřidla P46D hraje robot, po 8 s běhu
 * (trať už zatáčí a stoupá) se uloží záběr. Hrdina musí stát na ohnutém terénu
 * (`__playGround`), zůstat v záběru a konzole bez chyb.
 */

const SENTENCES = (JSON.parse(readFileSync(join(process.cwd(), 'evals/play/p46d/sentences.json'), 'utf8')) as { sentences: { id: string; text: string }[] }).sentences;

/** Věty bez pronásledovatele: tučňák na ledu a liška ve městě. */
const PICKED = ['r3', 'r4'] as const;

function runnerSpec(text: string): GameSpecV1 {
  const read = readGenreSpec(runnerGenre.draftFill(text, null));
  if (!read.ok) throw new Error(read.issues.join('; '));
  return compileGenre(read.value);
}

async function publishSpec(request: APIRequestContext, spec: unknown): Promise<string> {
  const response = await request.post('/api/play/games', { data: { spec } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

test.describe('runner track bends in the scene (P46D T3)', () => {
  for (const id of PICKED) {
    test(`${id}: the hero runs on the bent valley, screenshot saved`, async ({ page, request }) => {
      test.setTimeout(150_000);
      const errors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(`${message.text()} ${message.location().url}`);
      });
      page.on('pageerror', (error) => errors.push(error.message));

      const sentence = SENTENCES.find((entry) => entry.id === id)!;
      await page.goto(await publishSpec(request, runnerSpec(sentence.text)));
      await page.waitForFunction(() => window.__playShell !== undefined && window.__playGround !== undefined, undefined, { timeout: 60_000 });
      await openPause(page);
      await page.getByTestId('play-demo-start').click();
      await page.waitForTimeout(8_000);

      const hero: number[] = [];
      const playerX: number[] = [];
      for (let sample = 0; sample < 20; sample += 1) {
        const report = await page.evaluate(() => window.__playGround!());
        if (report.hero !== null) hero.push(report.hero.gap);
        playerX.push(Number(await page.getByTestId('arcade-stage').getAttribute('data-player-x')));
        await page.waitForTimeout(100);
      }
      await page.getByTestId('arcade-stage').screenshot({ path: join(process.cwd(), '.claude', `p46d-runner-path-${id}.png`) });

      expect(hero.length, 'hrdina v záběru').toBeGreaterThan(10);
      expect(Math.min(...hero.map(Math.abs)), `nejmenší mezera hrdiny nad ohnutým terénem (px): ${hero.map((gap) => gap.toFixed(1)).join(' ')}`).toBeLessThanOrEqual(5);
      for (const x of playerX) expect(Math.abs(x), 'hrdina vodorovně v záběru').toBeLessThan(0.8);
      expect(errors, 'chyby konzole').toEqual([]);
    });
  }
});
