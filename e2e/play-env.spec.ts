import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Panorama prostředí za každou hrou (P29C T5). Plátno nese `data-env` (id
 * panoramatu na obrazovce); pás oblohy nahoře nesmí být jedna plochá barva,
 * kterou hra kreslila dřív.
 * Panorama se stahuje až po prvním snímku, takže první obraz nečeká na obrázek.
 */

const FIXTURES = join(process.cwd(), 'src/play/arcade/__fixtures__');

const GAMES: readonly { name: string; fixture?: string; sentence?: string; setting?: string; testId: string }[] = [
  { name: 'arcade runner', fixture: 'runner.json', setting: 'a snowy forest', testId: 'arcade-stage' },
  { name: 'grid', sentence: 'Collect five glowing mushrooms then open a portal.', testId: 'play-grid-stage' },
  { name: 'timing', fixture: 'timing.json', setting: 'a glacier', testId: 'arcade-stage' },
  { name: 'rhythm', fixture: 'rhythm.json', setting: 'a jungle clearing', testId: 'arcade-stage' },
  { name: 'duel', fixture: 'duel.json', setting: 'australian outback', testId: 'arcade-stage' },
];

async function publish(request: APIRequestContext, game: (typeof GAMES)[number]): Promise<string> {
  let data: unknown;
  if (game.fixture !== undefined) {
    const base = JSON.parse(readFileSync(join(FIXTURES, game.fixture), 'utf8')) as { theme: Record<string, unknown> } & Record<string, unknown>;
    data = { spec: { ...base, theme: { ...base.theme, setting: game.setting } } };
  } else {
    data = { sentence: game.sentence };
  }
  const response = await request.post('/api/play/games', { data });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

/**
 * Podíl nejčastější barvy v horním pásu plátna (15 % výšky). Plochá obloha je
 * jedna přesná barva přes skoro celý pás – předměty v něm (paprsek věže,
 * špičky stromů) ho sníží jen o svou plochu. Fotka panoramatu přesnou barvu
 * neopakuje ani v plynulém přechodu. Rozptyl jasu tohle nerozlišil: dodaly
 * ho předměty v pásu i nad plochou barvou (mutace prošla).
 */
async function skyDominantShare(page: Page, testId: string): Promise<number> {
  const canvas = page.getByTestId(testId).locator('canvas').first();
  // Jen plátno: HUD karta nahoře by pás rozbila sama, i nad plochou barvou.
  await canvas.evaluate((target) => {
    for (const el of document.body.querySelectorAll<HTMLElement>('*')) if (!el.contains(target) && el !== target) el.style.visibility = 'hidden';
  });
  const box = (await canvas.boundingBox())!;
  const png = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height * 0.15 } });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const counts = new Map<number, number>();
    for (let i = 0; i < data.length; i += 4) {
      const rgb = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      counts.set(rgb, (counts.get(rgb) ?? 0) + 1);
    }
    return Math.max(...counts.values()) / (data.length / 4);
  }, png.toString('base64'));
}

/** Nad tímhle podílem je pás jedna plochá barva, ne panorama. */
const SKY_DOMINANT_MAX = 0.5;

for (const game of GAMES) {
  test(`${game.name} draws the setting panorama behind the game`, async ({ page, request }) => {
    test.setTimeout(120_000);
    const url = await publish(request, game);
    await page.goto(url);
    const canvas = page.getByTestId(game.testId).locator('canvas').first();
    await expect(canvas).toHaveAttribute('data-env', /.+/, { timeout: 60_000 });
    const env = await canvas.getAttribute('data-env');
    // Plné panorama po náhledu: počkej, až bude i ono venku.
    await page.waitForFunction((id) => performance.getEntriesByType('resource').some((r) => r.name.endsWith(`/env/${id}.webp`)), env, { timeout: 30_000 });
    await page.waitForTimeout(800);
    await page.getByTestId(game.testId).screenshot({ path: test.info().outputPath(`${game.name}-${env}.png`) });
    const share = await skyDominantShare(page, game.testId);
    console.log(`[env] ${game.name} ${env}: dominant sky colour ${share.toFixed(3)}`);
    expect(share, `dominant sky colour share of ${env}`).toBeLessThan(SKY_DOMINANT_MAX);
  });
}

test('the panorama is fetched only after the first frame', async ({ page, request }) => {
  const url = await publish(request, GAMES[0]);
  // První snímek = první WebGL draw call plátna (jako sonda P28E), ne značka, kterou píše sama Panorama.
  await page.addInitScript(() => {
    const w = window as unknown as { __firstDraw: number | null };
    w.__firstDraw = null;
    for (const proto of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype] as unknown as Record<string, (...args: unknown[]) => unknown>[]) {
      for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
        const original = proto[name];
        if (typeof original !== 'function') continue;
        proto[name] = function (this: unknown, ...args: unknown[]) {
          if (w.__firstDraw === null) w.__firstDraw = performance.now();
          return original.apply(this, args);
        };
      }
    }
  });
  await page.goto(url);
  const canvas = page.getByTestId('arcade-stage').locator('canvas').first();
  await expect(canvas).toHaveAttribute('data-env', /.+/, { timeout: 60_000 });
  const { frameAt, envStarts } = await page.evaluate(() => {
    return {
      frameAt: (window as unknown as { __firstDraw: number | null }).__firstDraw ?? NaN,
      envStarts: performance
        .getEntriesByType('resource')
        .filter((r) => r.name.includes('/assets/worldstream/env/'))
        .map((r) => r.startTime),
    };
  });
  expect(Number.isFinite(frameAt)).toBe(true);
  expect(envStarts.length).toBeGreaterThan(0);
  for (const start of envStarts) expect(start).toBeGreaterThanOrEqual(frameAt);
});
