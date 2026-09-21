import { expect, test } from '@playwright/test';

/**
 * Feed na `/play` (P23-D T4): po třech publikacích skutečnými dveřmi feed
 * ukáže jejich karty a klepnutí na kartu vede na hru. Prázdný stav se měří
 * přes `page.route` – sdílený server mají i ostatní sady, takže prázdný feed
 * by se bez zástupu nikdy neukázal.
 */

// Tři různé archetypy, aby rozmanitost feedu žádnou z nich neodložila.
const SENTENCES = [
  'A hamster escapes a supermarket while a giant Roomba hunts it.',
  'Carry a fragile cake across a kitchen to a party table.',
  'Flip three switches to open a vault door.',
];

test.describe('/play – feed', () => {
  test('three publications show up as cards and a card opens its game', async ({ page, request }) => {
    const ids: string[] = [];
    for (const sentence of SENTENCES) {
      const response = await request.post('/api/play/games', { data: { sentence } });
      expect(response.status(), sentence).toBeLessThan(300);
      ids.push(((await response.json()) as { versionId: string }).versionId);
    }

    await page.goto('/play');
    const cards = page.getByTestId('play-feed-card');
    await expect(cards.first()).toBeVisible();
    expect(await cards.count()).toBeGreaterThanOrEqual(3);
    for (const id of ids) await expect(page.locator(`a[data-testid="play-feed-card"][href="/play/${id}"]`)).toBeVisible();

    const card = page.locator(`a[data-testid="play-feed-card"][href="/play/${ids[0]}"]`);
    await expect(card).toContainText(/\d+ remix(es)?/);
    await card.click();
    await expect(page).toHaveURL(new RegExp(`/play/${ids[0]}$`));
  });

  test('an empty feed says so honestly', async ({ page }) => {
    await page.route('**/api/play/games?recent=*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ games: [] }) }));
    await page.goto('/play');
    await expect(page.getByTestId('play-feed-empty')).toHaveText('No games yet – write the first sentence.');
    await expect(page.getByTestId('play-feed-card')).toHaveCount(0);
  });
});
