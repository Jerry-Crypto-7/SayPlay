import { expect, test } from '@playwright/test';

/**
 * Feed, který nikdy není prázdný (P37C T6): čistá instance bez Upstash a bez
 * jediné publikované hry ukáže na `/play` vestavěnou sadu ověřených her –
 * hru přes obrazovku a pod ní karty –, ne „No games yet“ nad ukázkou.
 * Vestavěná hra jde otevřít odkazem a zahrát.
 *
 * Spouštět na čerstvě spuštěném `next start` (`--workers=1`): hra publikovaná
 * jiným testem by se ve feedu objevila taky, ale vestavěné hry nevytlačí.
 */

test('a fresh instance without a store shows the built-in games, not an empty feed', async ({ page, request }) => {
  const listed = await request.get('/api/play/games?recent=48');
  expect(listed.ok()).toBe(true);
  const { games } = (await listed.json()) as { games: { versionId: string; title: string }[] };
  expect(games.length).toBeGreaterThanOrEqual(24);

  await page.goto('/play');
  await expect(page.getByTestId('feed-pager')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('play-feed-empty')).toHaveCount(0);
  await expect(page.getByTestId('feed-demo')).toHaveCount(0);
  const current = page.getByTestId('feed-current');
  const shown = await current.getAttribute('data-version-id');
  expect(games.map((game) => game.versionId)).toContain(shown);

  // Na kartě hned hraje náhled robota v plátně feedu (P54A T7).
  await expect(current.locator('canvas')).toHaveCount(1, { timeout: 30_000 });

  // Další hra feedu je jiná vestavěná hra.
  await page.getByTestId('feed-next').click();
  await expect(current).not.toHaveAttribute('data-version-id', shown ?? '');

  // Odkaz na vestavěnou hru vede na hru, ne na „Game not found“.
  const opened = await page.goto(`/play/${games[1]?.versionId ?? ''}`);
  expect(opened?.status()).toBe(200);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
});
