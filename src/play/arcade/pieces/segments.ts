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
import { PACING, type SegmentNews } from './pacing';

/** Žánry se scénářem úseků; `field` = volné pole (sběr, útěk, přežití, quest v prostoru – P47A T8, jen `genre.v4`). */
export type SegmentGenre = 'runner' | 'steer' | 'platform' | 'field';

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
  /** Volná šířka trati uprostřed rozjezdu, úseku 2 a úseku 3 (řízení: mezi mantinely); užší úsek = prostředí `narrow`. */
  readonly widths?: readonly number[];
  /**
   * Druhy prostředí, které generátor postavil do rozjezdu, úseku 2 a úseku 3 (skákačka: `trap` = past, `moving` =
   * pohyblivá plošina); každý, který dřívější úsek neměl, je změna úseku – bez losu, svět je hotový.
   */
  readonly places?: readonly (readonly string[])[];
}

/** Úseky 2 a 3 jako `[začátek, konec)` v promile postupu. */
export const segmentSpans = (): readonly (readonly [number, number])[] => [
  [PACING.segments.intro, PACING.segments.buildUp],
  [PACING.segments.buildUp, PACING.segments.peak],
];

/**
 * Které změny žánr unese. Běžec bez prostředí a hustoty: řady navíc by zavřely
 * volný pruh (`GENRE_PACING.runner_track`), rychlost dávají fáze křivky. Řízení
 * (T5): nový soupeř, rychlost a užší trať (`widths` – šířky staví generátor).
 */
const KINDS: Readonly<Record<SegmentGenre, readonly SegmentChange['kind'][]>> = {
  runner: ['speedTier', 'newFoe'],
  steer: ['speedTier', 'newFoe', 'terrain'],
  // Skákačka (T6): nová past a pohyblivá plošina (`places` z generátoru) a rychlost; nepřítel je jen boss finále.
  platform: ['speedTier', 'terrain'],
  // Pole (P47A T8): jen nový nepřítel – rychlost pronásledovatelů dávají vlny, aréna nemá prostředí po úsecích.
  field: ['newFoe'],
};

/**
 * Změny úseků, které žánr unese, slovy oznámení (`SEGMENT_NEWS`): totéž co `KINDS`, prostředí rozepsané na druhy,
 * které generátor žánru staví (řízení užší trať, skákačka past a pohyblivou plošinu). Čte je režisér (P46E T3).
 */
export const SEGMENT_NEWS_OF: Readonly<Record<SegmentGenre, readonly SegmentNews[]>> = {
  runner: ['newFoe', 'faster'],
  steer: ['newFoe', 'narrow', 'faster'],
  platform: ['trap', 'moving', 'faster'],
  field: ['newFoe'],
};

const rises = (values: readonly number[] | undefined, k: number): boolean =>
  values !== undefined && (values[k] ?? 0) > (values[k - 1] ?? Infinity);
const falls = (values: readonly number[] | undefined, k: number): boolean =>
  values !== undefined && (values[k] ?? Infinity) < (values[k - 1] ?? 0);

/**
 * Scénář úseků 2 a 3: rychlost a hustota, když proti předchozímu úseku rostou,
 * a losem nový nepřítel a nový druh prostředí, které žádný dřívější úsek neměl.
 * Nepřítel úseku smí přijít nejdřív na jeho začátku (`from`); u běžce tak úsek 2
 * otevře flanker nebo ostřelovač a úsek 3 hejno. Los jen tam, kde je z čeho vybrat.
 *
 * Scénář režiséra (`script`, P46E T4) ho přepíše: úsek 2 nese první změnu, úsek 3 ostatní, a úsek dostane jen
 * změny, které režisér jmenoval a hra má. Úsek bez „newFoe“ nového nepřítele nepřinese (`withPacing` podrží
 * nepřátele bez příchodu za ním).
 */
export function segmentScriptOf(rng: CompileRng, genre: SegmentGenre, cast: SegmentCast, script?: readonly SegmentNews[]): SegmentStep[] {
  const used = new Set<string>();
  return segmentSpans().map(([at, until], index) => {
    const named = script === undefined ? null : index === 0 ? script.slice(0, 1) : script.slice(1);
    const kinds = new Set(KINDS[genre].filter((kind) => named === null || named.some((news) => NEWS_KINDS[news] === kind)));
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
    const placed = (cast.places?.[k] ?? []).filter((variant) => !(cast.places ?? []).slice(0, k).some((earlier) => earlier.includes(variant)));
    // Užší trať je změna každého úseku, který zúží – bez losu (šířky jsou ve světě hotové); stejně nový druh prostředí z generátoru.
    if (kinds.has('terrain') && falls(cast.widths, k)) changes.push({ kind: 'terrain', variant: 'narrow' });
    else if (kinds.has('terrain') && placed.length > 0) changes.push(...placed.map((variant) => ({ kind: 'terrain' as const, variant })));
    else if (kinds.has('terrain') && terrain.length > 0) {
      const variant = rng.pick(terrain);
      used.add(`terrain:${variant}`);
      changes.push({ kind: 'terrain', variant });
    }
    // Prostředí scénáře režiséra jen jmenovaného druhu: past ano, pohyblivá plošina ne.
    return { at, until, changes: named === null ? changes : changes.filter((change) => change.kind !== 'terrain' || (named as readonly string[]).includes(change.variant)) };
  });
}

/** Druh změny scénáře, kterou slovo režiséra jmenuje. */
const NEWS_KINDS: Readonly<Record<SegmentNews, SegmentChange['kind']>> = { newFoe: 'newFoe', faster: 'speedTier', narrow: 'terrain', trap: 'terrain', moving: 'terrain' };
