import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { devices, expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * P73B T5: hráč na startu vidí, jak jsme větu přečetli („How I read it“) a že
 * verzi ověřila brána („Checked“); po prohře karta výsledku nabídne „Why this
 * game is fair“ a z ní „Watch the robot win“ pustí záznam robota.
 *
 * Snímky pěti vět z P73A (desktop + telefon) do `evals/play/p73/cteni/` jen na
 * požádání: `P73B_SHOTS=1` – jeden fotící proces na server.
 */

const CAT = 'A cat delivering pizzas across rooftops while avoiding seagulls';

const FIVE = [
  ['p1-cat', CAT],
  ['p2-library', 'A haunted library where books fly at you and you must find the exit'],
  ['p3-turtle', 'An underwater race between a turtle and a shark'],
  ['p4-pancakes', 'Balance a tower of pancakes on a windy day'],
  ['p5-volcano', 'Escape a volcano before the lava reaches you'],
] as const;

interface IdleProbe {
  readonly idleRun: () => { readonly runState: string; readonly tick: number };
}

async function publish(request: APIRequestContext, sentence: string): Promise<string> {
  const response = await request.post('/api/play/games', { data: { sentence } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

async function tick(page: Page): Promise<number> {
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
  return page.evaluate(() => window.__playShell!.tick());
}

test('the start card reads the sentence and says it was checked; after a loss the robot shows it is fair', async ({ page, request }) => {
  test.setTimeout(180_000);
  await page.goto(await publish(request, CAT));

  const line = page.getByTestId('play-start-read-line');
  await expect(page.getByTestId('play-start-read')).toContainText('How I read it', { timeout: 60_000 });
  await expect(line).toContainText(/You: .*cat/i);
  await expect(line).toContainText(/Against: .*seagull/i);

  // „Checked“ otevře list a hru nepustí – hodiny stojí dál na nule.
  const checked = page.getByTestId('play-start-checked');
  await expect(checked).toBeVisible();
  await checked.click();
  await expect(page.getByTestId('play-fair-list')).toBeVisible();
  expect(await tick(page)).toBe(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('play-fair-list')).toBeHidden();

  const lost = await page.evaluate(() => (window.__playShell as unknown as IdleProbe).idleRun());
  expect(lost.runState).toBe('lost');
  const result = page.getByTestId('play-postrun');
  await expect(result).toBeVisible();
  await result.getByTestId('play-fair').click();
  await expect(page.getByTestId('play-fair-list')).toBeVisible();

  await page.getByTestId('play-fair-watch').click();
  await expect(page.getByTestId('play-demo')).toBeVisible();
  await expect(page.getByTestId('play-fair-list')).toBeHidden();
});

test.describe('photos of the five P73A sentences', () => {
  test.skip(process.env.P73B_SHOTS !== '1', 'photos only on request: P73B_SHOTS=1');
  const out = join(process.cwd(), 'evals', 'play', 'p73', 'cteni');

  test('desktop and phone start cards', async ({ browser, request }) => {
    test.setTimeout(600_000);
    mkdirSync(out, { recursive: true });
    const profiles = [
      ['desktop', { viewport: { width: 1440, height: 900 } }],
      ['phone', { ...devices['Pixel 7'] }],
    ] as const;
    for (const [name, sentence] of FIVE) {
      const url = await publish(request, sentence);
      for (const [profile, options] of profiles) {
        const context = await browser.newContext(options);
        const page = await context.newPage();
        await page.goto(url);
        await expect(page.getByTestId('play-start-read')).toBeVisible({ timeout: 60_000 });
        // Scéna se dokreslí až po kartě; snímek bez modelů by ukázal prázdný svět.
        await page.waitForTimeout(4_000);
        await page.screenshot({ path: join(out, `${name}-${profile}.png`) });
        await context.close();
      }
    }
  });
});
