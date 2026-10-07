import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import sharp from 'sharp';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Panorama prostředí za každou hrou (P29C T5). Plátno nese `data-env` (id
 * panoramatu na obrazovce); pás oblohy nahoře nesmí být jedna plochá barva,
 * kterou hra kreslila dřív.
 * Panorama se stahuje až po prvním snímku, takže první obraz nečeká na obrázek.
 *
 * Jen mřížka (P32A T6): arkádové hry fotopanorama nekreslí – obloha je rigu
 * vzhledu a prostředí z věty vybírá paletu a kulisy (bez sítě to hlídá
 * `p32-look.spec.ts`). `/studio` má panoramata svého světa mimo tenhle soubor.
 */

const GRID_FIXTURE = join(process.cwd(), 'src/play/__fixtures__/collect_exit.json');

// Věta mřížku nedá: od žánrů (P32B) jde každá nová věta do arkády. Mřížka žije jen v uložených hrách, proto fixtura.
const GAMES: readonly { name: string; fixture?: string; sentence?: string; setting?: string; testId: string }[] = [
  { name: 'grid', fixture: GRID_FIXTURE, testId: 'play-grid-stage' },
];

async function publish(request: APIRequestContext, game: (typeof GAMES)[number]): Promise<string> {
  let data: unknown;
  if (game.fixture !== undefined) {
    const base = JSON.parse(readFileSync(game.fixture, 'utf8')) as { theme: Record<string, unknown> } & Record<string, unknown>;
    data = { spec: game.setting === undefined ? base : { ...base, theme: { ...base.theme, setting: game.setting } } };
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
  const canvas = page.getByTestId(GAMES[0].testId).locator('canvas').first();
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

/**
 * Vlastní panorama pro prostředí, které knihovna nezná (P29C T7). Stub služby
 * `ops/env/server.py` běží tady v testu; server hry ho musí znát:
 *
 *   PLAY_ENV_ENDPOINT=http://127.0.0.1:3295 PLAY_ENV_KEY=e2e-env-key node node_modules/next/dist/bin/next start -p 3293
 *
 * Úloha je hotová až na druhý dotaz, takže hra nejdřív ukáže knihovní
 * panorama a pak ho bez přenačtení vymění. Běh robota před výměnou a po ní
 * musí skončit stejně – prostředí je jen obraz.
 */
const STUB_PORT = Number(process.env.E2E_ENV_STUB_PORT ?? 3295);
const STUB_KEY = 'e2e-env-key';
const CUSTOM_SETTING = 'inside a giant cuckoo clock';

test.describe('custom panorama', () => {
  let stub: Server;
  let jobReads = 0;
  let wrongKey = 0;

  test.beforeAll(async () => {
    const image = readFileSync(join(process.cwd(), 'public/assets/worldstream/env/desert-1.webp'));
    const low = readFileSync(join(process.cwd(), 'public/assets/worldstream/env/desert-1-low.webp'));
    stub = createServer((request, response) => {
      if (request.headers['x-env-key'] !== STUB_KEY) {
        wrongKey += 1;
        response.writeHead(401).end();
        return;
      }
      const send = (body: unknown) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (request.url === '/panorama') return send({ jobId: 'e2e0001' });
      if (request.url === '/jobs/e2e0001') {
        jobReads += 1;
        if (jobReads < 2) return send({ jobId: 'e2e0001', setting: CUSTOM_SETTING, status: 'running' });
        return send({ jobId: 'e2e0001', setting: CUSTOM_SETTING, status: 'done', id: 'cuckoo-clock', file: 'cuckoo-clock.webp', low: 'cuckoo-clock-low.webp', horizon: '#886644' });
      }
      if (request.url === '/files/cuckoo-clock.webp' || request.url === '/files/cuckoo-clock-low.webp') {
        response.writeHead(200, { 'content-type': 'image/webp' }).end(request.url.endsWith('-low.webp') ? low : image);
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => stub.listen(STUB_PORT, '127.0.0.1', resolve));
  });

  test.afterAll(async () => {
    await new Promise((resolve) => stub.close(resolve));
  });

  test('an unseen setting swaps in its own panorama without reloading, and the run stays the same', async ({ page, request }) => {
    test.setTimeout(120_000);
    const url = await publish(request, { name: 'custom', fixture: GRID_FIXTURE, setting: CUSTOM_SETTING, testId: 'play-grid-stage' });
    await page.goto(url);
    const canvas = page.getByTestId('play-grid-stage').locator('canvas').first();
    await expect(canvas).toHaveAttribute('data-env', /.+/, { timeout: 60_000 });
    const library = await canvas.getAttribute('data-env');
    expect(library).not.toMatch(/^custom-/);
    // Značka v okně přežije jen tehdy, když se stránka nepřenačte.
    await page.evaluate(() => ((window as unknown as { __sameDocument: boolean }).__sameDocument = true));
    const before = await page.evaluate(() => window.__playShell!.playWitness());

    await expect(canvas).toHaveAttribute('data-env', 'custom-cuckoo-clock', { timeout: 60_000 });
    await page.waitForFunction(() => performance.getEntriesByType('resource').some((r) => r.name.includes('/env?file=full')), undefined, { timeout: 30_000 });
    expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true);
    const after = await page.evaluate(() => window.__playShell!.playWitness());
    // Svědek mřížky je stavový: podruhé nemá co přehrát (`last` je null), vrátí jen konec téhož běhu.
    expect({ runState: after.runState, tick: after.tick }).toEqual({ runState: before.runState, tick: before.tick });
    expect(wrongKey).toBe(0);
    await page.waitForTimeout(500);
    await page.getByTestId('play-grid-stage').screenshot({ path: test.info().outputPath('custom-cuckoo-clock.png') });
    expect(await skyDominantShare(page, 'play-grid-stage')).toBeLessThan(SKY_DOMINANT_MAX);
  });
});

/** P41 T30: six independent sentences, frozen anonymous frames for the blind judge. */
const P41_ENV_CASES = [
  { id: '01', sentence: 'Drive a car to the finish through a desert.', control: 'steer', environment: 'desert', aliases: ['desert', 'sandy desert', 'dunes', 'sand dunes'] },
  { id: '02', sentence: 'Drive a car to the finish through a city at night.', control: 'steer', environment: 'city', aliases: ['city', 'urban', 'city at night', 'night city', 'urban street'] },
  { id: '03', sentence: 'Swim a submarine through rings underwater.', control: 'glide', environment: 'underwater', aliases: ['underwater', 'underwater ocean', 'ocean', 'undersea', 'ocean floor', 'coral reef'] },
  { id: '04', sentence: 'Fly a spaceship through rings in outer space.', control: 'glide', environment: 'space', aliases: ['space', 'outer space', 'cosmos', 'deep space', 'starfield'] },
  { id: '05', sentence: 'Walk through a forest maze to the exit.', control: 'walker', environment: 'forest', aliases: ['forest', 'woods', 'woodland', 'woodlands'] },
  { id: '06', sentence: 'Play football and score goals in a snowy field.', control: 'ball', environment: 'snow', aliases: ['snow', 'snowy field', 'snowy landscape', 'snowfield', 'winter', 'ice', 'icy landscape'] },
] as const;

test('P41 six environments produce anonymous frames across four native movements', async ({ page, request }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const { existsSync, mkdirSync, unlinkSync, writeFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const out = join(process.cwd(), 'evals/play/p41/env');
  mkdirSync(out, { recursive: true });
  const manifestPath = join(out, 'manifest.json');
  if (existsSync(manifestPath)) unlinkSync(manifestPath);
  const frames: Record<string, unknown>[] = [];
  for (const entry of P41_ENV_CASES) {
    const response = await request.post('/api/play/games', { data: { sentence: entry.sentence, seed: 41 } });
    expect(response.ok(), await response.text()).toBe(true);
    const published = await response.json() as { versionId: string; url: string };
    const storedResponse = await request.get(`/api/play/games/${published.versionId}`);
    expect(storedResponse.ok()).toBe(true);
    const stored = await storedResponse.json() as { spec: { control: string; theme: unknown }; arcade: unknown };
    expect(stored.spec.control, entry.sentence).toBe(entry.control);
    expect(stored.arcade).toBeDefined();
    await page.goto(published.url);
    await page.waitForFunction(() => window.__playShell !== undefined && window.__playRender !== undefined && window.__playRender().calls > 0, undefined, { timeout: 60_000 });
    await page.waitForFunction(() => (window.__playShell as unknown as { physicsReady(): boolean }).physicsReady(), undefined, { timeout: 30_000 });
    await page.evaluate(() => {
      const probe = window.__playShell as unknown as {
        byHand(on: boolean): void; start(): void; botWants(): { axis: number; buttons: number };
        hold(axis: number): void; press(buttons: number): void; tickByHand(): unknown;
      };
      probe.byHand(true);
      probe.start();
      for (let tick = 0; tick < 60; tick++) {
        const input = probe.botWants();
        probe.hold(input.axis);
        probe.press(input.buttons);
        probe.tickByHand();
      }
    });
    // Text/UI must not tell the judge the scene's name; capture WebGL only.
    await page.addStyleTag({ content: 'body * { visibility: hidden !important; } [data-testid="arcade-stage"] canvas { visibility: visible !important; }' });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const canvas = page.locator('[data-testid="arcade-stage"] canvas').first();
    const file = `${entry.id}.png`;
    const image = await sharp(await canvas.screenshot()).png().toBuffer();
    writeFileSync(join(out, file), image);
    frames.push({ ...entry, file, sha256: createHash('sha256').update(image).digest('hex'), versionId: published.versionId, seed: 41, tick: await page.evaluate(() => window.__playShell!.tick()), theme: stored.spec.theme });
  }
  // Ground truth never enters any blind judge's cwd or prompt.
  writeFileSync(join(out, 'manifest.json'), JSON.stringify({ schema: 'p41.env-capture.v1', capturedAt: new Date().toISOString(), viewport: { width: 1280, height: 800 }, frames }, null, 2));
});
