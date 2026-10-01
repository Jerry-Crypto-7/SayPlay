import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type APIRequestContext, devices, expect, type Page, test } from '@playwright/test';
import sharp from 'sharp';

import { compileGenre, readGenreSpec } from '../src/play/genre/index';
import { voyageGenre } from '../src/play/genre/voyage';
import type { GameSpecV1 } from '../src/play/spec';

/**
 * Plavba ve stylu B (P32F T4). Tři věty z přijímací sady – pirát (závod mezi
 * ostrovy), raketa (přistání na Marsu) a pes (město) – na desktopu 1280×720
 * a na Pixel 7 se 4× pomalejším CPU: snímek na startu, uprostřed a po konci
 * do `evals/play/p32/voyage/`. Snímky posuzuje autor; test hlídá, co jde změřit:
 * třídu pohybu hrdiny a vodu v záběru u piráta, výhru přistání botem, FPS
 * a žádnou fialovou.
 */

const SENTENCES = (JSON.parse(readFileSync(join(process.cwd(), 'evals/play/p32/sentences.json'), 'utf8')) as { sentences: { id: string; text: string }[] }).sentences;
const sentence = (id: string): string => SENTENCES.find((entry) => entry.id === id)!.text;

const GAMES = [
  { id: 'pirate', motion: 'boat' },
  { id: 'rocket', motion: 'lander' },
  { id: 'dog', motion: 'vehicle' },
] as const;

/** Rychlá verze: věta → `draftFill` modulu Plavby bez modelu → `compileGenre` → `GameSpecV1`. */
function gameSpecOf(id: string): GameSpecV1 {
  const read = readGenreSpec(voyageGenre.draftFill(sentence(id), null));
  if (!read.ok) throw new Error(read.issues.join('; '));
  return compileGenre(read.value);
}

async function publish(request: APIRequestContext, id: string): Promise<string> {
  const response = await request.post('/api/play/games', { data: { spec: gameSpecOf(id) } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

const SHOTS = join(process.cwd(), 'evals/play/p32/voyage');

/** Nad plátnem nic: HUD a „+1“ se mění jinak než scéna (jako `p32-penguin`). */
const ONLY_CANVAS = 'body * { visibility: hidden !important; } [data-testid="arcade-stage"] canvas { visibility: visible !important; }';

/** Tvar arkádové sondy `__playShell` (`ArcadePlay.tsx`); globální typ je mřížkový. */
type ArcadeProbe = {
  readonly tick: () => number;
  readonly playWitness: () => { readonly runState: string; readonly tick: number };
  readonly handPlay: (until: 'score' | 'end') => { readonly runState: string; readonly tick: number };
};

const press = (page: Page, id: string): Promise<boolean> =>
  page.evaluate((testId) => {
    const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    button?.click();
    return button !== null;
  }, id);

/** Další krok k „Show me how“: vlastní hra po ukázce, znovu po konci, jinak karta pauzy (od P34 je tlačítko na ní). */
async function towardDemo(page: Page): Promise<void> {
  if (!(await press(page, 'play-demo-yours')) && !(await press(page, 'play-replay'))) await press(page, 'play-pause');
}

/** „Show me how“ od tiku 0 (postup `p32-penguin`). */
async function startDemo(page: Page): Promise<void> {
  if (await press(page, 'play-demo-stop')) await page.locator('[data-testid="play-demo"]').waitFor({ state: 'detached' });
  const deadline = Date.now() + 15_000;
  while (!(await press(page, 'play-demo-start'))) {
    expect(Date.now(), 'tlačítko „Show me how“').toBeLessThan(deadline);
    await towardDemo(page);
    await page.waitForTimeout(200);
  }
}

/** Hra běží do tiku `at`, pak ji zastaví skrytá záložka – obraz stojí. */
function freezeAt(page: Page, at: number): Promise<number> {
  return page.evaluate(
    (target) =>
      new Promise<number>((resolve) => {
        const showTab = (state: 'visible' | 'hidden'): void => {
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
          document.dispatchEvent(new Event('visibilitychange'));
        };
        showTab('visible');
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
        const wait = (): void => {
          const tick = (window.__playShell as unknown as ArcadeProbe).tick();
          if (tick < target) {
            requestAnimationFrame(wait);
            return;
          }
          showTab('hidden');
          resolve(tick);
        };
        requestAnimationFrame(wait);
      }),
    at,
  );
}

/** Hra běží, dokud scéna nehlásí blízkou kouli v záběru, a v tom samém snímku ji zastaví skrytá záložka. */
function freezeOnShot(page: Page, timeout: number): Promise<boolean> {
  return page.evaluate(
    (limit) =>
      new Promise<boolean>((resolve) => {
        const showTab = (state: 'visible' | 'hidden'): void => {
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
          document.dispatchEvent(new Event('visibilitychange'));
        };
        const stage = document.querySelector<HTMLElement>('[data-testid="arcade-stage"]');
        const until = performance.now() + limit;
        const wait = (): void => {
          const seen = Number(stage?.dataset.shotsInView ?? 0) > 0;
          if (!seen && performance.now() < until) {
            requestAnimationFrame(wait);
            return;
          }
          showTab('hidden');
          resolve(seen);
        };
        requestAnimationFrame(wait);
      }),
    timeout,
  );
}

/** Robot dohraje „rukou“ – lidský běh, sběrnice efektů vydá i výhru. */
function playToEnd(page: Page): Promise<{ readonly runState: string; readonly tick: number }> {
  return page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
    return (window.__playShell as unknown as ArcadeProbe).handPlay('end');
  });
}

/** Fialová (`rules/design-output.md`): odstín 250–320°, HSV S ≥ 0,25 a V ≥ 0,2 – podíl pixelů snímku. */
async function purpleShare(png: Buffer): Promise<number> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let purple = 0;
  for (let at = 0; at < info.width * info.height * 3; at += 3) {
    const [r, g, b] = [data[at]! / 255, data[at + 1]! / 255, data[at + 2]! / 255];
    const max = Math.max(r, g, b);
    const span = max - Math.min(r, g, b);
    if (max < 0.2 || span / max < 0.25) continue;
    const hue = max === r ? (60 * ((g - b) / span) + 360) % 360 : max === g ? 60 * ((b - r) / span) + 120 : 60 * ((r - g) / span) + 240;
    if (hue >= 250 && hue <= 320) purple += 1;
  }
  return purple / (info.width * info.height);
}

async function shoot(page: Page, name: string): Promise<void> {
  const path = join(SHOTS, `${name}.png`);
  const png = await page.locator('[data-testid="arcade-stage"] canvas').first().screenshot({ path, scale: 'css' });
  expect(existsSync(path), `${name}: snímek na disku`).toBe(true);
  expect(await purpleShare(png), `${name}: podíl fialových pixelů`).toBeLessThan(0.001);
}

/** Hra načtená, scéna Plavby našla relaci (třída hrdiny v DOM), modely stažené. */
async function openGame(page: Page, url: string, motion: string): Promise<void> {
  await page.goto(url);
  // Závod čeká na „Tap to start“ (jako `play-steer`).
  await page.waitForFunction(() => window.__playShell !== undefined && window.__playFx !== undefined, undefined, { timeout: 60_000 });
  await page.evaluate(() => window.__playShell!.start());
  await page.waitForFunction(() => window.__playShell!.tick() > 5, undefined, { timeout: 30_000 });
  const stage = page.getByTestId('arcade-stage');
  await expect(stage).toHaveAttribute('data-control', 'steer');
  await expect(stage, 'třída pohybu hrdiny').toHaveAttribute('data-hero-class', motion, { timeout: 15_000 });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
}

/** Start, polovina jízdy (ukázka robota) a konec (robot „rukou“); vrací výsledek konce. */
async function shootRun(page: Page, prefix: string): Promise<string> {
  mkdirSync(SHOTS, { recursive: true });
  await page.addStyleTag({ content: ONLY_CANVAS });
  const bot = await page.evaluate(() => (window.__playShell as unknown as ArcadeProbe).playWitness());
  expect(bot.runState, 'záznam robota vyhraje').toBe('won');
  await startDemo(page);
  await freezeAt(page, 30);
  await page.waitForTimeout(800);
  await shoot(page, `${prefix}-start`);
  await freezeAt(page, Math.round(bot.tick / 2));
  await page.waitForTimeout(800);
  await shoot(page, `${prefix}-mid`);
  await freezeAt(page, Math.max(31, bot.tick - 30));
  const end = await playToEnd(page);
  await page.waitForTimeout(500);
  await shoot(page, `${prefix}-end`);
  return end.runState;
}

/** Co jde změřit: pirát pluje po vodě, raketa přistane botem a sběrnice vydá výhru. */
async function checkGame(page: Page, id: string, prefix: string): Promise<void> {
  if (id === 'pirate') {
    const stage = page.getByTestId('arcade-stage');
    await expect(stage, 'voda v záběru pod hrdinou').toHaveAttribute('data-water-in-view', /^[1-3]$/, { timeout: 10_000 });
    // Dělová koule se stopou: ukázka robota, dokud nějaká blízká nevletí do záběru, pak hned stop a snímek.
    await startDemo(page);
    expect(await freezeOnShot(page, 30_000), 'dělová koule blízko v záběru').toBe(true);
    await page.waitForTimeout(500);
    mkdirSync(SHOTS, { recursive: true });
    await page.addStyleTag({ content: ONLY_CANVAS });
    await shoot(page, `${prefix}-cannon`);
  }
  const end = await shootRun(page, prefix);
  expect(end, 'robot „rukou“ dojede').toBe('won');
  if (id === 'rocket') expect((await page.evaluate(() => window.__playFx!())).win ?? 0, 'přistání vydalo win').toBeGreaterThan(0);
}

test.describe('voyage, desktop 1280×720', () => {
  test.use({ viewport: { width: 1280, height: 720 } });
  for (const game of GAMES)
    test(`${game.id}: ${game.motion} hero, start, mid and end shots`, async ({ page, request }) => {
      test.setTimeout(180_000);
      await openGame(page, await publish(request, game.id), game.motion);
      await checkGame(page, game.id, `${game.id}-desktop`);
    });
});

/** Snímků za sekundu po celých sekundách (rAF), `seconds` dlouho (z `p32-penguin`). */
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

const { defaultBrowserType: _browser, ...PIXEL_7 } = devices['Pixel 7'];

test.describe('voyage, Pixel 7 with CPU 4× slower', () => {
  test.use(PIXEL_7);
  /** Medián FPS po 20 s ukázek robota, pak snímky ve stejném zpomalení (postup `p32-penguin`). */
  for (const game of GAMES)
    test(`${game.id}: holds 30 FPS, then start, mid and end shots`, async ({ page, request, context }) => {
      test.setTimeout(300_000);
      const url = await publish(request, game.id);
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await openGame(page, url, game.motion);
      const stage = page.getByTestId('arcade-stage');
      await expect(stage).toHaveAttribute('data-quality', /^(high|medium|low)$/, { timeout: 60_000 });
      // Zahřátí: první vteřiny po startu dotahují modely a shadery (1–3 FPS) a úroveň kvality
      // se volí až po 3 s pod 40 FPS – měří se hraní, ne načítání.
      await startDemo(page);
      await page.waitForTimeout(5_000);
      const sampling = sampleFps(page, 20);
      const until = Date.now() + 20_000;
      while (Date.now() < until) {
        if (!(await press(page, 'play-demo-start'))) await towardDemo(page);
        await page.waitForTimeout(500);
      }
      const samples = await sampling;
      const tier = await stage.getAttribute('data-quality');
      const fps = `medián ${median(samples).toFixed(1)} FPS, úroveň ${String(tier)}, vzorky ${samples.map((value) => value.toFixed(0)).join(' ')}`;
      test.info().annotations.push({ type: 'fps', description: fps });
      console.log(`${game.id}-pixel7: ${fps}`);
      expect(samples.length).toBeGreaterThanOrEqual(15);
      expect(median(samples), `medián FPS (úroveň ${String(tier)})`).toBeGreaterThanOrEqual(30);

      await openGame(page, url, game.motion);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await checkGame(page, game.id, `${game.id}-pixel7`);
    });
});

// ---------------------------------------------------------------------------
// Hrdina plavby dost velký (P35 T7)

/**
 * V přejímce kola 1 byl pes hnědá kostička na silnici (~4 % výšky obrazu)
 * a pirátská loď „tiny dark boat“ – astra je naslepo nepoznala. Kolik výšky
 * obrazu hrdina zabírá aspoň, stejně jako aréna (`p32-arena`, P35 T2).
 */
const HERO_SHARE = { desktop: 0.07, phone: 0.09 } as const;

/** Kolik sekund trati před hrdinou při plné rychlosti hráč vidí aspoň (`data-ahead-s`, `SteerScene.tsx`). */
const AHEAD_S = 2;

const T7_SHOTS = join(process.cwd(), 'evals/play/p35/T7');

/** Podíl výšky obrazu, který hrdina zabírá, a sekundy trati v záběru; snímek plátna do `evals/play/p35/T7/`. */
async function measureFrame(page: Page, name: string): Promise<{ readonly share: number; readonly ahead: number }> {
  const frame = await page.evaluate(() => window.__playFrame!());
  expect(frame.hero, `${name}: hrdina v záběru`).not.toBeNull();
  expect(frame.hero!.behind, `${name}: hrdina před kamerou`).toBe(false);
  const ahead = Number((await page.getByTestId('arcade-stage').getAttribute('data-ahead-s')) ?? 'NaN');
  mkdirSync(T7_SHOTS, { recursive: true });
  await page.locator('[data-testid="arcade-stage"] canvas').first().screenshot({ path: join(T7_SHOTS, `${name}.png`), scale: 'css' });
  const share = frame.hero!.heightPx / frame.height;
  const line = `${name}: hrdina ${(share * 100).toFixed(1)} % výšky (${frame.hero!.widthPx.toFixed(0)}×${frame.hero!.heightPx.toFixed(0)} px), trať v záběru ${ahead.toFixed(1)} s plnou rychlostí`;
  test.info().annotations.push({ type: 'frame', description: line });
  console.log(line);
  return { share, ahead };
}

/**
 * Hrdina na tiku 0 stojí 1,5 s na místě (±0,01 NDC – loď se houpe na vlně) – modely
 * dotažené, úvodní průlet kamery doběhl. Nejdéle 30 s.
 */
async function settledStart(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => window.__playFrame?.().hero != null, undefined, { timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
  let last = '';
  let since = Date.now();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const hero = await page.evaluate(() => window.__playFrame!().hero);
    const key = hero === null ? '' : [hero.minX, hero.maxX, hero.minY, hero.maxY].map((v) => v.toFixed(2)).join(' ');
    if (key !== last) {
      last = key;
      since = Date.now();
    } else if (Date.now() - since >= 1500) return;
    await page.waitForTimeout(250);
  }
}

for (const [device, use, minShare] of [
  ['phone', PIXEL_7, HERO_SHARE.phone],
  ['desktop', { viewport: { width: 1280, height: 720 } }, HERO_SHARE.desktop],
] as const) {
  test.describe(`voyage hero framing, ${device}`, () => {
    test.use(use);
    for (const id of ['dog', 'pirate'] as const)
      test(`${id}: hero big enough to recognise, 2 s of course in view`, async ({ page, request }) => {
        test.setTimeout(180_000);
        await settledStart(page, await publish(request, id));
        await page.addStyleTag({ content: ONLY_CANVAS });
        // Start: tak hru fotí přejímka. Jízda: ukázka robota v plné rychlosti, zastavená skrytou záložkou.
        const start = await measureFrame(page, `${id}-${device}-start`);
        const bot = await page.evaluate(() => (window.__playShell as unknown as ArcadeProbe).playWitness());
        await startDemo(page);
        await freezeAt(page, Math.round(bot.tick / 2));
        await page.waitForTimeout(800);
        const run = await measureFrame(page, `${id}-${device}-run`);
        for (const [moment, frame] of [['start', start], ['run', run]] as const) {
          expect(frame.share, `${moment}: podíl výšky obrazu, který hrdina zabírá`).toBeGreaterThanOrEqual(minShare);
          expect(frame.ahead, `${moment}: sekundy trati před hrdinou v záběru`).toBeGreaterThanOrEqual(AHEAD_S);
        }
      });
  });
}
