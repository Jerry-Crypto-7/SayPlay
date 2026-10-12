/**
 * Scénář úseků (P46B T3): co přinese úsek 2 a úsek 3 hry proti úseku před ním.
 *
 * Úseky jsou `PACING.segments`: rozjezd 0–200 ‰, úsek 2 200–650, úsek 3
 * 650–850, finále 850–1000. Scénář je čistá funkce ze streamu `pacing` –
 * `withPacing` ho losuje až za rozvrhem, takže kroky rozvrhu zůstanou, kde
 * byly, a za běhu žádná náhoda. Každá změna je hratelná (nový nepřítel,
 * rychlost, prostředí, hustota); nový vzhled téhož chování změna není.
 */

import type { CompileRng } from '@/play/compile/rng';

import type { BehaviourId } from './behaviours';
// Cyklus s `pacing.ts` (`withPacing` losuje scénář) je bezpečný: `PACING` se čte jen ve funkcích, ne při načtení.
import { PACING } from './pacing';

/** Žánry se scénářem úseků; řízení a skákačka přibudou s T5 a T6. */
export type SegmentGenre = 'runner';

export type SegmentChange =
  | { readonly kind: 'newFoe'; readonly behaviour: BehaviourId }
  | { readonly kind: 'speedTier'; readonly percent: number }
  | { readonly kind: 'terrain'; readonly variant: string }
  | { readonly kind: 'density'; readonly step: number };

/** Úsek scénáře: od `at` ‰ do `until` ‰ postupu, přinese `changes` (prázdné = hra nemá čím úsek změnit). */
export interface SegmentStep {
  readonly at: number;
  readonly until: number;
  readonly changes: readonly SegmentChange[];
}

/** Co hra pro úseky má: nová chování (od kterého postupu smějí přijít), rychlost a hustota v rozjezdu a obou úsecích, druhy prostředí. */
export interface SegmentCast {
  readonly foes: readonly { readonly behaviour: BehaviourId; readonly from: number }[];
  /** Rychlost trati v % na začátku rozjezdu, úseku 2 a úseku 3 (fáze světa); prázdné = trať bez fází. */
  readonly speeds: readonly number[];
  readonly terrain?: readonly string[];
  readonly density?: readonly number[];
}

/** Úseky 2 a 3 jako `[začátek, konec)` v promile postupu. */
export const segmentSpans = (): readonly (readonly [number, number])[] => [
  [PACING.segments.intro, PACING.segments.buildUp],
  [PACING.segments.buildUp, PACING.segments.peak],
];

/**
 * Které změny žánr unese. Běžec bez prostředí a hustoty: řady navíc by zavřely
 * volný pruh (`GENRE_PACING.runner_track`), rychlost dávají fáze křivky.
 */
const KINDS: Readonly<Record<SegmentGenre, readonly SegmentChange['kind'][]>> = {
  runner: ['speedTier', 'newFoe'],
};

const rises = (values: readonly number[] | undefined, k: number): boolean =>
  values !== undefined && (values[k] ?? 0) > (values[k - 1] ?? Infinity);

/**
 * Scénář úseků 2 a 3: rychlost a hustota, když proti předchozímu úseku rostou,
 * a losem nový nepřítel a nový druh prostředí, které žádný dřívější úsek neměl.
 * Nepřítel úseku smí přijít nejdřív na jeho začátku (`from`); u běžce tak úsek 2
 * otevře flanker nebo ostřelovač a úsek 3 hejno. Los jen tam, kde je z čeho vybrat.
 */
export function segmentScriptOf(rng: CompileRng, genre: SegmentGenre, cast: SegmentCast): SegmentStep[] {
  const kinds = new Set(KINDS[genre]);
  const used = new Set<string>();
  return segmentSpans().map(([at, until], index) => {
    const k = index + 1;
    const changes: SegmentChange[] = [];
    if (kinds.has('speedTier') && rises(cast.speeds, k)) changes.push({ kind: 'speedTier', percent: cast.speeds[k] as number });
    if (kinds.has('density') && rises(cast.density, k)) changes.push({ kind: 'density', step: k });
    const open = cast.foes.filter((foe) => foe.from <= at && !used.has(foe.behaviour));
    // Přednost má nepřítel, který dřív přijít ani nesměl: jinak ho `withPacing` z dřívějších úseků vyjme a ubude jim útoků.
    const fresh = open.filter((foe) => foe.from >= at);
    const foes = [...new Set((fresh.length > 0 ? fresh : open).map((foe) => foe.behaviour))];
    if (kinds.has('newFoe') && foes.length > 0) {
      const behaviour = rng.pick(foes);
      used.add(behaviour);
      changes.push({ kind: 'newFoe', behaviour });
    }
    const terrain = (cast.terrain ?? []).filter((variant) => !used.has(`terrain:${variant}`));
    if (kinds.has('terrain') && terrain.length > 0) {
      const variant = rng.pick(terrain);
      used.add(`terrain:${variant}`);
      changes.push({ kind: 'terrain', variant });
    }
    return { at, until, changes };
  });
}
