import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

import { type ArcadeWorld, AXIS_MAX, BODY, COUNTER, FLAG, HEADER, ROLE, bodyBase, bodyHp, nativeRule } from '../src/play/arcade/contract';
import { hooksOf, inBreak, roundOf } from '../src/play/arcade/hooks';
import { LEGIBLE_CAP, LEGIBLE_SHARE } from '../src/play/arcade/models';
import { type ArrowsTapParams, cursorOf, gridOfRound } from '../src/play/arcade/pieces/arrows';
import { arrowsChoices } from '../src/play/arcade/pieces/arrows-bot';
import { occupancy, roundOfCode } from '../src/play/arcade/pieces/arrows-level';
import { capture, replayState, ticks } from './play-native-input';

/**
 * Šipky na telefonu i na desktopu (P66 T9, T2a): hra z ručního specu `e2e/fixtures/p66-arrows-spec.json` (věty k žánru
 * povede až T12) se otevře, dá se dohrát prstem (`pixel7-touch`) i klávesnicí (`chromium`) a skončí kartou výsledku.
 *
 * - Mřížka leží celá ve spodních 45 % telefonu, buňka má aspoň 44 px (`--sp-size-touch-min`), hrdina je čitelný
 *   (`LEGIBLE_SHARE.hero`, pod ním jen zvětšený na strop), konzole bez chyb.
 * - Náraz: ťuk na zatarasený kus vezme srdce a kus zůstane.
 *
 * Hodiny jsou ruční (`byHand`); co zahrát, říká stav přehraný v Node ze záznamu (`replayState`, týž hash jako
 * Chromium). Snímky pro oko do `D:/caches/p66/arrows/` (`P66_ARROWS_SHOTS` cestu přepíše).
 */

const FIXTURE = join(process.cwd(), 'e2e/fixtures/p66-arrows-spec.json');
const SHOTS = process.env.P66_ARROWS_SHOTS ?? 'D:/caches/p66/arrows';
const TOUCH_MIN = 44;

interface Shell {
  byHand(on: boolean): void;
  tickByHand(): { readonly runState: string; readonly tick: number; readonly items: number; readonly health: number; readonly score: number };
  idleRun(): { readonly runState: string; readonly tick: number };
}

async function publish(request: APIRequestContext): Promise<{ url: string; id: string }> {
  const spec = JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown;
  const response = await request.post('/api/play/games', { data: { spec } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  const url = ((await response.json()) as { url: string }).url;
  return { url, id: url.split('/').at(-1)! };
}

const tick = (page: Page) => page.evaluate(() => (window.__playShell as unknown as Shell).tickByHand());
const alive = (state: Int32Array, body: number) => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;
const drawnPieces = (page: Page) => page.evaluate(() => window.__playFrame!().items.piece?.count ?? 0);

/** Mřížka na plátně (`data-lane-cells`) v px stránky. */
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
    top: box.y + top * box.height,
    bottom: box.y + bottom * box.height,
    /** Střed buňky `cell` (po řadách zleva shora). */
    center: (cell: number) => ({ x: box.x + left * box.width + ((cell % cols) + 0.5) * cellW, y: box.y + top * box.height + (Math.floor(cell / cols) + 0.5) * cellH }),
  };
}

/** Hra z fixture otevřená, mřížka zapsaná na plátně; svět ze serveru a pomocníci pro hru rukou. */
async function openArrows(page: Page, request: APIRequestContext, touch: boolean) {
  const { url, id } = await publish(request);
  await page.goto(url);
  const stage = page.getByTestId('arcade-stage');
  await expect(stage).toHaveAttribute('data-control', 'arrows', { timeout: 60_000 });
  await expect(stage).toHaveAttribute('data-lane-cells', /^\d+,\d+(?:,[\d.]+){4}$/, { timeout: 60_000 });
  await page.waitForFunction(() => window.__playFrame?.().hero != null && window.__playShell !== undefined, undefined, { timeout: 90_000 });
  const world = ((await (await request.get(`/api/play/games/${id}`)).json()) as { arcade: ArcadeWorld }).arcade;
  const initial = Int32Array.from(world.initial);
  const pieces = Array.from({ length: initial[HEADER.bodyCount] as number }, (_, body) => body).filter((body) => initial[bodyBase(body) + BODY.role] === ROLE.target && bodyHp(initial, body) > 0);
  return {
    world,
    params: nativeRule(world.rules, 'arrows_tap')!.params as ArrowsTapParams,
    keeper: hooksOf(world.rules)!.keeper,
    player: world.initial[HEADER.player] as number,
    /** Kusy prvního kola (scéna je kreslí od startu). */
    firstRound: pieces.filter((body) => roundOfCode(bodyHp(initial, body)) === 0),
    pieces,
    /** Stav hry v tuhle chvíli: záznam relace přehraný v Node, hash se musí shodovat s Chromiem. */
    now: async (): Promise<Int32Array> => replayState(world, await capture(page)),
    tapCell: async (cell: number) => {
      const { x, y } = (await gridOnPage(page)).center(cell);
      if (touch) await page.touchscreen.tap(x, y);
      else await page.mouse.click(x, y);
    },
    byHand: () => page.evaluate(() => (window.__playShell as unknown as Shell).byHand(true)),
  };
}

test('arrows: the grid sits under the thumb, a bump costs a heart, the game plays to its end card by touch or keys (P66 T9)', async ({ page, request }, info) => {
  test.setTimeout(300_000);
  const touch = info.project.name === 'pixel7-touch';
  mkdirSync(SHOTS, { recursive: true });
  const shot = (name: string) => page.screenshot({ path: join(SHOTS, `${info.project.name}-${name}.png`) });
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  const game = await openArrows(page, request, touch);
  const { params, keeper, player } = game;

  // Hrdina čitelný: aspoň 20 % výšky, nebo zvětšený čitelností na strop a aspoň 8 % × strop (jako `play-hero-size`).
  await expect
    .poll(async () => page.evaluate(() => {
      const frame = window.__playFrame!();
      return { share: (frame.hero!.maxY - frame.hero!.minY) / 2, legible: frame.legible.hero };
    }).then(({ share, legible }) => share >= LEGIBLE_SHARE.hero || (legible >= LEGIBLE_CAP - 1e-6 && share >= 0.08 * LEGIBLE_CAP)), { timeout: 30_000 })
    .toBe(true);
  // Věci věty jsou vidět: kusy první mřížky kreslí scéna (`userData.item`).
  expect(game.firstRound.length).toBeGreaterThan(0);
  await expect.poll(() => drawnPieces(page)).toBe(game.firstRound.length);

  // Mřížka pod palcem: buňka aspoň 44 px, na telefonu celá ve spodních 45 % výšky.
  const grid = await gridOnPage(page);
  expect(grid.cols * grid.rows).toBeLessThan(AXIS_MAX);
  expect(Math.min(grid.cellW, grid.cellH), 'buňka menší než dotykový cíl').toBeGreaterThanOrEqual(TOUCH_MIN);
  if (touch) {
    const viewport = page.viewportSize()!;
    expect(grid.top, 'mřížka nad dolními 45 % výšky').toBeGreaterThanOrEqual(viewport.height * 0.55 - 1);
    expect(grid.bottom).toBeLessThanOrEqual(viewport.height);
  }
  await shot('start');

  await game.byHand();
  let last = await tick(page);
  await expect(page.getByTestId('hook-round-banner')).toHaveText('Round 1 of 3');

  // Náraz: zatarasený kus zůstane, srdce dolů.
  let state = await game.now();
  const stuck = arrowsChoices(state, { keeper, grids: params.grids }).blocked[0];
  expect(stuck, 'první mřížka nemá zatarasený kus').toBeDefined();
  const stuckBody = (occupancy(state, 0, gridOfRound(params.grids, 0))[stuck!] as number) - 1;
  await game.tapCell(stuck!);
  last = await tick(page);
  expect(last.health).toBe(2);
  state = await game.now();
  expect(alive(state, stuckBody)).toBe(true);
  await expect(page.getByTestId('hud-counter-lives')).toHaveAttribute('data-count', '2');

  // Dohrát: prst na první volný kus, nebo klávesnice – šipka vpravo k němu a mezerník.
  let midShot = false;
  while (last.runState === 'running' && last.tick < 5400) {
    state = await game.now();
    if (inBreak(state, keeper)) {
      await ticks(page, 10);
      last = await tick(page);
      continue;
    }
    const target = arrowsChoices(state, { keeper, grids: params.grids }).free[0];
    if (target === undefined) {
      last = await tick(page);
      continue;
    }
    if (!midShot && roundOf(state, keeper) === 1) {
      // Kamera dojíždí na větší mřížku kola plynule (jen obraz); snímek až po dojetí.
      await page.waitForTimeout(1500);
      await shot('mid');
      midShot = true;
    }
    if (touch) await game.tapCell(target);
    else {
      const round = roundOf(state, keeper);
      const occ = occupancy(state, round, gridOfRound(params.grids, round));
      // Kolikrát vpravo: kusy po řadách od kurzoru až k cíli. Bez kurzoru vede první stisk na první kus; kurzor nad
      // odletěným kusem (nebo z menší mřížky) ovládání nejdřív posune na další kus po řadách.
      const cursor = cursorOf(state, player) - 1;
      const order = Array.from({ length: occ.length }, (_, index) => index).filter((index) => (occ[index] as number) > 0);
      const snapped = cursor < 0 ? -1 : (occ[cursor] ?? 0) > 0 ? cursor : (order.find((index) => index > cursor) ?? (order[0] as number));
      const steps = snapped < 0 ? order.indexOf(target) + 1 : (order.indexOf(target) - order.indexOf(snapped) + order.length) % order.length;
      for (let step = 0; step < steps; step += 1) {
        await page.keyboard.press('ArrowRight');
        await tick(page);
      }
      if (steps > 0) expect(cursorOf(await game.now(), player) - 1).toBe(target);
      await page.keyboard.press(' ');
    }
    last = await tick(page);
  }
  expect(last.runState).toBe('won');
  expect(last.items).toBe(game.pieces.length);
  expect(midShot).toBe(true);
  // Výsledek: karta kitu, anglicky.
  await expect(page.getByTestId('play-postrun')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('play-postrun')).toContainText('You did it!');
  await shot('result');
  state = await game.now();
  expect(state[HEADER.counters + COUNTER.items]).toBe(game.pieces.length);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('arrows: a player who does nothing loses on the clock (P66 T9)', async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.goto((await publish(request)).url);
  await expect(page.getByTestId('arcade-stage')).toHaveAttribute('data-control', 'arrows', { timeout: 60_000 });
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
  const idle = await page.evaluate(() => (window.__playShell as unknown as Shell).idleRun());
  expect(idle.runState).toBe('lost');
  await expect(page.getByTestId('play-postrun')).toContainText('Try again', { timeout: 30_000 });
});
