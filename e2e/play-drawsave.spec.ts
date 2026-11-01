import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type APIRequestContext, type BrowserContext, devices, expect, type Page, test, type TestInfo } from '@playwright/test';

import { ARCADE_LIMITS, type ArcadeInput, type ArcadeState, type ArcadeWorld, BUTTON, COUNTER, HEADER, type InputEvent, NO_INPUT } from '../src/play/arcade/contract';
import { type ArcadeProgram, hashArcade, instantiate, loadProgram, outcomeOf, step } from '../src/play/arcade/kernel';
import { ARCADE_LIBRARY } from '../src/play/arcade/library';
import { roofStroke } from '../src/play/arcade/pieces/drawsave-bot';
import { DRAWSAVE, PHASE, cellOf, colOf, heroCellOf, phaseOf, segmentCountOf, threatsOf } from '../src/play/arcade/pieces/drawsave-world';
import { axisOfCell, cellOfAxis } from '../src/play/arcade/pieces/lanes';
import { DRAWSAVE_STROKE } from '../src/play/genre/p68-contract';
import { unpackInputs } from '../src/play/score/dare';
import { capture } from './play-native-input';

/**
 * Kresli a zachraň na telefonu i na desktopu (P68-S T14). Hra z ručního specu `e2e/fixtures/p68-drawsave-spec.json`
 * (štěně, 10 padajících kamenů; žánr je `staged`, věty ho zatím nevolí).
 *
 * - **Kreslení skutečným tahem:** test přečte `data-lane-cells` a táhne prstem přes buňky – `pixel7-touch` přes CDP
 *   (`Input.dispatchTouchEvent`, skutečný dotyk Chromia), `iphone-touch` syntetickými dotykovými `PointerEvent`
 *   (WebKit dotyk z Playwright neumí táhnout, vzor `play-touch.spec.ts`), `chromium` myší. Střecha robota
 *   (`roofStroke`) tažená prstem vyhraje, čára na opačné straně desky prohraje, nečinný hráč prohraje.
 * - Hra běží na ručních hodinách (`byHand`); Node vede dvojče hry ze stejného světa a po každém tiku tahu porovná
 *   zapsaný vstup (`HOLD` a buňka v ose) i hash s prohlížečem – tah, který trefí jinou buňku, test hned shodí.
 * - Snímky na výšku i na šířku do `D:/caches/p68/stavba/shots/` (`P68_STAVBA_SHOTS` cestu přepíše), žádná chyba
 *   stránky ani konzole. FPS: 10 s snímků přes `requestAnimationFrame` od konce kreslení přes obranu; `chromium`
 *   hlídá medián ≥ 40 FPS a p95 doby snímku ≤ 33,3 ms, telefony jen zapíší. Čísla do
 *   `evals/play/p68/stavba/fps-drawsave.json`.
 * - **Sdílení a Dare (vzor `play-buildshift.spec.ts`):** výhra tahem pošle běh na server, odkaz nese id výzvy,
 *   kamarád na něm vidí cíl k překonání a uložený záznam – i s tahem prstu – se v Node přehraje na tentýž výsledek,
 *   tik a hash jako původní běh.
 */

const FIXTURE = join(process.cwd(), 'e2e/fixtures/p68-drawsave-spec.json');
const SHOTS = process.env.P68_STAVBA_SHOTS ?? 'D:/caches/p68/stavba/shots';
const FPS_FILE = join(process.cwd(), 'evals/play/p68/stavba/fps-drawsave.json');
const TOUCH_MIN = 44;
/**
 * Nejmenší buňka tam, kde se 12 řad po 44 px nad dolní řadu HUD nevejde (telefon na šířku, iPhone 15 na výšku s 659 px):
 * deska tam vyplní volnou výšku – přesné velikosti pinuje `drawsave-camera.test.ts` (20–37 px).
 */
const TIGHT_CELL_MIN = 18;
const HOLD = BUTTON[DRAWSAVE_STROKE.hold];
/** Druhá orientace telefonu: skutečný rozměr na šířku z Playwright, ne prohozené strany na výšku. */
const LANDSCAPE: Readonly<Record<string, string>> = { 'pixel7-touch': 'Pixel 7 landscape', 'iphone-touch': 'iPhone 15 landscape' };
const FPS_WINDOW_MS = 10_000;
const FPS_MIN_MEDIAN = 40;
const FPS_MAX_P95_MS = 33.3;
/** Tik, od kterého FPS měří skutečné hodiny: sekundu před koncem kreslení, aby okno pokrylo pád všech hrozeb. */
const FPS_FROM_TICK = DRAWSAVE.drawTicks - 60;
/** Kolik bodů tahu prst projede mezi dvěma body tahu (všechny v jednom tiku – jádro dostane jen cílovou buňku). */
const DRAG_STEPS = 5;
/**
 * Prst před zvednutím chvíli stojí na posledním bodě. Zvednutí hned po rychlém tažení vyhodnotí Chromium (CDP dotyk)
 * jako švih a první další ťuk spolkne (potlačení ťuku po švihu) – „Dare a friend“ by pak nic neudělal.
 */
const REST_MS = 150;

interface Probe {
  byHand(on: boolean): void;
  tickByHand(): { readonly runState: string; readonly tick: number };
  idleRun(): { readonly runState: string; readonly tick: number };
  start(): void;
}

/** Hláška Chromia, ne hry (vzor `play-survivor.spec.ts`): rekordér klipu při změně rozlišení plátna. */
const CLIP_RESOLUTION_WARNING = 'When using "avc1" for mp4 encoding, the codec description is not supposed to change';

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith(CLIP_RESOLUTION_WARNING)) errors.push(`console: ${message.text()}`);
  });
  return errors;
}

async function publishFixture(request: APIRequestContext): Promise<{ readonly url: string; readonly id: string }> {
  const spec = JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown;
  const response = await request.post('/api/play/games', { data: { spec } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  const url = ((await response.json()) as { url: string }).url;
  return { url, id: url.split('/').at(-1)! };
}

/** Mřížka na plátně (`data-lane-cells`) v px stránky: deska 8 × 12. */
async function gridOnPage(page: Page) {
  const stage = page.getByTestId('arcade-stage');
  const [cols, rows, left, top, right, bottom] = ((await stage.getAttribute('data-lane-cells')) ?? '').split(',').map(Number) as [number, number, number, number, number, number];
  const box = (await stage.boundingBox())!;
  const cellW = ((right - left) * box.width) / cols;
  const cellH = ((bottom - top) * box.height) / rows;
  return {
    cols,
    rows,
    cellW,
    cellH,
    left: box.x + left * box.width,
    right: box.x + right * box.width,
    top: box.y + top * box.height,
    bottom: box.y + bottom * box.height,
    /** Střed buňky `cell` (po řadách zleva shora, jako `cellAxisAt`). */
    center: (cell: number) => ({ x: box.x + left * box.width + ((cell % cols) + 0.5) * cellW, y: box.y + top * box.height + (Math.floor(cell / cols) + 0.5) * cellH }),
  };
}
type Grid = Awaited<ReturnType<typeof gridOnPage>>;

/** Mřížka se ustálila (póza kamery čeká na obdélník hry): atribut se 600 ms nezměnil. */
async function settledGrid(page: Page): Promise<Grid> {
  const stage = page.getByTestId('arcade-stage');
  let last = '';
  let since = Date.now();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const attr = (await stage.getAttribute('data-lane-cells')) ?? '';
    if (attr !== last) [last, since] = [attr, Date.now()];
    else if (attr !== '' && Date.now() - since >= 600) break;
    await page.waitForTimeout(150);
  }
  return gridOnPage(page);
}

/**
 * Celá deska leží v okně nad dolní řadou HUD (Restart, „Change one thing“, sdílení – vede přes celou šířku) a buňka je
 * aspoň dotykový cíl, kde se 12 řad vejde (výška ≥ 700 px a šířka ≥ 400 px); jinde aspoň `TIGHT_CELL_MIN`. Vrací
 * nejmenší stranu buňky (px).
 */
async function expectReachable(grid: Grid, page: Page, where: string): Promise<number> {
  const viewport = page.viewportSize()!;
  const bar = (await page.getByRole('navigation', { name: 'Game actions' }).boundingBox())!;
  expect([grid.cols, grid.rows], where).toEqual([DRAWSAVE.cols, DRAWSAVE.rows]);
  expect(grid.left, `${where}: grid left edge`).toBeGreaterThanOrEqual(-1);
  expect(grid.top, `${where}: grid top edge`).toBeGreaterThanOrEqual(-1);
  expect(grid.right, `${where}: grid right edge`).toBeLessThanOrEqual(viewport.width + 1);
  expect(grid.bottom, `${where}: board above the HUD bottom row`).toBeLessThanOrEqual(bar.y + 1);
  const cell = Math.min(grid.cellW, grid.cellH);
  const roomy = viewport.height >= 700 && viewport.width >= 400;
  expect(cell, `${where}: cell smaller than a touch target`).toBeGreaterThanOrEqual(roomy ? TOUCH_MIN : TIGHT_CELL_MIN);
  return cell;
}

/** Čitelnost na plátně (`__playFrame`): podíl výšky plátna, který zabere hrdina a nejvíc v záběru hrozba. */
async function legibilityOf(page: Page) {
  return page.evaluate(() => {
    const frame = window.__playFrame!();
    const share = (box: { readonly minY: number; readonly maxY: number } | null | undefined): number => (box == null ? 0 : (box.maxY - box.minY) / 2);
    return { hero: share(frame.hero), legible: frame.legible.hero, threat: share(frame.items.threat?.box), heightPx: frame.height };
  });
}

/**
 * Mez čitelnosti (podíl výšky plátna). Mez survivoru (`LEGIBLE_SHARE.hero` 20 %) deska 8 × 12 nesplní: celá deska musí
 * být vidět a hrdina nad `HERO_CAP` (1,15 buňky) by přerostl buňku, ve které ho jádro zasáhne. Mez hlídá, že kamera
 * neodjede a postavy se nezmenší.
 */
const DRAWSAVE_LEGIBLE = { hero: 0.035 } as const;

/** Je kus scény se značkou `item` právě nakreslený (`__playFrame().items` vidí jen viditelné)? */
const shownItem = (page: Page, item: string) => page.evaluate((name) => (window.__playFrame!().items[name]?.count ?? 0) > 0, item);

const shell = (page: Page) => ({
  byHand: (on: boolean) => page.evaluate((value) => (window.__playShell as unknown as Probe).byHand(value), on),
  tick: () => page.evaluate(() => (window.__playShell as unknown as Probe).tickByHand()),
});

/**
 * Prst (nebo myš) na plátně. `pixel7-touch` = CDP dotyk Chromia, `iphone-touch` = syntetické dotykové `PointerEvent`
 * na prvek pod prstem (WebKit z Playwright táhnout neumí), `chromium` = myš.
 */
async function fingerOf(page: Page, context: BrowserContext, info: TestInfo, browserName: string) {
  const touch = info.project.use.hasTouch === true;
  if (!touch) {
    return {
      down: async (x: number, y: number) => {
        await page.mouse.move(x, y);
        await page.mouse.down();
      },
      move: (x: number, y: number) => page.mouse.move(x, y),
      up: () => page.mouse.up(),
    };
  }
  if (browserName === 'chromium') {
    const cdp = await context.newCDPSession(page);
    return {
      down: (x: number, y: number) => cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x, y }] }).then(() => undefined),
      move: (x: number, y: number) => cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x, y }] }).then(() => undefined),
      up: () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }).then(() => undefined),
    };
  }
  // Dotyk drží cíl položení prstu (implicitní zachycení): pohyb i zvednutí jdou tam a probublají na okno.
  const pointer = (type: 'pointerdown' | 'pointermove' | 'pointerup', x: number, y: number) =>
    page.evaluate(
      ({ type, x, y }) => {
        const own = window as unknown as { __finger?: Element | null };
        if (type === 'pointerdown') own.__finger = document.elementFromPoint(x, y);
        const target = own.__finger;
        if (target == null) return;
        target.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true, composed: true }));
        if (type === 'pointerup') own.__finger = null;
      },
      { type, x, y },
    );
  let at = { x: 0, y: 0 };
  return {
    down: async (x: number, y: number) => {
      at = { x, y };
      await pointer('pointerdown', x, y);
    },
    move: async (x: number, y: number) => {
      at = { x, y };
      await pointer('pointermove', x, y);
    },
    up: () => pointer('pointerup', at.x, at.y),
  };
}
type Finger = Awaited<ReturnType<typeof fingerOf>>;

/**
 * Otevřená hra na ručních hodinách a její dvojče v Node. `stroke` = skutečný tah přes body (tik na každý bod, pak
 * zvednutí a tik bez vstupu); `run` dotiká obě do konce (nebo do `until`) a porovná hash.
 */
async function openGame(page: Page, request: APIRequestContext, game: { readonly url: string; readonly id: string }, finger: Finger) {
  await page.goto(game.url);
  const stage = page.getByTestId('arcade-stage');
  await expect(stage).toHaveAttribute('data-control', 'drawsave', { timeout: 60_000 });
  await expect(stage).toHaveAttribute('data-lane-cells', /^8,12(?:,[\d.]+){4}$/, { timeout: 90_000 });
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 90_000 });
  const world = ((await (await request.get(`/api/play/games/${game.id}`)).json()) as { arcade: ArcadeWorld }).arcade;
  const grid = await settledGrid(page);
  const probe = shell(page);
  await probe.byHand(true);

  const state: ArcadeState = instantiate(world);
  const program: ArcadeProgram = loadProgram(world, ARCADE_LIBRARY);
  const tickOf = () => state[HEADER.tick] as number;
  const start = await capture(page);
  expect(start.tick, 'the game waits at tick 0').toBe(0);
  expect(start.hash).toBe(hashArcade(state));

  /**
   * Tik v obou; `input` = co má hra z tahu zapsat (`NO_INPUT` = nic). Předtím dva snímky: Chromium doručí pohyb
   * dotyku až se snímkem (rAF-aligned input) – bez čekání by tik dostal předposlední bod tažení.
   */
  const tick = async (input: ArcadeInput, what: string) => {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await probe.tick();
    step(state, input, program);
    const seen = await capture(page);
    if (input !== NO_INPUT) expect(seen.inputs.at(-1), `${what} reached the game`).toEqual({ tick: tickOf() - 1, ...input });
    else expect(seen.inputs.at(-1)?.tick ?? -1, `${what}: no input recorded`).toBeLessThan(tickOf() - 1);
    expect(seen.hash, `browser and Node diverged after ${what}`).toBe(hashArcade(state));
  };

  return {
    world,
    state,
    hero: heroCellOf(state),
    tick: tickOf,
    grid: () => grid,
    /** Tah přes body `cells`: prst dolů na první, tažením (`DRAG_STEPS` mezibodů v jednom tiku) na další. `hold` nechá prst dole. */
    stroke: async (cells: readonly number[], { hold = false }: { readonly hold?: boolean } = {}) => {
      const first = grid.center(cells[0]!);
      await finger.down(first.x, first.y);
      await tick({ buttons: HOLD, axis: axisOfCell(cells[0]!) }, `the touch on cell ${String(cells[0])}`);
      let from = first;
      for (const cell of cells.slice(1)) {
        const to = grid.center(cell);
        for (let k = 1; k <= DRAG_STEPS; k += 1) await finger.move(from.x + ((to.x - from.x) * k) / DRAG_STEPS, from.y + ((to.y - from.y) * k) / DRAG_STEPS);
        from = to;
        await tick({ buttons: HOLD, axis: axisOfCell(cell) }, `the drag to cell ${String(cell)}`);
      }
      if (hold) return;
      await page.waitForTimeout(REST_MS);
      await finger.up();
      await tick(NO_INPUT, 'the lift');
    },
    /** Zvednutí prstu po `stroke(…, { hold: true })`. */
    lift: async () => {
      await page.waitForTimeout(REST_MS);
      await finger.up();
      await tick(NO_INPUT, 'the lift');
    },
    /** Tiky bez vstupu v obou do konce běhu nebo do tiku `until`; pak porovná tik a hash. */
    run: async (until: number = ARCADE_LIMITS.maxTicks) => {
      const target = Math.min(until, ARCADE_LIMITS.maxTicks);
      while (outcomeOf(state) === 'running' && tickOf() < target) step(state, NO_INPUT, program);
      await page.evaluate((end) => {
        const probe = window.__playShell as unknown as Probe;
        let now = probe.tickByHand();
        while (now.runState === 'running' && now.tick < end) now = probe.tickByHand();
      }, tickOf());
      const seen = await capture(page);
      expect(seen.tick).toBe(tickOf());
      expect(seen.hash, `browser and Node diverged by tick ${String(tickOf())}`).toBe(hashArcade(state));
      return outcomeOf(state);
    },
  };
}
type Game = Awaited<ReturnType<typeof openGame>>;

/** Čára mimo (jako test jádra): vodorovný tah ve druhé řadě na opačné polovině desky, než postava sedí. */
const lineAway = (hero: number): readonly number[] => (colOf(hero) >= DRAWSAVE.cols / 2 ? [cellOf(0, 1), cellOf(2, 1)] : [cellOf(5, 1), cellOf(7, 1)]);

/** Záznam přehraný v Node jako `replay` jádra, vrací konečný stav. */
function playRecord(world: ArcadeWorld, inputs: readonly InputEvent[]): ArcadeState {
  const state = instantiate(world);
  const program = loadProgram(world, ARCADE_LIBRARY);
  let next = 0;
  for (let tick = 0; tick < ARCADE_LIMITS.maxTicks && outcomeOf(state) === 'running'; tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    const event = inputs[next];
    step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program);
  }
  return state;
}

/** Nabídka sdílení se v e2e nedá obsluhovat – zachytí se, co by dostala (vzor `p36-dare.spec.ts`). */
const SHARE_CAPTURE = () => {
  const shared: ShareData[] = [];
  Object.assign(window, { __shared: shared });
  Object.defineProperty(navigator, 'share', { configurable: true, value: async (data: ShareData) => void shared.push(data) });
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
};
const sharedOf = (page: Page) => page.evaluate(() => (window as unknown as { __shared: ShareData[] }).__shared);

/**
 * Každý „člověk“ z vlastní adresy: strop výzev je 1 za 10 s na volajícího a bez hlavičky je každý požadavek na
 * localhostu týž volající (vzor `p36-dare.spec.ts`). Jiné adresy než `play-buildshift.spec.ts`.
 */
const PERSON: Readonly<Record<string, number>> = { chromium: 71, 'pixel7-touch': 72, 'iphone-touch': 73 };
const person = (info: TestInfo, friend: boolean) => ({ 'x-forwarded-for': `198.51.100.${String((PERSON[info.project.name] ?? 70) + (friend ? 100 : 0))}` });

function shotOf(page: Page, info: TestInfo) {
  mkdirSync(SHOTS, { recursive: true });
  return (name: string) => page.screenshot({ path: join(SHOTS, `drawsave-${info.project.name}-${name}.png`) });
}

const orientation = (page: Page): 'portrait' | 'landscape' => {
  const { width, height } = page.viewportSize()!;
  return width < height ? 'portrait' : 'landscape';
};

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};
const percentile = (values: readonly number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;
};

const LOST_HEADLINE = /So close\.|Try again!/;

test.describe('drawsave (P68-S T14)', () => {
  test.describe.configure({ mode: 'serial' });
  let game = { url: '', id: '' };

  test.beforeAll(async ({ request }) => {
    game = await publishFixture(request);
  });

  test('drawsave: a roof drawn by a drag over the hero saves it and wins', async ({ page, request, context, browserName }, info) => {
    test.setTimeout(300_000);
    const errors = watchErrors(page);
    const shot = shotOf(page, info);
    const finger = await fingerOf(page, context, info, browserName);
    const play = await openGame(page, request, game, finger);
    const where = `${info.project.name} ${orientation(page)}`;
    const cell = await expectReachable(play.grid(), page, where);
    await shot(`start-${orientation(page)}`);

    // Prst dole na druhém bodě: bod tahu má kroužek a kolem něj kruh dosahu (náhled dalšího bodu).
    const roof = roofStroke(play.hero);
    await play.stroke(roof, { hold: true });
    expect(segmentCountOf(play.state), 'the drag drew one segment').toBe(1);
    await page.waitForTimeout(300);
    expect(await shownItem(page, 'line'), 'the drawn line is on the canvas').toBe(true);
    expect(await shownItem(page, 'pen'), 'the pen point is marked').toBe(true);
    expect(await shownItem(page, 'reach'), 'the reach of the remaining ink is shown').toBe(true);
    await shot(`drawing-${orientation(page)}`);
    await play.lift();
    expect(await capture(page).then((seen) => seen.inputs), 'the record holds only the two points of the drag').toEqual(roof.map((at, k) => ({ tick: k, buttons: HOLD, axis: axisOfCell(at) })));

    // Obrana: hrozby padají, odrážejí se od střechy.
    await play.run(DRAWSAVE.drawTicks + 90);
    expect(phaseOf(play.state)).toBe(PHASE.defend);
    expect(threatsOf(play.state).length, 'threats are falling').toBeGreaterThan(0);
    await page.waitForTimeout(300);
    expect(await shownItem(page, 'threat'), 'threats are on the canvas').toBe(true);
    expect(await shownItem(page, 'cell'), 'the grid dots are gone once drawing ends').toBe(false);
    const legible = await legibilityOf(page);
    test.info().annotations.push({ type: 'legible', description: `${where}: ${JSON.stringify(legible)}` });
    expect(legible.hero, `hero ${JSON.stringify(legible)}`).toBeGreaterThanOrEqual(DRAWSAVE_LEGIBLE.hero);
    await shot(`defend-${orientation(page)}`);

    const outcome = await play.run();
    expect(outcome, `the roof run ended at tick ${String(play.tick())}`).toBe('won');
    await expect(page.getByTestId('play-postrun')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('play-postrun')).toContainText('You did it!');
    await shot(`result-${orientation(page)}`);
    expect(errors, errors.join('\n')).toEqual([]);
    test.info().annotations.push({ type: 'run', description: `${where} roof ${JSON.stringify(roof)} (hero ${String(play.hero)}): ${outcome} at tick ${String(play.tick())}; smallest cell ${cell.toFixed(1)} px` });
  });

  test('drawsave: a line drawn away from the hero does not save it and loses', async ({ page, request, context, browserName }, info) => {
    test.setTimeout(300_000);
    const errors = watchErrors(page);
    const finger = await fingerOf(page, context, info, browserName);
    const play = await openGame(page, request, game, finger);
    const away = lineAway(play.hero);
    await play.stroke(away);
    expect(segmentCountOf(play.state)).toBe(1);
    const outcome = await play.run();
    expect(outcome, `the line away ended at tick ${String(play.tick())}`).toBe('lost');
    await expect(page.getByTestId('play-postrun')).toContainText(LOST_HEADLINE, { timeout: 30_000 });
    await shotOf(page, info)(`away-result-${orientation(page)}`);
    expect(errors, errors.join('\n')).toEqual([]);
    test.info().annotations.push({ type: 'run', description: `line away ${JSON.stringify(away)} (hero ${String(play.hero)}): ${outcome} at tick ${String(play.tick())}` });
  });

  test('drawsave: an idle player draws nothing and loses', async ({ page }) => {
    test.setTimeout(180_000);
    const errors = watchErrors(page);
    await page.goto(game.url);
    await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 90_000 });
    const end = await page.evaluate(() => (window.__playShell as unknown as Probe).idleRun());
    expect(end.runState).toBe('lost');
    await expect(page.getByTestId('play-postrun')).toContainText(LOST_HEADLINE, { timeout: 30_000 });
    expect(errors, errors.join('\n')).toEqual([]);
    test.info().annotations.push({ type: 'run', description: `idle: ${end.runState} at tick ${String(end.tick)}` });
  });

  test('drawsave: share and Dare – the friend sees the target and the stored run replays the drag to the same result', async ({ page, browser, request, context, browserName }, info) => {
    test.setTimeout(300_000);
    const touch = info.project.use.hasTouch === true;
    await page.context().setExtraHTTPHeaders(person(info, false));
    await page.addInitScript(SHARE_CAPTURE);
    const errors = watchErrors(page);
    const finger = await fingerOf(page, context, info, browserName);
    const play = await openGame(page, request, game, finger);
    const posted = page.waitForResponse((response) => response.url().endsWith(`/api/play/games/${game.id}/dare`) && response.request().method() === 'POST', { timeout: 120_000 });

    const roof = roofStroke(play.hero);
    await play.stroke(roof);
    expect(await play.run()).toBe('won');
    const original = { outcome: outcomeOf(play.state), tick: play.tick(), score: play.state[HEADER.counters + COUNTER.score] as number, hash: hashArcade(play.state) };
    const response = await posted;
    // 201 nová výzva; 200, když tentýž běh už výzvou je (druhý průchod sadou nad týmž serverem).
    expect([200, 201], await response.text()).toContain(response.status());
    const dare = (await response.json()) as { dareId: string; score: number; ticks: number };
    expect({ score: dare.score, ticks: dare.ticks }).toEqual({ score: original.score, ticks: original.tick });

    // Odkaz ze sdílení nese id výzvy.
    await expect(page.getByTestId('play-postrun')).toContainText('You did it!', { timeout: 30_000 });
    const share = page.getByTestId('play-share');
    if (touch) await share.tap();
    else await share.click();
    await expect.poll(async () => (await sharedOf(page)).length).toBe(1);
    const link = (await sharedOf(page))[0]!.url!;
    expect(link).toMatch(new RegExp(`/play/${game.id}\\?via=share&dare=${dare.dareId}$`));

    // Uložený běh = tah prstu; přehraný v Node dá tentýž výsledek, tik i hash.
    const stored = (await (await request.get(`/api/play/games/${game.id}/dare/${dare.dareId}`)).json()) as { score: number; ticks: number; hash: string; replay: { readonly inputs: unknown } | null };
    expect(stored.replay, 'the dare keeps its run').not.toBeNull();
    const inputs = unpackInputs(stored.replay!.inputs);
    if (typeof inputs === 'string') throw new Error(inputs);
    expect(inputs).toEqual((await capture(page)).inputs);
    expect(inputs.map((event) => [event.buttons, cellOfAxis(event.axis)]), 'the stored run is the drag').toEqual(roof.map((at) => [HOLD, at]));
    const replayed = playRecord(play.world, inputs);
    expect({ outcome: outcomeOf(replayed), tick: replayed[HEADER.tick], score: replayed[HEADER.counters + COUNTER.score], hash: hashArcade(replayed) }).toEqual(original);
    expect({ score: stored.score, ticks: stored.ticks, hash: stored.hash }).toEqual({ score: original.score, ticks: original.tick, hash: original.hash });
    expect(errors, errors.join('\n')).toEqual([]);

    // Kamarád otevře odkaz: cíl výzvy je vidět na kartě startu i v HUD.
    const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = info.project.use;
    const friend = await browser.newContext({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, baseURL: info.project.use.baseURL, extraHTTPHeaders: person(info, true) });
    try {
      const pageB = await friend.newPage();
      const errorsB = watchErrors(pageB);
      await pageB.goto(link);
      const clock = `${(dare.ticks / 60).toFixed(1)}s`;
      await expect(pageB.getByTestId('play-dare-goal')).toHaveText(dare.score > 0 ? `Beat ${dare.score.toLocaleString('en-US')} in ${clock}` : `Beat ${clock}`, { timeout: 60_000 });
      await expect(pageB.getByTestId('hud-counter-dare')).toContainText('Beat');
      await expect(pageB.getByTestId('arcade-stage')).toHaveAttribute('data-control', 'drawsave');
      await expect(pageB.getByTestId('arcade-stage')).toHaveAttribute('data-lane-cells', /^8,12,/, { timeout: 90_000 });
      await settledGrid(pageB);
      await shotOf(pageB, info)(`dare-${orientation(pageB)}`);
      expect(errorsB, errorsB.join('\n')).toEqual([]);
    } finally {
      await friend.close();
    }
    test.info().annotations.push({ type: 'dare', description: `dare ${dare.dareId}: score ${String(dare.score)}, ${String(dare.ticks)} ticks; replay ${outcomeOf(replayed)} at ${String(replayed[HEADER.tick])} (original ${original.outcome} at ${String(original.tick)})` });
  });

  test('drawsave: the other orientation keeps the whole board reachable and draws by drag', async ({ browser, request, browserName }, info) => {
    test.setTimeout(300_000);
    const touch = info.project.use.hasTouch === true;
    // Telefon na šířku, desktop na výšku – nová stránka rovnou v té orientaci (WebKit na Windows po otočení okna
    // za běhu nechá plátno prázdné u každé hry, požadavek v integration.md).
    const landscapePhone = touch && LANDSCAPE[info.project.name] !== undefined;
    const native = info.project.use.viewport!;
    const context = await browser.newContext({
      ...(landscapePhone ? devices[LANDSCAPE[info.project.name]!]! : { viewport: { width: native.height, height: native.width } }),
      hasTouch: touch,
      baseURL: info.project.use.baseURL,
    });
    try {
      const page = await context.newPage();
      const errors = watchErrors(page);
      const finger = await fingerOf(page, context, info, browserName);
      const play = await openGame(page, request, game, finger);
      const where = `${info.project.name} ${orientation(page)}`;
      const cell = await expectReachable(play.grid(), page, where);
      test.info().annotations.push({ type: 'cell', description: `${where} ${JSON.stringify(page.viewportSize())}: smallest cell side ${cell.toFixed(1)} px` });
      // Krátké tahy v protějších rozích desky (nejdál od středu, kde se posunutá mřížka pozná nejdřív), pak střecha.
      // Inkoust: 1 + 1 + ~4,1 buňky z 10.
      await play.stroke([cellOf(0, 0), cellOf(1, 0)]);
      await play.stroke([cellOf(DRAWSAVE.cols - 1, DRAWSAVE.rows - 1), cellOf(DRAWSAVE.cols - 2, DRAWSAVE.rows - 1)]);
      await play.stroke(roofStroke(play.hero), { hold: true });
      expect(segmentCountOf(play.state)).toBe(3);
      await page.waitForTimeout(400);
      expect(await shownItem(page, 'line')).toBe(true);
      await shotOf(page, info)(`drawing-${orientation(page)}`);
      await play.lift();
      expect(errors, errors.join('\n')).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('drawsave: the defence runs smoothly (FPS)', async ({ page, request, context, browserName }, info) => {
    test.setTimeout(300_000);
    const touch = info.project.use.hasTouch === true;
    const errors = watchErrors(page);
    const finger = await fingerOf(page, context, info, browserName);
    const play = await openGame(page, request, game, finger);
    await play.stroke(roofStroke(play.hero));
    await play.run(FPS_FROM_TICK);
    const native = page.viewportSize()!;

    // FPS od sekundy před koncem kreslení: hodiny zase skutečné, hrozby padají a odrážejí se; 10 s snímků přes rAF.
    await page.evaluate(() => {
      const probe = window.__playShell as unknown as Probe;
      probe.byHand(false);
      probe.start();
    });
    const deltas = await page.evaluate(
      (windowMs) =>
        new Promise<number[]>((resolve) => {
          const out: number[] = [];
          let first = -1;
          let last = -1;
          const frame = (now: number) => {
            if (first < 0) first = now;
            else out.push(now - last);
            last = now;
            if (now - first < windowMs) requestAnimationFrame(frame);
            else resolve(out);
          };
          requestAnimationFrame(frame);
        }),
      FPS_WINDOW_MS,
    );
    const ticked = await capture(page);
    await shotOf(page, info)(`defend-live-${orientation(page)}`);
    expect(ticked.tick, 'the clock ran during the measurement').toBeGreaterThan(play.tick() + 60);
    const medianFrameMs = median(deltas);
    const record = {
      measuredAt: new Date().toISOString(),
      viewport: `${String(native.width)}x${String(native.height)}`,
      frames: deltas.length,
      windowMs: FPS_WINDOW_MS,
      medianFps: Math.round((1000 / medianFrameMs) * 10) / 10,
      medianFrameMs: Math.round(medianFrameMs * 100) / 100,
      p95FrameMs: Math.round(percentile(deltas, 95) * 100) / 100,
      maxFrameMs: Math.round(Math.max(...deltas) * 100) / 100,
      ticksDuring: ticked.tick - play.tick(),
      asserted: !touch,
    };
    const file = existsSync(FPS_FILE) ? (JSON.parse(readFileSync(FPS_FILE, 'utf8')) as { runs?: Record<string, unknown> }) : {};
    const runs = { ...(file.runs ?? {}), [info.project.name]: record };
    writeFileSync(
      FPS_FILE,
      `${JSON.stringify({ note: 'P68-S T14: drawsave defence, 10 s of requestAnimationFrame deltas from 1 s before the draw phase ends (the touch-drawn roof, threats falling and bouncing). chromium asserts median >= 40 FPS and p95 <= 33.3 ms; touch projects record only. Written by e2e/play-drawsave.spec.ts.', runs }, null, 1)}\n`,
    );
    if (!touch) {
      expect(record.medianFps, JSON.stringify(record)).toBeGreaterThanOrEqual(FPS_MIN_MEDIAN);
      expect(record.p95FrameMs, JSON.stringify(record)).toBeLessThanOrEqual(FPS_MAX_P95_MS);
    }
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
