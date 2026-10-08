import { expect, test, type Page } from '@playwright/test';

/**
 * Nápověda první návštěvy na `/play` (P44D T12): pět měřených vět a „Try your
 * own“ nad polem věty. Věta jen vyplní pole jako karta nápadu, „Not now“ nebo
 * první hra ji schová natrvalo, a bez úložiště stránka funguje dál.
 *
 * Měření pod `@measure` (běžná sada ho přeskočí) ověří, že každá z pěti vět
 * dá hru do 3 s od „Make it!“, a vyfotí nápovědu na telefonu i na desktopu:
 *   E2E_PORT=3217 FALLBACK_SMOKE_URL=http://127.0.0.1:3217 npx playwright test e2e/first-visit.spec.ts --grep @measure
 */

const PICKS = [
  ['f22', 'A knight fights a three-headed hydra at the castle gates.'],
  ['s037', 'A space marine shoots alien bugs in a mining colony'],
  ['h10', 'a penguin that slides down a glacier, jumps over seals and catches fish'],
  ['m16', 'a kangaroo jumps over cars then collects coins on the highway'],
  ['f08', 'a unicorn gallops across a rainbow to reach a castle in the clouds'],
] as const;

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

async function openHint(page: Page): Promise<void> {
  await page.goto('/play');
  await expect(page.getByTestId('play-first-visit')).toBeVisible();
}

type Frame = { y: number; hint: boolean; hydrated: boolean };

/**
 * Otevře `/play` a vrátí namalované snímky (`requestAnimationFrame`) od
 * prvního, na kterém je pole věty, do deseti snímků po hydrataci: kde pole
 * stálo a jestli byla vidět nápověda (P44D T18). Hydratovaný uzel nese klíč
 * `__reactFiber…`. Skripty Next dorazí o 500 ms později jako na pomalém
 * telefonu, kde je poskočení vidět: bez toho stihne studený server hydratovat
 * dřív, než prohlížeč HTML poprvé namaluje, a nebylo by co měřit.
 */
async function framesUntilHydrated(page: Page): Promise<Frame[]> {
  await page.route('**/_next/static/chunks/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  await page.addInitScript(() => {
    const frames: Frame[] = [];
    Object.assign(window, { __frames: frames });
    const tick = (): void => {
      const field = document.querySelector('[data-testid="play-sentence"]');
      if (field !== null) {
        const hint = document.querySelector<HTMLElement>('[data-testid="play-first-visit"]');
        const hydrated = Object.keys(field).some((key) => key.startsWith('__reactFiber'));
        frames.push({ y: field.getBoundingClientRect().y, hint: hint !== null && hint.offsetHeight > 0, hydrated });
      }
      if (frames.filter((frame) => frame.hydrated).length < 10) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.goto('/play', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window as unknown as { __frames: Frame[] }).__frames.filter((frame) => frame.hydrated).length >= 10);
  const frames = await page.evaluate(() => (window as unknown as { __frames: Frame[] }).__frames);
  expect(frames[0]!.hydrated, 'the first painted frame is the server HTML').toBe(false);
  return frames;
}

function spread(frames: Frame[]): number {
  const ys = frames.map((frame) => frame.y);
  return Math.max(...ys) - Math.min(...ys);
}

test.describe('/play – first visit hint', () => {
  // Vlastní adresa: hry odsud neubírají strop dveří (50 za 10 s na adresu) specům, které běží hned po tomhle.
  test.use({ extraHTTPHeaders: { 'x-forwarded-for': '198.51.100.30' } });

  test('a pick fills the prompt without starting, the hint sits above the field', async ({ page }) => {
    await page.setViewportSize(PHONE);
    let posted = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('/api/play/games') && request.method() === 'POST') posted += 1;
    });
    await openHint(page);

    const hint = await page.getByTestId('play-first-visit').boundingBox();
    const field = page.getByTestId('play-sentence');
    expect(hint!.y).toBeLessThan((await field.boundingBox())!.y);
    await expect(field).toBeInViewport();

    await page.getByTestId('play-pick-f22').click();
    await expect(field).toHaveValue(PICKS[0][1]);
    await expect(field).toBeFocused();
    await page.waitForTimeout(300);
    expect(posted).toBe(0);
  });

  test('a first visit paints the hint from the first frame and the prompt never moves', async ({ page }) => {
    await page.setViewportSize(PHONE);
    const frames = await framesUntilHydrated(page);
    expect(frames.every((frame) => frame.hint)).toBe(true);
    expect(spread(frames)).toBeLessThanOrEqual(1);
  });

  test('a returning player never sees the hint and the prompt never moves', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.addInitScript(() => window.localStorage.setItem('sp-first-visit', '1'));
    const frames = await framesUntilHydrated(page);
    expect(frames.some((frame) => frame.hint)).toBe(false);
    expect(spread(frames)).toBeLessThanOrEqual(1);
    await expect(page.getByTestId('play-first-visit')).toHaveCount(0);
  });

  test('Try your own focuses the empty prompt', async ({ page }) => {
    await openHint(page);
    await page.getByTestId('play-try-own').click();
    const field = page.getByTestId('play-sentence');
    await expect(field).toBeFocused();
    await expect(field).toHaveValue('');
  });

  test('Not now hides it for good', async ({ page }) => {
    await openHint(page);
    await page.getByTestId('play-first-visit-close').click();
    await expect(page.getByTestId('play-first-visit')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('play-sentence')).toBeVisible();
    await expect(page.getByTestId('play-first-visit')).toHaveCount(0);
  });

  test('after the first game it no longer shows', async ({ page }) => {
    await openHint(page);
    await page.getByTestId('play-pick-s037').click();
    await page.getByTestId('play-create').click();
    await expect(page).toHaveURL(/\/play\/[a-f0-9]+$/);
    await page.goto('/play');
    await expect(page.getByTestId('play-sentence')).toBeVisible();
    await expect(page.getByTestId('play-first-visit')).toHaveCount(0);
  });

  test('without storage the hint shows and the page still makes a game', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get: () => {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        },
      });
    });
    await openHint(page);
    await page.getByTestId('play-pick-m16').click();
    await page.getByTestId('play-create').click();
    await expect(page).toHaveURL(/\/play\/[a-f0-9]+$/);
  });
});

test.describe('@measure first visit hint', () => {
  for (const [profile, viewport] of [
    ['phone', PHONE],
    ['desktop', DESKTOP],
  ] as const) {
    test(`@measure ${profile}: screenshot, and every pick makes a game within 3 s`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize(viewport);
      await openHint(page);
      await page.evaluate(() => document.fonts.ready);
      await page.getByTestId('play-first-visit').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `.claude/p44d-first-visit-${profile}.png` });

      for (const [index, [id, sentence]] of PICKS.entries()) {
        // Každá věta z čisté první návštěvy a od jiného „porotce“: strop dveří počítá hry na adresu.
        await page.setExtraHTTPHeaders({ 'x-forwarded-for': `198.51.100.${String(profile === 'phone' ? index + 10 : index + 20)}` });
        await page.evaluate(() => window.localStorage.clear());
        await openHint(page);
        await page.getByTestId(`play-pick-${id}`).click();
        await expect(page.getByTestId('play-sentence')).toHaveValue(sentence);
        const started = Date.now();
        await page.getByTestId('play-create').click();
        await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 30_000 });
        const ms = Date.now() - started;
        console.log(`${profile} ${id}: game in ${String(ms)} ms – ${sentence}`);
        expect(ms, `${id}: ${sentence}`).toBeLessThanOrEqual(3_000);
      }
    });
  }
});
