/**
 * Kresli a zachraň (P68-S T12, kategorie `stavba`): hráč tahem prstu přes buňky mřížky nakreslí čáry, hrozby padají
 * shora, odrážejí se od nich a chráněná postava z věty musí vydržet 10 s. Míry a čtení stavu jsou v `drawsave-world.ts`.
 *
 * **Vstup** (`DRAWSAVE_STROKE`, `p68-contract.ts`): každý tik tahu nese `HOLD` a buňku v ose (`axisOfCell`). Tik
 * s `HOLD` na jiné buňce, než je poslední bod tahu, přidá bod a úsečku od posledního bodu (libovolně daleko – rychlý
 * tah „spojuje tečky“); tik bez `HOLD` tah ukončí a další `HOLD` začne nový tah bez spojení. Úsečka, na kterou
 * nezbývá inkoust (`DRAWSAVE.ink`, délka v jednotkách) nebo místo (12 úseček), se zahodí a bod tahu se nepohne.
 * Kreslení skončí po `drawTicks`, nebo hned, jak dojde inkoust – jiné tlačítko hra nemá.
 *
 * **Kdo co dělá v tiku:**
 * - ovládání `drawsave`: kreslení; ve fázi obrany pohyb hrozeb (gravitace, strop rychlosti, průběžná srážka s čarami,
 *   odraz, odchod z desky). Jádro hrozbami nehýbe, jejich rychlost leží v `THREAT_SLOTS`;
 * - `drawsave_wave` (tik): hrozby podle rozpisu od konce kreslení, výhra po `surviveTicks` obrany;
 * - `drawsave_hit` (kontakt jádra s postavou): dotyk hrozby = prohra (prohra má v tiku přednost před výhrou).
 *
 * **Srážka je průběžná:** dráha středu hrozby za tik (stará → nová poloha) se protne s obdélníkem kolem úsečky
 * o půlšířce `REACH` (poloměr hrozby + půl tloušťky čáry, konce prodloužené o totéž). Nejdřívější vstup vyhraje,
 * hrozba zůstane v bodě dotyku a rychlost se odrazí podle normály zasažené stěny. Střed hrozby tak nikdy nevejde do
 * obdélníku žádné čáry a přes čáru nepřeskočí při žádné rychlosti. Vše celá čísla: zlomky času se porovnávají
 * křížovým násobením (součiny pod 2⁵³), odraz dělí `e·e` bez odmocniny.
 *
 * Determinismus: celá čísla, náhoda jen při stavbě (`createCompileRng`: postava ze streamu `layout`, hrozby ze `spawn`).
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';

import { DRAWSAVE_STROKE, P68_MAX_TICKS } from '../../genre/p68-contract';
import {
  ARCADE_HZ,
  ARCADE_LIMITS,
  type ArcadeEffect,
  type ArcadeInput,
  type ArcadeLevel,
  type ArcadeState,
  BODY,
  BUTTON,
  type BodyInit,
  type ControlPiece,
  FLAG,
  HEADER,
  type ModeGeneratorPiece,
  type ModeParts,
  type PieceRef,
  type RulePiece,
  bodyBase,
} from '../contract';
import {
  BOARD_TOP,
  DRAWSAVE,
  DRAWSAVE_BODIES,
  HALF_WIDTH,
  KEEPER_SLOTS,
  PHASE,
  REACH,
  SEGMENT_SLOTS,
  SPAWN_SLOTS,
  THREAT_ROLE,
  THREAT_SLOTS,
  cellOf,
  cellX,
  cellY,
  colOf,
  colX,
  defendStartOf,
  inkSpent,
  inkUsedOf,
  isBoardCell,
  phaseOf,
  rowOf,
  segmentCountOf,
  segmentsOf,
  strokeLength,
  threatsOf,
} from './drawsave-world';
import { cellOfAxis } from './lanes';

export * from './drawsave-world';

if (DRAWSAVE.drawTicks + DRAWSAVE.surviveTicks > P68_MAX_TICKS) throw new Error('drawsave: the round does not fit P68_MAX_TICKS');

const KEEPER = bodyBase(DRAWSAVE_BODIES.keeper);
const HOLD = BUTTON[DRAWSAVE_STROKE.hold];
const clampSpeed = (v: number): number => Math.max(-DRAWSAVE.maxSpeed, Math.min(DRAWSAVE.maxSpeed, v));

// ---------------------------------------------------------------------------
// Kreslení

/** Úsečka z buňky `a` do `b`, když na ni zbývá inkoust i místo; jinak nic. */
export function addSegment(state: ArcadeState, a: number, b: number): boolean {
  const count = segmentCountOf(state);
  const length = strokeLength(a, b);
  if (count >= DRAWSAVE.maxSegments || inkUsedOf(state) + length > DRAWSAVE.ink) return false;
  const base = bodyBase(DRAWSAVE_BODIES.firstSegment + count);
  state[base + SEGMENT_SLOTS.ax] = cellX(a);
  state[base + SEGMENT_SLOTS.ay] = cellY(a);
  state[base + SEGMENT_SLOTS.bx] = cellX(b);
  state[base + SEGMENT_SLOTS.by] = cellY(b);
  state[base + SEGMENT_SLOTS.length] = length;
  state[KEEPER + KEEPER_SLOTS.segments] = count + 1;
  state[KEEPER + KEEPER_SLOTS.ink] = inkUsedOf(state) + length;
  return true;
}

/** Jeden tik kreslení: `HOLD` přidá bod tahu (a úsečku od posledního), bez `HOLD` tah končí. Prst mimo mřížku nic nepřidá. */
function draw(state: ArcadeState, input: ArcadeInput): void {
  if ((input.buttons & HOLD) === 0) {
    state[KEEPER + KEEPER_SLOTS.strokeLast] = 0;
    return;
  }
  const cell = cellOfAxis(input.axis);
  if (!isBoardCell(cell)) return;
  const last = (state[KEEPER + KEEPER_SLOTS.strokeLast] as number) - 1;
  if (last === cell) return;
  if (last < 0 || addSegment(state, last, cell)) state[KEEPER + KEEPER_SLOTS.strokeLast] = cell + 1;
}

// ---------------------------------------------------------------------------
// Srážka s čarou

/** Čára pro srážku: počátek, směr `e`, `e·e` a půlšířka obdélníku × délka (`REACH · |e|`). */
interface Line {
  readonly ax: number;
  readonly ay: number;
  readonly ex: number;
  readonly ey: number;
  readonly e2: number;
  readonly reach: number;
}

const linesOf = (state: ArcadeState): Line[] =>
  segmentsOf(state).map((s) => {
    const ex = s.bx - s.ax;
    const ey = s.by - s.ay;
    return { ax: s.ax, ay: s.ay, ex, ey, e2: ex * ex + ey * ey, reach: REACH * s.length };
  });

/** Vstup dráhy do obdélníku čáry: čas `num/den` ∈ [0, 1) a vnější normála zasažené stěny (`|n|² = e·e`). */
interface Hit {
  readonly num: number;
  readonly den: number;
  readonly nx: number;
  readonly ny: number;
  readonly e2: number;
}

/**
 * Obdélník čáry v jejích souřadnicích: napříč `W = e × (p − a)` v (−reach, reach), podél `U = e · (p − a)`
 * v (−reach, e·e + reach); obojí je lineární v čase tiku, takže vstup je největší ze vstupních časů obou pásů.
 */
function slabs(line: Line, px: number, py: number, vx: number, vy: number): readonly (readonly [number, number, number, number, number, number])[] {
  const dx = px - line.ax;
  const dy = py - line.ay;
  return [
    [line.ex * dy - line.ey * dx, line.ex * vy - line.ey * vx, -line.reach, line.reach, -line.ey, line.ex],
    [line.ex * dx + line.ey * dy, line.ex * vx + line.ey * vy, -line.reach, line.e2 + line.reach, line.ex, line.ey],
  ];
}

/** Leží bod uvnitř obdélníku čáry (hranice není uvnitř)? */
const inside = (line: Line, px: number, py: number): boolean => slabs(line, px, py, 0, 0).every(([f0, , lo, hi]) => lo < f0 && f0 < hi);

/** Kdy dráha `p → p + v` vstoupí do otevřeného obdélníku čáry, nebo `null`. Bod mimo obdélník je podmínka volajícího. */
function entryOf(line: Line, px: number, py: number, vx: number, vy: number): Hit | null {
  let inNum = 0;
  let inDen = 1;
  let outNum = 1;
  let outDen = 1;
  let normal: readonly [number, number] | null = null;
  for (const [f0, fv, lo, hi, bx, by] of slabs(line, px, py, vx, vy)) {
    if (fv === 0) {
      if (f0 <= lo || f0 >= hi) return null;
      continue;
    }
    const den = Math.abs(fv);
    const enter = fv > 0 ? lo - f0 : f0 - hi;
    const exit = fv > 0 ? hi - f0 : f0 - lo;
    if (enter * inDen > inNum * den || (normal === null && enter * inDen === inNum * den)) {
      inNum = enter;
      inDen = den;
      // Stěna, kterou dráha vstupuje: při pohybu nahoru po ose spodní (normála −b), jinak horní (+b).
      normal = fv > 0 ? [-bx, -by] : [bx, by];
    }
    if (exit * outDen < outNum * den) {
      outNum = exit;
      outDen = den;
    }
  }
  if (normal === null || inNum * outDen >= outNum * inDen) return null;
  return { num: inNum, den: inDen, nx: normal[0], ny: normal[1], e2: line.e2 };
}

/** Výsledek tiku jedné hrozby: střed a rychlost. */
interface ThreatMove {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
}

/**
 * Tik hrozby se středem `(x, y)`: gravitace a strop rychlosti, pak průběžná srážka se všemi čarami. Bez srážky
 * doletí celou rychlostí; se srážkou zůstane v bodě dotyku nejdřívější čáry (useknutém k počátku – kdyby ho
 * zaokrouhlení posunulo do některé čáry, zůstane na místě) a kolmá složka rychlosti se odrazí s `restitution` %.
 */
function moveThreat(lines: readonly Line[], x: number, y: number, vx0: number, vy0: number): ThreatMove {
  const vx = clampSpeed(vx0);
  const vy = clampSpeed(vy0 - DRAWSAVE.gravity);
  let hit: Hit | null = null;
  for (const line of lines) {
    const entry = entryOf(line, x, y, vx, vy);
    if (entry !== null && (hit === null || entry.num * hit.den < hit.num * entry.den)) hit = entry;
  }
  if (hit === null) return { x: x + vx, y: y + vy, vx, vy };
  let cx = x + Math.trunc((vx * hit.num) / hit.den);
  let cy = y + Math.trunc((vy * hit.num) / hit.den);
  if (lines.some((line) => inside(line, cx, cy))) {
    cx = x;
    cy = y;
  }
  const along = (100 + DRAWSAVE.restitution) * (vx * hit.nx + vy * hit.ny);
  const scale = 100 * hit.e2;
  return { x: cx, y: cy, vx: vx - Math.trunc((along * hit.nx) / scale), vy: vy - Math.trunc((along * hit.ny) / scale) };
}

/** Obrana: každá živá hrozba udělá tik; která celá opustí desku dolů nebo do stran, zmizí. */
function moveThreats(state: ArcadeState): void {
  const lines = linesOf(state);
  const half = DRAWSAVE.threat / 2;
  for (const threat of threatsOf(state)) {
    const base = bodyBase(threat);
    const move = moveThreat(lines, state[base + BODY.x] as number, (state[base + BODY.y] as number) + half, state[base + THREAT_SLOTS.vx] as number, state[base + THREAT_SLOTS.vy] as number);
    state[base + BODY.x] = move.x;
    state[base + BODY.y] = move.y - half;
    state[base + THREAT_SLOTS.vx] = move.vx;
    state[base + THREAT_SLOTS.vy] = move.vy;
    if (move.y < -half || move.x < -HALF_WIDTH - half || move.x > HALF_WIDTH + half) state[base + BODY.flags] = (state[base + BODY.flags] as number) & ~FLAG.alive;
  }
}

// ---------------------------------------------------------------------------
// Ovládání

const controlParams = z.object({}).strict();

/**
 * Ovládání hry. Pořadí v tiku: postava bez gravitace (jádro ji dává každému hráči, postava ale sedí ve své buňce) →
 * kreslení (do `drawTicks`) → konec kreslení po okně nebo bez inkoustu → (obrana) pohyb hrozeb.
 */
export const drawsaveControl: ControlPiece<z.infer<typeof controlParams>> = {
  id: 'drawsave',
  params: controlParams,
  roles: ['player', 'enemy', 'obstacle'],
  cost: () => ({ bodies: 0, rules: 0 }),
  step: (state, player, input) => {
    const hero = bodyBase(player);
    state[hero + BODY.flags] = (state[hero + BODY.flags] as number) & ~FLAG.gravity;
    if (phaseOf(state) === PHASE.defend) {
      moveThreats(state);
      return;
    }
    const tick = state[HEADER.tick] as number;
    draw(state, input);
    if (tick + 1 >= DRAWSAVE.drawTicks || inkSpent(state)) {
      state[KEEPER + KEEPER_SLOTS.phase] = PHASE.defend;
      state[KEEPER + KEEPER_SLOTS.defendStart] = tick;
      state[KEEPER + KEEPER_SLOTS.strokeLast] = 0;
    }
  },
};

// ---------------------------------------------------------------------------
// Pravidla

const waveParams = z
  .object({
    /** Tiky hrozeb od začátku obrany, vzestupně. */
    ticks: z.array(z.int().min(1).max(ARCADE_LIMITS.maxTicks)).min(1).max(DRAWSAVE.threats.max),
    /** Sloupec, nad kterým hrozba se stejným pořadím spadne. */
    columns: z.array(z.int().min(0).max(DRAWSAVE.cols - 1)).min(1).max(DRAWSAVE.threats.max),
  })
  .strict();
export type DrawsaveWaveParams = z.infer<typeof waveParams>;

/** Obrana (tik): hrozby nad horní hranou desky podle rozpisu, po `surviveTicks` obrany výhra. */
export const drawsaveWave: RulePiece<DrawsaveWaveParams> = {
  id: 'drawsave_wave',
  params: waveParams,
  roles: ['enemy'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state }, params) => {
    if (phaseOf(state) !== PHASE.defend) return [];
    const since = (state[HEADER.tick] as number) - defendStartOf(state);
    const effects: ArcadeEffect[] = [];
    params.ticks.forEach((at, k) => {
      if (at === since) effects.push({ kind: 'spawn', template: DRAWSAVE_BODIES.threat, x: colX(params.columns[k] as number), y: BOARD_TOP, z: 0, vx: 0, vy: 0, vz: 0 });
    });
    if (since >= DRAWSAVE.surviveTicks) effects.push({ kind: 'win' });
    return effects;
  },
};

const hitParams = z.object({}).strict();

/** Dotyk hrozby s postavou (kontakt jádra, AABB): prohra. */
export const drawsaveHit: RulePiece<z.infer<typeof hitParams>> = {
  id: 'drawsave_hit',
  params: hitParams,
  roles: ['player', 'enemy'],
  trigger: 'contact',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, other }) => (state[bodyBase(other) + BODY.role] === THREAT_ROLE ? [{ kind: 'lose' }] : []),
};

/** Pravidla hry – `library.ts` je rozbalí do `rules`. */
export const DRAWSAVE_RULES: Readonly<Record<string, RulePiece>> = {
  drawsave_wave: drawsaveWave as RulePiece,
  drawsave_hit: drawsaveHit as RulePiece,
};

// ---------------------------------------------------------------------------
// Generátor

const clampThreats = (n: number): number => Math.min(DRAWSAVE.threats.max, Math.max(DRAWSAVE.threats.min, n));

export const drawsaveParams = z
  .object({
    /** Kolik hrozeb spadne (parametr žánru `threats`, mimo 1–30 se ořízne). */
    threats: z.int().default(DRAWSAVE.threats.default).transform(clampThreats),
  })
  .strict();
export type DrawsaveParams = z.infer<typeof drawsaveParams>;

/** Buňka postavy ze streamu `layout`: řada ve spodní třetině, libovolný sloupec. */
export function heroCellFor(seed: number): number {
  const rng = createCompileRng(seed, 'layout');
  const row = rng.int(DRAWSAVE.heroRows.min, DRAWSAVE.heroRows.max);
  return cellOf(rng.int(0, DRAWSAVE.cols - 1), row);
}

/**
 * Rozpis `count` hrozeb ze streamu `spawn`: tiky od začátku obrany (první `firstThreat`, všechny do `threatSpan` po ní,
 * rozestupy z vah 60–140 %, vzestupně a každá v jiném tiku) a sloupce – každá druhá hrozba (od první) míří na
 * sloupec postavy, ostatní padají do losovaného sloupce.
 */
export function threatPlan(seed: number, count: number, heroCol: number): DrawsaveWaveParams {
  const rng = createCompileRng(seed, 'spawn');
  const weights = Array.from({ length: count - 1 }, () => rng.int(60, 140));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const ticks: number[] = [DRAWSAVE.firstThreat];
  let acc = 0;
  for (const weight of weights) {
    acc += weight;
    ticks.push(Math.max((ticks.at(-1) as number) + 1, DRAWSAVE.firstThreat + Math.floor((DRAWSAVE.threatSpan * acc) / total)));
  }
  const columns = ticks.map((_, k) => (k % 2 === 0 ? heroCol : rng.int(0, DRAWSAVE.cols - 1)));
  return { ticks, columns };
}

const dead = (role: BodyInit['role'], kind: string, size: number): BodyInit => ({ role, kind, x: 0, y: 0, z: 0, w: size, h: size, d: size, solid: false, template: true });

/** Tělesa úrovně: postava v buňce `hero`, počítadlo, předloha hrozby a 12 úseček (mrtvé, dokud je tah nevyplní). */
function bodiesFor(hero: number): BodyInit[] {
  return [
    { role: 'player', kind: 'player', x: cellX(hero), y: cellY(hero) - DRAWSAVE.hero.h / 2, z: 0, ...DRAWSAVE.hero, solid: false },
    dead('thing', 'player', 1),
    dead('enemy', 'threat', DRAWSAVE.threat),
    ...Array.from({ length: DRAWSAVE.maxSegments }, () => dead('obstacle', 'wall', DRAWSAVE.thickness)),
  ];
}

const levelFor = (seed: number): ArcadeLevel => ({ bodies: bodiesFor(heroCellFor(seed)), length: 0, spawnSlots: SPAWN_SLOTS });

/** Tvrzení „hratelné z konstrukce“ nad úrovní a rozpisem; prázdné pole = hratelné. */
export function checkDrawsaveLevel(level: ArcadeLevel, plan: DrawsaveWaveParams, hero: number): string[] {
  const issues: string[] = [];
  if (level.bodies[0]?.role !== 'player') issues.push('no hero');
  if (rowOf(hero) < DRAWSAVE.heroRows.min || rowOf(hero) > DRAWSAVE.heroRows.max) issues.push('the hero is not in the lower rows');
  if (plan.columns.length !== plan.ticks.length) issues.push('every threat needs a column');
  if (plan.ticks.some((at, k) => k > 0 && at <= (plan.ticks[k - 1] as number))) issues.push('threats are out of order');
  if (plan.columns[0] !== colOf(hero)) issues.push('no threat falls on the hero');
  // Poslední hrozba musí dopadnout dřív, než obrana skončí: z horní hrany na dno za necelou sekundu, 2 s rezerva.
  if ((plan.ticks.at(-1) as number) > DRAWSAVE.surviveTicks - 2 * ARCADE_HZ) issues.push('the last threat falls after the round ends');
  if (level.bodies.length + (level.spawnSlots ?? 0) > ARCADE_LIMITS.maxBodies) issues.push('the level exceeds the body limit');
  return issues;
}

/**
 * Režim `drawsave.default` (generátor `drawsave_level`): postava na semínkem dané buňce spodní třetiny, `threats` hrozeb
 * od konce kreslení, výhra po 10 s obrany, prohra prvním dotykem (životy hra nemá, `health` se nečte).
 */
export const drawsaveLevel: ModeGeneratorPiece<DrawsaveParams> = {
  id: 'drawsave_level',
  params: drawsaveParams,
  roles: ['player', 'enemy', 'obstacle'],
  cost: () => ({ bodies: 3 + DRAWSAVE.maxSegments + SPAWN_SLOTS, rules: 2 }),
  generate: (seed) => levelFor(seed),
  parts: (seed, params): ModeParts => {
    const hero = heroCellFor(seed);
    const level = levelFor(seed);
    const plan = threatPlan(seed, params.threats, colOf(hero));
    const rules: PieceRef[] = [
      { id: 'drawsave_wave', params: plan },
      { id: 'drawsave_hit', params: {} },
    ];
    return {
      control: { id: 'drawsave', params: {} },
      bot: { id: 'drawsave_bot', params: {} },
      level,
      rules,
      issues: checkDrawsaveLevel(level, plan, hero),
    };
  },
};
