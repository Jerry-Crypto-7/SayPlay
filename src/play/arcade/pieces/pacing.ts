/**
 * Průběh hry (P45C): úvod, stupňování, vrchol, finále.
 *
 * Intenzita je čistá celočíselná funkce **postupu ke cíli** v promile
 * (`progressOf`) – hra se stupňuje stejně pro rychlého i pomalého hráče a
 * finále přijde těsně před výhrou; podíl uběhlého času je spodní mez, takže
 * tlak roste i nečinnému hráči. Intenzita 1000 = dnešní úroveň hry.
 *
 * Rozvrh spawnů se losuje jen při stavbě světa ze streamu `pacing`
 * (`createCompileRng(seed, 'pacing')`); za běhu žádná náhoda.
 */

import { z } from 'zod';

import type { CompileRng } from '@/play/compile/rng';

import { ARCADE_LIMITS, BODY, COUNTER, FLAG, HEADER, bodyBase } from '../contract';

export const PACING = {
  /** Konce segmentů v promile postupu: úvod 0–200, stupňování 200–650, vrchol 650–850, finále 850–1000. */
  segments: { intro: 200, buildUp: 650, peak: 850, finale: 1000 },
  /** Intenzita v promile dnešní úrovně: úvod, konec stupňování, vrchol, finále. */
  intensity: { intro: 700, buildUp: 1100, peak: 1300, finale: 1500 },
  /** Hustota spawnů roste s `intensita − spawnFloor`: úvod dostane málo, vrchol a finále hodně. */
  spawnFloor: 500,
  /** Živých těl chování naráz nejvýš. */
  maxActors: 12,
} as const;

/** Body křivky `[postup ‰, intenzita ‰]`; mezi body lineárně, dva body na stejném postupu = skok. */
export type TensionCurve = readonly (readonly [permille: number, intensity: number])[];

const { segments: S, intensity: I } = PACING;

/** Plocha pod křivkou 1030 ‰ dnešní úrovně: úvod lehčí, vrchol a finále těžší. */
export const TENSION_CURVE: TensionCurve = [
  [0, I.intro],
  [S.intro, I.intro],
  [S.buildUp, I.buildUp],
  [S.buildUp, I.peak],
  [S.peak, I.peak],
  [S.peak, I.finale],
  [S.finale, I.finale],
];

/** Intenzita v promile na postupu `progress` (0–1000); celočíselně, poslední bod se stejným postupem vyhrává. */
export function intensityAt(progress: number, curve: TensionCurve): number {
  let at = 0;
  while (at + 1 < curve.length && (curve[at + 1] as readonly [number, number])[0] <= progress) at += 1;
  const [x0, y0] = curve[at] as readonly [number, number];
  const next = curve[at + 1];
  if (next === undefined || next[0] === x0) return y0;
  const [x1, y1] = next;
  const rise = (y1 - y0) * (progress - x0);
  // Celočíselné dělení se zaokrouhlením k nule i pro klesající úsek.
  return y0 + (rise - (rise % (x1 - x0))) / (x1 - x0);
}

/** Jak hra měří postup ke cíli: ujetá trať, sebrané věci, skóre, padlí soupeři, nebo jen čas. */
export const pacingGoalSchema = z
  .object({
    by: z.enum(['distance', 'items', 'score', 'fallen', 'time']),
    /** Délka trati v jednotkách, potřebné věci, cílové skóre, počet soupeřů, nebo tiky (`time`). */
    need: z.int().min(1),
    /** Jen `fallen`: kód role soupeřů. */
    role: z.int().min(1).optional(),
    /** Tiky, po kterých je postup podle času 1000 (spodní mez postupu). */
    limit: z.int().min(1).max(ARCADE_LIMITS.maxTicks),
  })
  .strict();
export type PacingGoal = z.infer<typeof pacingGoalSchema>;

const share = (done: number, need: number): number => Math.min(1000, Math.max(0, Math.floor((done * 1000) / need)));

/** Postup ke cíli v promile: větší z cílového postupu a podílu uběhlého času. */
export function progressOf(state: Int32Array, goal: PacingGoal): number {
  const time = share(state[HEADER.tick] as number, goal.limit);
  const counter = (name: keyof typeof COUNTER): number => state[HEADER.counters + COUNTER[name]] as number;
  let done = 0;
  if (goal.by === 'distance') done = state[bodyBase(state[HEADER.player] as number) + BODY.z] as number;
  else if (goal.by === 'items') done = counter('items');
  else if (goal.by === 'score') done = counter('score');
  else if (goal.by === 'fallen') {
    let alive = 0;
    const bodies = state[HEADER.bodyCount] as number;
    for (let body = 0; body < bodies; body += 1) {
      const base = bodyBase(body);
      if (state[base + BODY.role] === goal.role && ((state[base + BODY.flags] as number) & FLAG.alive) !== 0) alive += 1;
    }
    done = goal.need - alive;
  } else done = state[HEADER.tick] as number;
  return Math.max(time, share(done, goal.need));
}

/** Jeden krok rozvrhu: na postupu `atPermille` přijde `count` těl chování `behaviour` (index), `entry` = vstup 0–3. */
export interface ScheduleEntry {
  readonly atPermille: number;
  readonly behaviour: number;
  readonly count: number;
  readonly entry: number;
}

/**
 * `n` míst v promile postupu, kde kumulovaná plocha `intensita − spawnFloor`
 * dosáhne středů `n` stejných dílů (± čtvrt dílu losem, když je `rng`).
 * Husté tam, kde je křivka vysoko. Statické žánry (rytmus) staví nad ním noty.
 */
export function placeByCurve(curve: TensionCurve, n: number, rng?: CompileRng): number[] {
  const cumulative: number[] = [0];
  for (let p = 0; p < 1000; p += 1) cumulative.push((cumulative[p] as number) + Math.max(0, intensityAt(p, curve) - PACING.spawnFloor));
  const total = cumulative[1000] as number;
  const quarter = Math.floor(total / (4 * n));
  const places: number[] = [];
  let p = 0;
  for (let k = 0; k < n; k += 1) {
    const target = Math.floor(((2 * k + 1) * total) / (2 * n)) + (rng === undefined ? 0 : rng.int(-quarter, quarter));
    while (p < 999 && (cumulative[p + 1] as number) <= target) p += 1;
    places.push(p);
  }
  return places;
}

/** Rozvrh `budget` spawnů z `kinds` chování; ve vrcholu a finále přijdou po dvou. Jen při stavbě. */
export function scheduleOf(rng: CompileRng, curve: TensionCurve, budget: number, kinds = 1): ScheduleEntry[] {
  return placeByCurve(curve, budget, rng).map((atPermille) => ({
    atPermille,
    behaviour: rng.int(0, kinds - 1),
    count: intensityAt(atPermille, curve) >= PACING.intensity.peak ? 2 : 1,
    entry: rng.int(0, 3),
  }));
}
