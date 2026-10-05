/**
 * Věrnost specu jedním číslem (P37A T8) a brána AI verze.
 *
 * `specFidelity` dřív žilo ve `scripts/play-fidelity.mjs`; teď ho volá i server
 * (`src/app/api/play/_upgrade.ts`), skript ho odsud importuje. Čísla se nemění:
 * `score` = podíl položek, které ovládání čte (`read`), `drawnScore` = podíl
 * položek, které scéna nakreslí – obojí zaokrouhlené na tři místa.
 *
 * Brána: AI verze se hráči nabídne, jen když proti návrhu ze slov na témž
 * kontrolním seznamu přidá aspoň `MIN_UPGRADE_GAIN`. Jinak zůstane návrh
 * a hráč na nic nečeká – verze, která věty nenese víc, nestojí za přepnutí.
 */

import type { ControlId, GameSpecV1 } from '../spec';

import { type ChainItem, type ChecklistEntry, fidelityChain } from './chain';

export interface SpecFidelity {
  readonly control: ControlId;
  readonly items: ChainItem[];
  readonly score: number;
  readonly drawnScore: number;
}

const share = (items: readonly ChainItem[], pick: (item: ChainItem) => boolean): number =>
  items.length === 0 ? 0 : Math.round((items.filter(pick).length / items.length) * 1000) / 1000;

/**
 * Položky seznamu nad jedním specem (`chain.ts`): `inSpec` = spec ji nese,
 * `read` = nese ji místem, které ovládání čte, `drawn` = scéna ji nakreslí.
 */
export function specFidelity(spec: GameSpecV1, checklist: readonly ChecklistEntry[]): SpecFidelity {
  const items = fidelityChain(spec, checklist);
  return { control: spec.control ?? 'tap_go', items, score: share(items, (item) => item.read), drawnScore: share(items, (item) => item.drawn) };
}

/**
 * O kolik musí AI verze zvednout `score`, aby ji hráč dostal. Jedna položka
 * ze čtyř je 0,25, ze dvaceti 0,05 – práh pustí každou verzi, která věty nese
 * aspoň o položku víc, a zastaví šum zaokrouhlení i verzi, která jen přeskládá
 * totéž.
 */
export const MIN_UPGRADE_GAIN = 0.05;

export interface UpgradeGain {
  readonly draft: number;
  readonly ai: number;
  /** `ai − draft`, na tři místa jako skóre – rozdíl dvou zaokrouhlených podílů jinak nese chybu plovoucí čárky. */
  readonly gain: number;
  readonly better: boolean;
}

/** Je AI verze o `MIN_UPGRADE_GAIN` věrnější než návrh? Prázdný seznam nedá zisk, tedy ani upgrade. */
export function upgradeGain(draft: GameSpecV1, ai: GameSpecV1, checklist: readonly ChecklistEntry[]): UpgradeGain {
  const before = specFidelity(draft, checklist).score;
  const after = specFidelity(ai, checklist).score;
  const gain = Math.round((after - before) * 1000) / 1000;
  return { draft: before, ai: after, gain, better: gain >= MIN_UPGRADE_GAIN };
}
