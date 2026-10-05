import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { startGame } from './play-start';

/**
 * Nový model z knihovny P37D ve skutečné hře (T3): věta s žábou projde dveřmi
 * `/api/play/games` (návrh ze slov), hra na `/play/[id]` stáhne GLB `gen3d-frog`
 * z `public/assets/worldstream/gen3d-p37d/` – dřív žábu kreslila liška z třídy
 * `animal`. Scéna id modelu nevystavuje, proto rozhoduje požadavek na soubor;
 * snímek jde do `test-results/p37d/` k prohlédnutí.
 */

const SENTENCE = 'a frog hops across lily pads to reach the far bank';
const FROG_GLB = /\/assets\/worldstream\/gen3d-p37d\/gen3d-frog-lod\d\.glb$/;

test('a sentence naming a frog loads the new frog model into the game', async ({ page, request }) => {
  const response = await request.post('/api/play/games', { data: { sentence: SENTENCE } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  const { url } = (await response.json()) as { url: string };

  const frog = page.waitForResponse((answer) => FROG_GLB.test(new URL(answer.url()).pathname), { timeout: 60_000 });
  await page.goto(url);
  await expect(page.getByTestId('arcade-stage')).toBeVisible();
  expect((await frog).status()).toBe(200);

  await startGame(page);
  await page.waitForTimeout(1_500);
  const out = join(process.cwd(), 'test-results', 'p37d');
  mkdirSync(out, { recursive: true });
  await page.getByTestId('arcade-stage').screenshot({ path: join(out, 'frog.png') });
});
