/**
 * Řetěz, nebo jedna hra (P56C T8). Řetěz míří na díru „obecná hra“ a na víceslovesné věty, kde dnes sloveso
 * zmizí; věta s jedním jasným slovesem chce hloubku té jedné hry. Pravidlo a důvod: plán P56C, oddíl „Rozhodnutí“.
 * Práh náskoku je nastavený jednou na dev sadě (`evals/play/p56c/decide.md`).
 */

import type { GenreRanking } from '../genre/classify';
import { VERB_MICROS } from './build';
import { MICRO } from './micro';
import type { SentenceRead } from './read';

/** Buňky, ve kterých klasifikátor končí, když z věty neslyší nic určitého. */
export const GENERIC_CELLS: ReadonlySet<string> = new Set(['arena.collect', 'arena.escape', 'runner.default', 'voyage.race']);

/** Věta, která o víc her výslovně žádá. „party“ jako přívlastek věci („to a party table“, startovní věta) ne. */
export const CHAIN_CUES = /\b(?:levels|rounds|mini-?games|challenges|party(?!\s+(?:tables?|hats?|food|guests?|dress)\b))\b/;

/** Náskok obecné buňky před druhou, pod kterým věta hraje řetěz (dev: „skateboard“ 2 → řetěz, „steer a balloon“ 4 → jedna hra). */
export const GENERIC_MARGIN = 3;

export type ChainReason = 'multi_verb' | 'generic' | 'cue';

/** Kolik různých ovládání dají různé třídy sloves věty: každá třída vezme první mikrohru s ještě nepoužitým ovládáním. */
function verbControls(read: SentenceRead): number {
  const used = new Set<string>();
  for (const verbClass of new Set(read.verbs.map((verb) => verb.class))) {
    const control = VERB_MICROS[verbClass].map((key) => MICRO.find((entry) => entry.key === key)!.control).find((id) => !used.has(id));
    if (control !== undefined) used.add(control);
  }
  return used.size;
}

/** Proč věta hraje řetěz; prázdné = jedna hra. */
export function chainReasons(sentence: string, read: SentenceRead, ranking: GenreRanking): ChainReason[] {
  const reasons: ChainReason[] = [];
  if (verbControls(read) >= 2) reasons.push('multi_verb');
  const [top, second] = ranking.ranked;
  // T17b: čtení modelem dává svému žánru +4, takže klasifikátor slyší vždy. Neslyšená věta je u něj čtení bez hratelného
  // slovesa, které nepřistálo ani na mikrohře řetězu („doing taxes“ → quest); „defends his tower“ s `idle` → obrana slyšená.
  const arcade = top !== undefined && MICRO.some((entry) => entry.key === `${top.genre}.${top.mode}`);
  const playable = read.source !== 'llm' || arcade || read.verbs.some((verb) => VERB_MICROS[verb.class].length > 0);
  const heard = top !== undefined && top.score > 0 && playable;
  if (!heard || (GENERIC_CELLS.has(`${top.genre}.${top.mode}`) && top.score - (second?.score ?? 0) < GENERIC_MARGIN)) reasons.push('generic');
  if (CHAIN_CUES.test(sentence.toLowerCase())) reasons.push('cue');
  return reasons;
}

export function chainOrSingle(sentence: string, read: SentenceRead, ranking: GenreRanking): 'chain' | 'single' {
  return chainReasons(sentence, read, ranking).length > 0 ? 'chain' : 'single';
}
