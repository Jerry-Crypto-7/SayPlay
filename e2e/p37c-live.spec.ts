import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { openAbout, startGame } from './play-start';

/**
 * Viditelné živé změny a remix (P37C T7). Po prvním dohraném běhu pozve čip
 * „Change it while you play“ a přijatá změna ukáže štítek, co hra dostala.
 * Remix ukáže proti rodiči 1–3 čipy a remix remixu celou cestu od originálu.
 * Remixy jdou přes čipy (`harder`, `reskin`) – deterministicky, bez modelu.
 */

const RUNNER = 'dodge the falling rocks';

const person = (n: number) => ({ 'x-forwarded-for': `198.51.100.${String(n)}` });

async function publish(request: APIRequestContext, sentence: string): Promise<string> {
  const response = await request.post('/api/play/games', { data: { sentence } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

async function remix(request: APIRequestContext, url: string, chip: string, n: number): Promise<string> {
  const response = await request.post(`/api/play/games/${url.split('/').at(-1)!}/remix`, { data: { chip }, headers: person(n) });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

const shot = async (page: Page, name: string): Promise<void> => {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
};

test.describe('/play/[id] – live changes and remixes show what changed (P37C T7)', () => {
  test('after the first run the game invites a live change, then labels what the game got', async ({ page, request }) => {
    await page.goto(await publish(request, RUNNER));
    await startGame(page);
    await expect(page.getByTestId('live-open')).toBeVisible({ timeout: 30_000 });
    // Napoprvé se hráč učí hru: žádná pozvánka.
    await expect(page.getByTestId('live-invite')).toHaveCount(0);

    const end = await page.evaluate(() => (window.__playShell as unknown as { idleRun: () => { runState: string } }).idleRun());
    expect(end.runState).toBe('lost');
    await page.getByTestId('play-replay').click();
    await startGame(page);
    const invite = page.getByTestId('live-invite');
    await expect(invite).toHaveText('Change it while you play', { timeout: 30_000 });
    await shot(page, 'invite-desktop');

    await invite.click();
    const input = page.getByTestId('live-input');
    await expect(input).toBeFocused();
    await input.fill('make it rain');
    await page.getByTestId('live-submit').click();
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-kind', 'live');
    await expect(page.getByTestId('live-changed')).toHaveText('rain');
    await expect(invite).toHaveCount(0);
    await shot(page, 'changed-desktop');
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, 'changed-phone');
  });

  test('a remix shows what changed against its parent, and a remix of a remix the whole chain', async ({ page, request }) => {
    const root = await publish(request, RUNNER);
    const child = await remix(request, root, 'harder', 51);
    const grandchild = await remix(request, child, 'reskin', 52);

    await page.goto(child);
    await openAbout(page);
    await expect(page.getByTestId('play-remix-changes').locator('.sp-chip')).toHaveText(['faster']);

    await page.goto(grandchild);
    await openAbout(page);
    const chain = page.getByTestId('play-lineage-chain');
    await expect(chain).toContainText('Remixed from');
    await expect(chain.locator('a')).toHaveCount(2);
    await expect(chain.locator('a').first()).toHaveAttribute('href', `/play/${root.split('/').at(-1)!}`);
    await expect(chain.locator('a').last()).toHaveAttribute('href', `/play/${child.split('/').at(-1)!}`);
    const chips = page.getByTestId('play-remix-changes').locator('.sp-chip');
    await expect(chips).toHaveCount(3);
    await shot(page, 'lineage-desktop');
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, 'lineage-phone');
  });
});
