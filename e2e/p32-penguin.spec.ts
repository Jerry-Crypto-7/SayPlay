import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type APIRequestContext, devices, expect, type Page, test } from '@playwright/test';
import sharp from 'sharp';

import type { FrameBox } from '../src/components/play/arcade/ArcadeStage';
import penguinAi from '../src/play/genre/__fixtures__/penguin.json';
import { compileGenre, readGenreSpec } from '../src/play/genre/index';
import { runnerGenre } from '../src/play/genre/runner';
import type { GameSpecV1 } from '../src/play/spec';

import { startGame } from './play-start';

/**
 * Tučňák běžce (P32A). T5: hrdina se hýbe jako postava – po stisku úhybu se
 * do 150 ms nakloní (sonda pózy `__playHero`), jede v póze jízdy a po skoku
 * a dopadu vydá sběrnice efektů `land` (sonda `__playFx`).
 *
 * T8: referenční řez. Věta tučňáka ve dvou verzích (rychlá bez modelu a AI
 * z fixtury), každá na desktopu 1280×720 a na Pixel 7 se 4× pomalejším CPU:
 * snímek na startu, uprostřed běhu a po výhře do `evals/play/p32/penguin/`.
 * Snímky posuzuje autor proti ukázce B (tamní README); test hlídá jen to,
 * co jde změřit – výhru, FPS, stín slunce a žádnou fialovou.
 */

async function publishSpec(request: APIRequestContext, spec: unknown): Promise<string> {
  const response = await request.post('/api/play/games', { data: { spec } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

async function publishPenguin(request: APIRequestContext): Promise<string> {
  const base = JSON.parse(readFileSync(join(process.cwd(), 'src/play/arcade/__fixtures__/runner.json'), 'utf8')) as {
    theme: Record<string, unknown>;
    roles: { id: string; label: string }[];
  } & Record<string, unknown>;
  return publishSpec(request, {
    ...base,
    title: 'Penguin Run',
    theme: { ...base.theme, setting: 'icy mountain slope' },
    roles: base.roles.map((role) => (role.id === 'player' ? { ...role, label: 'penguin' } : role)),
  });
}

test('penguin: leans into a dodge within 150 ms, rides tilted forward and lands with a land event', async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.goto(await publishPenguin(request));
  await startGame(page);
  await page.waitForFunction(
    () => window.__playShell !== undefined && window.__playHero?.() != null && window.__playFx !== undefined && window.__playShell.tick() > 5,
    undefined,
    { timeout: 60_000 },
  );

  const start = await page.evaluate(() => window.__playHero!()!);
  expect(start.ride, 'tučňák klouže na břiše').toBe('lie');
  expect(start.pitch, 'předklon jízdy (°)').toBeGreaterThan(45);
  expect(start.shadow, 'kontaktní stín pod hrdinou').toBeGreaterThan(0);

  // Úhyb doprava a měření v téže stránce po snímcích: zpáteční cesta testu by 150 ms snědla.
  // Stisk až po deseti plynulých snímcích – první snímky hry zdrží načítání modelu a shaderů.
  const lean = await page.evaluate(
    () =>
      new Promise<{ ms: number; roll: number }>((resolve) => {
        let smooth = 0;
        let last = performance.now();
        const measure = (from: number): void => {
          const roll = window.__playHero!()!.roll;
          const ms = performance.now() - from;
          if (roll > 5 || ms > 500) resolve({ ms, roll });
          else requestAnimationFrame(() => measure(from));
        };
        const settle = (now: number): void => {
          smooth = now - last < 40 ? smooth + 1 : 0;
          last = now;
          if (smooth < 10) {
            requestAnimationFrame(settle);
            return;
          }
          const from = performance.now();
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
          requestAnimationFrame(() => measure(from));
        };
        requestAnimationFrame(settle);
      }),
  );
  expect(lean.roll, 'náklon doprava (°)').toBeGreaterThan(5);
  expect(lean.ms, `náklon ${lean.roll.toFixed(1)}° po ${lean.ms.toFixed(0)} ms`).toBeLessThanOrEqual(150);

  expect((await page.evaluate(() => window.__playFx!())).land ?? 0, 'před skokem žádný dopad').toBe(0);
  // `cancelable` jako skutečná klávesa: mezerník, který hra nezruší, je od P34 pauza (`useHudKeys`).
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', cancelable: true })));
  await page.waitForFunction(() => (window.__playFx!().land ?? 0) > 0, undefined, { timeout: 5_000 });
});

// ---------------------------------------------------------------------------
// T8: snímky řezu

/** Referenční věta z přijímací sady P32. */
const PENGUIN_SENTENCE = (
  JSON.parse(readFileSync(join(process.cwd(), 'evals/play/p32/sentences.json'), 'utf8')) as { sentences: { id: string; text: string }[] }
).sentences.find((sentence) => sentence.id === 'penguin')!.text;

/**
 * Rychlá verze: věta → `draftFill` modulu běžce bez čtení modelem. Dokud stopa B
 * nepřepojí návrh ze slov na žánry, skládá ji test sám stejnými funkcemi.
 * AI verze: `penguin.json` – `GenreSpec`, jaký napíše model. Obě jdou přes
 * `compileGenre` na `GameSpecV1`, který se publikuje jako každá jiná hra.
 */
const VERSIONS = [
  { id: 'quick', genre: runnerGenre.draftFill(PENGUIN_SENTENCE, null) },
  { id: 'ai', genre: penguinAi },
] as const;

function gameSpecOf(genre: unknown): GameSpecV1 {
  const read = readGenreSpec(genre);
  if (!read.ok) throw new Error(read.issues.join('; '));
  return compileGenre(read.value);
}

/** T5-R1: sloveso jízdy z věty dojde přes `theme.motion` až do pózy hrdiny, který není pták. */
test('a sentence that skis puts a non-bird hero in the riding pose', async ({ page, request }) => {
  test.setTimeout(120_000);
  const spec = gameSpecOf(runnerGenre.draftFill('A girl skis down a snowy mountain and avoids trees', null));
  expect(spec.theme.motion).toBe('ride');
  await page.goto(await publishSpec(request, spec));
  await page.waitForFunction(() => window.__playHero?.() != null, undefined, { timeout: 60_000 });
  const pose = await page.waitForFunction(() => {
    const hero = window.__playHero!()!;
    return hero.ride === 'board' && hero.pitch > 20 ? hero : null;
  }, undefined, { timeout: 10_000 }).then((handle) => handle.jsonValue());
  expect(pose?.ride, 'předklon jízdy, ne běh').toBe('board');
  await page.getByTestId('arcade-stage').screenshot({ path: test.info().outputPath('skier-ride.png') });
});

const SHOTS = join(process.cwd(), 'evals/play/p32/penguin');

/** Nad plátnem nic: HUD, „+1“ a CSS počasí se mění jinak než scéna (jako `p32-look`). */
const ONLY_CANVAS = 'body * { visibility: hidden !important; } [data-testid="arcade-stage"] canvas { visibility: visible !important; }';

/** Tvar arkádové sondy `__playShell` (`ArcadePlay.tsx`); globální typ je mřížkový. */
type ArcadeProbe = {
  readonly tick: () => number;
  readonly playWitness: () => { readonly runState: string; readonly tick: number };
  readonly handPlay: (until: 'score' | 'end') => { readonly runState: string; readonly tick: number };
};

/**
 * Záznam robota přehraný bez kreslení: tik výhry, podle kterého se měří „uprostřed
 * běhu“. Jen na čerstvé stránce – hrdina skočí do cíle, kamera zůstane u startu.
 */
function witness(page: Page): Promise<{ readonly runState: string; readonly tick: number }> {
  return page.evaluate(() => (window.__playShell as unknown as ArcadeProbe).playWitness());
}

const press = (page: Page, id: string): Promise<boolean> =>
  page.evaluate((testId) => {
    const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    button?.click();
    return button !== null;
  }, id);

/**
 * „Show me how“ od tiku 0: robot hraje v reálném čase. Běžící ukázku nejdřív
 * zastaví; po konci běhu nejdřív „znovu“ (tlačítko výsledku se ukáže až po klipu konce).
 *
 * Restart po dohraném běhu nechá kameru v cíli a hrdinu neukáže (`World.tsx`
 * kreslí jen těla do `far` + 12 m od kamery ze snímku předtím, hrdinu taky).
 * Sem se proto chodí jen s kamerou blízko startu: čerstvá stránka nebo krátká ukázka.
 */
async function startDemo(page: Page): Promise<void> {
  if (await press(page, 'play-demo-stop')) await page.locator('[data-testid="play-demo"]').waitFor({ state: 'detached' });
  const deadline = Date.now() + 15_000;
  while (!(await press(page, 'play-demo-start'))) {
    expect(Date.now(), 'tlačítko „Show me how“').toBeLessThan(deadline);
    // „Show me how“ je od P34 na kartě pauzy (postup `p32-arena`).
    if (!(await press(page, 'play-demo-yours')) && !(await press(page, 'play-replay'))) await press(page, 'play-pause');
    await page.waitForTimeout(200);
  }
  // `attached`: nad plátnem je všechno skryté (`ONLY_CANVAS`).
  await page.locator('[data-testid="play-demo"]').waitFor({ state: 'attached' });
}

/**
 * Nechá hru běžet do tiku `at` a pak ji pozastaví skrytou záložkou (postup
 * `p32-split`): plátno pak kreslí jen na požádání a obraz stojí.
 */
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

/**
 * Robot dohraje „rukou“: lidský běh, takže sběrnice vydá i konfety výhry (ukázka
 * efekty nevydává). Celý běh proběhne v jednom volání – kamera musí stát blízko
 * cíle, jinak hrdinu v cíli nedohoní (viz `startDemo`).
 */
function playToEnd(page: Page): Promise<{ readonly runState: string; readonly tick: number }> {
  return page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
    return (window.__playShell as unknown as ArcadeProbe).handPlay('end');
  });
}

interface Pixels {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
}

async function pixelsOf(png: Buffer): Promise<Pixels> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * Fialová (`rules/design-output.md`): odstín 250–320° se znatelnou sytostí
 * (HSV S ≥ 0,25) a ne ve tmě (V ≥ 0,2) – podíl takových pixelů snímku.
 */
function purpleShare({ data, width, height }: Pixels): number {
  let purple = 0;
  for (let at = 0; at < width * height * 3; at += 3) {
    const r = data[at]! / 255;
    const g = data[at + 1]! / 255;
    const b = data[at + 2]! / 255;
    const max = Math.max(r, g, b);
    const span = max - Math.min(r, g, b);
    if (max < 0.2 || span / max < 0.25) continue;
    const hue = max === r ? (60 * ((g - b) / span) + 360) % 360 : max === g ? 60 * ((b - r) / span) + 120 : 60 * ((r - g) / span) + 240;
    if (hue >= 250 && hue <= 320) purple += 1;
  }
  return purple / (width * height);
}

interface Rect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** Obdélník sondy (NDC, +y nahoru) v pixelech snímku (+y dolů). */
const rectOf = (box: FrameBox, { width, height }: Pixels): Rect => ({
  x0: ((box.minX + 1) / 2) * width,
  x1: ((box.maxX + 1) / 2) * width,
  y0: ((1 - box.maxY) / 2) * height,
  y1: ((1 - box.minY) / 2) * height,
});

const inside = (rect: Rect, x: number, y: number): boolean => x >= rect.x0 && x < rect.x1 && y >= rect.y0 && y < rect.y1;

/**
 * Stín slunce u těla: podíl pixelů pásu na straně stínu, které jsou zřetelně
 * tmavší než osvětlená země v témže pásu a zároveň modré.
 *
 * - Pás: od pravé hrany obdélníku těla (sonda `__playFrame`) o 60 % jeho šířky
 *   dál, svisle od poloviny výšky těla nad jeho spodní hranou po polovinu pod ní.
 *   Slunce sady `snow` (`BEHIND_LEFT`) svítí zleva zezadu, stín padá doprava.
 * - Kontaktní skvrna pod hrdinou (T5) leží pod půdorysem těla, tedy uvnitř jeho
 *   obdélníku – do pásu nezasáhne. Měří se jen stín slunce: bez stínové mapy je pás prázdný.
 * - Ve stínu = světlost (Rec. 709) pod 72 % osvětlené země (85. percentil pásu)
 *   a modrá nad červenou aspoň o 40: stín sady `snow` svítí modrá obloha. Černý
 *   tučňák, oranžové nohy, šedý kámen, zelený mech ani žluté mince tím neprojdou.
 * - Obdélníky ostatních těl ze sondy se z pásu vynechají.
 */
function shadowShare(pixels: Pixels, body: FrameBox, others: readonly FrameBox[]): number {
  const { data, width, height } = pixels;
  const rect = rectOf(body, pixels);
  const w = rect.x1 - rect.x0;
  const h = rect.y1 - rect.y0;
  const skip = others.map((box) => rectOf(box, pixels));
  const band: { luma: number; blue: number }[] = [];
  for (let y = Math.max(0, Math.floor(rect.y1 - h / 2)); y < Math.min(height, Math.ceil(rect.y1 + h / 2)); y += 1) {
    for (let x = Math.max(0, Math.floor(rect.x1)); x < Math.min(width, Math.ceil(rect.x1 + 0.6 * w)); x += 1) {
      if (skip.some((box) => inside(box, x + 0.5, y + 0.5))) continue;
      const at = (y * width + x) * 3;
      band.push({ luma: 0.2126 * data[at]! + 0.7152 * data[at + 1]! + 0.0722 * data[at + 2]!, blue: data[at + 2]! - data[at]! });
    }
  }
  if (band.length === 0) return 0;
  const lit = band.map((pixel) => pixel.luma).sort((a, b) => a - b)[Math.floor(band.length * 0.85)]!;
  return band.filter((pixel) => pixel.luma < lit * 0.72 && pixel.blue >= 40).length / band.length;
}

interface ShotReport {
  readonly name: string;
  readonly purple: number;
  /** Stín slunce u hrdiny; `null`, když hrdina v záběru není. */
  readonly heroShadow: number | null;
}

/** Menší těla (px) se na stín neměří: pár pixelů kolem vzdáleného kamene je šum. */
const MIN_BODY_PX = 24;

const pct = (share: number | null): string => (share === null ? '–' : `${(share * 100).toFixed(1)} %`);

/**
 * Snímek plátna do `evals/play/p32/penguin/` a jeho měření. Sonda záběru ukáže
 * obdélník hrdiny a nejbližšího tělesa před ním (kámen nebo vločka); to se
 * měří taky, ale nehlídá – jestli je v daném tiku nějaké blízko, je náhoda.
 */
async function shoot(page: Page, name: string, tick: number): Promise<ShotReport> {
  const frame = await page.evaluate(() => window.__playFrame!());
  const tier = await page.getByTestId('arcade-stage').getAttribute('data-quality');
  const png = await page.locator('[data-testid="arcade-stage"] canvas').first().screenshot({ path: join(SHOTS, `${name}.png`), scale: 'css' });
  const pixels = await pixelsOf(png);
  const hero = frame.hero !== null && !frame.hero.behind ? frame.hero : null;
  const ahead = frame.target !== null && !frame.target.behind && frame.target.sizePx >= MIN_BODY_PX ? frame.target : null;
  const report: ShotReport = {
    name,
    purple: purpleShare(pixels),
    heroShadow: hero === null ? null : shadowShare(pixels, hero, ahead === null ? [] : [ahead]),
  };
  const aheadShadow = ahead === null ? null : shadowShare(pixels, ahead, hero === null ? [] : [hero]);
  const line = `${name} (tik ${tick}, ${pixels.width}×${pixels.height}, úroveň ${String(tier)}): stín u hrdiny ${pct(report.heroShadow)}, u tělesa před ním ${pct(aheadShadow)}, fialová ${pct(report.purple)}`;
  test.info().annotations.push({ type: 'shot', description: line });
  console.log(line);
  return report;
}

/** Start: pár desetin sekundy ukázky, kamera už v herním pohledu. */
const START_TICK = 30;
/** Ukázka se zastaví tolik tiků před cílem a zbytek dohraje robot „rukou“. */
const BEFORE_FINISH = 30;

/**
 * Start, uprostřed běhu (ukázka robota) a po výhře (robot „rukou“) jedné verze na
 * jednom zařízení. `warmUpMs`: ukázka před snímky, ať si telefon stihne vybrat
 * úroveň kvality (sestup trvá 3 s pod 40 FPS).
 */
async function shootSlice(page: Page, prefix: string, warmUpMs = 0): Promise<readonly ShotReport[]> {
  mkdirSync(SHOTS, { recursive: true });
  await page.addStyleTag({ content: ONLY_CANVAS });

  const bot = await witness(page);
  expect(bot.runState, 'záznam robota vyhraje').toBe('won');
  if (warmUpMs > 0) {
    await startDemo(page);
    await page.waitForTimeout(warmUpMs);
  }

  await startDemo(page);
  const start = await freezeAt(page, START_TICK);
  await page.waitForTimeout(800);
  const shots = [await shoot(page, `${prefix}-start`, start)];

  const mid = await freezeAt(page, Math.round(bot.tick / 2));
  await page.waitForTimeout(800);
  shots.push(await shoot(page, `${prefix}-mid`, mid));

  await freezeAt(page, bot.tick - BEFORE_FINISH);
  const end = await playToEnd(page);
  expect(end.runState, 'robot „rukou“ vyhraje').toBe('won');
  expect((await page.evaluate(() => window.__playFx!())).win ?? 0, 'sběrnice vydala výhru (konfety)').toBeGreaterThan(0);
  // Konfety letí ještě ~1 s; plátno po konci kreslí naplno 1,5 s (`END_CLIP_MS`).
  await page.waitForTimeout(500);
  shots.push(await shoot(page, `${prefix}-win`, end.tick));
  return shots;
}

/** Hra načtená, modely stažené (bez nich by snímek ukázal náhradní tvary). */
async function openGame(page: Page, url: string): Promise<void> {
  await page.goto(url);
  // Hra stojí na tiku 0 pod „Tap to start“ (P33 T11); snímky i měření FPS pouští ukázka.
  await page.waitForFunction(() => window.__playShell !== undefined && window.__playFrame !== undefined && window.__playFx !== undefined, undefined, { timeout: 60_000 });
  await expect(page.getByTestId('arcade-stage')).toHaveAttribute('data-look', 'snow');
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
}

/**
 * Žádná fialová na žádném snímku; stín slunce u hrdiny nad 3 % na startu. Start
 * je v obou verzích týž záběr (tik 30, hrdina ve stejném pruhu). Uprostřed běhu
 * a v cíli se stín jen měří: kolik ho vykoukne zpoza těla, záleží na pruhu –
 * v pravém pruhu ho tučňák skoro celý zakryje (AI verze uprostřed běhu 2,9 %).
 */
function expectLooks(shots: readonly ShotReport[]): void {
  for (const shot of shots) expect(shot.purple, `${shot.name}: podíl fialových pixelů`).toBeLessThan(0.001);
  const start = shots[0]!;
  expect(start.heroShadow, `${start.name}: hrdina v záběru`).not.toBeNull();
  expect(start.heroShadow!, `${start.name}: podíl stínu slunce u hrdiny`).toBeGreaterThan(0.03);
}

test.describe('penguin slice, desktop 1280×720', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  for (const version of VERSIONS) {
    test(`${version.id}: start, mid-run and win shots`, async ({ page, request }) => {
      test.setTimeout(180_000);
      await openGame(page, await publishSpec(request, gameSpecOf(version.genre)));
      expectLooks(await shootSlice(page, `${version.id}-desktop`));
    });
  }
});

/** Snímků za sekundu po celých sekundách (rAF), `seconds` dlouho (z `p32-look`). */
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

test.describe('penguin slice, Pixel 7 with CPU 4× slower', () => {
  test.use(PIXEL_7);

  /**
   * Medián FPS po 20 s ukázky robota na čerstvé stránce (postup `p32-look`; jedna
   * ukázka trvá 22–25 s, takže restart s kamerou v cíli do měření nespadne).
   * Pak znovu načíst a snímky ve stejném zpomalení, na úrovni kvality, kterou si
   * telefon vybral.
   */
  for (const version of VERSIONS) {
    test(`${version.id}: holds 30 FPS, then start, mid-run and win shots`, async ({ page, request, context }) => {
      test.setTimeout(300_000);
      const url = await publishSpec(request, gameSpecOf(version.genre));
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await openGame(page, url);
      const stage = page.getByTestId('arcade-stage');
      await expect(stage).toHaveAttribute('data-quality', /^(high|medium|low)$/, { timeout: 60_000 });

      const sampling = sampleFps(page, 20);
      const end = Date.now() + 20_000;
      while (Date.now() < end) {
        if (!(await press(page, 'play-demo-start'))) if (!(await press(page, 'play-demo-yours'))) if (!(await press(page, 'play-again'))) await press(page, 'play-pause');
        await page.waitForTimeout(500);
      }
      const samples = await sampling;
      const tier = await stage.getAttribute('data-quality');
      const fps = `medián ${median(samples).toFixed(1)} FPS, úroveň ${String(tier)}, vzorky ${samples.map((value) => value.toFixed(0)).join(' ')}`;
      test.info().annotations.push({ type: 'fps', description: fps });
      console.log(`${version.id}-pixel7: ${fps}`);
      expect(samples.length).toBeGreaterThanOrEqual(15);
      expect(median(samples), `medián FPS (úroveň ${String(tier)})`).toBeGreaterThanOrEqual(30);

      await openGame(page, url);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      expectLooks(await shootSlice(page, `${version.id}-pixel7`, 5_000));
    });
  }
});
