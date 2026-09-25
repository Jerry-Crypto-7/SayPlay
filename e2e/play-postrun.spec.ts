import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Po dohrání (P23-C T6): Replay přehraje týž běh do téhož konce, čip
 * „Make it harder“ vede na **jinou** hru s vlastním odkazem a rodokmen to
 * ukáže na obou stranách; CHALLENGE A FRIEND zkopíruje odkaz.
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

  test('Replay plays the same run to the same ending', async ({ page }) => {
    await page.goto(url);
    const tick = await win(page);
    const inputs = await page.evaluate(() => window.__playShell!.inputs().length);
    await page.getByTestId('play-replay').click();
    // Přetočení na začátek je vidět na tiku HUD dřív, než běh znovu dojde do konce.
    await expect.poll(async () => Number(await page.getByTestId('play-tick').getAttribute('data-tick')), { intervals: [20] }).toBeLessThan(tick);
    // Hráč vidí sekundy (P28B F-15); stejný konec pinuje tik v atributu, text by 28,1 s nerozlišil od 28,14 s.
    await expect(page.locator('.play-outcome-detail')).toHaveAttribute('data-tick', String(tick), { timeout: 30_000 });
    await expect(page.getByTestId('play-outcome')).toContainText('You won');
    expect(await page.evaluate(() => window.__playShell!.inputs().length)).toBe(inputs);
  });

  test('Make it harder lands on a different game whose lineage points back', async ({ page }) => {
    await page.goto(url);
    await expect(page.getByTestId('play-lineage')).toContainText('Original');
    await win(page);
    await expect(page.getByText('CHANGE ONE THING')).toBeVisible();

    const parentId = url.split('/').at(-1)!;
    await page.getByTestId('play-chip-harder').click();
    await expect(page).toHaveURL(/\/play\/[a-f0-9]+$/, { timeout: 30_000 });
    await expect(page).not.toHaveURL(new RegExp(`/play/${parentId}$`));

    const lineage = page.getByTestId('play-lineage');
    await expect(lineage).toContainText('Remixed from');
    await expect(lineage.locator(`a[href="/play/${parentId}"]`)).toBeVisible();

    await page.goto(url);
    await expect(page.getByTestId('play-lineage')).toContainText('1 remix');
  });

  test('CHALLENGE A FRIEND copies the link', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(url);
    await win(page);
    await page.getByTestId('play-share').click();
    await expect(page.getByText('Link copied')).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain(url);
  });
});
