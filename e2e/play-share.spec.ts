import { expect, test } from '@playwright/test';

import { startGame } from './play-start';

/**
 * Sdílený odkaz (P23-C T7): cizí prohlížeč bez cookies a bez úložiště jde
 * rovnou do hry, odkaz nese náhled (`og:title`, `og:image` jako PNG) a
 * neznámá hra dá 404 s větou – stránka i obrázek.
 */

test.describe('/play/[id] – share landing', () => {
  let url = '';
  let id = '';
  let gameTitle = '';

  test.beforeAll(async ({ request }) => {
    const response = await request.post('/api/play/games', { data: { sentence: 'Race through five neon gates in order.' } });
    expect(response.status(), await response.text()).toBeLessThan(300);
    ({ url, title: gameTitle } = (await response.json()) as { url: string; title: string });
    id = url.split('/').at(-1)!;
  });

  test('a fresh browser context lands straight in the game', async ({ browser }) => {
    const context = await browser.newContext();
    expect(await context.cookies()).toEqual([]);
    const page = await context.newPage();
    await page.goto(url);
    await expect(page.getByTestId('play-goal')).toBeVisible();
    await expect(page.getByTestId('play-sentence')).toHaveCount(0);
    await context.close();
  });

  test('the page carries the game title and a PNG preview image', async ({ page, request }) => {
    await page.goto(url);
    const title = await page.locator('meta[property="og:title"]').getAttribute('content');
    // Titulek píše návrh ze slov, ne opis věty – náhled nese ten, který dveře vrátily.
    expect(gameTitle).not.toBe('');
    expect(title).toContain(gameTitle);
    expect(title).toContain('WORLDSTREAM PLAY');
    await expect(page).toHaveTitle(/WORLDSTREAM PLAY/);
    const image = await page.locator('meta[property="og:image"]').getAttribute('content');
    expect(image).toMatch(new RegExp(`/api/play/games/${id}/og$`));

    const png = await request.get(`/api/play/games/${id}/og`);
    expect(png.status()).toBe(200);
    expect(png.headers()['content-type']).toBe('image/png');
    // P27B T6: náhled kreslí hru (ne paletová záloha), 1200×630, na verzi natrvalo.
    expect(png.headers()['x-og-fallback']).toBeUndefined();
    expect(png.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
    const bytes = await png.body();
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1200, 630]);
    expect(await page.locator('meta[property="og:image:alt"]').getAttribute('content')).toBe(`${gameTitle} – cover image`);
  });

  test('sharing mid-game keeps the game running and a second browser opens the same version (P27B T5)', async ({ browser }) => {
    const first = await browser.newContext();
    // Nabídka sdílení prohlížeče se v e2e nedá obsluhovat – zachytí se, co by dostala.
    await first.addInitScript(() => {
      const shared: ShareData[] = [];
      (window as unknown as { __shared: ShareData[] }).__shared = shared;
      Object.defineProperty(navigator, 'share', { configurable: true, value: async (data: ShareData) => void shared.push(data) });
    });
    const page = await first.newPage();
    await page.goto(url);
    await startGame(page);
    await page.waitForFunction(() => window.__playShell !== undefined && window.__playShell.tick() > 20, undefined, { timeout: 60_000 });
    const inputs = await page.evaluate(() => window.__playShell!.inputs().length);
    await page.getByTestId('play-share').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __shared: ShareData[] }).__shared.length)).toBe(1);
    const data = await page.evaluate(() => (window as unknown as { __shared: ShareData[] }).__shared[0]);
    expect(data.url).toMatch(new RegExp(`/play/${id}\\?via=share$`));
    expect(data.title).toBe(gameTitle);
    // Stisk do hry nepropadl: žádný nový vstup, hodiny běží dál, pauza nenastala.
    const tick = await page.evaluate(() => window.__playShell!.tick());
    await expect.poll(() => page.evaluate(() => window.__playShell!.tick())).toBeGreaterThan(tick);
    expect(await page.evaluate(() => window.__playShell!.inputs().length)).toBe(inputs);
    await expect(page.getByTestId('play-paused')).toHaveCount(0);
    // Otisk světa, jak ho dostal tento prohlížeč: spec, blueprint i arkádový svět verze.
    const worldOf = (target: typeof page) =>
      target.evaluate(async (versionId) => {
        const game = (await (await fetch(`/api/play/games/${versionId}`)).json()) as Record<string, unknown>;
        return JSON.stringify([game.spec, game.blueprint ?? null, game.arcade ?? null]);
      }, id);
    const world = await worldOf(page);

    const second = await browser.newContext();
    const other = await second.newPage();
    let generated = 0;
    other.on('request', (request) => {
      // Události smyčky (P27D T4) jsou POST, ale nic negenerují.
      if (request.method() === 'POST' && !request.url().includes('/api/play/events')) generated += 1;
    });
    await other.goto(data.url!);
    await expect(other).toHaveURL(new RegExp(`/play/${id}\\?via=share$`));
    await other.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
    await expect(other.getByTestId('play-goal')).toBeVisible();
    expect(await worldOf(other)).toBe(world);
    expect(generated).toBe(0);
    await first.close();
    await second.close();
  });

  test('without a share sheet the HUD button copies the link to this version', async ({ browser }) => {
    const context = await browser.newContext();
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    });
    const page = await context.newPage();
    await page.goto(url);
    await page.getByTestId('play-share').click();
    // P34 T6: toast mluví kitem („Link copied. Go dare someone.“ místo „Link copied“).
    await expect(page.getByText('Link copied. Go dare someone.')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`^https?://[^/]+/play/${id}\\?via=share$`));
    // E2e server nemá sdílené úložiště (P27D T5): odkaz nesmí vypadat trvale.
    await expect(page.getByText('the link stops working when it restarts')).toBeVisible();
    await context.close();
  });

  test('an unknown game is a 404 with a sentence, for the page and the image', async ({ page, request }) => {
    const response = await page.goto('/play/deadbeef');
    expect(response?.status()).toBe(404);
    await expect(page.getByText('This game does not exist or has expired.')).toBeVisible();
    await expect(page.locator('a[href="/play"]')).toBeVisible();

    const image = await request.get('/api/play/games/deadbeef/og');
    expect(image.status()).toBe(404);
    expect(((await image.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });
});
