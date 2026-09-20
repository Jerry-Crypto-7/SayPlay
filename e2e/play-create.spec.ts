import { expect, test } from '@playwright/test';

/**
 * `/play` (P23-C T4): věta dovnitř, odkaz na hru ven.
 *
 * Šťastná cesta jde skutečnými dveřmi `POST /api/play/games` (dvojník
 * režiséra, žádný model). Chybová cesta dveře zastoupí `page.route`, protože
 * dvojník žádnou větu neodmítne – a přesně proto by bez zástupu chybový stav
 * nikdo nikdy neviděl.
 */

test.describe('/play – create', () => {
  test('hero, starter card fills the sentence, Play it lands on /play/<id>', async ({ page }) => {
    await page.goto('/play');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Imagine a game. Play it.');

    const sentence = page.getByTestId('play-sentence');
    await expect(sentence).toHaveValue('');
    await page.getByTestId('play-starter-collect_exit').click();
    await expect(sentence).toHaveValue('Collect five glowing mushrooms then open a portal.');

    await page.getByTestId('play-create').click();
    await expect(page).toHaveURL(/\/play\/[a-f0-9]+$/);
  });

  test('a refused sentence shows the door message and stays on /play', async ({ page }) => {
    await page.route('**/api/play/games', (route) =>
      route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'SPEC_REJECTED', message: 'no_loop: the sentence could not become a game' } }),
      }),
    );
    await page.goto('/play');
    await page.getByTestId('play-sentence').fill('A sentence the director refuses.');
    await page.getByTestId('play-create').click();

    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('no_loop');
    await expect(page).toHaveURL(/\/play$/);
    await expect(page.getByTestId('play-sentence')).toHaveValue('A sentence the director refuses.');
  });

  test('the sentence counter refuses more than 500 characters', async ({ page }) => {
    await page.goto('/play');
    await page.getByTestId('play-sentence').fill('a'.repeat(600));
    await expect(page.getByTestId('play-sentence')).toHaveValue('a'.repeat(500));
    await expect(page.getByText('500 / 500')).toBeVisible();
  });
});
