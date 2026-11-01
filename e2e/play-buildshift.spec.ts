import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type APIRequestContext, devices, expect, type Page, test, type TestInfo } from '@playwright/test';

import { ARCADE_LIMITS, type ArcadeInput, type ArcadeState, type ArcadeWorld, BUTTON, HEADER, NO_INPUT, nativeRule } from '../src/play/arcade/contract';
import { type ArcadeProgram, hashArcade, instantiate, loadProgram, outcomeOf, step } from '../src/play/arcade/kernel';
import { ARCADE_LIBRARY } from '../src/play/arcade/library';
import { type ShopLayout, badLayout, planLayout, serveWithLayout } from '../src/play/arcade/pieces/buildshift-bot';
import { PALETTE, PHASE, STATION, STATION_COST, coinsOf, phaseOf, servedOf, stationCode, stationsByCell } from '../src/play/arcade/pieces/buildshift-world';
import { axisOfCell, cellOfAxis } from '../src/play/arcade/pieces/lanes';
import { capture, ticks } from './play-native-input';

/**
 * Směna se stavbou obchodu na telefonu i na desktopu (P68-S T6). Hra z ručního specu
 * `e2e/fixtures/p68-buildshift-spec.json` (roboti chtějí pizzu, cíl 10; žánr je `staged`, věty ho zatím nevolí).
 *
 * - **Stavba skutečnými ťuky:** test přečte `data-lane-cells`, prstem (`pixel7-touch`, `iphone-touch`) nebo myší
 *   (`chromium`) vybere v paletě druh, ťukne na buňku desky a nakonec na Open. Provoz hraje týmiž ťuky společná
 *   obsluha robota `serveWithLayout` nad rozvržením, které prst postavil – ne `handPlay`, ten relaci restartuje
 *   a přehraje robotovu vlastní stavbu, takže by stavbu prstem neověřil.
 * - **Rozhoduje rozvržení:** dobré rozvržení (robotovo `planLayout`) vyhraje, pevné špatné (`badLayout`, pec v rohu
 *   nejdál od pultu) se stejnou obsluhou obslouží méně a prohraje. Nečinný hráč prohraje.
 * - Hra běží na ručních hodinách (`byHand`); Node vede dvojče hry ze stejného světa a po každém ťuku porovná hash
 *   s prohlížečem – ťuk, který trefí jinou buňku, nebo stavba, která se neprovede, test hned shodí.
 * - Snímky na výšku i na šířku do `D:/caches/p68/stavba/shots/` (`P68_STAVBA_SHOTS` cestu přepíše), žádná chyba
 *   stránky ani konzole. FPS: 10 s snímků přes `requestAnimationFrame` v provozu; `chromium` hlídá medián ≥ 40 FPS
 *   a p95 doby snímku ≤ 33,3 ms, telefony jen zapíší. Čísla do `evals/play/p68/stavba/fps.json`.
 */

const FIXTURE = join(process.cwd(), 'e2e/fixtures/p68-buildshift-spec.json');
const SHOTS = process.env.P68_STAVBA_SHOTS ?? 'D:/caches/p68/stavba/shots';
const FPS_FILE = join(process.cwd(), 'evals/play/p68/stavba/fps.json');
const TOUCH_MIN = 44;
/** Okraj rámu kamery nahoře a nad dolní řadou HUD (`VIEW.edgePx` v `buildshift-camera.ts`). */
const FIT_MARGIN_PX = 8;
/** Druhá orientace telefonu: skutečný rozměr na šířku z Playwright, ne prohozené strany na výšku. */
const LANDSCAPE: Readonly<Record<string, string>> = { 'pixel7-touch': 'Pixel 7 landscape', 'iphone-touch': 'iPhone 15 landscape' };
const FPS_WINDOW_MS = 10_000;
const FPS_MIN_MEDIAN = 40;
const FPS_MAX_P95_MS = 33.3;

interface Probe {
  byHand(on: boolean): void;
  tickByHand(): { readonly runState: string; readonly tick: number };
  bodies(role: string): number;
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

/** Mřížka na plátně (`data-lane-cells`) v px stránky: deska 5 × 6 a pod ní řada palety. */
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
 * Celá mřížka (i paleta) leží v okně nad dolní řadou HUD (Restart, „Change one thing“, sdílení – vede přes celou
 * šířku) a buňka je aspoň dotykový cíl. Výjimka: na šířku telefonu se 7 řad po 44 px nad dolní řadu nevejde
 * (požadavek v `evals/play/p68/stavba/integration.md`) – tam řady vyplní volnou výšku, jako pinuje
 * `buildshift-camera.test.ts`. Vrací nejmenší stranu buňky (px).
 */
async function expectReachable(grid: Grid, page: Page, where: string, landscapePhone: boolean): Promise<number> {
  const viewport = page.viewportSize()!;
  const bar = (await page.getByRole('navigation', { name: 'Game actions' }).boundingBox())!;
  expect(grid.cols * grid.rows, where).toBe(35);
  expect(grid.left, `${where}: grid left edge`).toBeGreaterThanOrEqual(-1);
  expect(grid.top, `${where}: grid top edge`).toBeGreaterThanOrEqual(-1);
  expect(grid.right, `${where}: grid right edge`).toBeLessThanOrEqual(viewport.width + 1);
  expect(grid.bottom, `${where}: palette under the HUD bottom row`).toBeLessThanOrEqual(bar.y + 1);
  const cell = Math.min(grid.cellW, grid.cellH);
  const floor = landscapePhone ? Math.min(TOUCH_MIN, (bar.y - 2 * FIT_MARGIN_PX) / 8) : TOUCH_MIN;
  expect(cell, `${where}: cell smaller than a touch target`).toBeGreaterThanOrEqual(floor);
  return cell;
}

const probe = (page: Page) => ({
  byHand: (on: boolean) => page.evaluate((value) => (window.__playShell as unknown as Probe).byHand(value), on),
  tick: () => page.evaluate(() => (window.__playShell as unknown as Probe).tickByHand()),
  stations: () => page.evaluate(() => (window.__playShell as unknown as Probe).bodies('target')),
});

/**
 * Otevřená hra na ručních hodinách a její dvojče v Node. `tap` = skutečný ťuk na buňku + jeden tik v obou; `wait` =
 * tik bez vstupu jen v Node (prohlížeč ho dožene před dalším ťukem); `sync` dožene a porovná hash.
 */
async function openShop(page: Page, request: APIRequestContext, game: { readonly url: string; readonly id: string }, touch: boolean) {
  await page.goto(game.url);
  const stage = page.getByTestId('arcade-stage');
  await expect(stage).toHaveAttribute('data-control', 'buildshift', { timeout: 60_000 });
  await expect(stage).toHaveAttribute('data-lane-cells', /^5,7(?:,[\d.]+){4}$/, { timeout: 90_000 });
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 90_000 });
  const world = ((await (await request.get(`/api/play/games/${game.id}`)).json()) as { arcade: ArcadeWorld }).arcade;
  const grid = await settledGrid(page);
  const shell = probe(page);
  await shell.byHand(true);

  const state: ArcadeState = instantiate(world);
  const program: ArcadeProgram = loadProgram(world, ARCADE_LIBRARY);
  let behind = 0;
  const tickOf = () => state[HEADER.tick] as number;
  const start = await capture(page);
  expect(start.tick, 'the shop opened with a running clock').toBe(0);
  expect(start.hash).toBe(hashArcade(state));

  const sync = async () => {
    if (behind > 0) await ticks(page, behind);
    behind = 0;
    const seen = await capture(page);
    expect(seen.tick).toBe(tickOf());
    expect(seen.hash, `browser and Node diverged at tick ${String(tickOf())}`).toBe(hashArcade(state));
    return seen;
  };
  return {
    world,
    state,
    goal: Number(nativeRule(world.rules, 'buildshift_goal')!.params.goal),
    player: world.initial[HEADER.player] as number,
    tick: tickOf,
    shell,
    grid: () => grid,
    tap: async (cell: number) => {
      if (behind > 0) await ticks(page, behind);
      behind = 0;
      const at = grid.center(cell);
      if (touch) await page.touchscreen.tap(at.x, at.y);
      else await page.mouse.click(at.x, at.y);
      await shell.tick();
      const input: ArcadeInput = { buttons: BUTTON.TAP, axis: axisOfCell(cell) };
      step(state, input, program);
      const seen = await capture(page);
      expect(seen.inputs.at(-1), `the tap on cell ${String(cell)} reached the game`).toEqual({ tick: tickOf() - 1, ...input });
      expect(seen.hash, `browser and Node diverged after the tap on cell ${String(cell)}`).toBe(hashArcade(state));
    },
    wait: () => {
      step(state, NO_INPUT, program);
      behind += 1;
    },
    sync,
  };
}
type Shop = Awaited<ReturnType<typeof openShop>>;

const PALETTE_OF = { oven: PALETTE.oven, counter: PALETTE.counter, shelf: PALETTE.shelf } as const;

/** Stavba prstem: druh v paletě, buňka desky, …, Open. Vrací stanoviště, která jádro opravdu postavilo. */
async function buildByTaps(shop: Shop, layout: ShopLayout): Promise<Map<number, number>> {
  const before = await shop.shell.stations();
  for (const at of layout.opening) {
    await shop.tap(PALETTE_OF[at.kind]);
    await shop.tap(at.cell);
  }
  expect(phaseOf(shop.state)).toBe(PHASE.build);
  await shop.tap(PALETTE.open);
  expect(phaseOf(shop.state), 'Open opened the shop').toBe(PHASE.open);
  const built = new Map<number, number>();
  stationsByCell(shop.state).forEach((body, cell) => {
    if (body >= 0) built.set(cell, stationCode(shop.state, body));
  });
  expect([...built].sort((a, b) => a[0] - b[0])).toEqual(layout.opening.map((at) => [at.cell, STATION[at.kind]] as const).sort((a, b) => a[0] - b[0]));
  expect(coinsOf(shop.state)).toBe(6 - layout.opening.reduce((sum, at) => sum + STATION_COST[at.kind], 0));
  // Sonda prohlížeče vidí tatáž stanoviště jako Node (živá těla role `target`).
  expect((await shop.shell.stations()) - before).toBe(layout.opening.length);
  return built;
}

/**
 * Provoz ťuky: obsluha `serveWithLayout(layout)` volí nad stavem dvojčete (bez zpoždění reakce), test každý její ťuk
 * zahraje prstem nebo myší. Do konce směny; vrací výsledek a obsloužené.
 */
async function serveByTaps(shop: Shop, layout: ShopLayout, onTick?: () => Promise<void>): Promise<{ readonly outcome: string; readonly served: number; readonly taps: number }> {
  const bot = serveWithLayout(layout);
  const params = bot.params.parse(shop.world.bot.params);
  let taps = 0;
  while (outcomeOf(shop.state) === 'running' && shop.tick() < ARCADE_LIMITS.maxTicks) {
    const want = bot.decide({ state: shop.state, player: shop.player, tick: shop.tick(), recent: [] }, params);
    if ((want.buttons & BUTTON.TAP) !== 0 && want.axis > 0) {
      await shop.tap(cellOfAxis(want.axis));
      taps += 1;
    } else shop.wait();
    if (onTick !== undefined) await onTick();
  }
  await shop.sync();
  return { outcome: outcomeOf(shop.state), served: servedOf(shop.state), taps };
}

function shotOf(page: Page, info: TestInfo) {
  mkdirSync(SHOTS, { recursive: true });
  return (name: string) => page.screenshot({ path: join(SHOTS, `${info.project.name}-${name}.png`) });
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

test.describe('buildshift (P68-S T6)', () => {
  test.describe.configure({ mode: 'serial' });
  let game = { url: '', id: '' };
  let goodServed = -1;

  test.beforeAll(async ({ request }) => {
    game = await publishFixture(request);
  });

  test('buildshift: a good layout built by taps serves the goal and wins', async ({ page, request }, info) => {
    test.setTimeout(600_000);
    const touch = info.project.use.hasTouch === true;
    const errors = watchErrors(page);
    const shot = shotOf(page, info);
    const shop = await openShop(page, request, game, touch);
    await expectReachable(shop.grid(), page, `${info.project.name} ${orientation(page)}`, false);
    await shot(`build-${orientation(page)}`);

    const layout = planLayout();
    const built = await buildByTaps(shop, layout);
    expect(built.size, 'at least two stations built by taps').toBeGreaterThanOrEqual(2);
    await shop.sync();
    await page.waitForTimeout(400);
    await shot(`open-${orientation(page)}`);

    let midShot = false;
    const run = await serveByTaps(shop, layout, async () => {
      if (midShot || servedOf(shop.state) < Math.floor(shop.goal / 2)) return;
      midShot = true;
      await shop.sync();
      await page.waitForTimeout(300);
      await shot(`service-${orientation(page)}`);
    });
    expect(run.outcome, `served ${String(run.served)} of ${String(shop.goal)} by tick ${String(shop.tick())}`).toBe('won');
    expect(run.served).toBeGreaterThanOrEqual(shop.goal);
    // Během směny robot staví i za vydělané mince (`later`): víc stanovišť, než postavila stavba prstem.
    expect([...stationsByCell(shop.state)].filter((body) => body >= 0).length).toBeGreaterThan(built.size);
    goodServed = run.served;

    await expect(page.getByTestId('play-postrun')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('play-postrun')).toContainText('You did it!');
    await shot(`result-${orientation(page)}`);
    expect(errors, errors.join('\n')).toEqual([]);
    test.info().annotations.push({ type: 'served', description: `good layout: ${String(run.served)}/${String(shop.goal)} at tick ${String(shop.tick())}, ${String(run.taps)} service taps` });
  });

  test('buildshift: a bad layout built by taps serves fewer and loses', async ({ page, request }, info) => {
    test.setTimeout(600_000);
    expect(goodServed, 'the good-layout run must go first').toBeGreaterThan(0);
    const touch = info.project.use.hasTouch === true;
    const errors = watchErrors(page);
    const shop = await openShop(page, request, game, touch);
    const layout = badLayout();
    const built = await buildByTaps(shop, layout);
    expect(built.size).toBe(2);
    const run = await serveByTaps(shop, layout);
    // Stavba změnila počet obsloužených: tatáž obsluha nad špatným rozvržením obslouží méně a prohraje.
    expect(run.served, `bad layout served ${String(run.served)}, good layout ${String(goodServed)}`).toBeLessThan(goodServed);
    expect(run.outcome).toBe('lost');
    await expect(page.getByTestId('play-postrun')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('play-postrun')).toContainText(run.served > 0 ? 'So close.' : 'Try again!');
    await shotOf(page, info)(`bad-result-${orientation(page)}`);
    expect(errors, errors.join('\n')).toEqual([]);
    test.info().annotations.push({ type: 'served', description: `bad layout: ${String(run.served)}/${String(shop.goal)} (good ${String(goodServed)})` });
  });

  test('buildshift: an idle player opens an empty shop and loses', async ({ page }) => {
    test.setTimeout(180_000);
    const errors = watchErrors(page);
    await page.goto(game.url);
    await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 90_000 });
    const end = await page.evaluate(() => (window.__playShell as unknown as Probe).idleRun());
    expect(end.runState).toBe('lost');
    await expect(page.getByTestId('play-postrun')).toContainText('Try again!', { timeout: 30_000 });
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('buildshift: the other orientation keeps the whole grid under the thumb and builds by taps', async ({ browser, request }, info) => {
    test.setTimeout(300_000);
    const touch = info.project.use.hasTouch === true;
    // Telefon na šířku, desktop na výšku – nová stránka rovnou v té orientaci. Otočení okna za běhu na WebKitu (Windows)
    // nechá plátno prázdné u každé hry (i šipek P66), to je požadavek v integration.md, ne stavba tohoto žánru.
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
      const shop = await openShop(page, request, game, touch);
      const where = `${info.project.name} ${orientation(page)}`;
      const cell = await expectReachable(shop.grid(), page, where, landscapePhone);
      test.info().annotations.push({ type: 'cell', description: `${where} ${JSON.stringify(page.viewportSize())}: smallest cell side ${cell.toFixed(1)} px` });
      // Každá buňka palety i deska dostane skutečný ťuk, který hra zapíše (dolní řada HUD ho nesmí spolknout).
      const layout = planLayout();
      await buildByTaps(shop, layout);
      await shop.tap(PALETTE.coins);
      // Na zabranou buňku se nestaví: prodavač jde k peci.
      await shop.tap(layout.opening.find((at) => at.kind === 'oven')!.cell);
      expect(stationsByCell(shop.state).filter((body) => body >= 0)).toHaveLength(layout.opening.length);
      await page.waitForTimeout(400);
      await shotOf(page, info)(`open-${orientation(page)}`);
      expect(errors, errors.join('\n')).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('buildshift: service runs smoothly (FPS)', async ({ page, request }, info) => {
    test.setTimeout(300_000);
    const touch = info.project.use.hasTouch === true;
    const errors = watchErrors(page);
    const shot = shotOf(page, info);
    const shop = await openShop(page, request, game, touch);
    await buildByTaps(shop, planLayout());
    const native = page.viewportSize()!;

    // FPS v provozu: hodiny zase skutečné, zákazníci přicházejí a řadí se; 10 s snímků přes rAF.
    await shop.sync();
    await page.evaluate(() => {
      const shell = window.__playShell as unknown as Probe;
      shell.byHand(false);
      shell.start();
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
    await shot(`service-live-${orientation(page)}`);
    expect(ticked.tick, 'the clock ran during the measurement').toBeGreaterThan(shop.tick() + 60);
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
      ticksDuring: ticked.tick - shop.tick(),
      asserted: !touch,
    };
    const file = existsSync(FPS_FILE) ? (JSON.parse(readFileSync(FPS_FILE, 'utf8')) as { runs?: Record<string, unknown> }) : {};
    const runs = { ...(file.runs ?? {}), [info.project.name]: record };
    writeFileSync(
      FPS_FILE,
      `${JSON.stringify({ note: 'P68-S T6: buildshift service phase, 10 s of requestAnimationFrame deltas after the touch-built good layout opened (customers arriving, seller idle). chromium asserts median >= 40 FPS and p95 <= 33.3 ms; touch projects record only. Written by e2e/play-buildshift.spec.ts.', runs }, null, 1)}\n`,
    );
    if (!touch) {
      expect(record.medianFps, JSON.stringify(record)).toBeGreaterThanOrEqual(FPS_MIN_MEDIAN);
      expect(record.p95FrameMs, JSON.stringify(record)).toBeLessThanOrEqual(FPS_MAX_P95_MS);
    }
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
