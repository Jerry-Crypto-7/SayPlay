/**
 * Mřížka šipek (P66 T9): kola s rostoucí mřížkou, kusy se šipkou směru a jejich stavba **řešitelná konstrukcí**.
 *
 * **Konstrukce:** kusy se kladou v obráceném pořadí odletu. Kus položený jako k-tý odletí jako (N − k + 1)-tý, takže
 * v době svého odletu na mřížce zbývají právě kusy položené před ním. Kus se proto smí položit jen do prázdné buňky
 * a jen se směrem, jehož cesta až ven z mřížky je volná od všech už položených kusů. Pozdější kusy jeho cestu zatarasit
 * smějí – odletí dřív než on. Úroveň je tak řešitelná vždy; řešič (`solveArrows`) to hlídá na 200 semínkách.
 *
 * Odebrání kusu cesty jen uvolňuje, takže hladový řešič (vždy první volný kus) vyčistí mřížku právě tehdy, když ji
 * vyčistit jde.
 *
 * **Mez buněk (T2a):** ťuk nese buňku v ose záznamu (`axisOfCell(cell) = cell + 1`, osa nejvýš `AXIS_MAX`), takže
 * mřížka kola má nejvýš `ARROWS.maxCells` buněk; větší by výzva (`score/dare.ts`) odmítla.
 *
 * Kód kusu ve stavu: HP těla = 1 + směr + 4 × kolo (`pieceCode`). Kusy všech kol stojí v úrovni od tiku 0 na týchž
 * místech; pravidlo, ovládání, robot i scéna berou jen kusy běžícího kola (`roundOf` háčků).
 */

import { createCompileRng } from '@/play/compile/rng';

import { AXIS_MAX, BODY, FLAG, HEADER, ROLE, bodyBase, bodyHp } from '../contract';
import { roundSeeds } from '../hooks/rounds';

/** Směry šipky v pořadí kódu: nahoru (k řadě 0, od kamery, +z), doprava (+x), dolů (ke kameře), doleva. */
export const ARROW_DIRS = ['up', 'right', 'down', 'left'] as const;
export type ArrowDir = (typeof ARROW_DIRS)[number];
/** Krok směru v mřížce: [sloupec, řada]. */
export const DIR_STEP: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

export interface ArrowsGrid {
  readonly cols: number;
  readonly rows: number;
}

export interface ArrowsRound extends ArrowsGrid {
  readonly pieces: number;
}

/** Kus mřížky: buňka (po řadách zleva shora) a směr (index v `ARROW_DIRS`). */
export interface ArrowPiece {
  readonly cell: number;
  readonly dir: number;
}

export const ARROWS = {
  /** Strana buňky (jednotky jádra). */
  cell: 2000,
  piece: { w: 1600, h: 900, d: 1600 },
  /** Hrdina stojí za mřížkou čelem ke kameře; vysoký, ať je na telefonu nad mřížkou vidět (`LEGIBLE_SHARE.hero`). */
  hero: { w: 1400, h: 3600, d: 1200 },
  /** Mezera mezi zadní hranou největší mřížky a hrdinou. */
  heroGap: 1500,
  rounds: { min: 2, max: 5, default: 3 },
  /** Buněk mřížky nejvýš (T2a): buňka 998 = osa 999 < `AXIS_MAX`, výzva ji přijme. */
  maxCells: 999,
  points: 10,
  /**
   * Mřížky od první po finále (sloupce × řady, kusy). Hra s `n` koly bere `n` z nich rovnoměrně od první po
   * poslední (`roundGrids`), takže každé kolo je větší než předchozí a poslední je vždy finále 6 × 5. Na telefonu
   * na výšku má buňka finále ~66 × 54 px (≥ `--sp-size-touch-min` 44 px); pět kol dá 50 kusů = strop počtu role.
   */
  steps: [
    { cols: 4, rows: 3, pieces: 6 },
    { cols: 4, rows: 4, pieces: 8 },
    { cols: 5, rows: 4, pieces: 10 },
    { cols: 5, rows: 5, pieces: 12 },
    { cols: 6, rows: 5, pieces: 14 },
  ],
  /** Hodiny celé hry: základ + za kus, v mezích `time_limit` (nejvýš 85 s, ať nečinný prohraje do horizontu 90 s). */
  seconds: { base: 12, perPiece: 2, min: 30, max: 85 },
  /** Kolik pokusů o stavbu kola, než generátor vzdá (prázdná buňka bez volného směru je vzácná). */
  attempts: 16,
  /** Z kolika (z 3) losů kus raději zatarasí cestu už položeného kusu – hádanka pak má co řešit. */
  blockBias: 2,
} as const;

/** Mřížky kol hry s `rounds` koly (2–5): rovnoměrně z `ARROWS.steps`, poslední je finále. */
export function roundGrids(rounds: number): ArrowsRound[] {
  const last = ARROWS.steps.length - 1;
  return Array.from({ length: rounds }, (_, round) => ARROWS.steps[Math.round((round * last) / Math.max(1, rounds - 1))] as ArrowsRound);
}

/** Kusů celé hry. */
export const totalPieces = (rounds: number): number => roundGrids(rounds).reduce((sum, grid) => sum + grid.pieces, 0);

/** Sekundy hodin hry s `rounds` koly. */
export function arrowsSeconds(rounds: number): number {
  const { base, perPiece, min, max } = ARROWS.seconds;
  return Math.max(min, Math.min(max, base + perPiece * totalPieces(rounds)));
}

/** Smí mřížka do hry: celá čísla ≥ 1 a nejvýš `ARROWS.maxCells` buněk (osa ťuku je unese). */
export function gridIssue(grid: ArrowsGrid): string | null {
  if (!Number.isInteger(grid.cols) || !Number.isInteger(grid.rows) || grid.cols < 1 || grid.rows < 1) return `a ${grid.cols} × ${grid.rows} grid is not a grid`;
  const cells = grid.cols * grid.rows;
  if (cells > ARROWS.maxCells) return `a ${grid.cols} × ${grid.rows} grid has ${cells} cells, over the ${ARROWS.maxCells} a tap can carry (axis up to ${AXIS_MAX})`;
  return null;
}

// ---------------------------------------------------------------------------
// Mřížka bez stavu (stavba, řešič, testy)

/** Volná cesta z buňky `cell` ve směru `dir` až ven: `occupied(c)` = v buňce `c` stojí kus. */
export function pathClear(grid: ArrowsGrid, cell: number, dir: number, occupied: (cell: number) => boolean): boolean {
  const [dc, dr] = DIR_STEP[dir] as readonly [number, number];
  let col = (cell % grid.cols) + dc;
  let row = Math.floor(cell / grid.cols) + dr;
  while (col >= 0 && col < grid.cols && row >= 0 && row < grid.rows) {
    if (occupied(row * grid.cols + col)) return false;
    col += dc;
    row += dr;
  }
  return true;
}

/** Leží buňka `cell` na cestě kusu `piece` (mezi ním a okrajem ve směru šipky)? */
function onPath(grid: ArrowsGrid, piece: ArrowPiece, cell: number): boolean {
  const [dc, dr] = DIR_STEP[piece.dir] as readonly [number, number];
  const col = cell % grid.cols;
  const row = Math.floor(cell / grid.cols);
  const fromCol = piece.cell % grid.cols;
  const fromRow = Math.floor(piece.cell / grid.cols);
  if (dc === 0) return col === fromCol && (row - fromRow) * dr > 0;
  return row === fromRow && (col - fromCol) * dc > 0;
}

/**
 * Kusy jednoho kola ze semínka kola, v pořadí položení (obrácené pořadí odletu). Kandidát = prázdná buňka a směr
 * s volnou cestou od už položených; z `ARROWS.blockBias` losů ze 3 bere kandidáta, který leží na cestě některého
 * položeného kusu (zatarasí ho), je-li takový. Prázdná buňka bez volného směru stavbu zasekne – pak další pokus
 * s dalším losem téhož streamu; `null`, když nevyjde ani jeden.
 */
export function buildRound(seed: number, round: ArrowsRound): ArrowPiece[] | null {
  if (gridIssue(round) !== null || round.pieces > round.cols * round.rows) return null;
  const rng = createCompileRng(seed, 'layout');
  const cells = round.cols * round.rows;
  for (let attempt = 0; attempt < ARROWS.attempts; attempt += 1) {
    const taken = new Uint8Array(cells);
    const placed: ArrowPiece[] = [];
    while (placed.length < round.pieces) {
      const candidates: ArrowPiece[] = [];
      for (let cell = 0; cell < cells; cell += 1) {
        if (taken[cell] === 1) continue;
        for (let dir = 0; dir < ARROW_DIRS.length; dir += 1) if (pathClear(round, cell, dir, (other) => taken[other] === 1)) candidates.push({ cell, dir });
      }
      if (candidates.length === 0) break;
      const blocking = candidates.filter((candidate) => placed.some((piece) => onPath(round, piece, candidate.cell)));
      const pool = blocking.length > 0 && rng.int(0, 2) < ARROWS.blockBias ? blocking : candidates;
      const piece = rng.pick(pool);
      taken[piece.cell] = 1;
      placed.push(piece);
    }
    if (placed.length === round.pieces) return placed;
  }
  return null;
}

/**
 * Hladový řešič: dokud něco zbývá, odletí první kus (po řadách) s volnou cestou. Vrací pořadí odletu (indexy do
 * `pieces`), nebo `null`, když se mřížka zasekne – úroveň řešitelná není.
 */
export function solveArrows(grid: ArrowsGrid, pieces: readonly ArrowPiece[]): number[] | null {
  const at = new Int32Array(grid.cols * grid.rows).fill(-1);
  for (const [index, piece] of pieces.entries()) {
    if (piece.cell < 0 || piece.cell >= at.length || at[piece.cell] !== -1) return null;
    at[piece.cell] = index;
  }
  const order: number[] = [];
  while (order.length < pieces.length) {
    let next = -1;
    for (let cell = 0; cell < at.length && next < 0; cell += 1) {
      const index = at[cell] as number;
      if (index >= 0 && pathClear(grid, cell, (pieces[index] as ArrowPiece).dir, (other) => (at[other] as number) >= 0)) next = index;
    }
    if (next < 0) return null;
    at[(pieces[next] as ArrowPiece).cell] = -1;
    order.push(next);
  }
  return order;
}

/** Kusy všech kol ze semínka hry: semínka kol ze streamu háčků `rounds` (`roundSeeds`), každé kolo vlastní stavba. */
export function arrowsRounds(seed: number, rounds: number): { readonly grids: readonly ArrowsRound[]; readonly pieces: readonly (readonly ArrowPiece[] | null)[] } {
  const grids = roundGrids(rounds);
  const seeds = roundSeeds(seed, rounds);
  return { grids, pieces: grids.map((grid, round) => buildRound(seeds[round] as number, grid)) };
}

// ---------------------------------------------------------------------------
// Mřížka ve stavu jádra

/** HP kusu: 1 + směr + 4 × kolo (nejvýš 20, `HP_MAX` 511). */
export const pieceCode = (round: number, dir: number): number => 1 + dir + 4 * round;
export const roundOfCode = (code: number): number => Math.floor((code - 1) / 4);
export const dirOfCode = (code: number): number => (code - 1) % 4;

/**
 * Střed buňky ve světě, střed mřížky v počátku: sloupce po +x, řada 0 nejdál (+z). Kamera scény stojí jako u ostatních
 * žánrů na −z a kouká po +z (x jádra kreslí zrcadlově), takže sloupec 0 je na plátně vlevo a řada 0 nahoře.
 */
export function cellX(grid: ArrowsGrid, cell: number): number {
  return ((2 * (cell % grid.cols) - (grid.cols - 1)) * ARROWS.cell) / 2;
}
export function cellZ(grid: ArrowsGrid, cell: number): number {
  return (((grid.rows - 1) - 2 * Math.floor(cell / grid.cols)) * ARROWS.cell) / 2;
}

/** Buňka pod bodem `x, z` (střed těla kusu), nebo −1 mimo mřížku. */
export function cellAt(grid: ArrowsGrid, x: number, z: number): number {
  const col = (2 * x + (grid.cols - 1) * ARROWS.cell) / (2 * ARROWS.cell);
  const row = ((grid.rows - 1) * ARROWS.cell - 2 * z) / (2 * ARROWS.cell);
  if (!Number.isInteger(col) || !Number.isInteger(row) || col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) return -1;
  return row * grid.cols + col;
}

/** Je tělo živý kus kola `round`? */
export function livePieceOf(state: Int32Array, body: number, round: number): boolean {
  const base = bodyBase(body);
  if (((state[base + BODY.flags] as number) & FLAG.alive) === 0 || state[base + BODY.role] !== ROLE.target) return false;
  const code = bodyHp(state, body);
  return code > 0 && roundOfCode(code) === round;
}

/** Obsazení mřížky kola `round`: buňka → index těla kusu + 1, 0 = prázdná. */
export function occupancy(state: Int32Array, round: number, grid: ArrowsGrid): Int32Array {
  const out = new Int32Array(grid.cols * grid.rows);
  const count = state[HEADER.bodyCount] as number;
  for (let body = 0; body < count; body += 1) {
    if (!livePieceOf(state, body, round)) continue;
    const cell = cellAt(grid, state[bodyBase(body) + BODY.x] as number, state[bodyBase(body) + BODY.z] as number);
    if (cell >= 0) out[cell] = body + 1;
  }
  return out;
}

/** Směr kusu `body` (index v `ARROW_DIRS`). */
export const dirOf = (state: Int32Array, body: number): number => dirOfCode(bodyHp(state, body));

/** Odletí kus v buňce `cell` (podle obsazení `occ`)? */
export const freeIn = (state: Int32Array, occ: Int32Array, grid: ArrowsGrid, cell: number): boolean =>
  (occ[cell] as number) > 0 && pathClear(grid, cell, dirOf(state, (occ[cell] as number) - 1), (other) => (occ[other] as number) > 0);
