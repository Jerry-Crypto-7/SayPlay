/**
 * Kresli a zachraň (P68-S T12) – brána proveditelnosti jádra: determinismus po tikách, přehrání přes `packInputs`,
 * prototyp robota se střechou proti nečinnému hráči a čáře mimo, a srážka hrozby s čarou bez proskočení.
 *
 * Pin: hra, kde čára tiše nic nezastaví, replay uteče nebo rychlá hrozba čarou proskočí, vypadá na pohled hratelně.
 * Testy proto čtou hashovaný stav a výsledek jádra, ne scénu.
 */

import { describe, expect, it } from 'vitest';

import { DRAWSAVE_STROKE, P68_MAX_TICKS } from '../../genre/p68-contract';
import { packInputs, unpackInputs } from '../../score/dare';
import { type ArcadeState, type ArcadeWorld, BODY, BODY_STRIDE, BUTTON, FLAG, HEADER, type InputEvent, NO_INPUT, bodyBase } from '../contract';
import { buildWorld, hashArcade, instantiate, loadProgram, outcomeOf, replay, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import {
  BOARD_CELLS,
  DRAWSAVE,
  DRAWSAVE_BODIES,
  KEEPER_SLOTS,
  PHASE,
  REACH,
  THREAT_SLOTS,
  addSegment,
  cellOf,
  cellX,
  cellY,
  colOf,
  defendStartOf,
  drawsaveLevel,
  heroCellOf,
  inkUsedOf,
  isqrt,
  phaseOf,
  rowOf,
  segmentCountOf,
  segmentsOf,
} from '../pieces/drawsave';
import { roofStroke } from '../pieces/drawsave-bot';
import { axisOfCell } from '../pieces/lanes';

const HORIZON = P68_MAX_TICKS;
const SEEDS = [101, 118, 135, 152, 169, 186, 203, 220, 237, 254, 271, 288] as const;
const HOLD = BUTTON[DRAWSAVE_STROKE.hold];

function partsOf(seed: number, threats: number = DRAWSAVE.threats.default) {
  const parts = drawsaveLevel.parts(seed, drawsaveLevel.params.parse({ threats }), undefined);
  expect(parts.issues ?? []).toEqual([]);
  return parts;
}

function worldOf(seed: number, threats?: number): ArcadeWorld {
  const parts = partsOf(seed, threats);
  const built = buildWorld({ seed, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level, health: parts.health }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

/** Tah: `HOLD` na buňkách `cells` v po sobě jdoucích tikách od `start`; další tik bez záznamu prst zvedne. */
const stroke = (start: number, cells: readonly number[]): InputEvent[] => cells.map((cell, k) => ({ tick: start + k, buttons: HOLD, axis: axisOfCell(cell) }));

const clampCol = (col: number): number => Math.max(0, Math.min(DRAWSAVE.cols - 1, col));

/** Tah robota (`roofStroke` z kusu `drawsave_bot`): jeden tah ze dvou bodů = střecha nad postavou. */
const roof = (world: ArcadeWorld): InputEvent[] => stroke(5, roofStroke(heroCellOf(instantiate(world))));

/** Čára mimo: vodorovný tah ve druhé řadě na opačné polovině desky, než postava sedí. */
function lineOff(world: ArcadeWorld): InputEvent[] {
  const left = colOf(heroCellOf(instantiate(world))) >= DRAWSAVE.cols / 2;
  return stroke(5, left ? [cellOf(0, 1), cellOf(2, 1)] : [cellOf(5, 1), cellOf(7, 1)]);
}

/**
 * Čmáranice z celočíselného LCG (bez `Math.random`): prst dole už v tiku 0, tři krátké tahy tažením i skoky, prst
 * chvíli na téže buňce i mimo mřížku, a poslední dlouhý tah tažením, který inkoust vyčerpá a drží se i po konci kreslení.
 */
function scribble(seed: number): InputEvent[] {
  let s = seed >>> 0;
  const next = (n: number): number => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s >>> 16) % n;
  };
  const drag = (cell: number): number => cellOf(clampCol(colOf(cell) + next(3) - 1), Math.max(0, Math.min(DRAWSAVE.rows - 1, rowOf(cell) + next(3) - 1)));
  const events: InputEvent[] = [];
  let tick = 0;
  let cell = next(BOARD_CELLS);
  for (let j = 0; j < 3; j += 1) {
    for (let k = 2 + next(2); k > 0; k -= 1) {
      cell = next(6) === 0 ? next(BOARD_CELLS) : drag(cell);
      events.push({ tick, buttons: HOLD, axis: next(10) === 0 ? 0 : axisOfCell(cell) });
      tick += 1;
    }
    tick += 1 + next(3);
  }
  for (let k = 0; k < 40; k += 1) {
    cell = drag(cell);
    events.push({ tick, buttons: HOLD, axis: axisOfCell(cell) });
    tick += 1;
  }
  return events;
}

/** Pustí záznam tik po tiku přes celý horizont (po konci běhu jádro stojí); `each` dostane stav po každém tiku. */
function run(world: ArcadeWorld, inputs: readonly InputEvent[], each?: (state: ArcadeState) => void): ArcadeState {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  const byTick = new Map(inputs.map((event) => [event.tick, event]));
  for (let tick = 0; tick < HORIZON; tick += 1) {
    step(state, byTick.get(tick) ?? NO_INPUT, program);
    each?.(state);
  }
  return state;
}

const hashes = (world: ArcadeWorld, inputs: readonly InputEvent[]): string[] => {
  const out: string[] = [];
  run(world, inputs, (state) => out.push(hashArcade(state)));
  return out;
};

describe('drawsave kernel feasibility gate (P68-S T12)', () => {
  it('draws strokes as connected dots within the ink budget and ends the draw phase on the window or when the ink runs out', () => {
    const world = worldOf(SEEDS[0]);
    const program = loadProgram(world, ARCADE_LIBRARY);
    const state = instantiate(world);
    const play = (inputs: readonly InputEvent[]): void => {
      const byTick = new Map(inputs.map((event) => [event.tick, event]));
      for (let tick = state[HEADER.tick] as number; tick <= (inputs.at(-1)?.tick ?? 0) + 1; tick += 1) step(state, byTick.get(tick) ?? NO_INPUT, program);
    };
    // Skok přes tři sloupce a pak soused: dva body navíc = dvě úsečky, prst na téže buňce nic nepřidá.
    play(stroke(1, [cellOf(1, 2), cellOf(4, 2), cellOf(4, 2), cellOf(4, 3)]));
    expect(segmentsOf(state).map((s) => s.length)).toEqual([3000, 1000]);
    // Po zvednutí prstu začne nový tah bez spojení s minulým.
    play(stroke(10, [cellOf(6, 0), cellOf(7, 1)]));
    expect(segmentsOf(state).map((s) => [s.ax, s.ay, s.length])).toEqual([
      [cellX(cellOf(1, 2)), cellY(cellOf(1, 2)), 3000],
      [cellX(cellOf(4, 2)), cellY(cellOf(4, 2)), 1000],
      [cellX(cellOf(6, 0)), cellY(cellOf(6, 0)), 1414],
    ]);
    // Úsečka delší než zbylý inkoust (4 586) se zahodí a bod tahu zůstane; kratší projdou a poslední ho srazí pod
    // jednu buňku (172): kreslení skončí hned, ne až po okně.
    play(stroke(20, [cellOf(0, 11), cellOf(7, 11), cellOf(3, 11), cellOf(4, 10)]));
    expect(segmentsOf(state).map((s) => s.length)).toEqual([3000, 1000, 1414, 3000, 1414]);
    expect(DRAWSAVE.ink - inkUsedOf(state)).toBe(172);
    expect(phaseOf(state)).toBe(PHASE.defend);
    expect(state[HEADER.tick] as number).toBeLessThan(DRAWSAVE.drawTicks);
    // Nečinný hráč: kreslení skončí oknem.
    const idle = instantiate(world);
    for (let tick = 0; tick < DRAWSAVE.drawTicks; tick += 1) {
      expect(phaseOf(idle)).toBe(PHASE.draw);
      step(idle, NO_INPUT, program);
    }
    expect(phaseOf(idle)).toBe(PHASE.defend);
  });

  it('the same input trace twice gives the same hash after every tick of the whole horizon, on 12 seeds', () => {
    const firstMismatch = (a: readonly string[], b: readonly string[]): number => a.findIndex((hash, tick) => hash !== b[tick]);
    const ends = new Set<string>();
    let inkOut = 0;
    for (const seed of SEEDS) {
      const world = worldOf(seed);
      for (const inputs of [scribble(seed), roof(world)]) {
        const first = hashes(world, inputs);
        const second = hashes(world, inputs);
        expect(first).toHaveLength(HORIZON);
        expect({ seed, tick: firstMismatch(first, second) }).toEqual({ seed, tick: -1 });
        ends.add(first.at(-1) as string);
      }
      // Čmáranice opravdu kreslí: vyčerpá inkoust a kolo skončí uvnitř horizontu.
      const scribbled = run(world, scribble(seed));
      expect(segmentCountOf(scribbled)).toBeGreaterThanOrEqual(2);
      expect(outcomeOf(scribbled)).not.toBe('running');
      if (defendStartOf(scribbled) < DRAWSAVE.drawTicks - 1) inkOut += 1;
    }
    // Semínko hru mění: konce běhů se neopakují. Většina čmáranic dojde inkoustem uprostřed tahu, ne oknem.
    expect(ends.size).toBe(2 * SEEDS.length);
    expect(inkOut).toBeGreaterThanOrEqual(SEEDS.length / 2);
  });

  it('packInputs → unpackInputs → replay gives the recorded final hash and outcome', () => {
    for (const seed of SEEDS) {
      const world = worldOf(seed);
      for (const inputs of [scribble(seed), roof(world)]) {
        const played = run(world, inputs);
        const unpacked = unpackInputs(packInputs(inputs));
        if (typeof unpacked === 'string') throw new Error(unpacked);
        expect(unpacked).toEqual(inputs);
        const again = replay(world, unpacked, ARCADE_LIBRARY, HORIZON);
        expect({ seed, hash: again.hash, outcome: again.outcome }).toEqual({ seed, hash: hashArcade(played), outcome: outcomeOf(played) });
        expect(again.outcome).not.toBe('running');
        expect(again.tick).toBeLessThanOrEqual(DRAWSAVE.drawTicks + DRAWSAVE.surviveTicks);
      }
    }
  });

  it('a roof bot wins at least 10 of 12 seeds, an idle player loses all 12 and a line drawn away from the hero loses at least 10', () => {
    const outcomes = (trace: (world: ArcadeWorld) => InputEvent[]): string[] =>
      SEEDS.map((seed) => {
        const world = worldOf(seed);
        return replay(world, trace(world), ARCADE_LIBRARY, HORIZON).outcome;
      });
    const count = (list: readonly string[], outcome: string): number => list.filter((entry) => entry === outcome).length;
    const bot = outcomes(roof);
    const idle = outcomes(() => []);
    const off = outcomes(lineOff);
    expect(count(bot, 'won')).toBeGreaterThanOrEqual(10);
    expect(count(idle, 'lost')).toBe(SEEDS.length);
    expect(count(off, 'lost')).toBeGreaterThanOrEqual(10);
    // Robot i čára mimo opravdu kreslí: každý tah je jedna úsečka (rozdíl dělá místo, ne inkoust).
    for (const seed of SEEDS.slice(0, 3)) {
      const world = worldOf(seed);
      expect([segmentCountOf(run(world, roof(world))), segmentCountOf(run(world, lineOff(world)))]).toEqual([1, 1]);
    }
  });

  it('a threat at the maximum fall speed never crosses a segment of the drawn thickness between two ticks – it bounces', () => {
    // Vodorovná čára má nejmenší svislou tloušťku; mírná střecha je tvar robota.
    const lines = [
      [cellOf(1, 6), cellOf(6, 6)],
      [cellOf(0, 4), cellOf(4, 5)],
    ] as const;
    let tunnelsWithoutSweep = 0;
    let cases = 0;
    for (const [a, b] of lines) {
      const line = lineWorld(a, b);
      for (let k = 0; k <= 8; k += 1) {
        const [x, lineY] = line.pointAt(k);
        for (let gap = 1; gap <= DRAWSAVE.maxSpeed; gap += 1) {
          const y = lineY + REACH + gap;
          // Start vně obdélníku čáry nad ní; dráha za tik by čáru překročila.
          if (line.side(x, y) < line.reach || line.side(x, y - DRAWSAVE.maxSpeed) >= 0) continue;
          if (-line.side(x, y - DRAWSAVE.maxSpeed) >= line.reach) tunnelsWithoutSweep += 1;
          const state = Int32Array.from(line.base);
          const threat = placeThreat(state, x, y, -DRAWSAVE.maxSpeed);
          step(state, NO_INPUT, line.program);
          const after = centreOf(state, threat);
          expect({ line: [a, b], x, y, outside: line.side(after.x, after.y) >= line.reach, bounced: after.vy > 0 }).toEqual({ line: [a, b], x, y, outside: true, bounced: true });
          cases += 1;
        }
      }
    }
    expect(cases).toBeGreaterThan(1000);
    // Bez průběžné srážky by hrozba v těchto případech skončila celá za čarou: test hlídá právě proskočení.
    expect(tunnelsWithoutSweep).toBeGreaterThan(0);
  });

  it('a threat dropped onto a line rests on it or slides off its end, but never sinks into or through it over 4 s', () => {
    const lines = [
      [cellOf(1, 6), cellOf(6, 6)],
      [cellOf(0, 4), cellOf(4, 5)],
      [cellOf(2, 3), cellOf(6, 7)],
    ] as const;
    const failures: string[] = [];
    let ticksOnLine = 0;
    for (const [a, b] of lines) {
      const line = lineWorld(a, b);
      for (let k = 0; k <= 8; k += 1) {
        for (const drop of [1, 37, 500, 2000]) {
          const [x, lineY] = line.pointAt(k);
          const y = lineY + Math.ceil(line.reach / line.ex) + drop;
          const state = Int32Array.from(line.base);
          const threat = placeThreat(state, x, y, 0);
          for (let tick = 0; tick < 4 * 60 && (state[bodyBase(threat) + BODY.flags] as number) & FLAG.alive; tick += 1) {
            step(state, NO_INPUT, line.program);
            const at = centreOf(state, threat);
            const along = line.along(at.x, at.y);
            // Nad úsečkou (průmět mezi konci) musí střed zůstat nad obdélníkem čáry.
            if (along < 0 || along > line.e2) continue;
            ticksOnLine += 1;
            if (line.side(at.x, at.y) < line.reach) failures.push(`line ${String(a)}-${String(b)} k ${String(k)} drop ${String(drop)}: inside or below at tick ${String(tick)}`);
          }
        }
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
    // Hrozby na čarách opravdu ležely nebo klouzaly (ne jen proletěly kolem).
    expect(ticksOnLine).toBeGreaterThan(5000);
  });
});

/** Svět bez rozpisu hrozeb s jednou čarou `a → b` ve fázi obrany: hrozby do kopie `base` staví test sám. */
function lineWorld(a: number, b: number) {
  const parts = partsOf(SEEDS[0]);
  const built = buildWorld({ seed: SEEDS[0], control: parts.control, rules: [], bot: parts.bot, level: parts.level }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  const base = instantiate(built.world);
  expect(addSegment(base, a, b)).toBe(true);
  base[bodyBase(DRAWSAVE_BODIES.keeper) + KEEPER_SLOTS.phase] = PHASE.defend;
  const [ax, ay, ex, ey] = [cellX(a), cellY(a), cellX(b) - cellX(a), cellY(b) - cellY(a)];
  return {
    program: loadProgram(built.world, ARCADE_LIBRARY),
    base,
    ex,
    e2: ex * ex + ey * ey,
    /** Strana čáry × délka: kladná nad čarou, `reach` = hrana obdélníku srážky. */
    side: (x: number, y: number): number => ex * (y - ay) - ey * (x - ax),
    along: (x: number, y: number): number => ex * (x - ax) + ey * (y - ay),
    reach: REACH * isqrt(ex * ex + ey * ey),
    /** Bod úsečky v osminách její délky. */
    pointAt: (k: number): readonly [number, number] => [ax + Math.trunc((ex * k) / 8), ay + Math.trunc((ey * k) / 8)],
  };
}

/** Hrozba se středem `(x, y)` a svislou rychlostí `vy` v dalším volném slotu; vrátí její index. */
function placeThreat(state: ArcadeState, x: number, y: number, vy: number): number {
  const threat = state[HEADER.bodyCount] as number;
  state[HEADER.bodyCount] = threat + 1;
  const at = bodyBase(threat);
  state.copyWithin(at, bodyBase(DRAWSAVE_BODIES.threat), bodyBase(DRAWSAVE_BODIES.threat) + BODY_STRIDE);
  state[at + BODY.x] = x;
  state[at + BODY.y] = y - DRAWSAVE.threat / 2;
  state[at + BODY.flags] = (state[at + BODY.flags] as number) | FLAG.alive;
  state[at + THREAT_SLOTS.vx] = 0;
  state[at + THREAT_SLOTS.vy] = vy;
  return threat;
}

const centreOf = (state: ArcadeState, threat: number): { readonly x: number; readonly y: number; readonly vy: number } => {
  const at = bodyBase(threat);
  return { x: state[at + BODY.x] as number, y: (state[at + BODY.y] as number) + DRAWSAVE.threat / 2, vy: state[at + THREAT_SLOTS.vy] as number };
};
