import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { type APIRequestContext, devices, expect, type Page, test } from '@playwright/test';
import sharp from 'sharp';

import { compileGenre, readGenreSpec } from '../src/play/genre/index';
import { platformerGenre } from '../src/play/genre/platformer';

/**
 * Plošinovka ve stylu B (P32F T5): pevné desky jsou ostrůvky z `islands.ts`
 * místo kvádrů hlína + tráva. Žába z modulu žánru (pocit skoku) a stará věta
 * s hroty dveřmi `sentence`, na desktopu 1280×720 a na Pixel 7 se 4× pomalejším
 * CPU: snímek na startu, uprostřed a po konci do `evals/play/p32/platform/`.
 * Snímky posuzuje autor; test hlídá, co jde změřit: hrdina stojí na nakreslené
 * horní ploše (±5 px, sonda `__playPlatform`), dopad vydá `land`, FPS a žádná fialová.
 */

const GAMES = [
  { id: 'frog', data: () => ({ spec: gameSpecOf('A frog jumps across lily pads to reach the island') }) },
  { id: 'spikes', data: () => ({ sentence: 'a platformer where you jump over spikes and collect coins' }) },
] as const;

function gameSpecOf(sentence: string): unknown {
  const read = readGenreSpec(platformerGenre.draftFill(sentence, null));
  if (!read.ok) throw new Error(read.issues.join('; '));
  return compileGenre(read.value);
}

async function publish(request: APIRequestContext, data: unknown): Promise<string> {
  const response = await request.post('/api/play/games', { data });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

const SHOTS = join(process.cwd(), 'evals/play/p32/platform');

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

/** Robot dohraje „rukou“ – lidský běh, sběrnice efektů vydá dopady i výhru. */
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

/** Hra načtená a puštěná, sonda ostrůvků připojená, modely stažené. */
async function openGame(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => window.__playShell !== undefined && window.__playFx !== undefined && window.__playPlatform !== undefined, undefined, { timeout: 60_000 });
  await page.evaluate(() => window.__playShell!.start());
  await page.waitForFunction(() => window.__playShell!.tick() > 5, undefined, { timeout: 30_000 });
  await expect(page.getByTestId('arcade-stage')).toHaveAttribute('data-control', 'platform');
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
}

/**
 * Hrdina stojí na startovní desce (bez vstupu se nehne): pata nakresleného modelu
 * proti horní ploše ostrůvku pod ní, obojí promítnuté kamerou – nejvýš 5 px.
 */
async function checkStanding(page: Page, prefix: string): Promise<void> {
  const gap = await page.evaluate(() => window.__playPlatform!());
  expect(gap, `${prefix}: pod hrdinou je ostrůvek`).not.toBeNull();
  test.info().annotations.push({ type: 'gap', description: `${prefix}: ${gap!.gap.toFixed(1)} px, ${gap!.lift.toFixed(3)} m` });
  expect(Math.abs(gap!.gap), `${prefix}: pata hrdiny na horní ploše (px)`).toBeLessThanOrEqual(5);
}

/** Start, polovina (ukázka robota) a konec (robot „rukou“ – člověk: dopady vydají `land`). */
async function shootRun(page: Page, prefix: string): Promise<void> {
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
  expect(end.runState, 'robot „rukou“ dojde do cíle').toBe('won');
  expect((await page.evaluate(() => window.__playFx!())).land ?? 0, 'dopad vydal land').toBeGreaterThan(0);
}

test.describe('platformer islands, desktop 1280×720', () => {
  test.use({ viewport: { width: 1280, height: 720 } });
  for (const game of GAMES)
    test(`${game.id}: hero stands on the island top, start, mid and end shots`, async ({ page, request }) => {
      test.setTimeout(180_000);
      await openGame(page, await publish(request, game.data()));
      await checkStanding(page, `${game.id}-desktop`);
      await shootRun(page, `${game.id}-desktop`);
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

test.describe('platformer islands, Pixel 7 with CPU 4× slower', () => {
  test.use(PIXEL_7);
  /** Medián FPS po 20 s ukázek robota (po 5 s zahřátí), pak snímky ve stejném zpomalení. */
  for (const game of GAMES)
    test(`${game.id}: holds 30 FPS, then start, mid and end shots`, async ({ page, request, context }) => {
      test.setTimeout(300_000);
      const url = await publish(request, game.data());
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await openGame(page, url);
      const stage = page.getByTestId('arcade-stage');
      await expect(stage).toHaveAttribute('data-quality', /^(high|medium|low)$/, { timeout: 60_000 });
      await checkStanding(page, `${game.id}-pixel7`);
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

      await openGame(page, url);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await shootRun(page, `${game.id}-pixel7`);
    });
});
