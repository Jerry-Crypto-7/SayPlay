import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Prostředí z věty ve hrách, které ho dřív nekreslily (P27A T3): závod a
 * aréna. `data-setting` říká, kterou sadu scéna kreslí; screenshot scény jde
 * do `test-results/` jako podklad pro lidskou kontrolu – atribut sám vizuální
 * důkaz není. Posílá se hotový spec (fixture + prostředí), ať test nečeká na draft.
 */

// P27A T4: načasování, rytmus a souboj; soupeř souboje s modelem z popisku (liška je v katalogu).
const GAMES: readonly { fixture: string; title: string; setting: string; control: string; look: string; rival?: string }[] = [
  { fixture: 'steer.json', title: 'shopping cart race in a supermarket', setting: 'supermarket', control: 'steer', look: 'supermarket' },
  { fixture: 'arena.json', title: 'grow in the city', setting: 'a city at night', control: 'move_free', look: 'city' },
  { fixture: 'timing.json', title: 'stack pancakes on a glacier', setting: 'a glacier', control: 'timing', look: 'snow' },
  { fixture: 'rhythm.json', title: 'drum in the jungle', setting: 'a jungle clearing', control: 'rhythm', look: 'jungle' },
  { fixture: 'duel.json', title: 'boxing a fox in the outback', setting: 'australian outback', control: 'duel', look: 'desert', rival: 'fox' },
];

async function publish(request: APIRequestContext, game: (typeof GAMES)[number]): Promise<string> {
  const base = JSON.parse(readFileSync(join(process.cwd(), 'src/play/arcade/__fixtures__', game.fixture), 'utf8')) as { theme: Record<string, unknown>; roles: { id: string; label: string }[] } & Record<string, unknown>;
  const roles = game.rival === undefined ? base.roles : base.roles.map((role) => (role.id === 'rival' ? { ...role, label: game.rival! } : role));
  const spec = { ...base, title: game.title, roles, theme: { ...base.theme, setting: game.setting } };
  const response = await request.post('/api/play/games', { data: { spec } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

for (const game of GAMES) {
  test(`/play/[id] – ${game.control} draws the ${game.look} setting`, async ({ page, request }) => {
    const url = await publish(request, game);
    await page.goto(url);
    const stage = page.getByTestId('arcade-stage');
    await expect(stage).toBeVisible();
    await expect(stage).toHaveAttribute('data-control', game.control);
    await expect(stage).toHaveAttribute('data-setting', game.look);
    await page.locator('canvas').first().waitFor();
    await page.waitForTimeout(2500);
    await stage.screenshot({ path: test.info().outputPath(`${game.control}-${game.look}.png`) });
  });
}
