/**
 * Směna se stavbou obchodu (P68-S T2) – jádro: stavba z palety, rozpočet mincí, provoz a obsluha, replay a vyzvání.
 *
 * Pin: hra, kde se stavba tiše neprovede nebo replay po stavbě uteče, vypadá na pohled hratelně. Testy proto čtou
 * hashovaný stav (mince, stanoviště po buňkách, obslouženo), ne scénu.
 */

import { describe, expect, it } from 'vitest';

import { unpackInputs, packInputs } from '../../score/dare';
import { type ArcadeState, type ArcadeWorld, BUTTON, type InputEvent, NO_INPUT } from '../contract';
import { hashArcade, instantiate, loadProgram, outcomeOf, replay, step } from '../kernel';
import { buildWorld } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import {
  BUILDSHIFT,
  PALETTE,
  PHASE,
  STATION,
  STATION_COST,
  arrivalTicks,
  buildshiftShop,
  coinsOf,
  customersFor,
  phaseOf,
  servedOf,
  shiftView,
  stationCode,
} from '../pieces/buildshift';
import { axisOfCell } from '../pieces/lanes';
import { runBot } from '../verify';

const HORIZON = 5400;

function worldOf(seed: number, goal: number = BUILDSHIFT.goal.default): ArcadeWorld {
  const parts = buildshiftShop.parts(seed, buildshiftShop.params.parse({ goal }), undefined);
  expect(parts.issues ?? []).toEqual([]);
  const built = buildWorld({ seed, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level, health: parts.health }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

const tap = (tick: number, cell: number): InputEvent => ({ tick, buttons: BUTTON.TAP, axis: axisOfCell(cell) });

/** Pustí záznam tik po tiku; `each` dostane stav po každém tiku. */
function run(world: ArcadeWorld, inputs: readonly InputEvent[], each?: (state: ArcadeState, tick: number) => void, horizon = HORIZON): ArcadeState {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  const byTick = new Map(inputs.map((event) => [event.tick, event]));
  for (let tick = 0; tick < horizon && outcomeOf(state) === 'running'; tick += 1) {
    step(state, byTick.get(tick) ?? NO_INPUT, program);
    each?.(state, tick);
  }
  return state;
}

/** Pec vlevo od pultu, pult přímo nad dveřmi (řada 4). */
const OVEN = 21;
const COUNTER = 22;

/** Ruční směna: vyber pec, postav ji, vyber pult, postav ho, Open, pak střídavě pec → pult. */
function handShift(trips: number): InputEvent[] {
  const inputs: InputEvent[] = [tap(5, PALETTE.oven), tap(10, OVEN), tap(15, PALETTE.counter), tap(20, COUNTER), tap(25, PALETTE.open)];
  for (let k = 0; k < trips; k += 1) {
    inputs.push(tap(40 + k * 300, OVEN), tap(40 + k * 300 + 150, COUNTER));
  }
  return inputs;
}

describe('buildshift kernel (P68-S T2)', () => {
  it('a hand-built oven and counter serve at least one customer', () => {
    const world = worldOf(1);
    let builtAt = -1;
    const state = run(world, handShift(10), (s, tick) => {
      if (builtAt < 0 && stationCode(s, shiftView(s).stations[COUNTER] as number) === STATION.counter) builtAt = tick;
    });
    const view = shiftView(state);
    expect(stationCode(state, view.stations[OVEN] as number)).toBe(STATION.oven);
    expect(stationCode(state, view.stations[COUNTER] as number)).toBe(STATION.counter);
    expect(builtAt).toBe(20);
    expect(servedOf(state)).toBeGreaterThanOrEqual(1);
  });

  it('building spends coins only on a free build cell with enough coins', () => {
    const world = worldOf(2);
    const coinsAfter = (inputs: InputEvent[], tick: number): number => {
      let coins = -1;
      run(world, inputs, (s, at) => {
        if (at === tick) coins = coinsOf(s);
      }, tick + 1);
      return coins;
    };
    const start = BUILDSHIFT.startCoins;
    // Volná buňka: pec stojí 3.
    expect(coinsAfter([tap(1, PALETTE.oven), tap(2, 0)], 2)).toBe(start - STATION_COST.oven);
    // Obsazená buňka, zeď, dveře, paleta bez výběru – mince se nezmění.
    expect(coinsAfter([tap(1, PALETTE.shelf), tap(2, 0), tap(3, 0)], 3)).toBe(start - STATION_COST.shelf);
    expect(coinsAfter([tap(1, PALETTE.shelf), tap(2, BUILDSHIFT.walls[0] as number)], 2)).toBe(start);
    expect(coinsAfter([tap(1, PALETTE.shelf), tap(2, BUILDSHIFT.door)], 2)).toBe(start);
    expect(coinsAfter([tap(2, 0)], 2)).toBe(start);
    // Bez mincí: dvě pece (3 + 3) vyčerpají 6, třetí se nepostaví a mince nejdou pod 0.
    let min = Number.MAX_SAFE_INTEGER;
    const spree = [tap(1, PALETTE.oven), tap(2, 0), tap(3, 1), tap(4, 2), tap(5, 3)];
    const state = run(world, spree, (s) => {
      min = Math.min(min, coinsOf(s));
    }, 10);
    expect(coinsOf(state)).toBe(0);
    expect(min).toBeGreaterThanOrEqual(0);
    const view = shiftView(state);
    expect([0, 1, 2, 3].map((cell) => stationCode(state, view.stations[cell] as number))).toEqual([STATION.oven, STATION.oven, 0, 0]);
  });

  it('the same seed and record give the same hash after every tick; another seed brings other arrivals', () => {
    const world = worldOf(3);
    const inputs = handShift(14);
    const first: string[] = [];
    const second: string[] = [];
    run(world, inputs, (s) => first.push(hashArcade(s)));
    run(world, inputs, (s) => second.push(hashArcade(s)));
    expect(first.length).toBeGreaterThan(1000);
    expect(second).toEqual(first);
    expect(arrivalTicks(3, customersFor(12))).not.toEqual(arrivalTicks(4, customersFor(12)));
    // Příchody jsou v pravidlech, ne v počátečním stavu: rozdíl se ukáže až během směny.
    const other: string[] = [];
    run(worldOf(4), inputs, (s) => other.push(hashArcade(s)));
    expect(other.at(-1)).not.toBe(first.at(-1));
  });

  it('an idle player opens an empty shop after the build window, serves nobody and loses', () => {
    const world = worldOf(5);
    let openedAt = -1;
    const state = run(world, [], (s, tick) => {
      if (openedAt < 0 && phaseOf(s) === PHASE.open) openedAt = tick;
    });
    expect(openedAt).toBe(BUILDSHIFT.buildTicks);
    expect(servedOf(state)).toBe(0);
    expect(outcomeOf(state)).toBe('lost');
  });

  it('the whole record survives packInputs → unpackInputs and replays to the same hash and outcome', () => {
    const world = worldOf(6);
    const inputs = handShift(14);
    const unpacked = unpackInputs(packInputs(inputs));
    expect(unpacked).toEqual(inputs);
    const direct = replay(world, inputs, ARCADE_LIBRARY, HORIZON);
    const again = replay(world, unpacked as InputEvent[], ARCADE_LIBRARY, HORIZON);
    expect(again).toEqual(direct);
    expect(direct.outcome).not.toBe('running');
  });

  it('a bot run survives packInputs → unpackInputs and replays to the same hash, outcome and served; without its build taps it does not (T7)', () => {
    const world = worldOf(7);
    const bot = runBot(world);
    expect(bot.outcome).toBe('won');
    const served = servedOf(run(world, bot.inputs));
    expect(served).toBeGreaterThanOrEqual(BUILDSHIFT.goal.default);
    const unpacked = unpackInputs(packInputs(bot.inputs));
    if (typeof unpacked === 'string') throw new Error(unpacked);
    expect(unpacked).toEqual(bot.inputs);
    const state = run(world, unpacked);
    expect({ hash: hashArcade(state), outcome: outcomeOf(state), served: servedOf(state) }).toEqual({ hash: bot.hash, outcome: bot.outcome, served });
    // Rovnost není samozřejmá: týž záznam bez ťuků stavby (výběr v paletě a stavba před Open) otevře prázdný obchod.
    const open = bot.inputs.findIndex((event) => event.axis === axisOfCell(PALETTE.open));
    expect(open).toBeGreaterThanOrEqual(2);
    const bare = run(world, bot.inputs.slice(open));
    expect({ outcome: outcomeOf(bare), served: servedOf(bare) }).not.toEqual({ outcome: bot.outcome, served });
    expect(servedOf(bare)).toBeLessThan(served);
  });
});
