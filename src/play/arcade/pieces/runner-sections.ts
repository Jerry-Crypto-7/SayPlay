/**
 * Knihovna úseků běžce (P46D T2): tabulka hratelných vzorů, ze kterých
 * `sectionedTrack` s `patterns: 1` skládá trať místo náhodných řad.
 *
 * Vzor vrací jen tvar – kroky: řadu překážek po pruzích, stavbu (dlouhé
 * těleso: zeď rozcestí, voda pod mostem, strop tunelu) nebo delší mezeru
 * (sprint, stezka věcí). Odstupy, rychlost a mince dává skladatel v
 * `runner.ts` podle úseku. Robot běžce čte stavbu jako jednu řadu (`nextRow`
 * bere střed tělesa), proto uvnitř stavby nestojí žádná řada a stavba zavře
 * své pruhy po celé délce; `checkRunnerLevel` to tvrdí nad hotovou tratí.
 *
 * Moduly se navzájem importují: tady se hodnoty z `runner.ts` čtou jen
 * uvnitř funkcí, nikdy při načtení modulu.
 */

import type { CompileRng } from '@/play/compile/rng';

import { UNIT } from '../contract';
import { OBSTACLES, type ObstacleKind, type PassBy } from './runner';

export const RUNNER_PATTERNS = ['zigzag', 'jump-chain', 'slide-alley', 'fork', 'bridge', 'tunnel', 'trail', 'sprint'] as const;
export type RunnerPatternId = (typeof RUNNER_PATTERNS)[number];

export const STRUCTURE_KINDS = ['divider', 'water', 'ceiling'] as const;
export type StructureKind = (typeof STRUCTURE_KINDS)[number];

export interface StructureShape {
  /** Pruhy, které stavba zabere (každý svým tělesem); `null` = jedno těleso přes celou trať. */
  readonly lanes: readonly number[] | null;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly solid: boolean;
  /** Délka v ose z: [min, max]. */
  readonly length: readonly [number, number];
}

/**
 * Stavby. Zeď rozcestí a voda pod mostem jsou vyšší než vrchol skoku (robot
 * je čte jako „jen jiným pruhem“). Strop tunelu visí nad hlavou běžce
 * (`RUNNER.runH` 1600): běží se pod ním, skok do něj narazí.
 */
export const STRUCTURES: Readonly<Record<StructureKind, StructureShape>> = {
  divider: { lanes: [0], y: 0, w: 1600, h: 1500, solid: true, length: [8 * UNIT, 14 * UNIT] },
  water: { lanes: [-1, 1], y: 0, w: 2000, h: 1500, solid: false, length: [10 * UNIT, 16 * UNIT] },
  ceiling: { lanes: null, y: 2000, w: 8000, h: 600, solid: false, length: [10 * UNIT, 16 * UNIT] },
};

/** Stezka věcí: tolik mincí po `spacing` napříč pruhy v jedné mezeře. */
export const TRAIL = { coins: 6, spacing: 3 * UNIT } as const;
/** Mezera stezky: mince a po jedné rozteči před a za nimi. */
export const TRAIL_GAP = (TRAIL.coins + 1) * TRAIL.spacing;
/** Sprint: mezera tolikrát delší než běžný odstup úseku. */
export const SPRINT_GAPS = 3;

/** Pruhy řady −1, 0, 1: druh překážky, nebo `null` = volno. */
export type RowLanes = readonly [ObstacleKind | null, ObstacleKind | null, ObstacleKind | null];

export type RunnerStep =
  | { readonly row: RowLanes }
  | { readonly structure: StructureKind; readonly length: number }
  | { readonly gap: 'sprint' | 'trail' };

export interface RunnerPattern {
  readonly id: RunnerPatternId;
  /** Nejnižší stupeň hustoty úseku (`RUNNER_DENSITIES`: 0 řídce, 1 normálně, 2 hustě), od kterého vzor přijde. */
  readonly from: number;
  /** Kolik řad nebo staveb vzor zabere: [min, max]; 0 = jen mezera před další řadou. */
  readonly units: readonly [number, number];
  /** První krok je řada, která zavře startovní pruh: vzor smí trať otevřít a stát za sprintem. */
  readonly opens: boolean;
  /** Nejvýš tolikrát na trati; bez hodnoty bez omezení. */
  readonly most?: number;
  /** Váha při losování mezi vzory, které se hodí; bez hodnoty `PATTERN_WEIGHT`. */
  readonly weight?: number;
  /** Vzor jde postavit z druhů překážek věty (a s mincemi, když je potřebuje). */
  readonly fits: (kinds: readonly ObstacleKind[], coins: boolean) => boolean;
  readonly build: (rng: CompileRng, kinds: readonly ObstacleKind[], units: number) => RunnerStep[];
  /** Vlastní kontrola průchodnosti nad kroky vzoru: prázdné pole = tvar drží. */
  readonly check: (steps: readonly RunnerStep[]) => string[];
}

const LANES = [-1, 0, 1] as const;
const passOf = (kind: ObstacleKind): PassBy => OBSTACLES[kind].passBy;
const withPass = (kinds: readonly ObstacleKind[], pass: PassBy): ObstacleKind[] => kinds.filter((kind) => passOf(kind) === pass);
const lanesOf = (pick: (lane: number) => ObstacleKind | null): RowLanes => [pick(-1), pick(0), pick(1)];
const rowsOf = (steps: readonly RunnerStep[]): RowLanes[] => steps.flatMap((step) => ('row' in step ? [step.row] : []));
const freeLanes = (row: RowLanes): number[] => LANES.filter((lane) => row[lane + 1] === null);
/** Řadu jde minout: volný pruh, nebo překážka ke skoku či skluzu. */
const passable = (row: RowLanes): boolean => row.some((kind) => kind === null || passOf(kind) !== 'lane');
const unpassable = (rows: readonly RowLanes[]): string[] => rows.flatMap((row, index) => (passable(row) ? [] : [`row ${index} closes every lane`]));

/** Řady zavřené ve všech pruzích, v aspoň dvou překážkou `pass` (řetěz skoků, ulička skluzu). */
function closedChain(pass: 'jump' | 'slide'): Pick<RunnerPattern, 'fits' | 'build' | 'check'> {
  return {
    fits: (kinds) => withPass(kinds, pass).length > 0,
    build: (rng, kinds, units) => {
      const own = withPass(kinds, pass);
      return Array.from({ length: units }, () => {
        const odd = rng.int(-1, 1);
        return { row: lanesOf((lane) => (lane === odd ? rng.pick(kinds) : rng.pick(own))) };
      });
    },
    check: (steps) => {
      const rows = rowsOf(steps);
      const issues = unpassable(rows);
      rows.forEach((row, index) => {
        if (freeLanes(row).length > 0) issues.push(`row ${index} leaves a lane open`);
        if (row.filter((kind) => kind !== null && passOf(kind) === pass).length < 2) issues.push(`row ${index} has fewer than two ${pass} lanes`);
      });
      return issues;
    },
  };
}

/** Jedna stavba dané délky. */
function structure(kind: StructureKind): Pick<RunnerPattern, 'fits' | 'build' | 'check'> {
  const [min, max] = STRUCTURES[kind].length;
  return {
    fits: () => true,
    build: (rng) => [{ structure: kind, length: rng.int(min, max) }],
    check: (steps) =>
      steps.length === 1 && 'structure' in steps[0]! && steps[0].structure === kind && steps[0].length >= min && steps[0].length <= max ? [] : [`expected one ${kind} of ${min / UNIT}-${max / UNIT} m`],
  };
}

export const RUNNER_PATTERN_LIBRARY: readonly RunnerPattern[] = [
  {
    // Cik-cak: jediný volný pruh na kraji, každou řadu na opačném (přesun o dva pruhy).
    id: 'zigzag',
    from: 0,
    units: [4, 5],
    opens: true,
    fits: () => true,
    build: (rng, kinds, units) => {
      const side = rng.pick([-1, 1] as const);
      return Array.from({ length: units }, (_, index) => {
        const open = index % 2 === 0 ? side : -side;
        return { row: lanesOf((lane) => (lane === open ? null : rng.pick(kinds))) };
      });
    },
    check: (steps) => {
      const rows = rowsOf(steps);
      const issues = rows.length === steps.length ? [] : ['zigzag holds only rows'];
      rows.forEach((row, index) => {
        const open = freeLanes(row);
        if (open.length !== 1 || open[0] === 0) issues.push(`row ${index} must leave exactly one edge lane open`);
        else if (index > 0 && freeLanes(rows[index - 1]!)[0] !== -open[0]!) issues.push(`row ${index} does not switch sides`);
      });
      return issues;
    },
  },
  // Zavřené řady jen v nejtěžším úseku, jednou na trať a s poloviční vahou: začátečník (reakce +12 tiků)
  // skáče pozdě a na řetězu ztratí všechny životy, bez řetězu vyhraje ~5 z 6. S rovnou vahou řetěz stál
  // na 3 tratích ze 4 a začátečník vyhrál 5/20; cíl 0,3–0,7 hlídá `runner-sections.test.ts`.
  { id: 'jump-chain', from: 2, units: [3, 3], opens: true, most: 1, weight: 1, ...closedChain('jump') },
  { id: 'slide-alley', from: 2, units: [3, 3], opens: true, most: 1, weight: 1, ...closedChain('slide') },
  {
    // Rozcestí: vstupní řada zavře střed (a jeden kraj překážkou ke skoku či skluzu), pak zeď dělí trať na dvě cesty.
    id: 'fork',
    from: 0,
    units: [2, 2],
    opens: true,
    fits: () => true,
    build: (rng, kinds) => {
      const over = kinds.filter((kind) => passOf(kind) !== 'lane');
      const side = rng.pick([-1, 1] as const);
      const closed = over.length > 0 && rng.int(0, 1) === 1 ? rng.pick(over) : null;
      const entry = lanesOf((lane) => (lane === 0 ? rng.pick(kinds) : lane === side ? closed : null));
      return [{ row: entry }, ...structure('divider').build(rng, kinds, 1)];
    },
    check: (steps) => {
      const [entry, wall] = steps;
      if (entry === undefined || !('row' in entry) || wall === undefined || !('structure' in wall) || wall.structure !== 'divider') return ['fork is an entry row and a divider'];
      return [...unpassable([entry.row]), ...(entry.row[1] === null ? ['the entry row leaves the centre open'] : []), ...(freeLanes(entry.row).length === 0 ? ['the entry row leaves no lane open'] : [])];
    },
  },
  // Most s jedním pruhem: voda v krajních pruzích, běží se středem.
  { id: 'bridge', from: 0, units: [1, 1], opens: false, ...structure('water') },
  // Tunel: strop nad hlavou přes celou trať, skok do něj narazí.
  { id: 'tunnel', from: 0, units: [1, 1], opens: false, ...structure('ceiling') },
  {
    // Stezka věcí: delší mezera, ve které mince kličkují napříč pruhy (klade je skladatel).
    id: 'trail',
    from: 0,
    units: [0, 0],
    opens: false,
    fits: (_kinds, coins) => coins,
    build: () => [{ gap: 'trail' }],
    check: (steps) => (steps.length === 1 && 'gap' in steps[0]! && steps[0].gap === 'trail' ? [] : ['trail is one trail gap']),
  },
  {
    // Volný sprint: mezera `SPRINT_GAPS`× delší, jen mezi dvěma řadami.
    id: 'sprint',
    from: 0,
    units: [0, 0],
    opens: false,
    fits: () => true,
    build: () => [{ gap: 'sprint' }],
    check: (steps) => (steps.length === 1 && 'gap' in steps[0]! && steps[0].gap === 'sprint' ? [] : ['sprint is one sprint gap']),
  },
];

/** Kde na trati se vybírá další vzor. */
export interface PatternSlot {
  /** Stupeň hustoty úseku. */
  readonly step: number;
  readonly kinds: readonly ObstacleKind[];
  readonly coins: boolean;
  /** Vzory, které už na trati stojí, v pořadí; stejný hned za sebou nepřijde. */
  readonly used: readonly RunnerPatternId[];
  /** Řad, které úseku zbývají. */
  readonly left: number;
  /** Na trati ještě nic nestojí. */
  readonly first: boolean;
  /** Poslední krok byla mezera (sprint nebo stezka), která čeká na další řadu. */
  readonly gap: 'sprint' | 'trail' | null;
  /** Poslední postavený prvek byla řada, ne stavba (sprint měřidlo pozná jen mezi řadami). */
  readonly afterRow: boolean;
}

export const PATTERN_WEIGHT = 2;

/** Vzor na místo losem podle vah, nebo `null`, když se žádný nehodí (skladatel postaví náhodnou řadu). */
export function pickPattern(rng: CompileRng, slot: PatternSlot, library?: readonly RunnerPattern[]): RunnerPattern | null {
  const options = patternsFor(slot, library).flatMap((pattern) => Array.from({ length: pattern.weight ?? PATTERN_WEIGHT }, () => pattern));
  return options.length === 0 ? null : rng.pick(options);
}

/** Vzory, které se na místo hodí. */
export function patternsFor(slot: PatternSlot, library: readonly RunnerPattern[] = RUNNER_PATTERN_LIBRARY): RunnerPattern[] {
  return library.filter((pattern) => {
    if (pattern.from > slot.step || pattern.id === slot.used.at(-1) || !pattern.fits(slot.kinds, slot.coins) || pattern.units[0] > slot.left) return false;
    if (pattern.most !== undefined && slot.used.filter((id) => id === pattern.id).length >= pattern.most) return false;
    if (slot.first || slot.gap === 'sprint') return pattern.opens;
    if (pattern.units[1] === 0) return slot.gap === null && (pattern.id !== 'sprint' || slot.afterRow);
    return true;
  });
}
