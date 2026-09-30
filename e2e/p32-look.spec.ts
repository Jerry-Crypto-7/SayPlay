import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { devices, expect, test, type APIRequestContext, type Page } from '@playwright/test';
import sharp from 'sharp';

import { openPause, startGame } from './play-start';

/**
 * Rig vzhledu (P32A). Scéna běžce se kreslí se stíny slunce a pod ACES
 * (sonda `__playRender`), a obraz se od snímku před rigem (`p32-split`,
 * P32-0 T5) opravdu liší – rig, který by nic nekreslil, by tu zčervenal.
 *
 * Snímek je deterministický stejně jako v `p32-split.spec.ts`: robot hraje do
 * prvního bodu, skrytá záložka hru pozastaví, na snímku je jen plátno.
 */

/** `THREE.NoToneMapping`: pod skládačem tónuje jeho efekt ACES (P32A T2). */
const NO_TONE_MAPPING = 0;

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
    // Skrytá rozehraná hra má od P34 kartu pauzy a tu pustí jen karta – jinak stisky robota propadnou.
    document.querySelector<HTMLButtonElement>('[data-testid="play-resume"]')?.click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
    const run = (window.__playShell as unknown as Hand).handPlay('score');
    showTab('hidden');
    return { score: run.score, tick: window.__playShell!.tick() };
  });
}

/** Podíl pixelů, které se liší o víc než šum komprese a vyhlazení (součet kanálů > 48). */
async function changedShare(a: Buffer, b: Buffer): Promise<number> {
  const right = await sharp(b).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  // Plátno má od P34 rámeček (1276 místo 1280 px): snímek se srovná na rozměr toho před rigem.
  const left = await sharp(a).resize(right.info.width, right.info.height, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
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
async function blueness(png: Buffer, from: number, to: number, left = 0, right = 1): Promise<number> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  let count = 0;
  for (let y = Math.floor(info.height * from); y < Math.floor(info.height * to); y += 1) {
    for (let x = Math.floor(info.width * left); x < Math.floor(info.width * right); x += 1) {
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
    await startGame(page);
    await page.waitForFunction(() => window.__playShell !== undefined && window.__playShell.tick() > 5 && window.__playRender !== undefined, undefined, { timeout: 60_000 });

    const render = await page.evaluate(() => window.__playRender!());
    expect(render.shadows, 'renderer.shadowMap.enabled').toBe(true);
    // Desktop drží high: AO, SMAA, bloom a ACES kreslí skládač (T2), renderer sám netónuje.
    await expect(page.getByTestId('arcade-stage')).toHaveAttribute('data-quality', 'high');
    expect(render.post, 'efekty postprocessingu').toEqual(['ao', 'smaa', 'bloom', 'aces']);
    expect(render.toneMapping, 'renderer.toneMapping pod skládačem').toBe(NO_TONE_MAPPING);

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
    // Jen prostřední třetina: od P34 je plátno 16:9 a do stran pásů sahají svahy údolí (T3).
    const top = await blueness(shot, 0, 0.04, 0.35, 0.65);
    const nearHorizon = await blueness(shot, 0.3, 0.34, 0.35, 0.65);
    expect(top - nearHorizon, `obloha nahoře (${top.toFixed(0)}) modřejší než u obzoru (${nearHorizon.toFixed(0)})`).toBeGreaterThan(20);
  });

  /**
   * Údolí běžce (T3): terén posunutý o 20 cm vypadá dobře, ale hráč pluje nebo se
   * boří. Sonda `__playGround` promítne patu těla i terén pod ní kamerou scény.
   * Hrdina skáče, proto platí nejmenší mezera za běh robota; překážky stojí.
   */
  test('runner: hero and obstacles stand on the valley', async ({ page, request }) => {
    test.setTimeout(120_000);
    await page.goto(await publish(request, 'runner'));
    // Hra stojí na tiku 0 pod „Tap to start“ (P33); ukázku pouští karta pauzy (P34).
    await page.waitForFunction(() => window.__playShell !== undefined && window.__playGround !== undefined, undefined, { timeout: 60_000 });
    await openPause(page);
    await page.getByTestId('play-demo-start').click();

    const hero: number[] = [];
    const grounded: number[] = [];
    for (let sample = 0; sample < 40; sample += 1) {
      const report = await page.evaluate(() => window.__playGround!());
      if (report.hero !== null) hero.push(report.hero.gap);
      // Laťka skluzu visí 1 m nad dráhou schválně; stojící překážka má patu na zemi.
      for (const obstacle of report.obstacles) if (obstacle.lift < 0.5) grounded.push(obstacle.gap);
      await page.waitForTimeout(100);
    }
    expect(hero.length, 'hrdina v záběru').toBeGreaterThan(20);
    expect(Math.min(...hero.map(Math.abs)), `nejmenší mezera hrdiny (px): ${hero.map((gap) => gap.toFixed(1)).join(' ')}`).toBeLessThanOrEqual(5);
    expect(grounded.length, 'stojící překážky v záběru').toBeGreaterThan(0);
    for (const gap of grounded) expect(Math.abs(gap), 'mezera překážky (px)').toBeLessThanOrEqual(5);
  });

  /**
   * T8-R1: po dohraném běhu stojí kamera u cíle. Hrdina na startu byl „za mlhou“,
   * skryl se a přestal se posouvat, takže ho kamera po restartu už nenašla.
   */
  test('runner: the hero is on screen right after a finished run restarts', async ({ page, request }) => {
    test.setTimeout(150_000);
    await page.goto(await publish(request, 'runner'));
    await page.waitForFunction(() => window.__playShell !== undefined && window.__playFrame !== undefined, undefined, { timeout: 60_000 });
    // Ukázka doběhne v reálném čase až do cíle (~25 s) a kamera s ní.
    await openPause(page);
    await page.getByTestId('play-demo-start').click();
    const yours = page.getByTestId('play-demo-yours');
    await expect(yours).toBeVisible({ timeout: 90_000 });
    await page.waitForTimeout(2_000);
    await yours.click();
    await page.waitForTimeout(1_000);
    const frame = await page.evaluate(() => window.__playFrame!());
    expect(frame.hero, 'hrdina v záběru po restartu').not.toBeNull();
  });
});

/** Snímků za sekundu po celých sekundách (rAF), `seconds` dlouho. */
function sampleFps(page: Page, seconds: number): Promise<number[]> {
  return page.evaluate(
    (span) =>
      new Promise<number[]>((resolve) => {
        const samples: number[] = [];
        let frames = 0;
        let from = performance.now();
        const end = from + span * 1000;
        const frame = (now: number): void => {
          frames += 1;
          if (now - from >= 1000) {
            samples.push((frames * 1000) / (now - from));
            frames = 0;
            from = now;
          }
          if (now < end) requestAnimationFrame(frame);
          else resolve(samples);
        };
        requestAnimationFrame(frame);
      }),
    seconds,
  );
}

const median = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

// Bez `defaultBrowserType`: ten ve skupině testů Playwright nepovolí (vynutil by nový worker).
const { defaultBrowserType: _browser, ...PIXEL_7 } = devices['Pixel 7'];

test.describe('Pixel 7, CPU 4× slower', () => {
  test.use(PIXEL_7);

  /**
   * Postprocessing a úrovně kvality (T2): běžec drží medián 30 FPS po 20 s
   * hry robota a úroveň hlásí sonda. Po konci běhu kreslí plátno jen na
   * požádání – robot proto hraje pořád znovu (postup `scripts/p32/shots.mjs`).
   */
  test('runner holds 30 FPS with post-processing and reports its quality tier', async ({ page, request, context }) => {
    test.setTimeout(180_000);
    const url = await publish(request, 'runner');
    await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto(url);
    const stage = page.getByTestId('arcade-stage');
    await expect(stage).toHaveAttribute('data-quality', /^(high|medium|low)$/, { timeout: 60_000 });
    await page.waitForFunction(() => window.__playShell !== undefined && window.__playRender !== undefined, undefined, { timeout: 60_000 });

    const press = (id: string): Promise<boolean> =>
      page.evaluate((testId) => {
        const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
        button?.click();
        return button !== null;
      }, id);
    const sampling = sampleFps(page, 20);
    const end = Date.now() + 20_000;
    while (Date.now() < end) {
      // „Show me how“ je od P34 na kartě pauzy; bez ukázky hra stojí na tiku 0 a FPS by měřily prázdné rAF.
      if (!(await press('play-demo-start'))) if (!(await press('play-demo-yours'))) if (!(await press('play-again'))) await press('play-pause');
      await page.waitForTimeout(500);
    }
    const samples = await sampling;
    const tier = await stage.getAttribute('data-quality');
    test.info().annotations.push({ type: 'fps', description: `median ${median(samples).toFixed(1)}, tier ${String(tier)}, samples ${samples.map((fps) => fps.toFixed(0)).join(' ')}` });
    expect(samples.length).toBeGreaterThanOrEqual(15);
    expect(median(samples), `medián FPS (úroveň ${String(tier)})`).toBeGreaterThanOrEqual(30);
  });
});
