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

/**
 * Jak moc je pás řádků obrazu (podíl výšky od–do) modrý: průměr B − R. Kreslená
 * obloha má nahoře zenit sady, u obzoru světlý obzor; plochá barva pozadí má obojí stejné.
 */
async function blueness(png: Buffer, from: number, to: number): Promise<number> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  let count = 0;
  for (let y = Math.floor(info.height * from); y < Math.floor(info.height * to); y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const at = (y * info.width + x) * 3;
      sum += data[at + 2]! - data[at]!;
      count += 1;
    }
  }
  return sum / count;
}

/** Fotopanorama knihovny a předpečené prostředí (P29C, P30A). */
const PANORAMA = /\/(assets\/worldstream\/env|play\/env)\/[^?]*\.webp/;

/**
 * Arkáda fotopanorama nestahuje (P32A T6): prostředí z věty vybírá paletu
 * a kulisy. Nastavení, pro která knihovna panorama má, ať by se stahovalo.
 */
for (const [fixture, setting] of [
  ['runner', 'a snowy forest'],
  ['timing', 'a glacier'],
] as const) {
  test(`${fixture} in "${setting}" fetches no photo panorama`, async ({ page, request }) => {
    test.setTimeout(120_000);
    const base = JSON.parse(readFileSync(join(process.cwd(), 'src/play/arcade/__fixtures__', `${fixture}.json`), 'utf8')) as { theme: Record<string, unknown> } & Record<string, unknown>;
    const response = await request.post('/api/play/games', { data: { spec: { ...base, theme: { ...base.theme, setting } } } });
    expect(response.status(), await response.text()).toBeLessThan(300);
    const requested: string[] = [];
    page.on('request', (sent) => requested.push(sent.url()));
    await page.goto(((await response.json()) as { url: string }).url);
    // Časovka bez ťuku netiká: stačí, že hra běží a síť se uklidní (panorama šlo až po prvním snímku).
    await page.waitForFunction(() => window.__playShell !== undefined && window.__playRender !== undefined && window.__playRender().calls > 0, undefined, { timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(2_000);
    expect(requested.length, 'síťový log něco zachytil').toBeGreaterThan(0);
    expect(requested.filter((url) => PANORAMA.test(url))).toEqual([]);
  });
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
    const shot = await canvas.screenshot({ path: test.info().outputPath('runner-desktop.png') });
    const share = await changedShare(shot, before);
    expect(share, 'podíl pixelů, které rig změnil proti snímku před ním').toBeGreaterThan(0.05);
    // Louka: zenit #3a86d8 nahoře, obzor #d7ecf8 těsně nad zemí (obzor je v ~40 % výšky).
    // Naměřeno 29. 9.: kreslená obloha 37 (záře slunce horní pás zesvětlí), plochá barva pozadí 7.
    const top = await blueness(shot, 0, 0.04);
    const nearHorizon = await blueness(shot, 0.3, 0.34);
    expect(top - nearHorizon, `obloha nahoře (${top.toFixed(0)}) modřejší než u obzoru (${nearHorizon.toFixed(0)})`).toBeGreaterThan(20);
  });
});
