import { expect, test, type APIRequestContext } from '@playwright/test';

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

  test('a one-command prompt says what to tap and goes away on the first tap (P28C T5)', async ({ page }) => {
    await page.goto(url);
    const prompt = page.getByTestId('play-first-prompt');
    await expect(prompt).toBeVisible({ timeout: 60_000 });
    await expect(prompt).toHaveText(/^Tap (a|an|the) /);
    await page.getByTestId('play-grid-stage').click({ position: { x: 5, y: 5 } });
    await expect(prompt).toHaveCount(0);
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
    await expect(page.getByTestId('play-outcome')).toContainText(String(outcome.tick));
  });
});
