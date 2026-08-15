/**
 * Od rozhodnutí routeru ke konkrétní rozehrané partii.
 *
 * Router vybere archetyp, ale archetyp sám je parametrická rodina — teprve
 * n-tice a seed dělají hru. Výběr obojího je **odvozený z promptu**, ne
 * náhodný: stejná věta musí dát stejný svět, jinak by se o fallbacku nedalo
 * tvrdit nic, co T203 dokázal enumerací.
 *
 * Sdílené mezi serverem (stránka routuje) a klientem (stránka hraje), proto
 * to nesmí být uvnitř žádného z nich.
 */

import { A1 } from './archetypes/a1-collect-unlock';
import { A2 } from './archetypes/a2-sort-match';
import { A3 } from './archetypes/a3-guide-avoid';
import type { Archetype, Game, Trace } from './loop';
import type { ArchetypeId } from './manifests';
import { stableHash, type ArchetypeDecision } from './router';

export const ARCHETYPES: Readonly<Record<ArchetypeId, Archetype>> = {
  collect_unlock: A1,
  sort_match: A2,
  guide_avoid: A3,
};

export type Session = {
  readonly archetype: ArchetypeId;
  /** Index do `tuples()`, ne kopie parametrů — n-tice vlastní archetyp. */
  readonly tupleIndex: number;
  readonly seed: number;
  readonly game: Game<unknown>;
  /** Vítězná stopa od řešitele archetypu, nebo `null`, když žádná není. */
  readonly solution: Trace | null;
};

/**
 * Dvě různá odvození z jednoho promptu potřebují dva různé hashe — jinak by
 * seed byl funkcí indexu n-tice a rozsah světů by se tiše zúžil.
 */
export function sessionFor(decision: ArchetypeDecision, prompt: string): Session {
  const archetype = ARCHETYPES[decision.archetype];
  const tuples = archetype.tuples();
  const tupleIndex = stableHash(prompt) % tuples.length;
  const seed = stableHash(`${prompt}#seed`);
  const params = tuples[tupleIndex];

  return {
    archetype: decision.archetype,
    tupleIndex,
    seed,
    game: archetype.game(params),
    solution: archetype.solve(params, seed),
  };
}
