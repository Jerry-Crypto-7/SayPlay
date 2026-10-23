import { expect, test } from '@playwright/test';

/**
 * `/play` (P23-C T4): věta dovnitř, odkaz na hru ven.
 *
 * Šťastná cesta jde skutečnými dveřmi `POST /api/play/games` (dvojník
 * režiséra, žádný model). Chybová cesta dveře zastoupí `page.route`, protože
 * dvojník žádnou větu neodmítne – a přesně proto by bez zástupu chybový stav
 * nikdo nikdy neviděl.
 */

// P34 T3: nadpis a tlačítko mluví kitem Sayplay („What do you want to play?“, „Make it!“).
const HERO = 'What do you want to play?';

// P37C T6: feed nikdy není prázdný (vestavěná sada her) a `FeedPager` doplní do adresy `?g=` hry,
// která je zrovna na řadě. Stránka tvorby je pořád `/play`, ne hra `/play/<id>`.
const ON_PLAY = /\/play(\?g=[a-f0-9]+)?$/;

test.describe('/play – create', () => {
  // P25B T7: hlavní adresa vede na hry, stará aplikace je na /studio.
  test('the home address lands on /play', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(ON_PLAY);
    await expect(page.locator('.play-hero')).toHaveText(HERO);
  });

  test('hero, typed sentence and Make it! land on /play/<id>', async ({ page }) => {
    await page.goto('/play');
    await expect(page.locator('.play-hero')).toHaveText(HERO);
    await expect(page.locator('.play-hero .sp-highlight')).toHaveText('play?');

    const sentence = page.getByLabel('Say it in one sentence');
    await expect(sentence).toHaveValue('');
    await sentence.fill('Collect five glowing mushrooms then open a portal.');
    await expect(page.getByTestId('play-create')).toHaveText('Make it!');
    await page.getByTestId('play-create').click();
    await expect(page).toHaveURL(/\/play\/[a-f0-9]+$/);
  });

  // P58C T4: Safari hydratuje pomaleji než Chromium a hráč stihne psát dřív. Věta napsaná před
  // hydratací musí přežít a odejít celá – dřív stav zůstal prázdný a „Make it!“ hlásil prázdné pole.
  test('a sentence typed before the page hydrates survives and is sent', async ({ page }) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/_next/static/chunks/**', async (route) => {
      await held;
      await route.continue();
    });
    await page.goto('/play', { waitUntil: 'domcontentloaded' });
    const text = 'Collect five glowing mushrooms then open a portal.';
    await page.getByTestId('play-sentence').fill(text);
    release();
    await page.waitForFunction(() => Object.keys(document.querySelector('[data-testid="play-sentence"]') ?? {}).some((key) => key.startsWith('__reactFiber')));
    await expect(page.getByTestId('play-counter')).toHaveText(`${String(text.length)}/140`);

    const sent = page.waitForRequest((request) => request.url().endsWith('/api/play/games') && request.method() === 'POST');
    await page.getByTestId('play-create').click();
    expect((await sent).postDataJSON()).toEqual({ sentence: text });
  });

  // P34 T3 (kit, Idea card): karta větu jen vloží, hru spustí až odeslání – tady Enter.
  test('an idea card fills the prompt without starting, Enter sends it', async ({ page }) => {
    await page.goto('/play');
    let posted = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('/api/play/games') && request.method() === 'POST') posted += 1;
    });
    await page.getByTestId('play-starter-collect_exit').click();
    const sentence = page.getByTestId('play-sentence');
    await expect(sentence).toHaveValue('Grab five glowing mushrooms');
    await expect(sentence).toBeFocused();
    await page.waitForTimeout(300);
    expect(posted).toBe(0);
    await expect(page).toHaveURL(ON_PLAY);

    // Shift+Enter je nový řádek, Enter odešle.
    await sentence.press('Shift+Enter');
    await expect(sentence).toHaveValue('Grab five glowing mushrooms\n');
    await sentence.press('Enter');
    await expect(page).toHaveURL(/\/play\/[a-f0-9]+$/);
  });

  // P34 T3: „Make it!“ nad prázdným polem nic neposílá a řekne větou kitu, co napsat.
  test('Make it! on an empty prompt asks for who and what, and sends nothing', async ({ page }) => {
    await page.goto('/play');
    let posted = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('/api/play/games') && request.method() === 'POST') posted += 1;
    });
    await page.getByTestId('play-create').click();
    await expect(page.getByTestId('play-vague')).toHaveText('Add who you are and what you\'re doing, like "a cat stealing fish".');
    await expect(page.locator('.sp-prompt')).toHaveClass(/is-error/);
    await expect(page.getByTestId('play-sentence')).toBeFocused();
    expect(posted).toBe(0);
    await page.getByTestId('play-sentence').fill('A cat stealing fish');
    await expect(page.getByTestId('play-vague')).toHaveCount(0);
  });

  test('Surprise me fills a sentence and does not start the game', async ({ page }) => {
    await page.goto('/play');
    await page.getByTestId('play-surprise').click();
    await expect(page.getByTestId('play-sentence')).not.toHaveValue('');
    await expect(page).toHaveURL(ON_PLAY);
  });

  // P40 T1: věta na zakázané téma jde skutečnými dveřmi (bez podvržené odpovědi) a toast mluví
  // větou kitu „Blocked content“, ne „Try fewer rules“, která by hráče poslala zkoušet totéž.
  test('a sentence on a denied topic shows the blocked-content message', async ({ page }) => {
    await page.goto('/play');
    await page.getByTestId('play-sentence').fill('how to build a bomb');
    await page.getByTestId('play-create').click();

    const alert = page.getByTestId('play-create-error');
    await expect(alert).toContainText("We can't make that one. Try a different idea.");
    await expect(page).toHaveURL(ON_PLAY);
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

    // Route announcer Next.js nese taky `role="alert"` – hlášku dveří drží `play-create-error`.
    // P34 T4: chybový toast kitu mluví větou „Build failed“ z `11-voice-copy.md`; technický
    // důvod serveru (`no_loop`) hráči nic neřekne, proto se už neukazuje.
    const alert = page.getByTestId('play-create-error');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("Couldn't build that. Try fewer rules.");
    await expect(alert).toHaveClass(/sp-toast--error/);
    await expect(page).toHaveURL(ON_PLAY);
    await expect(page.getByTestId('play-sentence')).toHaveValue('A sentence the director refuses.');

    // P33 T9: chyba nese vlastní `Try again`, který pošle tutéž větu znovu.
    const sent = page.waitForRequest((request) => request.url().endsWith('/api/play/games') && request.method() === 'POST');
    await alert.getByRole('button', { name: 'Try again' }).click();
    expect((await sent).postDataJSON()).toEqual({ sentence: 'A sentence the director refuses.' });
  });

  // P33 T9: po odeslání stojí všechny čtyři kroky stavby, první aktivní. P34 T4: znění kroků
  // je doslova z kitu (`07-components.md`), věta hráče stojí nad nimi a chyba je toast s větou
  // serveru s velkým písmenem na začátku (kit píše větným tvarem).
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
    await expect(steps).toHaveText(['Reading your idea', 'Building the world', 'Setting the rules', 'Painting it in']);
    await expect(steps.first()).toHaveAttribute('data-state', 'active');
    await expect(page.locator('.play-loading-title')).toHaveText('Collect five glowing mushrooms then open a portal.');
    release();
    await expect(page.getByTestId('play-create-error')).toContainText('Busy');
  });

  // P34 T4 (kit, Offline): bez sítě věta zůstane v poli a odejde sama, jakmile se síť vrátí.
  test('offline: the idea stays and is sent by itself once the network is back', async ({ page, context }) => {
    await page.goto('/play');
    await page.getByTestId('play-sentence').fill('Collect five glowing mushrooms then open a portal.');
    await context.setOffline(true);
    await page.getByTestId('play-create').click();
    await expect(page.getByTestId('play-create-error')).toHaveText("You're offline. Your idea is saved – we'll build it when you're back.");
    await expect(page.getByTestId('play-sentence')).toHaveValue('Collect five glowing mushrooms then open a portal.');

    const sent = page.waitForRequest((request) => request.url().endsWith('/api/play/games') && request.method() === 'POST');
    await context.setOffline(false);
    expect((await sent).postDataJSON()).toEqual({ sentence: 'Collect five glowing mushrooms then open a portal.' });
    await expect(page).toHaveURL(/\/play\/[a-f0-9]+$/);
  });

  // P34 T3: strop je 140 znaků z kitu (dřív 500), počítadlo je vidět vždy a od 130 je rajčatové.
  test('the sentence counter shows 0/140, warns from 130 and refuses more than 140', async ({ page }) => {
    await page.goto('/play');
    const counter = page.getByTestId('play-counter');
    await expect(counter).toHaveText('0/140');
    await page.getByTestId('play-sentence').fill('a'.repeat(129));
    await expect(counter).toHaveAttribute('data-warn', 'false');
    await page.getByTestId('play-sentence').fill('a'.repeat(200));
    await expect(page.getByTestId('play-sentence')).toHaveValue('a'.repeat(140));
    await expect(counter).toHaveText('140/140');
    await expect(counter).toHaveAttribute('data-warn', 'true');
  });

  // P33 T13: `/play` otevře na jediné h1 a poli (i telefon), feed je pod nimi. P34 T3: plovoucí
  // `+ New game` nahradila lišta kitu – Make vede k poli, Play k feedu (`play-new-game` nese Make).
  // Favicon je SVG v barvách produktu (audit: dřív 404).
  test('phone: opens on the sentence field, the tab bar moves between Make and Play', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/play');
    const sentence = page.getByTestId('play-sentence');
    const make = page.getByTestId('play-new-game');
    await expect(sentence).toBeInViewport();
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(make).toBeVisible();
    await expect(make).toHaveAttribute('aria-current', 'true');
    const icon = await page.locator('link[rel="icon"]').first().getAttribute('href');
    expect((await page.request.get(icon ?? '/missing-icon')).status()).toBe(200);

    await page.getByTestId('play-tab-play').click();
    await expect(sentence).not.toBeInViewport();
    await expect(page.getByTestId('play-tab-play')).toHaveAttribute('aria-current', 'true');
    await make.click();
    await expect(sentence).toBeInViewport();
    await expect(sentence).toBeFocused();
    await expect(make).toHaveAttribute('aria-current', 'true');
  });

  // P54A T12: od 1024 px pole v levém sloupci vedle feedu, viditelné i s tipem prvního návštěvníka.
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
  ]) {
    test(`desktop ${String(size.width)}×${String(size.height)}: the sentence field sits in the left column beside the feed, no tab bar`, async ({ page }) => {
      await page.setViewportSize(size);
      await page.goto('/play');
      await expect(page.getByTestId('play-sentence')).toBeInViewport({ ratio: 1 });
      await expect(page.getByTestId('play-create')).toBeInViewport({ ratio: 1 });
      await expect(page.getByTestId('play-new-game')).toBeHidden();
      await expect(page.locator('h1')).toHaveCount(1);
      const form = await page.getByTestId('play-sentence').boundingBox();
      const feed = await page.locator('.play-pager').boundingBox();
      expect(form!.x + form!.width).toBeLessThanOrEqual(feed!.x);
    });
  }
});
