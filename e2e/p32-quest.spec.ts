import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type APIRequestContext, devices, expect, type Page, test } from '@playwright/test';
import sharp from 'sharp';

import type { FrameReport } from '../src/components/play/arcade/ArcadeStage';
import { compileGenre, readGenreSpec } from '../src/play/genre/index';
import { questGenre } from '../src/play/genre/quest';
import type { GameSpecV1 } from '../src/play/spec';

/**
 * Úkol (P32G T6): sloveso z věty mění předmět před očima. Věty hasiče,
 * čaroděje a kuchaře z přijímací sady P32 jdou přes `draftFill` modulu úkolu
 * (rychlá verze bez modelu) a `compileGenre` na `GameSpecV1`, který se
 * publikuje jako každá jiná hra.
 *
 * Ukázka robota se nejdřív přehraje celá a sonda vrstvy cílů na plátně
 * (`data-quest`, stavy cílů po řadě) řekne, na kterém tiku se předmět posunul.
 * Druhá ukázka se zastaví 10 tiků před tím a 30 tiků po tom a snímky jdou do
 * `evals/play/p32/quest/`, na desktopu 1280×720 i na Pixel 7 se 4× pomalejším
 * CPU:
 * - hasič: strom hoří → po zásahu kouří;
 * - čaroděj: svíčka nezapálená → hoří, duch v záběru;
 * - kuchař (stanoviště, blízká kamera nad pultem): palačinka syrová → zlatá.
 *
 * Snímky posuzuje autor; test hlídá, co jde změřit: robot vyhraje, stav cíle se
 * posune (před = 0, po = cílový stav), hrdina a cíl v záběru, žádná fialová,
 * u kuchaře okno připravenosti (`data-quest-ready`) zavřené i otevřené a
 * tlačítko „Use“, na Pixel 7 se 4× CPU aspoň 30 FPS.
 */

type QuestId = 'firefighter' | 'wizard' | 'chef';

/** Stav, který snímek „po“ ukáže: kouří, hoří, zlatá. */
const AFTER_STATE: Readonly<Record<QuestId, number>> = { firefighter: 1, wizard: 1, chef: 2 };

const SENTENCES = (JSON.parse(readFileSync(join(process.cwd(), 'evals/play/p32/sentences.json'), 'utf8')) as { sentences: { id: string; text: string; hero: string }[] }).sentences;

/** Prostředí, když ho rychlá verze ve větě nenajde („A chef cooks pancakes“); jinak ho doplní model. */
const SETTING: Readonly<Record<QuestId, string>> = { firefighter: 'forest', wizard: 'haunted castle', chef: 'kitchen' };

function questSpec(id: QuestId): GameSpecV1 {
  const sentence = SENTENCES.find((entry) => entry.id === id)!;
  const fill = questGenre.draftFill(sentence.text, null);
  const read = readGenreSpec({ hero: sentence.hero, ...fill, setting: fill.setting ?? SETTING[id] });
  if (!read.ok) throw new Error(read.issues.join('; '));
  return compileGenre(read.value);
}

async function publishSpec(request: APIRequestContext, spec: unknown): Promise<string> {
  const response = await request.post('/api/play/games', { data: { spec } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

const SHOTS = join(process.cwd(), 'evals/play/p32/quest');

/** Nad plátnem nic: HUD se mění jinak než scéna (jako `p32-arena`). */
const ONLY_CANVAS = 'body * { visibility: hidden !important; } [data-testid="arcade-stage"] canvas { visibility: visible !important; }';

/** Tvar arkádové sondy `__playShell` (`ArcadePlay.tsx`); globální typ je mřížkový. */
type ArcadeProbe = {
  readonly tick: () => number;
  readonly playWitness: () => { readonly runState: string; readonly tick: number };
};

const press = (page: Page, id: string): Promise<boolean> =>
  page.evaluate((testId) => {
    const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    button?.click();
    return button !== null;
  }, id);

/** „Show me how“ od tiku 0 (postup `p32-arena`): běžící ukázku nejdřív zastaví, po konci běhu „znovu“. */
async function startDemo(page: Page): Promise<void> {
  if (await press(page, 'play-demo-stop')) await page.locator('[data-testid="play-demo"]').waitFor({ state: 'detached' });
  const deadline = Date.now() + 15_000;
  while (!(await press(page, 'play-demo-start'))) {
    expect(Date.now(), 'tlačítko „Show me how“').toBeLessThan(deadline);
    if (!(await press(page, 'play-demo-yours')) && !(await press(page, 'play-replay'))) await press(page, 'play-pause');
    await page.waitForTimeout(200);
  }
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

interface Watched {
  /** Tik a stavy cílů pokaždé, když se sonda `data-quest` změnila. */
  readonly changes: readonly { readonly tick: number; readonly states: string }[];
  readonly first: string;
  /** Hodnoty sondy okna připravenosti, které se během ukázky objevily. */
  readonly ready: readonly string[];
}

/** Ukázka robota: změny sondy `data-quest` po tiku, dokud některý cíl nedojde do stavu `goal`, nejdéle do tiku `until`. */
async function watchDemo(page: Page, until: number, goal: number): Promise<Watched> {
  await startDemo(page);
  return page.evaluate(
    ([end, want]) =>
      new Promise<Watched>((resolve, reject) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="arcade-stage"] canvas')!;
        const shell = window.__playShell as unknown as ArcadeProbe;
        const first = canvas.dataset.quest ?? '';
        const changes: { tick: number; states: string }[] = [];
        const ready = new Set<string>();
        let last = first;
        const deadline = performance.now() + 150_000;
        const step = (): void => {
          const tick = shell.tick();
          const now = canvas.dataset.quest ?? '';
          if (now !== last) {
            changes.push({ tick, states: now });
            last = now;
          }
          if (canvas.dataset.questReady !== undefined) ready.add(canvas.dataset.questReady);
          const reached = now.split(' ').some((state) => Number(state) >= want);
          if (reached || tick >= end) resolve({ changes, first, ready: [...ready] });
          else if (performance.now() > deadline) reject(new Error(`the demo stopped at tick ${String(tick)} before ${String(end)}`));
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    [until, goal] as const,
  );
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
  readonly heroShare: number | null;
  readonly targetInView: boolean;
  readonly chaserInView: boolean;
  /** Stavy cílů ze sondy `data-quest` ve chvíli snímku. */
  readonly states: readonly number[];
  readonly purple: number;
}

const inView = (box: FrameReport['target']): boolean => box !== null && !box.behind && Math.abs(box.x) < 1 && Math.abs(box.y) < 1;

async function shoot(page: Page, name: string, tick: number): Promise<Shot> {
  const frame = await page.evaluate(() => window.__playFrame!());
  const canvas = page.locator('[data-testid="arcade-stage"] canvas').first();
  const states = ((await canvas.getAttribute('data-quest')) ?? '').split(' ').filter(Boolean).map(Number);
  const tier = await page.getByTestId('arcade-stage').getAttribute('data-quality');
  const png = await canvas.screenshot({ path: join(SHOTS, `${name}.png`), scale: 'css' });
  const hero = frame.hero !== null && !frame.hero.behind ? frame.hero : null;
  const shot: Shot = {
    name,
    frame,
    heroShare: hero === null ? null : hero.heightPx / frame.height,
    targetInView: inView(frame.target),
    chaserInView: inView(frame.items.chaser?.box ?? null),
    states,
    purple: await purpleShare(png),
  };
  const pct = (share: number | null): string => (share === null ? '–' : `${(share * 100).toFixed(1)} %`);
  const line = `${name} (tik ${tick}, ${frame.width}×${frame.height}, úroveň ${String(tier)}): stavy [${states.join(' ')}], hrdina ${pct(shot.heroShare)} výšky, cíl ${shot.targetInView ? 'v záběru' : 'mimo'}, duch ${shot.chaserInView ? 'v záběru' : 'mimo'}, fialová ${pct(shot.purple)}`;
  test.info().annotations.push({ type: 'shot', description: line });
  console.log(line);
  return shot;
}

/** Hra načtená, modely stažené; hra stojí na tiku 0 pod „Tap to start“, snímky pouští ukázka. */
async function openGame(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => window.__playShell !== undefined && window.__playFrame !== undefined, undefined, { timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
}

/**
 * Robot vyhraje, ukázka ukáže tik posunu, pak snímky před a po. Cíl, který se
 * posunul první, musí být před ve stavu 0 a po v `AFTER_STATE`.
 */
async function shootQuest(page: Page, id: QuestId, prefix: string, warmUpMs = 0): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  // Tlačítko „Use“ (`ActionButton`) je vidět dřív, než se nad plátnem všechno skryje.
  await expect(page.getByTestId('arcade-use'), 'tlačítko „Use“').toHaveText('Use');
  await page.addStyleTag({ content: ONLY_CANVAS });
  const bot = await page.evaluate(() => (window.__playShell as unknown as ArcadeProbe).playWitness());
  expect(bot.runState, 'záznam robota vyhraje').toBe('won');
  if (warmUpMs > 0) {
    await startDemo(page);
    await page.waitForTimeout(warmUpMs);
  }

  const watched = await watchDemo(page, bot.tick - 2, AFTER_STATE[id]);
  const summary = `${prefix}: začátek [${watched.first}], změny ${watched.changes.map((change) => `${String(change.tick)}→[${change.states}]`).join(' ')}, okno ${watched.ready.join('/') || '–'}`;
  test.info().annotations.push({ type: 'quest', description: summary });
  console.log(summary);
  const before = watched.first.split(' ').map(Number);
  const firstChange = watched.changes[0];
  expect(firstChange, 'stav cíle se v ukázce posune (stateChange)').toBeDefined();
  const moved = firstChange!.states.split(' ').map(Number).findIndex((state, i) => state > before[i]!);
  expect(moved, 'posunul se některý cíl').toBeGreaterThanOrEqual(0);
  const reached = watched.changes.find((change) => Number(change.states.split(' ')[moved]) >= AFTER_STATE[id]);
  expect(reached, `cíl ${String(moved)} dojde do stavu ${String(AFTER_STATE[id])}`).toBeDefined();
  if (id === 'chef') expect([...watched.ready].sort(), 'okno připravenosti zavřené i otevřené').toEqual(['0', '1']);

  await startDemo(page);
  const beforeShot = await shoot(page, `${prefix}-before`, await freezeAt(page, Math.max(1, firstChange!.tick - 10)));
  await page.waitForTimeout(800);
  const afterShot = await shoot(page, `${prefix}-after`, await freezeAt(page, reached!.tick + 30));
  await page.waitForTimeout(500);

  for (const shot of [beforeShot, afterShot]) {
    expect(shot.purple, `${shot.name}: podíl fialových pixelů`).toBeLessThan(0.001);
    expect(shot.heroShare, `${shot.name}: hrdina v záběru`).not.toBeNull();
    expect(shot.heroShare!, `${shot.name}: podíl výšky obrazu, který hrdina zabírá`).toBeGreaterThanOrEqual(0.04);
    expect(shot.targetInView, `${shot.name}: cíl v záběru`).toBe(true);
  }
  expect(beforeShot.states[moved], `${beforeShot.name}: cíl ještě ve stavu 0`).toBe(0);
  expect(afterShot.states[moved], `${afterShot.name}: cíl ve stavu ${String(AFTER_STATE[id])}`).toBeGreaterThanOrEqual(AFTER_STATE[id]);
  if (id === 'wizard') expect(beforeShot.chaserInView || afterShot.chaserInView, 'duch v záběru').toBe(true);
}

const QUESTS: readonly QuestId[] = ['firefighter', 'wizard', 'chef'];

test.describe('quest verbs, desktop 1280×720', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  for (const id of QUESTS) {
    test(`${id}: target before and after the verb`, async ({ page, request }) => {
      test.setTimeout(240_000);
      await openGame(page, await publishSpec(request, questSpec(id)));
      await shootQuest(page, id, `${id}-desktop`);
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

/** Medián FPS po 20 s ukázky robota (postup `p32-arena`); ukázka se po konci pouští znovu. */
async function demoFps(page: Page, name: string): Promise<void> {
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
  console.log(`${name}: ${fps}`);
  expect(samples.length).toBeGreaterThanOrEqual(15);
  expect(median(samples), `medián FPS (úroveň ${String(tier)})`).toBeGreaterThanOrEqual(30);
}

test.describe('quest verbs, Pixel 7 with CPU 4× slower', () => {
  test.use(PIXEL_7);

  for (const id of QUESTS) {
    test(`${id}: holds 30 FPS, then target before and after the verb`, async ({ page, request, context }) => {
      test.setTimeout(360_000);
      const url = await publishSpec(request, questSpec(id));
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await openGame(page, url);
      await demoFps(page, `${id}-pixel7`);

      await openGame(page, url);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await shootQuest(page, id, `${id}-pixel7`, 5_000);
    });
  }
});
