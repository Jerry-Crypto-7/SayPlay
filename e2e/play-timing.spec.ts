import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Načasování, rytmus a souboj na `/play/[id]` (P25H T5): věta projde
 * skutečnými dveřmi (dvojník režiséra = návrh ze slov → `timing` / `rhythm`
 * / `duel`), hra se načte ve vlastní scéně a čeká na první ťuk, který ji
 * jen spustí (do záznamu nejde), záznam robota přehraný sondou skončí na
 * „You won“ a mobil nescrolluje do strany.
 */

const GAMES = [
  { control: 'timing', sentence: 'stack blocks as high as you can', unit: 'rounds' },
  { control: 'rhythm', sentence: 'tap to the beat with glowing tiles', unit: 'notes' },
  { control: 'duel', sentence: 'boxing match against a kangaroo', unit: 'hits' },
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

    test('the scene waits for a starting tap, then runs and records the next input', async ({ page }) => {
      await page.goto(url);
      const stage = page.getByTestId('arcade-stage');
      await expect(stage).toBeVisible();
      await expect(stage).toHaveAttribute('data-control', game.control);
      await expect(page.getByTestId('play-goal')).not.toHaveText('');
      await expect(page.getByTestId('play-tick')).toContainText(game.unit);
      await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
      await page.waitForTimeout(800);
      expect(await page.evaluate(() => window.__playShell!.tick())).toBe(0);
      await page.keyboard.press('Space');
      await expect.poll(() => page.evaluate(() => window.__playShell!.tick())).toBeGreaterThan(10);
      // Startovní ťuk jen pustil hodiny – u načasování by v tiku 0 byl minutím.
      expect(await page.evaluate(() => window.__playShell!.inputs().length)).toBe(0);
      await page.keyboard.press('Space');
      await expect.poll(() => page.evaluate(() => window.__playShell!.inputs().length)).toBe(1);
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
