import { expect, test } from '@playwright/test';

/**
 * Feed na `/play` (P23-D T4). Do feedu jde jen autorská verze od režiséra
 * (nález revize T4-1: titul návrhu i ručního specu píše volající), a e2e
 * model nevolá – skutečný feed tu proto návrhy ukázat nesmí, a to se měří
 * přímo na dveřích. Karty se měří nad třemi skutečně publikovanými hrami,
 * jejichž řádky feedu dodá `page.route`; klepnutí vede na skutečnou hru.
 */

const SENTENCES = [
  'A hamster escapes a supermarket while a giant Roomba hunts it.',
  'Carry a fragile cake across a kitchen to a party table.',
  'Race through five neon gates in order.',
];

interface Created {
  readonly versionId: string;
  readonly title: string;
  readonly archetype: string;
}

test.describe('/play – feed', () => {
  test('drafts stay out of the real feed; feed cards open their games', async ({ page, request }) => {
    const created: Created[] = [];
    for (const sentence of SENTENCES) {
      const response = await request.post('/api/play/games', { data: { sentence } });
      expect(response.status(), sentence).toBeLessThan(300);
      created.push((await response.json()) as Created);
    }

    const real = await request.get('/api/play/games?recent=24');
    expect(real.status()).toBe(200);
    const ids = ((await real.json()) as { games: { versionId: string }[] }).games.map((game) => game.versionId);
    for (const game of created) expect(ids).not.toContain(game.versionId);

    const rows = created.map((game, index) => ({ ...game, createdAt: new Date(Date.now() - index * 1000).toISOString(), parentId: null, remixes: index }));
    await page.route('**/api/play/games?recent=*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ games: rows }) }));
    await page.goto('/play');
    const cards = page.getByTestId('play-feed-card');
    await expect(cards).toHaveCount(3);
    await expect(cards.nth(0)).toContainText(created[0].title);
    // Věta archetypu přichází ze serverové stránky, ne z registru v klientovi.
    expect(created[0].archetype).toBe('chase_escape');
    await expect(cards.nth(0)).toContainText('Something hunts the player');
    await expect(cards.nth(0)).toContainText('0 remixes');
    await expect(cards.nth(1)).toContainText('1 remix');

    await cards.nth(2).click();
    await expect(page).toHaveURL(new RegExp(`/play/${created[2].versionId}$`));
  });

  test('an empty feed says so honestly', async ({ page }) => {
    await page.route('**/api/play/games?recent=*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ games: [] }) }));
    await page.goto('/play');
    await expect(page.getByTestId('play-feed-empty')).toHaveText('No games yet – write the first sentence.');
    await expect(page.getByTestId('play-feed-card')).toHaveCount(0);
  });
});
