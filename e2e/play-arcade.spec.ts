import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Skákačka na `/play/[id]` (P25A T6): věta „jumping arcade game with a lot of
 * obstacles“ projde skutečnými dveřmi (dvojník režiséra = návrh ze slov →
 * běžec), hra se načte v arkádovém plátně, HUD běží, mezerník zapíše skok,
 * záznam robota přehraný sondou skončí na „You won“ a mobil nescrolluje do
 * strany.
 */

const SENTENCE = 'jumping arcade game with a lot of obstacles';

async function publish(request: APIRequestContext): Promise<string> {
  const response = await request.post('/api/play/games', { data: { sentence: SENTENCE } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

test.describe('/play/[id] – arcade runner', () => {
  let url = '';

  test.beforeAll(async ({ request }) => {
    url = await publish(request);
  });

  test('the runner loads, the HUD advances and Space records a jump', async ({ page }) => {
    await page.goto(url);
    await expect(page.getByTestId('arcade-stage')).toBeVisible();
    await expect(page.getByTestId('play-goal')).not.toHaveText('');
    await page.waitForFunction(() => window.__playShell !== undefined && window.__playShell.tick() > 30, undefined, { timeout: 60_000 });
    const first = Number(await page.getByTestId('play-tick').getAttribute('data-tick'));
    await page.waitForTimeout(500);
    expect(Number(await page.getByTestId('play-tick').getAttribute('data-tick'))).toBeGreaterThan(first);

    const before = await page.evaluate(() => window.__playShell!.inputs().length);
    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate(() => window.__playShell!.inputs().length)).toBe(before + 1);
  });

  test('"Show me how" plays the verified run as a labelled demo, then the player plays (P27D T3)', async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto(url);
    await page.waitForFunction(() => window.__playShell !== undefined && window.__playShell.tick() > 10, undefined, { timeout: 60_000 });
    await page.getByTestId('play-demo-start').click();
    await expect(page.getByTestId('play-demo')).toBeVisible();
    // Ukázka běží v čase před očima, ne naráz.
    const early = await page.evaluate(() => window.__playShell!.tick());
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => window.__playShell!.tick())).toBeGreaterThan(early);
    // Stisk hráče během ukázky se do jeho záznamu nezapíše.
    await page.keyboard.press('Space');
    expect(await page.evaluate(() => window.__playShell!.inputs().length)).toBe(0);
    await expect(page.getByTestId('play-demo-outcome')).toHaveAttribute('data-verified', 'true', { timeout: 200_000 });
    await expect(page.getByTestId('play-outcome')).toHaveCount(0);
    await page.getByTestId('play-demo-yours').click();
    await expect(page.getByTestId('play-demo-outcome')).toHaveCount(0);
    await expect(page.getByTestId('play-demo-start')).toBeVisible();
    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate(() => window.__playShell!.inputs().length)).toBeGreaterThan(0);
  });

  test('a hidden tab pauses the game and the first key resumes it (P27B T3)', async ({ page }) => {
    await page.goto(url);
    await page.waitForFunction(() => window.__playShell !== undefined && window.__playShell.tick() > 30, undefined, { timeout: 60_000 });
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.getByTestId('play-paused')).toBeVisible();
    const frozen = await page.evaluate(() => window.__playShell!.tick());
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(500);
    // Návrat do popředí hru sám nerozběhne.
    expect(await page.evaluate(() => window.__playShell!.tick())).toBe(frozen);
    await page.keyboard.press('Space');
    await expect(page.getByTestId('play-paused')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__playShell!.tick())).toBeGreaterThan(frozen);
  });

  test('Space on the focused share button shares and does not jump (P27B T5)', async ({ page }) => {
    await page.addInitScript(() => {
      const shared: unknown[] = [];
      (window as unknown as { __shared: unknown[] }).__shared = shared;
      Object.defineProperty(navigator, 'share', { configurable: true, value: async (data: unknown) => void shared.push(data) });
    });
    await page.goto(url);
    await page.waitForFunction(() => window.__playShell !== undefined && window.__playShell.tick() > 30, undefined, { timeout: 60_000 });
    const before = await page.evaluate(() => window.__playShell!.inputs().length);
    await page.getByTestId('play-share').focus();
    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared.length)).toBe(1);
    expect(await page.evaluate(() => window.__playShell!.inputs().length)).toBe(before);
  });

  test('ArrowLeft moves the runner to the left of the screen', async ({ page }) => {
    await page.goto(url);
    const stage = page.getByTestId('arcade-stage');
    await expect(stage).toHaveAttribute('data-player-x', /.+/, { timeout: 60_000 });
    const start = Number(await stage.getAttribute('data-player-x'));
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => Number(await stage.getAttribute('data-player-x'))).toBeLessThan(start - 0.05);
  });

  test('the verifier bot replayed by the probe wins and the outcome says so', async ({ page }) => {
    await page.goto(url);
    await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
    const outcome = await page.evaluate(() => window.__playShell!.playWitness());
    expect(outcome.runState).toBe('won');
    await expect(page.getByTestId('play-outcome')).toContainText('You won');
    await expect(page.getByTestId('play-progress')).toHaveAttribute('data-progress', '100');
  });

  test('after the run the scene draws on demand: the end state and Replay still redraw it (P28E T2)', async ({ page }) => {
    await page.goto(url);
    await page.waitForFunction(() => window.__playShell !== undefined && window.__playShell.tick() > 30, undefined, { timeout: 60_000 });
    const stage = page.getByTestId('arcade-stage').locator('canvas');
    const running = await stage.screenshot();
    await page.evaluate(() => window.__playShell!.playWitness());
    await expect(page.getByTestId('play-outcome')).toContainText('You won');
    // Konec běhu přepne plátno na kreslení na požádání; poslední stav se přesto nakreslí.
    await expect.poll(async () => (await stage.screenshot()).equals(running)).toBe(false);
    const ended = await stage.screenshot();
    await page.getByTestId('play-replay').click();
    await expect.poll(async () => (await stage.screenshot()).equals(ended)).toBe(false);
  });

  test('a phone viewport has no horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url);
    await expect(page.getByTestId('arcade-stage')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
