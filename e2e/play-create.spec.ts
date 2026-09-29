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
  // P25B T7: hlavní adresa vede na hry, stará aplikace je na /studio.
  test('the home address lands on /play', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/play$/);
    await expect(page.locator('.play-hero')).toHaveText('Imagine a game. Play it.');
  });

  test('hero, typed sentence and Play it land on /play/<id>', async ({ page }) => {
    await page.goto('/play');
    await expect(page.locator('.play-hero')).toHaveText('Imagine a game. Play it.');

    const sentence = page.getByTestId('play-sentence');
    await expect(sentence).toHaveValue('');
    await sentence.fill('Collect five glowing mushrooms then open a portal.');
    await page.getByTestId('play-create').click();
    await expect(page).toHaveURL(/\/play\/[a-f0-9]+$/);
  });

  // P28D T7: vzor je hra na jedno klepnutí, ne předvyplněné pole.
  test('a starter card creates its game without a second click', async ({ page }) => {
    await page.goto('/play');
    await page.getByTestId('play-starter-collect_exit').click();
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

    // Route announcer Next.js nese taky `role="alert"` – hlášku dveří drží `.play-alert`.
    const alert = page.locator('p.play-alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('no_loop');
    await expect(page).toHaveURL(/\/play$/);
    await expect(page.getByTestId('play-sentence')).toHaveValue('A sentence the director refuses.');

    // P33 T9: chyba nese vlastní `Try again`, který pošle tutéž větu znovu.
    const sent = page.waitForRequest((request) => request.url().endsWith('/api/play/games') && request.method() === 'POST');
    await alert.getByRole('button', { name: 'Try again' }).click();
    expect((await sent).postDataJSON()).toEqual({ sentence: 'A sentence the director refuses.' });
  });

  // P33 T9: po odeslání stojí pod polem všechny čtyři kroky stavby, první aktivní.
  test('sending shows all four build steps with the first one active', async ({ page }) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/api/play/games', async (route) => {
      await held;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'busy' } }) });
    });
    await page.goto('/play');
    await page.getByTestId('play-sentence').fill('Collect five glowing mushrooms then open a portal.');
    await page.getByTestId('play-create').click();

    const steps = page.getByTestId('play-status').locator('li');
    await expect(steps).toHaveText(['Designing the challenge', 'Building a playable version', 'Checking the rules', 'Adding the look']);
    await expect(steps.first()).toHaveAttribute('data-state', 'active');
    release();
    await expect(page.locator('p.play-alert')).toContainText('busy');
  });

  test('the sentence counter refuses more than 500 characters', async ({ page }) => {
    await page.goto('/play');
    // P33 T9: počítadlo se ukáže až od 400 znaků.
    await page.getByTestId('play-sentence').fill('a'.repeat(399));
    await expect(page.locator('.play-counter')).toHaveCount(0);
    await page.getByTestId('play-sentence').fill('a'.repeat(600));
    await expect(page.getByTestId('play-sentence')).toHaveValue('a'.repeat(500));
    await expect(page.getByText('500 / 500')).toBeVisible();
  });

  // P33 T9: telefon má hru první a k poli vede plovoucí `+ New game`; na desktopu je pole nad feedem.
  test('phone: + New game brings the sentence field into view', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/play');
    const sentence = page.getByTestId('play-sentence');
    await expect(sentence).not.toBeInViewport();
    await page.getByTestId('play-new-game').click();
    await expect(sentence).toBeInViewport();
    await expect(sentence).toBeFocused();
    await expect(page.getByTestId('play-new-game')).toBeHidden();
  });

  test('desktop: the sentence field sits above the feed', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/play');
    await expect(page.getByTestId('play-sentence')).toBeInViewport();
    await expect(page.getByTestId('play-new-game')).toBeHidden();
    const form = await page.getByTestId('play-sentence').boundingBox();
    const feed = await page.locator('.play-pager').boundingBox();
    expect(form!.y).toBeLessThan(feed!.y);
  });
});
