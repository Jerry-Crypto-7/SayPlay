import { devices, expect, type Page, test } from '@playwright/test';

import { arenaGenre } from '../src/play/genre/arena';
import { compileGenre, readGenreSpec } from '../src/play/genre/index';
import { platformerGenre } from '../src/play/genre/platformer';
import { questGenre } from '../src/play/genre/quest';
import { runnerGenre } from '../src/play/genre/runner';
import { voyageGenre } from '../src/play/genre/voyage';
import type { GameSpecV1 } from '../src/play/spec';

/**
 * Čitelný hrdina (P36C T6): v každém z 5 žánrů, na telefonu i na desktopu, je
 * hrdina aspoň 8 % výšky obrazu a nese inkoustový obrys. Výška je promítnutý
 * kvádr hrdiny skutečnou kamerou scény (`__playFrame().hero`, NDC −1 … 1), obrys
 * počet obalů pod hrdinou (`heroInk`). Obrys je v scéně, ne v postprocessingu,
 * takže drží i na úrovni `low`, která skládač nemá.
 */

const MIN_HERO_SHARE = 0.08;

const GAMES = [
  { genre: 'runner', module: runnerGenre, sentence: 'a fox runs through a forest dodging logs and rocks' },
  { genre: 'platformer', module: platformerGenre, sentence: 'a frog hops across platforms to reach the flag' },
  { genre: 'arena', module: arenaGenre, sentence: 'a cat collects fish in a garden while dogs chase it' },
  { genre: 'quest', module: questGenre, sentence: 'a knight lights the torches in a dark castle' },
  { genre: 'voyage', module: voyageGenre, sentence: 'a pirate ship races between islands to the treasure' },
] as const;

function gameSpecOf(game: (typeof GAMES)[number]): GameSpecV1 {
  const read = readGenreSpec({ hero: 'fox', ...(game.module.draftFill(game.sentence, null) as object) });
  if (!read.ok) throw new Error(read.issues.join('; '));
  return compileGenre(read.value);
}

interface Hero {
  readonly share: number;
  readonly ink: number;
  readonly behind: boolean;
}

/** Počet sítí se 1,5 s nezměnil = modely dotažené; pak změř hrdinu. */
async function heroOnScreen(page: Page): Promise<Hero> {
  await page.waitForFunction(() => window.__playRender !== undefined && window.__playFrame?.().hero != null, undefined, { timeout: 90_000 });
  let last = -1;
  let since = Date.now();
  const deadline = Date.now() + 20_000;
  while (Date.now() - since < 1500 && Date.now() < deadline) {
    const meshes = await page.evaluate(() => window.__playRender!().meshes);
    if (meshes !== last) [last, since] = [meshes, Date.now()];
    await page.waitForTimeout(250);
  }
  return page.evaluate(() => {
    const frame = window.__playFrame!();
    const hero = frame.hero!;
    return { share: (hero.maxY - hero.minY) / 2, ink: frame.heroInk, behind: hero.behind };
  });
}

/** Bez `defaultBrowserType`: ten v `describe` vynutí nový worker a Playwright ho odmítne. */
const asUse = ({ defaultBrowserType: _, ...rest }: (typeof devices)[string]) => rest;

for (const [device, use] of [
  ['desktop', asUse(devices['Desktop Chrome']!)],
  ['phone', asUse(devices['Pixel 7']!)],
] as const) {
  test.describe(`hero readable on ${device}`, () => {
    test.use(use);
    test.setTimeout(150_000);

    for (const game of GAMES) {
      test(`${game.genre}: hero is at least 8 % of the frame and outlined`, async ({ page, request }) => {
        const response = await request.post('/api/play/games', { data: { spec: gameSpecOf(game) } });
        expect(response.status(), await response.text()).toBeLessThan(300);
        const { url } = (await response.json()) as { url: string };
        await page.goto(url);
        const hero = await heroOnScreen(page);
        console.log(`${device} ${game.genre}: hero ${(hero.share * 100).toFixed(1)} % of the height, ${hero.ink} ink hulls`);
        expect(hero.behind).toBe(false);
        expect(hero.share).toBeGreaterThanOrEqual(MIN_HERO_SHARE);
        expect(hero.ink).toBeGreaterThan(0);
      });
    }
  });
}
