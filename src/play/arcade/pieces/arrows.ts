/**
 * Šipky (P66 T9): mřížka kusů z věty se šipkami směru; klepnutý kus odletí, má-li ve směru šipky volnou cestu ven,
 * jinak narazí a hráč ztratí srdce. Kola s rostoucí mřížkou, poslední je finále (`arrows-level.ts`).
 *
 * **Vstup:** ťuk nese buňku v ose záznamu (`axisOfCell` v `lanes.ts`; plátno ji spočítá z `data-lane-cells` –
 * `cellAxisAt`), takže hra nový vstup nepotřebuje. Klávesnice: šipky vlevo / vpravo posunou kurzor po kusech běžícího
 * kola (po řadách), mezerník ťukne na kus pod kurzorem; první mezerník bez kurzoru kurzor jen ukáže.
 *
 * Tělo hráče: `aux0` = kurzor (buňka + 1, 0 = žádný), `aux1` = buňka ťuku v tomto tiku + 1 (0 = bez ťuku).
 *
 * **Pravidlo `arrows_tap`:** ťuk na kus s volnou cestou = kus odletí (body × kombo, `items` + 1); poslední kus kola
 * = výhra pravidla, kterou háčky (`withHooks`, `clear: 'win'`) před posledním kolem promění v konec kola. Ťuk na kus
 * s kusem v cestě = náraz: srdce dolů a kombo zpět na ×1. Ťuk do prázdné buňky nedělá nic. Kombo roste za sérii
 * odletů bez nárazu, bez časového okna; parametr `combo` z něj dělá zdroj komba nové hry (`hookedComboSources`).
 *
 * Prohra: srdce na nule (`out_of_health`) nebo hodiny celé hry (`time_limit`, `arrowsSeconds`).
 * Kusy, kurzor ani pravidlo nelosují nic za běhu; náhodu spotřebuje jen stavba (`arrows-level.ts`).
 */

import { z } from 'zod';

import {
  ARCADE_LIMITS,
  type ArcadeEffect,
  type ArcadeLevel,
  BODY,
  BUTTON,
  type BodyInit,
  type ControlPiece,
  type ModeGeneratorPiece,
  type ModeParts,
  type PieceRef,
  type RulePiece,
  START_LIVES,
  bodyBase,
} from '../contract';
import { roundOf, withHooks } from '../hooks';
import {
  ARROWS,
  type ArrowPiece,
  type ArrowsGrid,
  arrowsRounds,
  arrowsSeconds,
  cellX,
  cellZ,
  freeIn,
  gridIssue,
  occupancy,
  pieceCode,
  roundGrids,
  solveArrows,
  totalPieces,
} from './arrows-level';
import { cellOfAxis } from './lanes';
import { nextMultiplier } from './rules';

const bodyIndex = z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1);
export const gridSchema = z.object({ cols: z.int().min(1).max(ARROWS.maxCells), rows: z.int().min(1).max(ARROWS.maxCells) }).strict();
const gridsSchema = z.array(gridSchema).min(1).max(ARROWS.rounds.max);

/** Mřížka běžícího kola (po posledním kole drží poslední). */
export const gridOfRound = (grids: readonly ArrowsGrid[], round: number): ArrowsGrid => (grids[Math.min(round, grids.length - 1)] as ArrowsGrid);

// ---------------------------------------------------------------------------
// Ovládání

const controlParams = z.object({ keeper: bodyIndex, grids: gridsSchema }).strict();
export type ArrowsControlParams = z.infer<typeof controlParams>;

/** Další kus po řadách od buňky `from` (bez ní) ve směru `step` (±1), dokola; buňka + 1, nebo 0, když žádný není. */
function nextPiece(occ: Int32Array, from: number, step: 1 | -1): number {
  const cells = occ.length;
  for (let offset = 1; offset <= cells; offset += 1) {
    const cell = (((from + step * offset) % cells) + cells) % cells;
    if ((occ[cell] as number) > 0) return cell + 1;
  }
  return 0;
}

/** Kurzor hráče (buňka + 1, 0 = žádný) a buňka ťuku v tomto tiku + 1. */
export const cursorOf = (state: Int32Array, player: number): number => state[bodyBase(player) + BODY.aux0] as number;
export const tapOf = (state: Int32Array, player: number): number => state[bodyBase(player) + BODY.aux1] as number;

export const arrowsControl: ControlPiece<ArrowsControlParams> = {
  id: 'arrows',
  params: controlParams,
  roles: ['player', 'target'],
  cost: () => ({ bodies: 0, rules: 0 }),
  step: (state, player, input, params) => {
    const base = bodyBase(player);
    const grid = gridOfRound(params.grids, roundOf(state, params.keeper));
    const occ = occupancy(state, roundOf(state, params.keeper), grid);
    let cursor = state[base + BODY.aux0] as number;
    // Kus pod kurzorem odletěl (nebo začalo kolo s jinou mřížkou): kurzor skočí na další kus po řadách.
    if (cursor > 0 && (cursor > occ.length || occ[cursor - 1] === 0)) cursor = nextPiece(occ, Math.min(cursor, occ.length) - 1, 1);
    if ((input.buttons & BUTTON.RIGHT) !== 0) cursor = cursor === 0 ? nextPiece(occ, -1, 1) : nextPiece(occ, cursor - 1, 1);
    if ((input.buttons & BUTTON.LEFT) !== 0) cursor = cursor === 0 ? nextPiece(occ, 0, -1) : nextPiece(occ, cursor - 1, -1);
    let tap = 0;
    if ((input.buttons & BUTTON.TAP) !== 0) {
      if (input.axis !== 0) {
        const cell = cellOfAxis(input.axis);
        if (cell >= 0 && cell < occ.length) tap = cell + 1;
      } else if (cursor > 0) tap = cursor;
      else cursor = nextPiece(occ, -1, 1);
    }
    state[base + BODY.aux0] = cursor;
    state[base + BODY.aux1] = tap;
  },
};

// ---------------------------------------------------------------------------
// Pravidlo

const tapParams = z
  .object({
    keeper: bodyIndex,
    grids: gridsSchema,
    points: z.int().min(1).max(100),
    /** Počítadlo komba (`withCombo`, zdroj komba nové hry od `genre.v6`); bez něj body bez násobiče. */
    combo: bodyIndex.optional(),
  })
  .strict();
export type ArrowsTapParams = z.infer<typeof tapParams>;

/** Násobič odletu: po nárazu (násobič 0 v počítadle) série začne od ×1, jinak o stupeň výš bez časového okna. */
const arrowsMultiplier = (state: Int32Array, keeper: number): number =>
  (state[bodyBase(keeper) + BODY.aux0] as number) === 0 ? 1 : nextMultiplier(state, keeper, ARCADE_LIMITS.maxTicks);

export const arrowsTapRule: RulePiece<ArrowsTapParams> = {
  id: 'arrows_tap',
  params: tapParams,
  roles: ['player', 'target'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params) => {
    const tap = tapOf(state, player);
    if (tap <= 0) return [];
    const round = roundOf(state, params.keeper);
    const grid = gridOfRound(params.grids, round);
    const occ = occupancy(state, round, grid);
    const cell = tap - 1;
    if (cell >= occ.length || occ[cell] === 0) return [];
    const body = (occ[cell] as number) - 1;
    if (!freeIn(state, occ, grid, cell)) {
      const bumped: ArcadeEffect[] = [{ kind: 'damage', amount: 1 }];
      if (params.combo !== undefined) bumped.push({ kind: 'combo', body: params.combo, multiplier: 0 });
      return bumped;
    }
    const multiplier = params.combo === undefined ? 1 : arrowsMultiplier(state, params.combo);
    // Body před zmizením: létající skóre háčků se ukáže nad kusem (`popBody`).
    const out: ArcadeEffect[] = [{ kind: 'score', amount: params.points * multiplier }, { kind: 'despawn', body }, { kind: 'count', counter: 'items', amount: 1 }];
    if (params.combo !== undefined) out.push({ kind: 'combo', body: params.combo, multiplier });
    if (occ.filter((entry) => entry > 0).length === 1) out.push({ kind: 'win' });
    return out;
  },
};

export const ARROWS_RULES: Readonly<Record<string, RulePiece>> = { arrows_tap: arrowsTapRule };

// ---------------------------------------------------------------------------
// Generátor

export const arrowsParams = z
  .object({
    /** Kola (mřížka roste, poslední je finále). */
    rounds: z.int().min(ARROWS.rounds.min).max(ARROWS.rounds.max).default(ARROWS.rounds.default),
  })
  .strict();
export type ArrowsParams = z.infer<typeof arrowsParams>;

/** Hrdina stojí za zadní hranou (řada 0, +z) mřížky s `rows` řadami, uprostřed, čelem ke kameře. */
export const heroZOf = (rows: number): number => (rows * ARROWS.cell) / 2 + ARROWS.heroGap + ARROWS.hero.d / 2;

/** Tělo hrdiny stojí za největší mřížkou hry; scéna ho kreslí za mřížkou běžícího kola (`heroZOf`). */
export const heroZ = (grids: readonly ArrowsGrid[]): number => heroZOf(Math.max(...grids.map((grid) => grid.rows)));

/** Úroveň šipek: hrdina a kusy všech kol na buňkách svých mřížek (HP = kód kola a směru). */
export function arrowsLevel(seed: number, rounds: number): { readonly level: ArcadeLevel; readonly issues: readonly string[]; readonly pieces: readonly (readonly ArrowPiece[])[] } {
  const built = arrowsRounds(seed, rounds);
  const issues: string[] = [];
  const pieces = built.pieces.map((round, index) => {
    const grid = built.grids[index] as ArrowsGrid;
    const problem = gridIssue(grid);
    if (problem !== null) issues.push(`round ${index + 1}: ${problem}`);
    if (round === null) issues.push(`round ${index + 1}: no solvable ${grid.cols} × ${grid.rows} grid could be built`);
    return round ?? [];
  });
  const hero: BodyInit = { role: 'player', kind: 'player', x: 0, y: 0, z: heroZ(built.grids), ...ARROWS.hero, solid: false };
  const bodies: BodyInit[] = [hero];
  pieces.forEach((round, index) => {
    const grid = built.grids[index] as ArrowsGrid;
    for (const piece of round) {
      bodies.push({ role: 'target', kind: 'piece', x: cellX(grid, piece.cell), y: 0, z: cellZ(grid, piece.cell), ...ARROWS.piece, solid: false, hp: pieceCode(index, piece.dir) });
    }
  });
  return { level: { bodies, length: 0 }, issues, pieces };
}

/** Tvrzení „řešitelné z konstrukce“ nad postavenými koly; prázdné = hratelná. */
export function checkArrowsLevel(grids: readonly ArrowsGrid[], pieces: readonly (readonly ArrowPiece[])[], bodies: number): string[] {
  const issues: string[] = [];
  grids.forEach((grid, round) => {
    const problem = gridIssue(grid);
    if (problem !== null) issues.push(`round ${round + 1}: ${problem}`);
    else if (solveArrows(grid, pieces[round] ?? []) === null) issues.push(`round ${round + 1}: the pieces jam – no order clears the grid`);
    if ((pieces[round]?.length ?? 0) === 0) issues.push(`round ${round + 1}: the grid has no pieces`);
    if (round > 0 && grid.cols * grid.rows <= (grids[round - 1] as ArrowsGrid).cols * (grids[round - 1] as ArrowsGrid).rows) issues.push(`round ${round + 1}: the grid does not grow`);
  });
  if (bodies > ARCADE_LIMITS.maxBodies) issues.push(`${bodies} bodies exceed the ${ARCADE_LIMITS.maxBodies} body limit`);
  return issues;
}

/** Díly světa: ovládání a robot šipek, kusy všech kol, pravidla a háčky kol (`clear: 'win'`). */
export function arrowsParts(seed: number, params: ArrowsParams, health: number | undefined): ModeParts {
  const lives = health ?? START_LIVES;
  const { level, issues, pieces } = arrowsLevel(seed, params.rounds);
  const grids = roundGrids(params.rounds).map(({ cols, rows }) => ({ cols, rows }));
  // Počítadlo háčků položí `withHooks` hned za tělesa úrovně – jeho index kusy dostanou předem.
  const keeper = level.bodies.length;
  const rules: PieceRef[] = [
    { id: 'arrows_tap', params: { keeper, grids, points: ARROWS.points } },
    { id: 'out_of_health', params: {} },
    { id: 'time_limit', params: { seconds: arrowsSeconds(params.rounds) } },
    // Pilulka postupu HUD (`collectNeed`) čte cíl z `finish_collected`; tělo cíle svět nemá, takže nevystřelí.
    { id: 'finish_collected', params: { need: totalPieces(params.rounds) } },
  ];
  const hooked = withHooks({ level, rules, bot: { id: 'arrows_bot', params: { keeper, grids } } }, seed, { rounds: params.rounds, clear: 'win' });
  return {
    control: { id: 'arrows', params: { keeper, grids } },
    bot: hooked.bot,
    level: hooked.level,
    rules: hooked.rules,
    issues: [...issues, ...checkArrowsLevel(grids, pieces, hooked.level.bodies.length)],
    health: lives,
  };
}

export const arrowsGrid: ModeGeneratorPiece<ArrowsParams> = {
  id: 'arrows_grid',
  params: arrowsParams,
  roles: ['player', 'target'],
  // Hrdina, kusy, počítadlo háčků a počítadlo komba (`withCombo`).
  cost: (params) => ({ bodies: 3 + totalPieces(params.rounds), rules: 5 }),
  generate: (seed, params) => arrowsLevel(seed, params.rounds).level,
  parts: arrowsParts,
};
