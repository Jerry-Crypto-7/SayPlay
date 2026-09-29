import { existsSync, mkdirSync } from 'node:fs';
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

const STATES = ['home-0s', 'home-5s', 'game-0s', 'game-5s', 'targets', 'result', 'remix-open', 'create-error'] as const;
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

      // Hra, která bez hráče sama skončí, ukáže konec do pár sekund; jinak ji dohraje běh ověřovače.
      const outcome = page.getByTestId('play-outcome');
      const ended = await outcome.waitFor({ timeout: 10_000 }).then(
        () => true,
        () => false,
      );
      if (!ended) await page.evaluate(() => window.__playShell!.playWitness());
      await expect(outcome).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(500);
      await shot(page, size.name, 'result');

      // Od P33 T4 je pole změny za tlačítkem „Change it“; dřív leží rovnou v kartě.
      const changeIt = page.getByRole('button', { name: 'Change it' });
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
      const alert = page.locator('p.play-alert');
      await expect(alert).toBeVisible();
      await alert.scrollIntoViewIfNeeded();
      await shot(page, size.name, 'create-error');
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
