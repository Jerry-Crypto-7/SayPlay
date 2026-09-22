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

  test('a phone viewport has no horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url);
    await expect(page.getByTestId('arcade-stage')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
