/**
 * Směna se stavbou obchodu (P68-S T3) – robot a důkaz, že rozvržení mění propustnost.
 *
 * Pin: robot, který vyhrává bez stavby, by hru „dokázal“ a herní aserce by chyběla. Stavby a Open se proto počítají
 * ze stop jádra (efekt `spawn` pravidla `buildshift_build`, přechod fáze po ťuku na Open), ne ze skóre, a stejná
 * obsluha `serveWithLayout` nad špatným rozvržením musí prohrát.
 *
 * Otisk běhů robota (semínko → obslouženo, výsledek, hash) je v `evals/play/p68/stavba/bot-runs.json`; vědomé
 * přepsání: `BUILDSHIFT_BOT_RUNS=write` při běhu testu.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ARCADE_LIMITS, type ArcadeWorld, BUTTON, type InputEvent, NO_INPUT } from '../contract';
import { type ArcadeLibrary, buildWorld, hashArcade, instantiate, loadProgram, outcomeOf, replay, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { BUILDSHIFT, PALETTE, PHASE, STATION_COST, buildshiftShop, isBuildCell, manhattan, phaseOf, servedOf } from '../pieces/buildshift';
import { type ShopLayout, badLayout, buildshiftBot, planLayout, serveWithLayout } from '../pieces/buildshift-bot';
import { axisOfCell } from '../pieces/lanes';
import { runBot, verifyArcade } from '../verify';

const HORIZON = ARCADE_LIMITS.maxTicks;
const SEEDS = [101, 118, 135, 152, 169, 186, 203, 220, 237, 254, 271, 288] as const;
const GOALS = { min: BUILDSHIFT.goal.min, default: BUILDSHIFT.goal.default, max: BUILDSHIFT.goal.max } as const;
const RUNS_FILE = fileURLToPath(new URL('../../../../evals/play/p68/stavba/bot-runs.json', import.meta.url));

function worldOf(seed: number, goal: number): ArcadeWorld {
  const parts = buildshiftShop.parts(seed, buildshiftShop.params.parse({ goal }), undefined);
  expect(parts.issues ?? []).toEqual([]);
  const built = buildWorld({ seed, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level, health: parts.health }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

const libraryWith = (layout: ShopLayout): ArcadeLibrary => ({ ...ARCADE_LIBRARY, bots: { ...ARCADE_LIBRARY.bots, buildshift_bot: serveWithLayout(layout) } });

interface Shift {
  readonly outcome: string;
  readonly served: number;
  readonly tick: number;
  readonly hash: string;
  /** Stanoviště, která jádro opravdu vystavilo (efekt `spawn` pravidla `buildshift_build`). */
  readonly builds: number;
  /** Tik, ve kterém ťuk na Open otevřel obchod, nebo −1 (otevřel se sám po okně stavby, nebo vůbec). */
  readonly openedByTap: number;
}

/** Robot odehraje směnu; jeho záznam se přehraje se stopou jádra, ze které se počítají stavby a Open. */
function shiftOf(world: ArcadeWorld, library: ArcadeLibrary = ARCADE_LIBRARY): Shift {
  const run = runBot(world, library);
  const program = loadProgram(world, library);
  const state = instantiate(world);
  const buildRule = world.rules.findIndex((ref) => ref.id === 'buildshift_build');
  const byTick = new Map(run.inputs.map((event) => [event.tick, event]));
  let builds = 0;
  let openedByTap = -1;
  for (let tick = 0; tick < HORIZON && outcomeOf(state) === 'running'; tick += 1) {
    const input = byTick.get(tick) ?? NO_INPUT;
    const before = phaseOf(state);
    step(state, input, program, (rule, effect) => {
      if (rule === buildRule && effect.kind === 'spawn') builds += 1;
    });
    const openTap = (input.buttons & BUTTON.TAP) !== 0 && input.axis === axisOfCell(PALETTE.open);
    if (before === PHASE.build && phaseOf(state) === PHASE.open && openTap) openedByTap = tick;
  }
  expect(hashArcade(state)).toBe(run.hash);
  return { outcome: run.outcome, served: servedOf(state), tick: run.tick, hash: run.hash, builds, openedByTap };
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};
const wins = (shifts: readonly Shift[]): number => shifts.filter((shift) => shift.outcome === 'won').length;
const cost = (layout: ShopLayout): number => layout.opening.reduce((sum, at) => sum + STATION_COST[at.kind], 0);

/** Pult z rozvržení pravidlem (u dveří). */
const COUNTER = (planLayout().opening.find((at) => at.kind === 'counter') as { readonly cell: number }).cell;

const botShifts = new Map<number, Shift[]>();
const botShiftsAt = (goal: number): Shift[] => {
  const known = botShifts.get(goal);
  if (known !== undefined) return known;
  const shifts = SEEDS.map((seed) => shiftOf(worldOf(seed, goal)));
  botShifts.set(goal, shifts);
  return shifts;
};

describe('buildshift bot (P68-S T3)', () => {
  it('the world bot is the rule layout with the shared service, and the layout follows the rule', () => {
    const layout = planLayout();
    expect(buildshiftBot.id).toBe('buildshift_bot');
    // Pult nejblíž dveřím, pec hned vedle něj, zbytek mincí na polici, během směny další pec vedle pultu.
    expect(manhattan(COUNTER, BUILDSHIFT.door)).toBe(1);
    const oven = layout.opening.find((at) => at.kind === 'oven');
    expect(oven !== undefined && manhattan(oven.cell, COUNTER)).toBe(1);
    expect(cost(layout)).toBe(BUILDSHIFT.startCoins);
    expect(layout.later.map((at) => at.kind)).toContain('oven');
    expect([...layout.opening, ...layout.later].every((at) => isBuildCell(at.cell))).toBe(true);
  });

  it('wins every seed at the default and min goal and at least 10 of 12 at the max goal, within the horizon', () => {
    const tally = Object.fromEntries(Object.entries(GOALS).map(([name, goal]) => [name, wins(botShiftsAt(goal))]));
    expect(tally).toEqual({ min: 12, default: 12, max: expect.any(Number) as number });
    expect(tally.max).toBeGreaterThanOrEqual(10);
    for (const goal of Object.values(GOALS)) for (const shift of botShiftsAt(goal)) if (shift.outcome === 'won') expect(shift.tick).toBeLessThanOrEqual(HORIZON);
  });

  it('every bot record builds at least two stations, opens by tapping Open and serves at least the goal', () => {
    for (const goal of Object.values(GOALS)) {
      for (const shift of botShiftsAt(goal)) {
        expect(shift.builds).toBeGreaterThanOrEqual(2);
        expect(shift.openedByTap).toBeGreaterThanOrEqual(0);
        expect(shift.openedByTap).toBeLessThan(BUILDSHIFT.buildTicks);
        if (shift.outcome === 'won') expect(shift.served).toBeGreaterThanOrEqual(goal);
      }
    }
    // Během směny staví z vydělaných mincí: víc staveb, než kolik pokryly mince na začátku.
    expect(botShiftsAt(GOALS.default).some((shift) => shift.builds > planLayout().opening.length)).toBe(true);
  });

  it('runBot and verifyArcade accept the game on every seed at the default goal', () => {
    for (const seed of SEEDS) {
      const verdict = verifyArcade(worldOf(seed, GOALS.default));
      expect(verdict.failures).toEqual([]);
      expect(verdict.publishEligible).toBe(true);
      expect(verdict.bot.outcome).toBe('won');
      expect(verdict.idle.outcome).toBe('lost');
    }
  });

  it('an idle player loses every seed', () => {
    for (const goal of Object.values(GOALS)) {
      const outcomes = SEEDS.map((seed) => replay(worldOf(seed, goal), [] as InputEvent[], ARCADE_LIBRARY, HORIZON).outcome);
      expect(outcomes.filter((outcome) => outcome === 'lost')).toHaveLength(SEEDS.length);
    }
  });

  it('a fixed bad layout with the same service loses and serves at most 60 % of the good median', () => {
    const bad = badLayout();
    expect(manhattan((bad.opening[1] as { readonly cell: number }).cell, COUNTER)).toBeGreaterThanOrEqual(5);
    const library = libraryWith(bad);
    const shifts = SEEDS.map((seed) => shiftOf(worldOf(seed, GOALS.default), library));
    // Rozvržení stojí celé (pult a pec), prohra není nepostavená stavba.
    expect(shifts.every((shift) => shift.builds === bad.opening.length)).toBe(true);
    expect(SEEDS.length - wins(shifts)).toBeGreaterThanOrEqual(10);
    const good = median(botShiftsAt(GOALS.default).map((shift) => shift.served));
    const poor = median(shifts.map((shift) => shift.served));
    expect(poor).toBeLessThanOrEqual(0.6 * good);
  });

  it('two admissible layouts at the same budget differ in median served by at least 25 %', () => {
    // Stejná stanoviště (pult, pec, police) za stejné mince, jen pec stojí jinde: vedle pultu, nebo tři řady za ním.
    const near: ShopLayout = { opening: planLayout().opening, later: [] };
    const behind = COUNTER - 3 * BUILDSHIFT.cols;
    const far: ShopLayout = { opening: near.opening.map((at) => (at.kind === 'oven' ? { kind: 'oven', cell: behind } : at)), later: [] };
    expect(cost(far)).toBe(cost(near));
    expect(manhattan(behind, COUNTER)).toBe(3);
    const servedWith = (layout: ShopLayout): number => {
      const library = libraryWith(layout);
      const shifts = SEEDS.map((seed) => shiftOf(worldOf(seed, GOALS.max), library));
      expect(shifts.every((shift) => shift.builds === layout.opening.length)).toBe(true);
      return median(shifts.map((shift) => shift.served));
    };
    const fast = servedWith(near);
    const slow = servedWith(far);
    expect(fast - slow).toBeGreaterThanOrEqual(0.25 * fast);
  });

  it('the bot runs match the recorded snapshot (rewrite with BUILDSHIFT_BOT_RUNS=write)', () => {
    const runs = Object.values(GOALS).flatMap((goal) =>
      botShiftsAt(goal).map((shift, k) => ({ goal, seed: SEEDS[k] as number, served: shift.served, outcome: shift.outcome, tick: shift.tick, hash: shift.hash })),
    );
    const snapshot = { note: 'P68-S T3: buildshift bot runs (goal, seed -> served, outcome, tick, final hash). Rewrite on purpose: BUILDSHIFT_BOT_RUNS=write.', runs };
    if (process.env.BUILDSHIFT_BOT_RUNS === 'write') writeFileSync(RUNS_FILE, `${JSON.stringify(snapshot, null, 1)}\n`);
    expect(existsSync(RUNS_FILE)).toBe(true);
    expect(JSON.parse(readFileSync(RUNS_FILE, 'utf8'))).toEqual(snapshot);
  });
});
