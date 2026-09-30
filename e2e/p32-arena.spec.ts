import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type APIRequestContext, devices, expect, type Page, test } from '@playwright/test';
import sharp from 'sharp';

import type { FrameReport } from '../src/components/play/arcade/ArcadeStage';
import { arenaGenre } from '../src/play/genre/arena';
import { compileGenre, readGenreSpec } from '../src/play/genre/index';
import type { GameSpecV1 } from '../src/play/spec';

/**
 * Aréna ve stylu B (P32E T5): kočka sbírá ryby na zamrzlém jezeře a honí ji
 * lední medvěd. Věta z přijímací sady P32 jde přes `draftFill` modulu arény
 * (rychlá verze bez modelu) a `compileGenre` na `GameSpecV1`, který se
 * publikuje jako každá jiná hra.
 *
 * Na desktopu 1280×720 i na Pixel 7 se 4× pomalejším CPU snímky do
 * `evals/play/p32/arena/`: start, probuzení medvěda, honička uprostřed běhu
 * a výhra. Snímky posuzuje autor v O10; test hlídá, co jde změřit:
 * - hrdina má aspoň 4 % výšky obrazu,
 * - pronásledovatel je na prvním snímku v záběru,
 * - při probuzení svítí vykřičník (`data-alerts`),
 * - podlaha je led (sada `snow`), žádná fialová,
 * - FPS Pixel 7 se 4× CPU aspoň 30.
 */

const CAT_SENTENCE = (
  JSON.parse(readFileSync(join(process.cwd(), 'evals/play/p32/sentences.json'), 'utf8')) as { sentences: { id: string; text: string }[] }
).sentences.find((sentence) => sentence.id === 'cat')!.text;

function catSpec(): GameSpecV1 {
  const read = readGenreSpec(arenaGenre.draftFill(CAT_SENTENCE, null));
  if (!read.ok) throw new Error(read.issues.join('; '));
  return compileGenre(read.value);
}

async function publishSpec(request: APIRequestContext, spec: unknown): Promise<string> {
  const response = await request.post('/api/play/games', { data: { spec } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

const SHOTS = join(process.cwd(), 'evals/play/p32/arena');

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

/**
 * „Show me how“ od tiku 0: běžící ukázku nejdřív zastaví, po konci běhu „znovu“.
 * Tlačítko je od P34 na kartě pauzy – když není vidět, otevře ji.
 */
async function startDemo(page: Page): Promise<void> {
  if (await press(page, 'play-demo-stop')) await page.locator('[data-testid="play-demo"]').waitFor({ state: 'detached' });
  const deadline = Date.now() + 15_000;
  while (!(await press(page, 'play-demo-start'))) {
    expect(Date.now(), 'tlačítko „Show me how“').toBeLessThan(deadline);
    if (!(await press(page, 'play-demo-yours')) && !(await press(page, 'play-replay'))) await press(page, 'play-pause');
    await page.waitForTimeout(200);
  }
  // `attached`: nad plátnem je všechno skryté (`ONLY_CANVAS`).
  await page.locator('[data-testid="play-demo"]').waitFor({ state: 'attached' });
}

/** Hra běží do tiku `at`, pak ji skrytá záložka pozastaví a obraz stojí (postup `p32-split`). */
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

/** Robot dohraje „rukou“: lidský běh, takže sběrnice vydá i konfety výhry. */
function playToEnd(page: Page): Promise<{ readonly runState: string; readonly tick: number }> {
  return page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
    return (window.__playShell as unknown as ArcadeProbe).handPlay('end');
  });
}

/** Podíl fialových pixelů: odstín 250–320°, HSV S ≥ 0,25, V ≥ 0,2 (`rules/design-output.md`). */
async function purpleShare(png: Buffer): Promise<number> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let purple = 0;
  for (let at = 0; at < info.width * info.height * 3; at += 3) {
    const r = data[at]! / 255;
    const g = data[at + 1]! / 255;
    const b = data[at + 2]! / 255;
    const max = Math.max(r, g, b);
    const span = max - Math.min(r, g, b);
    if (max < 0.2 || span / max < 0.25) continue;
    const hue = max === r ? (60 * ((g - b) / span) + 360) % 360 : max === g ? 60 * ((b - r) / span) + 120 : 60 * ((r - g) / span) + 240;
    if (hue >= 250 && hue <= 320) purple += 1;
  }
  return purple / (info.width * info.height);
}

interface Shot {
  readonly name: string;
  readonly frame: FrameReport;
  /** Výška hrdiny jako podíl výšky obrazu; `null` mimo záběr. */
  readonly heroShare: number | null;
  /** Pronásledovatel v záběru: střed jeho obdélníku uvnitř obrazu. */
  readonly chaserInView: boolean;
  readonly alerts: number;
  readonly purple: number;
}

async function shoot(page: Page, name: string, tick: number): Promise<Shot> {
  const frame = await page.evaluate(() => window.__playFrame!());
  const stage = page.getByTestId('arcade-stage');
  const alerts = Number((await stage.getAttribute('data-alerts')) ?? '0');
  const tier = await stage.getAttribute('data-quality');
  const png = await page.locator('[data-testid="arcade-stage"] canvas').first().screenshot({ path: join(SHOTS, `${name}.png`), scale: 'css' });
  const hero = frame.hero !== null && !frame.hero.behind ? frame.hero : null;
  const chaser = frame.items.chaser?.box ?? null;
  const shot: Shot = {
    name,
    frame,
    heroShare: hero === null ? null : hero.heightPx / frame.height,
    chaserInView: chaser !== null && !chaser.behind && Math.abs(chaser.x) < 1 && Math.abs(chaser.y) < 1,
    alerts,
    purple: await purpleShare(png),
  };
  const pct = (share: number | null): string => (share === null ? '–' : `${(share * 100).toFixed(1)} %`);
  const at = chaser === null ? '–' : `(${chaser.x.toFixed(2)}, ${chaser.y.toFixed(2)})`;
  const line = `${name} (tik ${tick}, ${frame.width}×${frame.height}, úroveň ${String(tier)}): hrdina ${pct(shot.heroShare)} výšky, medvěd ${shot.chaserInView ? 'v záběru' : 'mimo'} ${at}, vykřičníky ${alerts}, fialová ${pct(shot.purple)}`;
  test.info().annotations.push({ type: 'shot', description: line });
  console.log(line);
  return shot;
}

/** Start: pár desetin sekundy ukázky. Probuzení: ochrana (120 tiků) dobíhá, vykřičník svítí posledních 45 tiků. */
const START_TICK = 30;
const WAKE_TICK = 105;
const BEFORE_FINISH = 30;

/** Start, probuzení, honička (půlka běhu robota) a výhra. `warmUpMs`: ukázka předem, ať si telefon vybere úroveň kvality. */
async function shootChase(page: Page, prefix: string, warmUpMs = 0): Promise<readonly Shot[]> {
  mkdirSync(SHOTS, { recursive: true });
  await page.addStyleTag({ content: ONLY_CANVAS });
  const bot = await page.evaluate(() => (window.__playShell as unknown as ArcadeProbe).playWitness());
  expect(bot.runState, 'záznam robota vyhraje').toBe('won');
  if (warmUpMs > 0) {
    await startDemo(page);
    await page.waitForTimeout(warmUpMs);
  }
  await startDemo(page);
  const shots: Shot[] = [];
  for (const [name, tick] of [['start', START_TICK], ['wake', WAKE_TICK], ['chase', Math.round(bot.tick / 2)]] as const) {
    const at = await freezeAt(page, tick);
    await page.waitForTimeout(800);
    shots.push(await shoot(page, `${prefix}-${name}`, at));
  }
  await freezeAt(page, bot.tick - BEFORE_FINISH);
  const end = await playToEnd(page);
  expect(end.runState, 'robot „rukou“ vyhraje').toBe('won');
  await page.waitForTimeout(500);
  shots.push(await shoot(page, `${prefix}-win`, end.tick));
  return shots;
}

function expectChase(shots: readonly Shot[]): void {
  for (const shot of shots) {
    expect(shot.purple, `${shot.name}: podíl fialových pixelů`).toBeLessThan(0.001);
    if (!shot.name.endsWith('-win')) expect(shot.heroShare, `${shot.name}: hrdina v záběru`).not.toBeNull();
    if (shot.heroShare !== null) expect(shot.heroShare, `${shot.name}: podíl výšky obrazu, který hrdina zabírá`).toBeGreaterThanOrEqual(0.04);
  }
  const [start, wake] = shots;
  expect(start!.chaserInView, `${start!.name}: pronásledovatel na prvním snímku v záběru`).toBe(true);
  expect(wake!.alerts, `${wake!.name}: vykřičník nad probouzejícím se medvědem`).toBeGreaterThanOrEqual(1);
}

/** Hra načtená, modely stažené (bez nich by snímek ukázal náhradní tvary); zamrzlé jezero = sada `snow`, podlaha led. */
async function openGame(page: Page, url: string): Promise<void> {
  await page.goto(url);
  // Hra stojí na tiku 0 pod „Tap to start“ (P33 T11); snímky pouští ukázka.
  await page.waitForFunction(() => window.__playShell !== undefined && window.__playFrame !== undefined, undefined, { timeout: 60_000 });
  await expect(page.getByTestId('arcade-stage')).toHaveAttribute('data-look', 'snow');
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
}

test.describe('arena chase, desktop 1280×720', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('cat: start, wake-up, chase and win shots', async ({ page, request }) => {
    test.setTimeout(180_000);
    await openGame(page, await publishSpec(request, catSpec()));
    expectChase(await shootChase(page, 'cat-desktop'));
  });
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

test.describe('arena chase, Pixel 7 with CPU 4× slower', () => {
  test.use(PIXEL_7);

  /** Medián FPS po 20 s ukázky robota (postup `p32-penguin`), pak znovu načíst a snímky ve stejném zpomalení. */
  test('cat: holds 30 FPS, then start, wake-up, chase and win shots', async ({ page, request, context }) => {
    test.setTimeout(300_000);
    const url = await publishSpec(request, catSpec());
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await openGame(page, url);
    const stage = page.getByTestId('arcade-stage');
    await expect(stage).toHaveAttribute('data-quality', /^(high|medium|low)$/, { timeout: 60_000 });

    const sampling = sampleFps(page, 20);
    const end = Date.now() + 20_000;
    while (Date.now() < end) {
      if ((await page.locator('[data-testid="play-demo"]').count()) === 0) await startDemo(page);
      await page.waitForTimeout(500);
    }
    const samples = await sampling;
    const tier = await stage.getAttribute('data-quality');
    const fps = `medián ${median(samples).toFixed(1)} FPS, úroveň ${String(tier)}, vzorky ${samples.map((value) => value.toFixed(0)).join(' ')}`;
    test.info().annotations.push({ type: 'fps', description: fps });
    console.log(`cat-pixel7: ${fps}`);
    expect(samples.length).toBeGreaterThanOrEqual(15);
    expect(median(samples), `medián FPS (úroveň ${String(tier)})`).toBeGreaterThanOrEqual(30);

    await openGame(page, url);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    expectChase(await shootChase(page, 'cat-pixel7', 5_000));
  });
});
