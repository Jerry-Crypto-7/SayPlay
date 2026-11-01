/**
 * Kresli a zachraň (P68-S T12) – míry, rozložení stavu a čtení stavu, které sdílí ovládání a pravidla
 * (`drawsave.ts`), robot i scéna. Bez chování: jen konstanty a čisté funkce nad stavem, celá čísla.
 *
 * **Mřížka z boku:** 8 sloupců × 12 řad, buňka = `row * 8 + col`, řada 0 nahoře. Buňka měří `UNIT` (1 m = 1000
 * jednotek); `x` jde do stran se středem desky v 0, `y` nahoru od spodní hrany desky (0) k horní (12 000), `z` = 0.
 * Tah nese buňku v ose (`axisOfCell` z `lanes.ts`) a `HOLD` po dobu tahu (`DRAWSAVE_STROKE`).
 *
 * **Inkoust** = součet eukleidovských délek úseček v jednotkách (tisíciny buňky): `isqrt(dx² + dy²)` mezi středy
 * buněk, takže soused stojí 1 000 a úhlopříčka 1 414.
 */

import { ARCADE_HZ, AXIS_MAX, type ArcadeState, BODY, FLAG, HEADER, ROLE, UNIT, bodyBase } from '../contract';

// ---------------------------------------------------------------------------
// Míry

export const DRAWSAVE = {
  cols: 8,
  rows: 12,
  cell: UNIT,
  /** Chráněná postava: semínko ji posadí do těchto řad (spodní třetina desky). */
  heroRows: { min: 8, max: 11 },
  hero: { w: 800, h: 800, d: 800 },
  /** Hrozba je čtverec této strany (poloměr 150). */
  threat: 300,
  /** Tloušťka nakreslené čáry. */
  thickness: 100,
  /** Gravitace hrozby (jednotek za tik²) a strop rychlosti v každé ose (jednotek za tik). */
  gravity: 6,
  maxSpeed: 420,
  /** Odraz od čáry: kolik procent kolmé složky rychlosti se vrátí. */
  restitution: 50,
  /** Inkoust na celé kreslení: 10 buněk délky. */
  ink: 10 * UNIT,
  maxSegments: 12,
  /** Fáze kreslení: nejdéle 6 s, nebo než dojde inkoust. */
  drawTicks: 6 * ARCADE_HZ,
  /** Výhra: přežít 10 s od konce kreslení. */
  surviveTicks: 10 * ARCADE_HZ,
  /** První hrozba 0,5 s po konci kreslení, poslední nejpozději `threatSpan` po první. */
  firstThreat: ARCADE_HZ / 2,
  threatSpan: 6 * ARCADE_HZ,
  /** Počet hrozeb z věty (parametr žánru `threats`). */
  threats: { min: 1, max: 30, default: 10 },
} as const;

/** Buněk desky; nejvyšší osa, kterou hra pošle, se drží pod `AXIS_MAX`. */
export const BOARD_CELLS = DRAWSAVE.cols * DRAWSAVE.rows;
if (BOARD_CELLS >= AXIS_MAX) throw new Error('drawsave: the grid does not fit the input axis');

/** Půl šířky desky a její horní hrana ve světě. */
export const HALF_WIDTH = (DRAWSAVE.cols * DRAWSAVE.cell) / 2;
export const BOARD_TOP = DRAWSAVE.rows * DRAWSAVE.cell;

/**
 * Dosah srážky hrozby s čárou: poloměr hrozby + půl tloušťky čáry. Strop rychlosti je schválně větší než dvojnásobek
 * dosahu – hrozba na stropu by přes čáru přeskočila mezi dvěma tiky, kdyby srážka nebyla průběžná (`drawsave.ts`).
 */
export const REACH = DRAWSAVE.threat / 2 + DRAWSAVE.thickness / 2;

/** Tělesa úrovně v pořadí (indexy jsou součást hashe): postava, počítadlo, předloha hrozby, úsečky. */
export const DRAWSAVE_BODIES = { hero: 0, keeper: 1, threat: 2, firstSegment: 3 } as const;

/** Volné sloty spawnu: nejvíc hrozeb, které věta smí chtít (všechny naráz ve vzduchu). */
export const SPAWN_SLOTS = DRAWSAVE.threats.max;

export const THREAT_ROLE = ROLE.enemy;

/**
 * Stav hry na těle-počítadle (mrtvá předloha za postavou): fáze (0 kreslení, 1 obrana), utracený inkoust, počet
 * úseček, poslední bod právě drženého tahu (buňka + 1, 0 = prst nahoře) a tik, kdy začala obrana.
 * Píše jen ovládání, pravidla čtou.
 */
export const KEEPER_SLOTS = { phase: BODY.x, ink: BODY.y, segments: BODY.z, strokeLast: BODY.vx, defendStart: BODY.vy } as const;
export const PHASE = { draw: 0, defend: 1 } as const;

/** Úsečka (mrtvé tělo `firstSegment + k`, platí pro k < počet úseček): konce ve světě a délka. */
export const SEGMENT_SLOTS = { ax: BODY.x, ay: BODY.y, bx: BODY.vx, by: BODY.vy, length: BODY.aux0 } as const;

/**
 * Hrozba (živá kopie předlohy): `x` = střed, `y` = spodní hrana jako u každého těla. Jádro jí nehýbe (`vx = vy = 0`);
 * polohu i rychlost píše ovládání, rychlost leží v `aux0/aux1`.
 */
export const THREAT_SLOTS = { vx: BODY.aux0, vy: BODY.aux1 } as const;

// ---------------------------------------------------------------------------
// Buňky

export const colOf = (cell: number): number => cell % DRAWSAVE.cols;
export const rowOf = (cell: number): number => Math.floor(cell / DRAWSAVE.cols);
export const cellOf = (col: number, row: number): number => row * DRAWSAVE.cols + col;
export const isBoardCell = (cell: number): boolean => Number.isInteger(cell) && cell >= 0 && cell < BOARD_CELLS;

/** Střed buňky ve světě. */
export const colX = (col: number): number => (2 * col - (DRAWSAVE.cols - 1)) * (DRAWSAVE.cell / 2);
export const cellX = (cell: number): number => colX(colOf(cell));
export const cellY = (cell: number): number => (DRAWSAVE.rows - 1 - rowOf(cell)) * DRAWSAVE.cell + DRAWSAVE.cell / 2;

/** Buňka pod bodem světa, nebo −1 mimo desku. */
export function cellAtWorld(x: number, y: number): number {
  const col = Math.floor((x + HALF_WIDTH) / DRAWSAVE.cell);
  const row = DRAWSAVE.rows - 1 - Math.floor(y / DRAWSAVE.cell);
  if (col < 0 || col >= DRAWSAVE.cols || row < 0 || row >= DRAWSAVE.rows) return -1;
  return cellOf(col, row);
}

/** Celočíselná odmocnina (dolní celá část), stejná na každém stroji. */
export function isqrt(n: number): number {
  let root = Math.floor(Math.sqrt(n));
  while (root * root > n) root -= 1;
  while ((root + 1) * (root + 1) <= n) root += 1;
  return root;
}

/** Délka úsečky mezi středy dvou buněk v jednotkách – tolik inkoustu stojí. */
export const strokeLength = (a: number, b: number): number => isqrt((cellX(b) - cellX(a)) ** 2 + (cellY(b) - cellY(a)) ** 2);

// ---------------------------------------------------------------------------
// Čtení stavu

export const alive = (state: ArcadeState, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;
const keeperSlot = (state: ArcadeState, slot: number): number => state[bodyBase(DRAWSAVE_BODIES.keeper) + slot] as number;

export const phaseOf = (state: ArcadeState): number => keeperSlot(state, KEEPER_SLOTS.phase);
export const inkUsedOf = (state: ArcadeState): number => keeperSlot(state, KEEPER_SLOTS.ink);
export const inkLeftOf = (state: ArcadeState): number => DRAWSAVE.ink - inkUsedOf(state);
export const segmentCountOf = (state: ArcadeState): number => keeperSlot(state, KEEPER_SLOTS.segments);
export const defendStartOf = (state: ArcadeState): number => keeperSlot(state, KEEPER_SLOTS.defendStart);
/** Poslední bod drženého tahu, nebo −1, když prst nekreslí. */
export const strokeLastOf = (state: ArcadeState): number => keeperSlot(state, KEEPER_SLOTS.strokeLast) - 1;

/** Kreslení skončí, když nezbude inkoust ani na nejkratší úsečku nebo je úseček plno. */
export const inkSpent = (state: ArcadeState): boolean => inkLeftOf(state) < DRAWSAVE.cell || segmentCountOf(state) >= DRAWSAVE.maxSegments;

export interface SegmentView {
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
  readonly length: number;
}

/** Nakreslené úsečky v pořadí kreslení. */
export function segmentsOf(state: ArcadeState): SegmentView[] {
  const out: SegmentView[] = [];
  for (let k = 0; k < segmentCountOf(state); k += 1) {
    const base = bodyBase(DRAWSAVE_BODIES.firstSegment + k);
    out.push({
      ax: state[base + SEGMENT_SLOTS.ax] as number,
      ay: state[base + SEGMENT_SLOTS.ay] as number,
      bx: state[base + SEGMENT_SLOTS.bx] as number,
      by: state[base + SEGMENT_SLOTS.by] as number,
      length: state[base + SEGMENT_SLOTS.length] as number,
    });
  }
  return out;
}

/** Živé hrozby (kopie předlohy) v pořadí indexů. */
export function threatsOf(state: ArcadeState): number[] {
  const template = bodyBase(DRAWSAVE_BODIES.threat);
  const out: number[] = [];
  for (let i = state[HEADER.spawnBase] as number; i < (state[HEADER.bodyCount] as number); i += 1) {
    const base = bodyBase(i);
    if (state[base + BODY.role] === state[template + BODY.role] && state[base + BODY.kind] === state[template + BODY.kind] && alive(state, i)) out.push(i);
  }
  return out;
}

/** Buňka, ve které postava sedí. */
export const heroCellOf = (state: ArcadeState): number => {
  const base = bodyBase(DRAWSAVE_BODIES.hero);
  return cellAtWorld(state[base + BODY.x] as number, (state[base + BODY.y] as number) + DRAWSAVE.hero.h / 2);
};
