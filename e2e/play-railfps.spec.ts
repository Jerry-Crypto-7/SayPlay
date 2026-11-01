import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type CDPSession, expect, type Page, test } from '@playwright/test';

import { screenAngle, sectorOfYaw, sectorToScreen } from '../src/components/play/arcade/genres/railfps/railfps-camera';
import { BUTTON } from '../src/play/arcade/contract';
import { enemyModel, modelPath } from '../src/play/arcade/models';
import { RAILFPS, YAW, axisToSector } from '../src/play/arcade/pieces/railfps-world';
import type { GameSpecV1 } from '../src/play/spec';
import { HUD_COUNTER_LABELS } from './hud-labels';

/**
 * Střelnice z očí na telefonu i na desktopu (P68-F T6). Hra z ručního specu `e2e/fixtures/p68-railfps-spec.json`
 * (astronaut proti mimozemšťanům v chodbě vesmírné stanice, `genre.v7`; žánr je `staged`, dveře `POST /api/play/games`
 * hotový spec přesto přijmou – dostupnost hlídá jen klasifikátor, režisér a čtečka):
 * - telefon (`iphone-touch`, `pixel7-touch`): celou hru dohraje prst. V každém kroku `botWants()` → sektor → sloupec
 *   obrazovky přes inverzi kamery (`sectorToScreen`, natočení a pole z `data-railfps-yaw` / `data-railfps-fov`) → ťuk.
 *   Sektor mimo záběr se nejdřív natočí tahem prstu (rozhlédnutí), pak ťukne;
 * - desktop (`chromium`): klik myší na nepřítele mimo střed zvýší skóre, zbytek dohraje `handPlay('end')`;
 * - herní aserce: po prvním ťuku mimo střed záznam nese ťuknutý sektor, natočení ve stavu (kamera ho jen kreslí)
 *   na něm skončí a skóre stoupne; nečinný hráč prohraje;
 * - nepřítel z věty je ve scéně a jeho model se stáhl, popisky počítadel z uzavřeného seznamu, žádná chyba stránky;
 * - Dare: výhra pošle záznam, server ho přehraje na týž výsledek a odkaz s výzvou otevře hru s cílem vyzyvatele;
 * - `@measure` (jen `pixel7-touch`): 20 s hry robotem, snímky přes `requestAnimationFrame` → `fps.json`.
 * Snímky pro oko do `D:/caches/p68/F/shots/` (`P68_RAILFPS_SHOTS` cestu přepíše).
 */

const FIXTURE = join(process.cwd(), 'e2e/fixtures/p68-railfps-spec.json');
const SPEC = JSON.parse(readFileSync(FIXTURE, 'utf8')) as GameSpecV1;
const SHOTS = process.env.P68_RAILFPS_SHOTS ?? 'D:/caches/p68/F/shots';
const FPS_OUT = join(process.cwd(), 'evals/play/p68/prvni-osoba/fps.json');
const BASELINE = join(process.cwd(), 'evals/play/p66/baseline-fps.json');
/** Zesílení tahu v `RailfpsTouch.tsx` (`DRAG_GAIN`): úhel, o který prst přejel, krát tohle = natočení. */
const DRAG_GAIN = 1.5;
/** Ťuk jen do sloupce, který je bezpečně uvnitř plátna; dál ke kraji se nejdřív natočí. */
const TAP_EDGE = 0.92;
/** Měření FPS: okno a zpomalení CPU jako `phone` profil `play-perf.spec.ts`, ze kterého je `baseline-fps.json`. */
const FPS_WINDOW_MS = 20_000;
const CPU_SLOWDOWN = 4;
const P95_MAX_MS = 33.3;

const CLIP_RESOLUTION_WARNING = 'When using "avc1" for mp4 encoding, the codec description is not supposed to change';

interface Wants {
  readonly buttons: number;
  readonly axis: number;
}
interface Now {
  readonly runState: string;
  readonly tick: number;
  readonly score: number;
  readonly health: number;
}
interface InputEvent {
  readonly tick: number;
  readonly buttons: number;
  readonly axis: number;
}
/** Arkádová sonda `__playShell` (`ArcadePlay.tsx`); globální typ je mřížkový. */
interface ArcadeProbe {
  byHand(on: boolean): void;
  botWants(): Wants | null;
  tickByHand(): Now;
  inputs(): readonly InputEvent[];
  handPlay(until: 'score' | 'end'): { readonly runState: string; readonly tick: number; readonly score: number };
  idleRun(): { readonly runState: string; readonly tick: number };
  bodies(role: string): number;
  tick(): number;
}
/** Krok sondy: stav po posledním tiku, co robot chce v příštím, a kolik nepřátel žije. */
interface Step {
  readonly now: Now;
  readonly wants: Wants | null;
  readonly enemies: number;
}
/** Co scéna naposledy nakreslila a kde je plátno (CSS px). */
interface View {
  readonly yaw: number;
  readonly fov: number;
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

/** Ukazatel: prst přes CDP (Chromium), syntetické události (WebKit), nebo myš. */
interface Pointer {
  tap(x: number, y: number): Promise<void>;
  down(x: number, y: number): Promise<void>;
  move(x: number, y: number): Promise<void>;
  up(): Promise<void>;
}

function cdpFinger(cdp: CDPSession): Pointer {
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x = 0, y = 0) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ id: 1, x, y }] }).then(() => undefined);
  return {
    tap: async (x, y) => {
      await touch('touchStart', x, y);
      await touch('touchEnd');
    },
    down: (x, y) => touch('touchStart', x, y),
    move: (x, y) => touch('touchMove', x, y),
    up: () => touch('touchEnd'),
  };
}

/**
 * WebKit nemá CDP: prst jsou syntetické `PointerEvent` (vzor `play-touch.spec.ts`). Cíl položení drží pohyb i zvednutí
 * (implicitní zachycení dotyku); adaptér poslouchá položení na ploše hry a pohyb i puštění na `window`.
 */
function syntheticFinger(page: Page): Pointer {
  let at = { x: 0, y: 0 };
  const send = (type: 'pointerdown' | 'pointermove' | 'pointerup', x: number, y: number) =>
    page.evaluate(
      ({ type, x, y }) => {
        const own = window as unknown as { __finger?: Element | null };
        const target = type === 'pointerdown' ? document.elementFromPoint(x, y) : own.__finger;
        if (target == null) return;
        own.__finger = type === 'pointerup' ? null : target;
        target.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true, composed: true }));
      },
      { type, x, y },
    );
  return {
    tap: async (x, y) => {
      await send('pointerdown', x, y);
      await send('pointerup', x, y);
    },
    down: (x, y) => {
      at = { x, y };
      return send('pointerdown', x, y);
    },
    move: (x, y) => {
      at = { x, y };
      return send('pointermove', x, y);
    },
    up: () => send('pointerup', at.x, at.y),
  };
}

function mouse(page: Page): Pointer {
  return {
    tap: (x, y) => page.mouse.click(x, y),
    down: async (x, y) => {
      await page.mouse.move(x, y);
      await page.mouse.down();
    },
    move: (x, y) => page.mouse.move(x, y),
    up: () => page.mouse.up(),
  };
}

/** Chyby stránky a konzole od otevření; 404 modelu by tu byla taky. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith(CLIP_RESOLUTION_WARNING)) errors.push(`console: ${message.text()}`);
  });
  return errors;
}

const frames = (page: Page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))));

/** Po dvou snímcích: natočení a pole, které scéna nakreslila, a plátno, ze kterého adaptér počítá sloupec. */
async function view(page: Page): Promise<View> {
  await frames(page);
  return page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-railfps-yaw]')!;
    const box = (host.querySelector('canvas') ?? host).getBoundingClientRect();
    return { yaw: Number(host.dataset.railfpsYaw), fov: Number(host.dataset.railfpsFov), box: { x: box.left, y: box.top, width: box.width, height: box.height } };
  });
}

const aspectOf = (v: View): number => v.box.width / v.box.height;
const xOf = (v: View, ndc: number): number => Math.round(v.box.x + ((ndc + 1) / 2) * v.box.width);

/** Výška ťuku ve sloupci `x`, kde je navrchu plátno (ne HUD, karta ani tlačítko); `null`, když nikde. */
function tapY(page: Page, v: View, x: number): Promise<number | null> {
  return page.evaluate(
    ({ x, box }) => {
      const canvas = document.querySelector('[data-railfps-yaw] canvas');
      for (const share of [0.42, 0.5, 0.34, 0.58, 0.26, 0.66]) {
        const y = Math.round(box.y + box.height * share);
        if (canvas !== null && document.elementFromPoint(x, y) === canvas) return y;
      }
      return null;
    },
    { x, box: v.box },
  );
}

/**
 * Sloupec obrazovky (NDC), kam ťuknout, aby adaptér poslal sektor `sector`: inverze kamery z toho, co scéna
 * nakreslila. `null` = sektor je mimo záběr (nebo u samého kraje) a musí se nejdřív natočit.
 */
function aimColumn(sector: number, v: View): number | null {
  const ndc = sectorToScreen(sector, v.yaw, aspectOf(v), v.fov);
  return ndc === null || Math.abs(ndc) > TAP_EDGE ? null : ndc;
}

/** Tiky, dokud robot nic nechce (nejvýš 40 naráz); `botWants` vždy před `tickByHand`, jak to `bot-hand.ts` chce. */
function batch(page: Page): Promise<Step> {
  return page.evaluate(() => {
    const shell = window.__playShell as unknown as ArcadeProbe;
    let now = shell.tickByHand();
    for (let k = 0; now.runState === 'running'; k += 1) {
      const wants = shell.botWants();
      if (k >= 40 || wants === null || wants.buttons !== 0 || wants.axis !== 0) return { now, wants, enemies: shell.bodies('enemy') };
      now = shell.tickByHand();
    }
    return { now, wants: null, enemies: shell.bodies('enemy') };
  });
}

/** Ťuk mimo střed ověřený ve hře: co nesl záznam, kam se natočil stav a o kolik stouplo skóre. */
interface Aimed {
  readonly from: number;
  readonly sector: number;
  readonly recorded: number;
  readonly drawnYaw: number;
  readonly before: number;
  readonly after: number;
  readonly tick: number;
}

interface Played {
  readonly last: Now;
  readonly taps: number;
  readonly looks: number;
  readonly aimed: Aimed | null;
  readonly enemySeen: boolean;
}

/**
 * Hra ukazatelem podle robota. `until: 'aimed'` skončí po prvním ověřeném ťuku mimo střed (na desktopu do nepřítele:
 * přírůstek skóre aspoň za nepřítele), `'end'` hraje do konce. První ťuk mimo střed se ověří vždy: tiky bez dalších
 * stisků, dokud rána nepadne, jeden tik navíc (scéna kreslí natočení předchozího tiku) a čtení natočení ze scény.
 */
async function playByPointer(page: Page, pointer: Pointer, until: 'aimed' | 'end', onEnemy: () => Promise<void>): Promise<Played> {
  let step: Step = await page.evaluate(() => {
    const shell = window.__playShell as unknown as ArcadeProbe;
    shell.byHand(true);
    return { now: { runState: 'running', tick: 0, score: 0, health: 3 }, wants: shell.botWants(), enemies: shell.bodies('enemy') };
  });
  let taps = 0;
  let looks = 0;
  let aimed: Aimed | null = null;
  let enemySeen = false;
  /** Cílový sektor míření podle posledního ťuku nebo tahu: dokud se k němu kamera točí, druhý tah netřeba. */
  let goal = 0;
  const needEnemy = until === 'aimed';
  while (step.now.runState === 'running' && step.now.tick < 6000) {
    if (!enemySeen && step.enemies > 0) {
      enemySeen = true;
      await onEnemy();
    }
    const wants = step.wants;
    if (wants !== null && (wants.buttons & BUTTON.FIRE) !== 0) {
      const sector = axisToSector(wants.axis);
      const v = await view(page);
      const ndc = aimColumn(sector, v);
      const x = ndc === null ? null : xOf(v, ndc);
      const y = x === null ? null : await tapY(page, v, x);
      if (x !== null && y !== null) {
        const from = sectorOfYaw(v.yaw);
        const before = step.now.score;
        await pointer.tap(x, y);
        taps += 1;
        goal = sector;
        await frames(page);
        if (aimed === null && from !== sector && (!needEnemy || enemySeen)) {
          const checked = await page.evaluate((score) => {
            const shell = window.__playShell as unknown as ArcadeProbe;
            let now = shell.tickByHand();
            const input = shell.inputs().at(-1) ?? null;
            for (let k = 0; k < 90 && now.runState === 'running' && now.score <= score; k += 1) {
              shell.botWants();
              now = shell.tickByHand();
            }
            if (now.runState === 'running') {
              shell.botWants();
              now = shell.tickByHand();
            }
            return { now, input, wants: now.runState === 'running' ? shell.botWants() : null, enemies: shell.bodies('enemy') };
          }, before);
          const drawn = await view(page);
          const hit: Aimed = {
            from,
            sector,
            recorded: checked.input === null || (checked.input.buttons & BUTTON.FIRE) === 0 ? Number.NaN : axisToSector(checked.input.axis),
            drawnYaw: drawn.yaw,
            before,
            after: checked.now.score,
            tick: checked.now.tick,
          };
          // Aim happened: the tap off the crosshair recorded its own sector and the state's yaw (drawn by the scene) ended there.
          expect(hit.recorded, `recorded sector ${JSON.stringify(hit)}`).toBe(sector);
          expect(sectorOfYaw(hit.drawnYaw), `yaw in state ${JSON.stringify(hit)}`).toBe(sector);
          expect(sectorOfYaw(hit.drawnYaw)).not.toBe(from);
          // Hit happened: the score rose.
          expect(hit.after, `score ${JSON.stringify(hit)}`).toBeGreaterThan(hit.before);
          if (!needEnemy || hit.after - hit.before >= RAILFPS.points.enemy) aimed = hit;
          step = { now: checked.now, wants: checked.wants, enemies: checked.enemies };
          if (aimed !== null && until === 'aimed') break;
          continue;
        }
      } else if (goal !== sector) {
        // Mimo záběr: tah prstem (rozhlédnutí) z protější strany, jeden tik s drženou osou, puštění.
        const turn = sector * YAW.stepDeg - v.yaw;
        const dir = Math.sign(turn);
        const startNdc = -0.85 * dir;
        const a0 = screenAngle(startNdc, aspectOf(v), v.fov);
        const aMax = screenAngle(0.85 * dir, aspectOf(v), v.fov);
        const a1 = dir > 0 ? Math.min(a0 + turn / DRAG_GAIN, aMax) : Math.max(a0 + turn / DRAG_GAIN, aMax);
        const endNdc = Math.tan((a1 * Math.PI) / 180) / (Math.tan((v.fov * Math.PI) / 360) * aspectOf(v));
        const x0 = xOf(v, startNdc);
        const y0 = await tapY(page, v, x0);
        if (y0 !== null) {
          await pointer.down(x0, y0);
          for (let k = 1; k <= 4; k += 1) await pointer.move(Math.round(x0 + ((xOf(v, endNdc) - x0) * k) / 4), y0);
          await frames(page);
          const held = await page.evaluate(() => {
            const shell = window.__playShell as unknown as ArcadeProbe;
            const now = shell.tickByHand();
            return { now, wants: now.runState === 'running' ? shell.botWants() : null, enemies: shell.bodies('enemy'), input: shell.inputs().at(-1) ?? null };
          });
          await pointer.up();
          await frames(page);
          // Tah zapsal do záznamu osu rozhlédnutí (bez rány) v právě odtikaném tiku.
          const look = held.input;
          expect(look !== null && look.tick === held.now.tick - 1 && look.buttons === 0, `look input ${JSON.stringify(look)} at tick ${String(held.now.tick)}`).toBe(true);
          goal = axisToSector(look!.axis);
          looks += 1;
          step = held;
          continue;
        }
      }
    }
    step = await batch(page);
  }
  return { last: step.now, taps, looks, aimed, enemySeen };
}

/** Počet sítí se 1,5 s nezměnil = modely dotažené (vzor `play-survivor.spec.ts`). */
async function settled(page: Page): Promise<number> {
  await page.waitForFunction(() => window.__playRender !== undefined && window.__playRender().calls > 0, undefined, { timeout: 90_000 });
  let last = -1;
  let since = Date.now();
  const deadline = Date.now() + 20_000;
  while (Date.now() - since < 1500 && Date.now() < deadline) {
    const meshes = await page.evaluate(() => window.__playRender!().meshes);
    if (meshes !== last) [last, since] = [meshes, Date.now()];
    await page.waitForTimeout(250);
  }
  return last;
}

test.describe('railfps (P68-F T6)', () => {
  let url = '';
  let id = '';

  test.beforeAll(async ({ request }) => {
    const response = await request.post('/api/play/games', { data: { spec: SPEC } });
    expect(response.status(), await response.text()).toBeLessThan(300);
    url = ((await response.json()) as { url: string }).url;
    id = url.split('/').at(-1)!;
  });

  test('railfps: aim by touch or mouse off center, play to the win, Dare round trip (P68)', async ({ page, browser, browserName }, info) => {
    test.setTimeout(600_000);
    const touch = info.project.name !== 'chromium';
    mkdirSync(SHOTS, { recursive: true });
    const shot = (name: string) => page.screenshot({ path: join(SHOTS, `${info.project.name}-${name}.png`) });
    const errors = watchErrors(page);
    // Model nepřítele z věty: GLB, které scéna stáhne pro roli `enemy`.
    const foeModel = enemyModel(SPEC);
    const foePath = modelPath(foeModel);
    const models: { url: string; status: number }[] = [];
    page.on('response', (response) => {
      if (/\.glb(?:$|\?)/.test(response.url())) models.push({ url: decodeURIComponent(new URL(response.url()).pathname), status: response.status() });
    });
    const posted = page.waitForResponse((response) => response.url().endsWith(`/api/play/games/${id}/dare`) && response.request().method() === 'POST', { timeout: 300_000 });

    await page.goto(url);
    const stage = page.getByTestId('arcade-stage');
    await expect(stage).toHaveAttribute('data-control', 'railfps', { timeout: 60_000 });
    await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 90_000 });
    await expect(stage).toHaveAttribute('data-railfps-fov', /^\d+(\.\d+)?$/, { timeout: 60_000 });
    await settled(page);
    const shown = await page.locator('[data-testid^="hud-counter-"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')!.slice('hud-counter-'.length)));
    for (const label of shown) expect(HUD_COUNTER_LABELS).toContain(label);
    await expect(page.getByTestId('hud-counter-lives')).toHaveAttribute('data-count', '3');
    await shot('start');

    const pointer = !touch ? mouse(page) : browserName === 'chromium' ? cdpFinger(await page.context().newCDPSession(page)) : syntheticFinger(page);
    const onEnemy = async () => {
      // Nepřítel z věty je ve scéně: tělo role žije, scéna ho kreslí a jeho model se stáhl (ne náhradní kvádr z 404).
      await frames(page);
      const drawn = await page.evaluate(() => window.__playFrame?.().items.enemy?.count ?? 0);
      expect(drawn, 'enemy groups drawn by the scene').toBeGreaterThan(0);
      await shot('enemy');
    };
    const played = await playByPointer(page, pointer, touch ? 'end' : 'aimed', onEnemy);
    console.log(`railfps ${info.project.name}: ${JSON.stringify({ last: played.last, taps: played.taps, looks: played.looks, aimed: played.aimed })}`);
    expect(played.enemySeen, 'an enemy of the sentence walked in').toBe(true);
    expect(played.aimed, 'an off-center tap aimed and hit').not.toBeNull();
    await expect.poll(() => models.some((model) => model.url.endsWith(foePath) && model.status === 200), { message: `enemy model ${foeModel} at ${foePath}; got ${JSON.stringify(models)}`, timeout: 30_000 }).toBe(true);

    let end: { runState: string; tick: number; score: number };
    if (touch) {
      expect(played.taps, 'the finger shot').toBeGreaterThan(0);
      expect(played.last.runState, `ended at tick ${String(played.last.tick)} with ${String(played.last.health)} lives`).toBe('won');
      end = { runState: played.last.runState, tick: played.last.tick, score: played.last.score };
    } else {
      await shot('aim');
      end = await page.evaluate(() => (window.__playShell as unknown as ArcadeProbe).handPlay('end'));
      expect(end.runState).toBe('won');
    }

    await expect(page.getByTestId('play-postrun')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('play-postrun')).toContainText('You did it!');
    await shot('result');

    // Dare: server přehrál záznam běhu na týž výsledek; odkaz s výzvou otevře hru s cílem vyzyvatele.
    const response = await posted;
    expect([200, 201]).toContain(response.status());
    const dare = (await response.json()) as { dareId: string; score: number; ticks: number };
    expect({ score: dare.score, ticks: dare.ticks }).toEqual({ score: end.score, ticks: end.tick });
    const friend = await browser.newContext({ baseURL: info.project.use.baseURL });
    const other = await friend.newPage();
    await other.goto(`${url}?via=share&dare=${dare.dareId}`);
    await expect(other.getByTestId('play-dare-goal')).toContainText(`Beat ${dare.score.toLocaleString('en-US')}`, { timeout: 60_000 });
    await friend.close();
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('railfps: an idle player is overrun and loses', async ({ page }, info) => {
    test.setTimeout(180_000);
    const errors = watchErrors(page);
    await page.goto(url);
    await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 90_000 });
    if (info.project.name !== 'chromium') {
      // Telefon na šířku: širší pole kamery, pás hry pořád mezi HUD a zónou palce.
      const size = page.viewportSize()!;
      await page.setViewportSize({ width: size.height, height: size.width });
      await expect(page.getByTestId('arcade-stage')).toHaveAttribute('data-railfps-fov', /^\d+(\.\d+)?$/, { timeout: 60_000 });
      await settled(page);
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, `${info.project.name}-landscape.png`) });
    }
    const end = await page.evaluate(() => (window.__playShell as unknown as ArcadeProbe).idleRun());
    expect(end.runState).toBe('lost');
    await expect(page.getByTestId('play-postrun')).toContainText(/So close\.|Try again!/, { timeout: 30_000 });
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('@measure railfps: 20 s of robot play on a Pixel 7, median FPS and p95 frame time', async ({ page }, info) => {
    test.skip(info.project.name !== 'pixel7-touch', 'the FPS self-check runs on the Pixel 7 profile only');
    test.setTimeout(240_000);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN });
    await page.goto(url);
    await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 90_000 });
    await settled(page);
    // Hraje robot v reálném čase: „Show me how“ z karty pauzy (vzor `play-perf.spec.ts`, klik přes DOM).
    const press = (testId: string) => page.evaluate((target) => (document.querySelector(`[data-testid="${target}"]`) as HTMLButtonElement | null)?.click(), testId);
    await press('play-pause');
    await page.waitForSelector('[data-testid="play-demo-start"]', { timeout: 10_000 });
    await press('play-demo-start');
    await expect(page.getByTestId('play-demo')).toBeVisible({ timeout: 10_000 });
    // Snímky se počítají jen za běhu ukázky. Robot vyhraje dřív než za 20 s (svědek ~17 s): po konci se ukázka pustí
    // znovu (konec ukázky → hra hráči → pauza → Show me how) a mezera mezi běhy se nepočítá.
    const { intervals, ticksPlayed, restarts } = await page.evaluate(
      (ms) =>
        new Promise<{ intervals: number[]; ticksPlayed: number; restarts: number }>((resolve) => {
          const shell = window.__playShell as unknown as ArcadeProbe;
          const click = (testId: string) => (document.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null)?.click();
          const pause = (wait: number) => new Promise((done) => setTimeout(done, wait));
          const out: number[] = [];
          const deadline = performance.now() + 4 * ms;
          let played = 0;
          let last = 0;
          let tick = shell.tick();
          let ticksPlayed = 0;
          let restarts = 0;
          let restarting = false;
          const step = (now: number) => {
            const playing = document.querySelector('[data-testid="play-demo"]') !== null;
            if (playing && last > 0) {
              out.push(now - last);
              played += now - last;
            }
            last = playing ? now : 0;
            const at = shell.tick();
            if (playing && at > tick) ticksPlayed += at - tick;
            tick = at;
            if (!playing && !restarting) {
              restarting = true;
              restarts += 1;
              void (async () => {
                // Konec ukázky ukáže „Your turn“ (`play-demo-yours`), ten vrátí hru hráči; pak znovu „Show me how“.
                click('play-demo-yours');
                await pause(400);
                click('play-pause');
                await pause(400);
                click('play-demo-start');
                await pause(400);
                restarting = false;
              })();
            }
            if (played < ms && now < deadline) requestAnimationFrame(step);
            else resolve({ intervals: out, ticksPlayed, restarts });
          };
          requestAnimationFrame(step);
        }),
      FPS_WINDOW_MS,
    );
    const sorted = [...intervals].sort((a, b) => a - b);
    const quantile = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
    const medianMs = quantile(0.5);
    const p95Ms = quantile(0.95);
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as { slowest: { genre: string; fpsP50: number }; commit: string };
    const minFps = Math.round(0.95 * baseline.slowest.fpsP50 * 10) / 10;
    const medianFps = Math.round((1000 / medianMs) * 10) / 10;
    const report = {
      schema: 'p68-railfps-fps.v1',
      about:
        'railfps FPS self-check (P68-F T6): Playwright project pixel7-touch (412x839 portrait, touch), CPU x4 via CDP like the phone profile of e2e/play-perf.spec.ts that produced evals/play/p66/baseline-fps.json; this machine GPU, not a phone. Robot plays via "Show me how" (real-time demo of the verified run), restarted after each win because the witness wins in under 20 s; frames are requestAnimationFrame intervals in the page counted only while the demo runs, 20 s in total. medianFps = 1000 / median frame time.',
      measuredAt: new Date().toISOString(),
      fixture: 'e2e/fixtures/p68-railfps-spec.json',
      windowMs: FPS_WINDOW_MS,
      cpuSlowdown: CPU_SLOWDOWN,
      frames: intervals.length,
      playedMs: Math.round(intervals.reduce((sum, ms) => sum + ms, 0)),
      ticksPlayed,
      demoRestarts: restarts,
      medianFrameMs: Math.round(medianMs * 100) / 100,
      medianFps,
      p95FrameMs: Math.round(p95Ms * 100) / 100,
      maxFrameMs: Math.round(sorted.at(-1)! * 100) / 100,
      baseline: { file: 'evals/play/p66/baseline-fps.json', commit: baseline.commit, slowest: baseline.slowest },
      gate: { minMedianFps: minFps, maxP95FrameMs: P95_MAX_MS, medianOk: medianFps >= minFps, p95Ok: p95Ms <= P95_MAX_MS, passed: medianFps >= minFps && p95Ms <= P95_MAX_MS },
    };
    writeFileSync(FPS_OUT, `${JSON.stringify(report, null, 1)}\n`);
    console.log(`railfps fps: ${JSON.stringify(report)}`);
    // Měření proběhlo a robot hrál; nesplněná brána je nález pro T9 (v `fps.json`), ne pád testu.
    expect(intervals.length).toBeGreaterThan(100);
    expect(report.playedMs, 'the robot played the whole window').toBeGreaterThanOrEqual(FPS_WINDOW_MS);
    expect(ticksPlayed, 'the robot played during the window').toBeGreaterThan(600);
  });
});
