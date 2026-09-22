import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Poctivá hláška (P25E T2): věta, kterou knihovna ovládání neumí, dostane nad
 * hrou proužek s důvodem – a hra pod ním pořád běží. Věta, kterou umíme,
 * proužek nemá. Hry vznikají skutečnými dveřmi `POST /api/play/games`.
 */

async function publish(request: APIRequestContext, sentence: string): Promise<{ url: string; honesty?: unknown }> {
  const response = await request.post('/api/play/games', { data: { sentence } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return (await response.json()) as { url: string; honesty?: unknown };
}

test.describe('/play/[id] – honesty strip', () => {
  test('a match-3 sentence shows the strip and the game still runs', async ({ page, request }) => {
    const game = await publish(request, 'a match 3 game with fruits');
    expect(game.honesty).toBeDefined();
    await page.goto(game.url);
    const strip = page.getByTestId('play-honest');
    await expect(strip).toBeVisible();
    await expect(strip).toContainText("This one isn't playable yet – here's the closest game we can build");
    await expect(page.getByTestId('play-honest-reason')).toContainText('a collect-and-escape game');
    await page.waitForFunction(() => window.__playShell !== undefined && window.__playShell.tick() > 0, undefined, { timeout: 60_000 });

    await strip.getByRole('button', { name: 'Got it' }).click();
    await expect(strip).toHaveCount(0);
  });

  test('a runner sentence has no strip', async ({ page, request }) => {
    const game = await publish(request, 'endless runner in a neon city');
    expect(game.honesty).toBeUndefined();
    await page.goto(game.url);
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('play-honest')).toHaveCount(0);
  });
});

/**
 * Co hra hráči dřív neukázala (P25E T3, T4): úsek, po kterém stráž vidí.
 * Sondy `__playSight` hlásí, co scéna doopravdy nakreslila.
 */
test.describe('/play/[id] – what the scene shows', () => {
  test('a stealth game draws the guard beats, one of them watched', async ({ page, request }) => {
    const game = await publish(request, 'sneak past guards in a museum and steal a diamond');
    await page.goto(game.url);
    await page.waitForFunction(() => window.__playSight !== undefined && window.__playSight().beats > 0, undefined, { timeout: 60_000 });
    const sight = await page.evaluate(() => window.__playSight!());
    expect(sight.watched).toBeGreaterThan(0);
  });

  test('a game without stealth draws no beats', async ({ page, request }) => {
    const game = await publish(request, 'Collect five glowing mushrooms then open a portal.');
    await page.goto(game.url);
    await page.waitForFunction(() => window.__playShell !== undefined && window.__playShell.tick() > 0, undefined, { timeout: 60_000 });
    const beats = await page.evaluate(() => window.__playSight?.().beats ?? 0);
    expect(beats).toBe(0);
  });
});
