import { expect, test, type APIRequestContext } from '@playwright/test';

import { startGame } from './play-start';

/**
 * `/play/[id]` (P23-C T5): hra se načte bez technického panelu, tik roste,
 * klepnutí na kartu cíle zapíše vstup do runtime, mobil nescrolluje do
 * strany, a svědek světa přehraný sondou skončí na „You won“.
 *
 * Hra vzniká skutečnými dveřmi `POST /api/play/games` (dvojník režiséra,
 * žádný model). Sonda `window.__playShell` je stejný vzor jako
 * `__worldstreamStage` – ptá se na to, co se z obrázku plátna přečíst nedá.
 */

async function publish(request: APIRequestContext, sentence: string): Promise<string> {
  const response = await request.post('/api/play/games', { data: { sentence } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  const body = (await response.json()) as { url: string };
  return body.url;
}

test.describe('/play/[id] – play shell', () => {
  let url = '';

  test.beforeAll(async ({ request }) => {
    url = await publish(request, 'Collect five glowing mushrooms then open a portal.');
  });

  test('HUD shows the goal, the tick advances, no technical panel is rendered', async ({ page }) => {
    await page.goto(url);
    await expect(page.getByTestId('play-goal')).toBeVisible();
    await expect(page.getByTestId('play-goal')).not.toHaveText('');
    await startGame(page);
    await page.waitForFunction(() => window.__playShell !== undefined && window.__playShell.tick() > 0, undefined, { timeout: 60_000 });
    const first = Number(await page.getByTestId('play-tick').getAttribute('data-tick'));
    await page.waitForTimeout(500);
    const second = Number(await page.getByTestId('play-tick').getAttribute('data-tick'));
    expect(second).toBeGreaterThan(first);

    await expect(page.getByTestId('inspect-toggle')).toHaveCount(0);
    await expect(page.getByTestId('runtime-action')).toHaveCount(0);
    await expect(page.locator('.ws-dock, .ws-controls, .ws-inspect')).toHaveCount(0);
  });

  test('tapping the first target card records an input in the runtime', async ({ page }) => {
    await page.goto(url);
    await startGame(page);
    await page.waitForFunction(() => window.__playShell !== undefined && window.__playShell.tick() > 0, undefined, { timeout: 60_000 });
    const card = page.locator('[data-testid^="play-target-"]').first();
    await expect(card).toBeVisible();
    const before = await page.evaluate(() => window.__playShell!.inputs().length);
    await card.click();
    await expect(card).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => page.evaluate(() => window.__playShell!.inputs().length)).toBe(before + 1);
    const last = await page.evaluate(() => window.__playShell!.inputs().at(-1));
    expect(last?.actionId).toBe('moveTo');
  });

  test('the collecting game is won by tapping the things themselves on the canvas (P28C T4)', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(url);
    await page.waitForFunction(() => window.__playShell !== undefined && window.__playShell.targets().length > 0, undefined, { timeout: 60_000 });
    const targets = await page.locator('[data-testid^="play-target-"]').count();
    const tapped = new Set<string>();
    let taps = 0;
    while ((await page.getByTestId('play-outcome').count()) === 0 && taps <= targets + 1) {
      // Sebrané věci na plátně zatím zůstávají (schová je P28B T8) – test si pamatuje, na co už klepl.
      const next = (await page.evaluate(() => window.__playShell!.targets())).find((target) => !tapped.has(target.id));
      if (next === undefined) break;
      tapped.add(next.id);
      const before = await page.evaluate(() => window.__playShell!.inputs().length);
      await page.mouse.click(next.x, next.y);
      taps += 1;
      // Jedno klepnutí: dojdi (moveTo) a po příchodu seber nebo použij – dva vstupy, nebo konec hry.
      await page.waitForFunction(
        (count) => document.querySelector('[data-testid="play-outcome"]') !== null || window.__playShell!.inputs().length >= count + 2,
        before,
        { timeout: 30_000 },
      );
    }
    await expect(page.getByTestId('play-outcome')).toContainText('You won');
    expect(taps).toBeLessThanOrEqual(targets + 1);
    const inputs = await page.evaluate(() => window.__playShell!.inputs());
    expect(inputs.some((input) => input.actionId !== 'moveTo')).toBe(true);
  });

  // P33 T11: mřížka stojí na tiku 0 pod „Tap to start“, dokud se hráč nedotkne.
  test('the grid waits on tick 0 under "Tap to start" and the first tap starts it (P28C T5, P33 T11)', async ({ page }) => {
    await page.goto(url);
    const prompt = page.getByTestId('play-first-prompt');
    await expect(prompt).toBeVisible({ timeout: 60_000 });
    await expect(prompt).toContainText('Tap to start');
    await expect(page.getByTestId('play-first-prompt-action')).toHaveText(/^Tap (a|an|the) /);
    await page.waitForTimeout(1_500);
    expect(await page.evaluate(() => window.__playShell!.tick())).toBe(0);
    await page.getByTestId('play-grid-stage').click({ position: { x: 5, y: 5 } });
    await expect(prompt).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__playShell!.tick())).toBeGreaterThan(0);
  });

  // P33 T12: na desktopu tenký pruh 64 px nad scénou, scéna zbytek výšky a nejvýš 16:9; akce ve sloupci vpravo.
  test('desktop 1440×900: the scene fills the window below a 64 px bar, at most 16:9', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url);
    await expect(page.getByTestId('play-goal')).toBeVisible();
    const stage = (await page.getByTestId('play-grid-stage').boundingBox())!;
    expect(stage.y).toBe(64);
    expect(stage.height).toBe(900 - 64);
    expect(stage.width).toBeLessThanOrEqual(Math.ceil((stage.height * 16) / 9));
    const hud = (await page.locator('.play-hud').boundingBox())!;
    expect(hud.height).toBe(64);
    const rail = (await page.locator('.play-rail').boundingBox())!;
    expect(rail.x + rail.width).toBeGreaterThan(1440 - 32);
    await expect(page.getByTestId('play-mute')).toBeVisible();
    await expect(page.getByTestId('play-info')).toBeVisible();
    await expect(page.getByTestId('play-more')).toHaveAttribute('href', '/play');
  });

  test('a phone viewport has no horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url);
    await expect(page.getByTestId('play-goal')).toBeVisible();
    await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('the scripted witness wins the game and the outcome overlay says so', async ({ page }) => {
    await page.goto(url);
    await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
    const outcome = await page.evaluate(() => window.__playShell!.playWitness());
    expect(outcome.runState).toBe('won');
    await expect(page.getByTestId('play-outcome')).toBeVisible();
    await expect(page.getByTestId('play-outcome')).toContainText('You won');
    // Sekundy, ne tiky (P28B F-15): grid tiká 20× za sekundu.
    await expect(page.getByTestId('play-outcome')).toContainText(`in ${(outcome.tick / 20).toFixed(1)} s`);
    await expect(page.getByTestId('play-outcome')).not.toContainText('tick');
    await expect(page.getByTestId('play-tick')).toHaveText('');
  });

  test('every pickup removes one item from the scene; none are left after the win (P28B F-16)', async ({ page }) => {
    await page.goto(url);
    await page.waitForFunction(() => window.__playShell !== undefined && window.__worldstreamStage?.ready() === true, undefined, { timeout: 60_000 });
    const shown = () => page.evaluate(() => window.__worldstreamStage!.slots().filter((slot) => slot.shown).length);
    let before = await shown();
    let pickups = 0;
    for (;;) {
      const step = await page.evaluate(() => window.__playShell!.playWitness(1));
      if (step.last === 'pickup') {
        pickups += 1;
        // Zmenšení trvá 200 ms, pak se obal skryje.
        await expect.poll(shown, { timeout: 5_000 }).toBe(before - 1);
      }
      before = await shown();
      if (step.left === 0) break;
    }
    expect(pickups).toBeGreaterThanOrEqual(5);
    await expect(page.getByTestId('play-outcome')).toContainText('You won');
    await expect.poll(shown).toBe(before);
    // Snímek pro lidské oko; WebGL pixely se mezi stroji liší, takže se nesrovnává.
    await test.info().attach('won-without-mushrooms', { body: await page.locator('canvas').first().screenshot(), contentType: 'image/png' });
  });
});
