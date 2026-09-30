import { expect, test, type APIRequestContext } from '@playwright/test';

import { startGame } from './play-start';

/**
 * Plošinovka a poletování na `/play/[id]` (P25C T6): věta projde skutečnými
 * dveřmi (dvojník režiséra = návrh ze slov → `platform` / `flap`), hra se
 * načte v arkádovém plátně s boční kamerou, HUD běží, vstup se zapíše,
 * záznam robota přehraný sondou skončí na „You did it!“ (P34 T6: slovník
 * kitu, dřív „You won“, prohra „So close.“ místo „You lost“) a mobil nescrolluje do
 * strany.
 */

const GAMES = [
  { control: 'platform', sentence: 'a platformer where you jump over spikes and collect coins' },
  { control: 'flap', sentence: 'like flappy bird but underwater' },
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

    test('the side scene loads, the HUD advances and input is recorded', async ({ page }) => {
      await page.goto(url);
      const stage = page.getByTestId('arcade-stage');
      await expect(stage).toBeVisible();
      await expect(stage).toHaveAttribute('data-control', game.control);
      await expect(page.getByTestId('play-goal')).not.toHaveText('');
      await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
      if (game.control === 'flap') {
        // Ptáček čeká na první ťuk – jinak by spadl dřív, než ho hráč uvidí.
        await expect(stage).toHaveAttribute('data-player-x', /.+/, { timeout: 60_000 });
        await page.waitForTimeout(800);
        expect(await page.evaluate(() => window.__playShell!.tick())).toBe(0);
        await page.keyboard.press('Space');
        await expect.poll(() => page.evaluate(() => window.__playShell!.tick())).toBeGreaterThan(10);
        expect(await page.evaluate(() => window.__playShell!.inputs()[0])).toMatchObject({ tick: 0 });
        // Bez dalšího mávání spadne na zem: hra opravdu běží a končí.
        await expect(page.getByTestId('play-outcome')).toContainText('So close.', { timeout: 15_000 });
        return;
      }
      await startGame(page);
      await page.waitForFunction(() => window.__playShell!.tick() > 30, undefined, { timeout: 60_000 });
      const first = Number(await page.getByTestId('play-tick').getAttribute('data-tick'));
      await page.waitForTimeout(500);
      expect(Number(await page.getByTestId('play-tick').getAttribute('data-tick'))).toBeGreaterThan(first);

      const before = await page.evaluate(() => window.__playShell!.inputs().length);
      await page.keyboard.press('Space');
      await expect.poll(() => page.evaluate(() => window.__playShell!.inputs().length)).toBeGreaterThan(before);
    });

    if (game.control === 'platform') {
      test('holding ArrowRight runs forward and every held tick is recorded', async ({ page }) => {
        await page.goto(url);
        const stage = page.getByTestId('arcade-stage');
        await expect(stage).toHaveAttribute('data-player-x', /.+/, { timeout: 60_000 });
        const start = await page.evaluate(() => window.__playShell!.inputs().length);
        await page.keyboard.down('ArrowRight');
        await page.waitForTimeout(600);
        await page.keyboard.up('ArrowRight');
        const held = await page.evaluate((from) => window.__playShell!.inputs().length - from, start);
        // 0,6 s držení ≈ 36 tiků; rezerva na pomalý prohlížeč.
        expect(held).toBeGreaterThan(10);
        await expect(page.getByTestId('play-tick')).not.toHaveText('0 m');
      });
    }

    test('the verifier bot replayed by the probe wins and the outcome says so', async ({ page }) => {
      await page.goto(url);
      await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
      const outcome = await page.evaluate(() => window.__playShell!.playWitness());
      expect(outcome.runState).toBe('won');
      await expect(page.getByTestId('play-outcome')).toContainText('You did it!');
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
