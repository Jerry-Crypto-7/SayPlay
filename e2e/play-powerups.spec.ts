import { devices, expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { HUD_COUNTER_LABELS } from './hud-labels';

/**
 * Power-up a kombo v HUD (P46C T5, `PowerupBadge.tsx`): ve hře z věty se
 * power-upy robot sebere power-up a pár věcí v řadě – HUD pak ukáže odznak
 * power-upu s prstencem a násobič aspoň ×2 u pilulky postupu. Na telefonu
 * se odznak nesmí potkat s tlačítky akcí (P46A) a stránka nesmí hlásit chybu.
 *
 * Power-upy dávají jen hry složené s `genre.v3` – spec projde, až je sourozenecká
 * práce P46C zapne.
 */

const SENTENCE = 'A bee gathers honey in a windy meadow before the storm hits';

interface BoostProbe {
  start(): void;
  byHand(on: boolean): void;
  botWants(): { readonly axis: number; readonly buttons: number } | null;
  hold(axis: number): void;
  press(buttons: number): void;
  tickByHand(): { readonly runState: string };
}

let people = 0;

async function publish(request: APIRequestContext): Promise<string> {
  // Každá hra z vlastní adresy: strop `/api/play/*` počítá požadavky na adresu.
  const response = await request.post('/api/play/games', { data: { sentence: SENTENCE }, headers: { 'x-forwarded-for': `198.51.100.${String(200 + (people += 1))}` } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

/**
 * Robot hraje tik po tiku, dokud HUD nemá power-up i kombo ≥ ×2 naráz (odečet je
 * DOM, React ho vykreslí mezi tiky – proto se po každém kroku pustí snímek).
 */
async function playUntilBoosted(page: Page): Promise<boolean> {
  await page.evaluate(() => {
    const shell = window.__playShell as unknown as BoostProbe;
    shell.start();
    shell.byHand(true);
  });
  for (let round = 0; round < 90; round += 1) {
    const state = await page.evaluate(async () => {
      const shell = window.__playShell as unknown as BoostProbe;
      for (let tick = 0; tick < 20; tick += 1) {
        const wants = shell.botWants() ?? { axis: 0, buttons: 0 };
        shell.hold(wants.axis);
        shell.press(wants.buttons);
        if (shell.tickByHand().runState !== 'running') return 'ended';
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const power = document.querySelector('[data-testid="hud-counter-powerup"]');
      const combo = Number(document.querySelector('[data-testid="hud-counter-combo"]')?.getAttribute('data-count') ?? 1);
      return power !== null && combo >= 2 ? 'boosted' : 'playing';
    });
    if (state === 'boosted') return true;
    if (state === 'ended') return false;
  }
  return false;
}

async function expectBoosts(page: Page): Promise<void> {
  const badge = page.getByTestId('hud-counter-powerup');
  await expect(badge).toBeVisible();
  expect(Number(await badge.getAttribute('data-count')), 'prstenec ukazuje zbylý čas').toBeGreaterThan(0);
  await expect(badge.locator('.play-boost-ring circle')).toHaveCount(1);
  const combo = page.getByTestId('hud-counter-combo');
  await expect(combo).toBeVisible();
  expect(Number(await combo.getAttribute('data-count'))).toBeGreaterThanOrEqual(2);
  await expect(combo).toHaveText(/^×[2-5]/);
  for (const label of ['powerup', 'combo']) expect(HUD_COUNTER_LABELS).toContain(label);
}

test.describe('power-up badge and combo meter', () => {
  test('desktop: the active power-up and a ×2+ combo show next to the score', async ({ page, request }) => {
    test.setTimeout(180_000);
    const errors = watchErrors(page);
    await page.goto(await publish(request));
    await expect(page.getByTestId('arcade-stage')).toBeVisible();
    await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
    expect(await playUntilBoosted(page), 'robot sebral power-up a dvě věci v řadě').toBe(true);
    await expectBoosts(page);
    // Odznak stojí pod pilulkou postupu, ne přes ni.
    const pill = await page.getByTestId('play-progress-pill').boundingBox();
    const boosts = await page.locator('.play-boosts').boundingBox();
    if (pill !== null && boosts !== null) expect(boosts.y).toBeGreaterThanOrEqual(pill.y + pill.height);
    expect(errors).toEqual([]);
  });

  test.describe('phone', () => {
    test.use({ ...devices['Pixel 7'] });

    test('Pixel 7: badge and combo stay clear of the action buttons', async ({ page, request }) => {
      test.setTimeout(180_000);
      const errors = watchErrors(page);
      await page.goto(await publish(request));
      await expect(page.getByTestId('arcade-stage')).toBeVisible();
      await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
      expect(await playUntilBoosted(page)).toBe(true);
      await expectBoosts(page);
      const boosts = await page.locator('.play-boosts').boundingBox();
      expect(boosts).not.toBeNull();
      const buttons = await page.locator('.play-fire').evaluateAll((nodes) =>
        nodes.map((node) => {
          const box = node.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        }),
      );
      for (const button of buttons) {
        const apart =
          boosts!.x + boosts!.width <= button.x || button.x + button.width <= boosts!.x || boosts!.y + boosts!.height <= button.y || button.y + button.height <= boosts!.y;
        expect(apart, 'odznak se nepotká s tlačítkem akce').toBe(true);
      }
      expect(errors).toEqual([]);
    });
  });
});
