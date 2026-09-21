import { expect, test } from '@playwright/test';

/**
 * Sdílený odkaz (P23-C T7): cizí prohlížeč bez cookies a bez úložiště jde
 * rovnou do hry, odkaz nese náhled (`og:title`, `og:image` jako PNG) a
 * neznámá hra dá 404 s větou – stránka i obrázek.
 */

test.describe('/play/[id] – share landing', () => {
  let url = '';
  let id = '';

  test.beforeAll(async ({ request }) => {
    const response = await request.post('/api/play/games', { data: { sentence: 'Race through five neon gates in order.' } });
    expect(response.status(), await response.text()).toBeLessThan(300);
    ({ url } = (await response.json()) as { url: string });
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
    expect(title).toContain('Race through five neon gates in order.');
    expect(title).toContain('WORLDSTREAM PLAY');
    await expect(page).toHaveTitle(/WORLDSTREAM PLAY/);
    const image = await page.locator('meta[property="og:image"]').getAttribute('content');
    expect(image).toMatch(new RegExp(`/api/play/games/${id}/og$`));

    const png = await request.get(`/api/play/games/${id}/og`);
    expect(png.status()).toBe(200);
    expect(png.headers()['content-type']).toBe('image/png');
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
