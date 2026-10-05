import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { closeAbout, openAbout, startGame } from './play-start';

/**
 * Po dohrání (P23-C T6): Play again začne nový běh (od P36B T3; dřív
 * přehrál týž běh do téhož konce), R po prohře taky a hned, čip
 * „Make it harder“ vede na **jinou** hru s vlastním odkazem a rodokmen to
 * ukáže na obou stranách; „Dare a friend to beat it“ i „Copy link“ zkopírují
 * odkaz. Od P33 T4 jsou čipy v listu za tlačítkem výsledku. Od P34 T6 mluví
 * výsledek slovníkem kitu: „You did it!“ (dřív „You won“), „Remix it“ (dřív
 * „Change it“), „Dare a friend…“ (dřív „Challenge a friend“) a toast
 * „Link copied. Go dare someone.“ (dřív „Link copied“).
 *
 * Čip, který by vedl na tutéž hru, vypadá jako remix – test proto drží jiné
 * id a odkaz dítěte zpět na rodiče.
 */

async function publish(request: APIRequestContext, sentence: string): Promise<string> {
  const response = await request.post('/api/play/games', { data: { sentence } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

async function win(page: import('@playwright/test').Page): Promise<number> {
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
  const outcome = await page.evaluate(() => window.__playShell!.playWitness());
  expect(outcome.runState).toBe('won');
  await expect(page.getByTestId('play-postrun')).toBeVisible();
  return outcome.tick;
}

test.describe('/play/[id] – after the run', () => {
  let url = '';

  test.beforeAll(async ({ request }) => {
    url = await publish(request, 'Collect five glowing mushrooms then open a portal.');
  });

  test('Play again starts a fresh run that waits for the first touch', async ({ page }) => {
    // Věta dělá arkádu (dřív mřížku, jejíž Replay přehrál týž běh do téhož konce – P36B T3 to zrušila).
    await page.goto(url);
    await win(page);
    await page.getByTestId('play-replay').click();
    await expect(page.getByTestId('play-postrun')).toHaveCount(0);
    await expect(page.getByTestId('play-first-prompt')).toBeVisible();
    expect(await page.evaluate(() => [window.__playShell!.tick(), window.__playShell!.inputs().length])).toEqual([0, 0]);
  });

  test('Make it harder lands on a different game whose lineage points back', async ({ page }) => {
    // Rodokmen je od P33 T7 poslední řádek listu „About this game“; ten se od P34 T5 otevírá z karty pauzy.
    await page.goto(url);
    await openAbout(page);
    await expect(page.getByTestId('play-lineage')).toContainText('Original');
    await closeAbout(page);
    await win(page);
    await page.getByRole('button', { name: 'Remix it' }).click();
    await expect(page.getByRole('dialog', { name: 'Change one thing' })).toBeVisible();

    const parentId = url.split('/').at(-1)!;
    await page.getByTestId('play-chip-harder').click();
    await expect(page).toHaveURL(/\/play\/[a-f0-9]+$/, { timeout: 30_000 });
    await expect(page).not.toHaveURL(new RegExp(`/play/${parentId}$`));

    await openAbout(page);
    const lineage = page.getByTestId('play-lineage');
    await expect(lineage).toContainText('Remixed from');
    await expect(lineage.locator(`a[href="/play/${parentId}"]`)).toBeVisible();

    await page.goto(url);
    await openAbout(page);
    await expect(page.getByTestId('play-lineage')).toContainText('1 remix');
  });

  test('Dare a friend and Copy link copy the link', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(url);
    await win(page);
    await page.getByTestId('play-share').click();
    await expect(page.getByText('Link copied. Go dare someone.')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(url);
    // „Copy link“ (P34 T6) jde rovnou do schránky, i kde by Dare otevřel nabídku sdílení.
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await page.getByTestId('play-copy-link').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(url);
  });
});

test.describe('/play/[id] – instant retry (P36B T3)', () => {
  test('a grid game: Play again is a fresh run, not the last record replayed', async ({ page, request }) => {
    const spec = JSON.parse(readFileSync(join(process.cwd(), 'src/play/__fixtures__/collect_exit.json'), 'utf8')) as unknown;
    const response = await request.post('/api/play/games', { data: { spec } });
    expect(response.status(), await response.text()).toBeLessThan(300);
    await page.goto(((await response.json()) as { url: string }).url);
    await expect(page.getByTestId('play-grid-stage')).toBeVisible({ timeout: 60_000 });
    const tick = await win(page);
    expect(await page.evaluate(() => window.__playShell!.inputs().length)).toBeGreaterThan(0);
    await page.getByTestId('play-replay').click();
    await expect(page.getByTestId('play-postrun')).toHaveCount(0);
    // Týž záznam přetočený na tik 0 by měl vstupy svědka a sám by hru dohrál; nový běh je má prázdné a hodiny jdou.
    await expect.poll(() => page.evaluate(() => window.__playShell!.inputs().length)).toBe(0);
    const first = await page.evaluate(() => window.__playShell!.tick());
    expect(first).toBeLessThan(tick);
    await expect.poll(() => page.evaluate(() => window.__playShell!.tick()), { timeout: 10_000 }).toBeGreaterThan(first);
    expect(await page.evaluate(() => window.__playShell!.inputs().length)).toBe(0);
  });

  test('R after a loss starts a fresh run within 300 ms', async ({ page, request }) => {
    // Běžec, který na hodiny první stisk nečeká; bez jediného stisku narazí do 3 s simulovaného času.
    await page.goto(await publish(request, 'dodge the falling rocks'));
    await startGame(page);
    // Jako člověk: scéna se nejdřív vykreslí za běhu. Nikdy nehraná scéna kompiluje shadery
    // v softwarovém WebGL až po restartu (naměřeno 0,6–0,7 s dvakrát), to není cena nového pokusu.
    await page.waitForFunction(() => window.__playShell!.tick() > 60, undefined, { timeout: 30_000 });
    const end = await page.evaluate(() => (window.__playShell as unknown as { idleRun: () => { runState: string } }).idleRun());
    expect(end.runState).toBe('lost');
    await expect(page.getByTestId('play-outcome')).toHaveAttribute('data-outcome', 'lost');
    // Čas se měří ve stránce: od stisku (zachytávací fáze, před restartem) po první snímek, kdy nový běh má tik.
    await page.evaluate(() => {
      const probe = window as unknown as { __retry?: { pressed: number; ticking: number | null } };
      window.addEventListener(
        'keydown',
        () => {
          const retry = { pressed: performance.now(), ticking: null as number | null };
          probe.__retry = retry;
          const look = () => {
            if (document.querySelector('[data-testid="play-outcome"]') === null && window.__playShell!.tick() > 0) retry.ticking = performance.now();
            else requestAnimationFrame(look);
          };
          requestAnimationFrame(look);
        },
        { capture: true, once: true },
      );
    });
    await page.keyboard.press('r');
    const retry = await page.waitForFunction(() => {
      const value = (window as unknown as { __retry?: { pressed: number; ticking: number | null } }).__retry;
      return value?.ticking != null ? value : null;
    });
    const { pressed, ticking } = (await retry.jsonValue()) as { pressed: number; ticking: number };
    expect(ticking - pressed).toBeLessThanOrEqual(300);
    // Nový běh, ne přehrání: záznam prázdný (R není klávesa hry) a hodiny jdou dál bez dalšího dotyku.
    expect(await page.evaluate(() => window.__playShell!.inputs().length)).toBe(0);
    const tick = await page.evaluate(() => window.__playShell!.tick());
    await expect.poll(() => page.evaluate(() => window.__playShell!.tick())).toBeGreaterThan(tick);
  });
});
