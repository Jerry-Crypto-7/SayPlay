import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { HUD_COUNTER_LABELS } from './hud-labels';
import { startGame } from './play-start';

/**
 * Doplňky arkády na `/play/[id]` (P26D T7): hra s doplňkem musí doplněk i
 * ukázat. Jádro umí `+shoot`/`+collect`/`+chaser` hrát (jednotkové testy), ale
 * jen sestavená aplikace pozná, jestli scéna nakreslí nepřátele, mince a
 * pronásledovatele a HUD počítadla. Věty ze slovního návrhu doplňky zatím
 * nerozpoznají (T8), proto se posílá hotový spec: fixture + `addons`.
 */

const GAMES = [
  {
    fixture: 'platform.json',
    title: 'jump and shoot the zombies',
    addons: ['shoot'],
    control: 'platform',
    drawn: ['enemy'],
    counters: ['ammo'],
  },
  {
    fixture: 'runner.json',
    title: 'a runner collecting coins chased by a bear',
    addons: ['collect', 'chaser'],
    control: 'runner',
    drawn: ['collectible', 'chaser'],
    counters: ['collected'],
  },
] as const;

async function publish(request: APIRequestContext, game: (typeof GAMES)[number]): Promise<string> {
  const base = JSON.parse(readFileSync(join(process.cwd(), 'src/play/arcade/__fixtures__', game.fixture), 'utf8')) as Record<string, unknown>;
  const spec = { ...base, title: game.title, addons: [...game.addons] };
  const response = await request.post('/api/play/games', { data: { spec } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

for (const game of GAMES) {
  test.describe(`/play/[id] – ${game.control} + ${game.addons.join(' + ')}`, () => {
    let url = '';

    test.beforeAll(async ({ request }) => {
      url = await publish(request, game);
    });

    test('the stage draws the addon bodies and the HUD shows their counters', async ({ page }) => {
      await page.goto(url);
      const stage = page.getByTestId('arcade-stage');
      await expect(stage).toBeVisible();
      // Scéna kreslí podle základního ovládání, ne podle obalu `addon_control`.
      await expect(stage).toHaveAttribute('data-control', game.control);
      await expect(stage).toHaveAttribute('data-drawn', /.+/, { timeout: 60_000 });
      const drawn = ((await stage.getAttribute('data-drawn')) ?? '').split(' ');
      for (const role of game.drawn) expect(drawn, `drawn: ${drawn.join(' ')}`).toContain(role);

      for (const label of game.counters) {
        expect(HUD_COUNTER_LABELS).toContain(label);
        const counter = page.getByTestId(`hud-counter-${label}`);
        await expect(counter).toBeVisible();
        await expect(counter).toHaveAttribute('data-count', /^\d+$/);
      }
      const shown = await page.locator('[data-testid^="hud-counter-"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')!.slice('hud-counter-'.length)));
      for (const label of shown) expect(HUD_COUNTER_LABELS).toContain(label);
    });

    if (game.addons.includes('shoot' as never)) {
      test('the Fire button and the F key record the fire bit', async ({ page }) => {
        await page.goto(url);
        await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
        await startGame(page);
        await page.waitForFunction(() => window.__playShell!.tick() > 10, undefined, { timeout: 60_000 });
        // `BUTTON.FIRE` = 64; počítají se záznamy s nastaveným bitem, ať klávesa nestojí na kliknutí.
        const fired = () => page.evaluate(() => (window.__playShell!.inputs() as unknown as { buttons: number }[]).filter((input) => (input.buttons & 64) !== 0).length);
        await page.getByTestId('arcade-fire').click();
        await expect.poll(fired).toBeGreaterThan(0);
        const afterClick = await fired();
        await page.keyboard.down('f');
        await page.waitForTimeout(100);
        await page.keyboard.up('f');
        await expect.poll(fired).toBeGreaterThan(afterClick);
      });
    }

    test('the verifier bot replayed by the probe wins', async ({ page }) => {
      await page.goto(url);
      await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
      const outcome = await page.evaluate(() => window.__playShell!.playWitness());
      expect(outcome.runState).toBe('won');
      await expect(page.getByTestId('play-outcome')).toContainText('You won');
    });
  });
}
