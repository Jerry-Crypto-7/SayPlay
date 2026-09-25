import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Závod a aréna na `/play/[id]` (P25F T6): věta projde skutečnými dveřmi
 * (dvojník režiséra = návrh ze slov → `steer` / `move_free`), hra se načte
 * v arkádovém plátně, hodiny běží, držená šipka se zapíše do každého tiku,
 * záznam robota přehraný sondou skončí na „You won“ a mobil nescrolluje do
 * strany.
 */

const GAMES = [
  { control: 'steer', sentence: 'car racing game' },
  { control: 'move_free', sentence: 'like agar.io but you are a fish eating smaller fish' },
] as const;

async function publish(request: APIRequestContext, sentence: string): Promise<string> {
  const response = await request.post('/api/play/games', { data: { sentence } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

for (const game of GAMES) {
  test.describe(`/play/[id] – arcade ${game.control}`, () => {
    let url = '';

    test.beforeAll(async ({ request }) => {
      url = await publish(request, game.sentence);
    });

    test('the scene loads, the clock runs and a held arrow is recorded every tick', async ({ page }) => {
      await page.goto(url);
      const stage = page.getByTestId('arcade-stage');
      await expect(stage).toBeVisible();
      await expect(stage).toHaveAttribute('data-control', game.control);
      await expect(page.getByTestId('play-goal')).not.toHaveText('');
      await expect(stage).toHaveAttribute('data-player-x', /.+/, { timeout: 60_000 });
      await page.waitForFunction(() => window.__playShell !== undefined && window.__playShell.tick() > 30, undefined, { timeout: 60_000 });

      const start = await page.evaluate(() => window.__playShell!.inputs().length);
      await page.keyboard.down('ArrowRight');
      await page.waitForTimeout(600);
      await page.keyboard.up('ArrowRight');
      const held = await page.evaluate((from) => window.__playShell!.inputs().length - from, start);
      // 0,6 s držení ≈ 36 tiků; rezerva na pomalý prohlížeč.
      expect(held).toBeGreaterThan(10);
    });

    test('a drag released outside the canvas lets go of the controls (P28B T4)', async ({ page }) => {
      await page.goto(url);
      const stage = page.getByTestId('arcade-stage');
      await expect(stage).toHaveAttribute('data-player-x', /.+/, { timeout: 60_000 });
      await page.waitForFunction(() => window.__playShell !== undefined && window.__playShell.tick() > 30, undefined, { timeout: 60_000 });
      const box = (await stage.boundingBox())!;
      const hud = (await page.locator('.play-hud').boundingBox())!;
      const count = (): Promise<number> => page.evaluate(() => window.__playShell!.inputs().length);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.75);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height * 0.75 - 60, { steps: 6 });
      // Tažená osa se zapisuje do každého tiku.
      const held = await count();
      await expect.poll(count).toBeGreaterThan(held + 5);
      // Puštění nad HUD – ten leží nad plátnem, ale není jeho součástí.
      await page.mouse.move(hud.x + hud.width / 2, hud.y + hud.height / 2, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(200);
      const released = await count();
      await page.waitForTimeout(500);
      expect(await count()).toBe(released);
    });

    test('the verifier bot replayed by the probe wins and the outcome says so', async ({ page }) => {
      await page.goto(url);
      await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
      const outcome = await page.evaluate(() => window.__playShell!.playWitness());
      expect(outcome.runState).toBe('won');
      await expect(page.getByTestId('play-outcome')).toContainText('You won');
      await expect(page.getByTestId('play-progress')).toHaveAttribute('data-progress', '100');
    });

    test('a phone viewport has no horizontal scroll', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(url);
      await expect(page.getByTestId('arcade-stage')).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
}
