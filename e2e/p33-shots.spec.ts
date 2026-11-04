import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Snímky každého stavu PLAY na telefonu a desktopu (P33 T1). Nástroj pro oko,
 * ne test chování: snímky jdou do `evals/play/p33/<label>/` a úloha je
 * prohlédne. Label je `P33_SHOTS_LABEL` (`before`, `phase1`, `final`).
 *
 * Asertuje jen dvě věci: že vznikly všechny snímky, a že se stránka na
 * telefonu neposouvá do strany (audit bod 6). Na základu větve P33 byl ten
 * assert zelený už v `before` – `.play-root` vodorovný posuv ořízne a lišta
 * cílů se posouvá sama – takže hlídá, aby to tak zůstalo.
 */

const LABEL = process.env.P33_SHOTS_LABEL || 'before';
const DIR = join(process.cwd(), 'evals', 'play', 'p33', LABEL);
const SENTENCE = "A fox steals eggs from a farm while the farmer's dog chases it";

const SIZES = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 900 },
] as const;

const STATES = ['home-0s', 'home-5s', 'game-0s', 'game-5s', 'targets', 'result', 'remix-open', 'create-error', 'create-progress', 'build-300ms'] as const;
type State = (typeof STATES)[number];

test.describe.configure({ mode: 'serial' });

async function publish(request: APIRequestContext): Promise<string> {
  const response = await request.post('/api/play/games', { data: { sentence: SENTENCE } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

async function shot(page: Page, size: string, state: State): Promise<void> {
  mkdirSync(DIR, { recursive: true });
  await page.screenshot({ path: join(DIR, `${state}-${size}.png`) });
}

/**
 * Podíl tmavých pixelů snímku (jas pod 40 z 255). Dekóduje se ve vlastní
 * prázdné stránce: hlavní stránka může zrovna přecházet na hru.
 */
async function darkShare(page: Page, png: Buffer): Promise<number> {
  const probe = await page.context().newPage();
  try {
    return await probe.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) if (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2] < 40) dark += 1;
      return dark / (data.length / 4);
    }, png.toString('base64'));
  } finally {
    await probe.close();
  }
}

/** Hra je vidět: plátno stojí a ani mřížka, ani fyzika už se nenačítá. */
async function gameShown(page: Page): Promise<void> {
  await page.locator('canvas').first().waitFor({ timeout: 60_000 });
  await expect(page.getByTestId('play-building')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId('arcade-physics-loading')).toHaveCount(0, { timeout: 60_000 });
}

for (const size of SIZES) {
  test.describe(`${size.name} ${size.width}×${size.height}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
    });

    test('home after load and after 5 s', async ({ page }) => {
      await page.goto('/play');
      await page.waitForLoadState('load');
      await page.locator('canvas').first().waitFor({ timeout: 60_000 });
      await shot(page, size.name, 'home-0s');
      await page.waitForTimeout(5_000);
      await shot(page, size.name, 'home-5s');
      await expect(page.getByText('So close.')).toHaveCount(0);
    });

    test('the fox game at 0 s and 5 s, its targets, result and remix box', async ({ page, request }) => {
      const url = await publish(request);
      await page.goto(url);
      await gameShown(page);
      const shownAt = Date.now();
      await shot(page, size.name, 'game-0s');

      const targets = page.locator('.play-targets');
      if ((await targets.count()) > 0) await targets.first().scrollIntoViewIfNeeded();
      await shot(page, size.name, 'targets');
      await page.evaluate(() => window.scrollTo(0, 0));

      await page.waitForTimeout(Math.max(0, 5_000 - (Date.now() - shownAt)));
      await shot(page, size.name, 'game-5s');
      // P33 T11 (audit bod 1): bez vstupu hráče hra stojí na tiku 0 a prohra nepřijde.
      // P34 T6: prohra se jmenuje „So close.“ (dřív „You lost“) – jinak by kontrola prošla naprázdno.
      await expect(page.getByText('So close.')).toHaveCount(0);
      expect(await page.evaluate(() => window.__playShell!.tick())).toBe(0);
      // P70C T2: desktopový ukazatel (i na šířce telefonu) kliká; „Tap to start“ jen na dotyku.
      await expect(page.getByTestId('play-first-prompt-start')).toHaveText(/^Click (?:or press Space|to start)$/);

      // Konec hry dohraje běh ověřovače – sama hra bez hráče neskončí.
      const outcome = page.getByTestId('play-outcome');
      await page.evaluate(() => window.__playShell!.playWitness());
      await expect(outcome).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(500);
      await shot(page, size.name, 'result');

      // Od P33 T4 je pole změny za tlačítkem výsledku (od P34 T6 „Remix it“, dřív „Change it“); dřív leží rovnou v kartě.
      const changeIt = page.getByRole('button', { name: 'Remix it' });
      if ((await changeIt.count()) > 0) await changeIt.click();
      const input = page.getByTestId('remix-input');
      await input.fill('Make the dog slower');
      await input.scrollIntoViewIfNeeded();
      await shot(page, size.name, 'remix-open');
    });

    test('create error state', async ({ page }) => {
      await page.route('**/api/play/games', (route) =>
        route.request().method() === 'POST'
          ? route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({ error: { code: 'MODEL_UNAVAILABLE', message: 'The AI is busy right now. Try again in a minute.' } }),
            })
          : route.continue(),
      );
      await page.goto('/play');
      const sentence = page.getByTestId('play-sentence');
      await sentence.fill(SENTENCE);
      await page.getByTestId('play-create').click();
      // P34 T4: chyba dveří je toast kitu s vlastním testid (dřív `p.play-alert`).
      const alert = page.getByTestId('play-create-error');
      await expect(alert).toBeVisible();
      await alert.scrollIntoViewIfNeeded();
      await shot(page, size.name, 'create-error');
    });

    // P33 T9: odpověď dveří se zdrží, aby byl vidět průběh stavby.
    test('create progress state', async ({ page }) => {
      await page.route('**/api/play/games', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        return route.abort();
      });
      await page.goto('/play');
      await page.getByTestId('play-sentence').fill(SENTENCE);
      await page.getByTestId('play-create').click();
      const steps = page.getByTestId('play-status');
      await expect(steps).toBeVisible();
      await steps.scrollIntoViewIfNeeded();
      await shot(page, size.name, 'create-progress');
    });

    // P33 T14: mezi odesláním věty a první scénou nikdy tmavá prázdnota – 300 ms po kliknutí
    // (dveře odpovídají doopravdy) nesmí být tmavých víc než 90 % pixelů.
    test('300 ms after Play it the screen is not a dark void', async ({ page }) => {
      await page.goto('/play');
      await page.getByTestId('play-sentence').fill(SENTENCE);
      await page.getByTestId('play-create').click();
      await page.waitForTimeout(300);
      const png = await page.screenshot();
      mkdirSync(DIR, { recursive: true });
      writeFileSync(join(DIR, `build-300ms-${size.name}.png`), png);
      expect(await darkShare(page, png)).toBeLessThanOrEqual(0.9);
    });
  });
}

test('every state was shot at both sizes', () => {
  const missing = SIZES.flatMap((size) => STATES.map((state) => `${state}-${size.name}.png`)).filter((file) => !existsSync(join(DIR, file)));
  expect(missing).toEqual([]);
});

test('phone: the page never scrolls sideways', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const url = await publish(request);
  for (const address of ['/play', url]) {
    await page.goto(address);
    await gameShown(page);
    const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
    expect(width.scroll, `${address} is ${width.scroll} px wide on a ${width.inner} px screen`).toBeLessThanOrEqual(width.inner);
  }
});
