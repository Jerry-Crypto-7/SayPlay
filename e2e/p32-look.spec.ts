import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import sharp from 'sharp';

/**
 * Rig vzhledu (P32A). Scéna běžce se kreslí se stíny slunce a pod ACES
 * (sonda `__playRender`), a obraz se od snímku před rigem (`p32-split`,
 * P32-0 T5) opravdu liší – rig, který by nic nekreslil, by tu zčervenal.
 *
 * Snímek je deterministický stejně jako v `p32-split.spec.ts`: robot hraje do
 * prvního bodu, skrytá záložka hru pozastaví, na snímku je jen plátno.
 */

/** `THREE.ACESFilmicToneMapping`. */
const ACES = 4;

/** Nad plátnem nic: HUD, „+1“ a počasí se mění jinak než scéna. */
const ONLY_CANVAS = 'body * { visibility: hidden !important; } [data-testid="arcade-stage"] canvas { visibility: visible !important; }';

async function publish(request: APIRequestContext, fixture: string): Promise<string> {
  const spec = JSON.parse(readFileSync(join(process.cwd(), 'src/play/arcade/__fixtures__', `${fixture}.json`), 'utf8')) as unknown;
  const response = await request.post('/api/play/games', { data: { spec } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

/** Robot do prvního bodu, pak pauza skrytou záložkou (postup z `p32-split.spec.ts`). */
function freezeAtFirstScore(page: Page): Promise<{ readonly score: number; readonly tick: number }> {
  return page.evaluate(() => {
    type Hand = { handPlay: (until: 'score' | 'end') => { score: number } };
    const showTab = (state: 'visible' | 'hidden'): void => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    showTab('visible');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
    const run = (window.__playShell as unknown as Hand).handPlay('score');
    showTab('hidden');
    return { score: run.score, tick: window.__playShell!.tick() };
  });
}

/** Podíl pixelů, které se liší o víc než šum komprese a vyhlazení (součet kanálů > 48). */
async function changedShare(a: Buffer, b: Buffer): Promise<number> {
  const [left, right] = await Promise.all([a, b].map((png) => sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })));
  expect(left!.info.width).toBe(right!.info.width);
  expect(left!.info.height).toBe(right!.info.height);
  let changed = 0;
  for (let i = 0; i < left!.data.length; i += 3) {
    const diff = Math.abs(left!.data[i]! - right!.data[i]!) + Math.abs(left!.data[i + 1]! - right!.data[i + 1]!) + Math.abs(left!.data[i + 2]! - right!.data[i + 2]!);
    if (diff > 48) changed += 1;
  }
  return changed / (left!.data.length / 3);
}

test.describe('desktop 1280×800', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('runner: the style rig casts sun shadows under ACES and changes the frame', async ({ page, request }) => {
    test.setTimeout(120_000);
    await page.goto(await publish(request, 'runner'));
    await expect(page.getByTestId('arcade-stage')).toBeVisible();
    const canvas = page.locator('[data-testid="arcade-stage"] canvas').first();
    await canvas.waitFor();
    await page.waitForFunction(() => window.__playShell !== undefined && window.__playShell.tick() > 5 && window.__playRender !== undefined, undefined, { timeout: 60_000 });

    const render = await page.evaluate(() => window.__playRender!());
    expect(render.shadows, 'renderer.shadowMap.enabled').toBe(true);
    expect(render.toneMapping, 'renderer.toneMapping').toBe(ACES);

    const first = await freezeAtFirstScore(page);
    expect(first.score).toBeGreaterThan(0);
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(2_000);
    expect(await freezeAtFirstScore(page)).toEqual(first);
    await page.waitForTimeout(800);
    await page.addStyleTag({ content: ONLY_CANVAS });

    const before = readFileSync(join(process.cwd(), 'e2e/__screenshots__/p32-split/runner-desktop.png'));
    const share = await changedShare(await canvas.screenshot({ path: test.info().outputPath('runner-desktop.png') }), before);
    expect(share, 'podíl pixelů, které rig změnil proti snímku před ním').toBeGreaterThan(0.05);
  });
});
