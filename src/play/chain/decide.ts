/**
 * Řetěz, nebo jedna hra (P56C T8). Řetěz míří na díru „obecná hra“ a na víceslovesné věty, kde dnes sloveso
 * zmizí; věta s jedním jasným slovesem chce hloubku té jedné hry. Pravidlo a důvod: plán P56C, oddíl „Rozhodnutí“;
 * P61 T4 zúžil `generic` na neslyšenou větu (`evals/play/p56c/decide.md`, `evals/play/p61/README.md`).
 */

import { saidMove } from '../compose/assemble';
import { readCountedNouns, singular } from '../draft/lexicon';
import type { GenreRanking } from '../genre/classify';
import { extractIntent } from '../intent';
import type { VerbClass } from '../read/schema';
import { VERB_MICROS } from './build';
import { MICRO } from './micro';
import type { SentenceRead } from './read';

/** Buňky, ve kterých klasifikátor končí, když z věty neslyší nic určitého. */
export const GENERIC_CELLS: ReadonlySet<string> = new Set(['arena.collect', 'arena.escape', 'runner.default', 'voyage.race']);

/** Věta, která o víc her výslovně žádá. „party“ jako přívlastek věci („to a party table“, startovní věta) ne. */
export const CHAIN_CUES = /\b(?:levels|rounds|mini-?games|challenges|party(?!\s+(?:tables?|hats?|food|guests?|dress)\b))\b/;

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

/** Třídy sloves, které jízda se střelbou hraje celé: řídit, střílet, dojet nebo sebrat, ujet honiči. */
const DRIVE_SHOOT_PLAYS: ReadonlySet<VerbClass> = new Set(['steer', 'aim_shoot', 'move_free', 'runner']);

/**
 * P65 T6b, rozhodnutí majitele 28. 10.: vozidlo nebo závod se střelbou je jedna jízda, která střílí (`steer` + `blaster`),
 * ne řetěz – ta hraje obě slovesa. Věta s dalším slovesem, které jízda nehraje („throw pies“), zůstane řetězem.
 */
function drivesAndShoots(sentence: string, read: SentenceRead): boolean {
  const intent = extractIntent(sentence);
  const shoots = intent.items.some((item) => item.essential && item.verb === 'shoot') && !intent.negated.includes('shoot');
  return shoots && saidMove(intent) === 'drive' && read.verbs.every((verb) => DRIVE_SHOOT_PLAYS.has(verb.class));
}

/** Proč věta hraje řetěz; prázdné = jedna hra. */
export function chainReasons(sentence: string, read: SentenceRead, ranking: GenreRanking): ChainReason[] {
  const reasons: ChainReason[] = [];
  const [top] = ranking.ranked;
  // T17b: čtení modelem dává svému žánru +4, takže klasifikátor slyší vždy. Neslyšená věta je u něj čtení bez hratelného
  // slovesa, které nepřistálo ani na mikrohře řetězu („doing taxes“ → quest); „defends his tower“ s `idle` → obrana slyšená.
  const arcade = top !== undefined && MICRO.some((entry) => entry.key === `${top.genre}.${top.mode}`);
  const playable = read.source !== 'llm' || arcade || read.verbs.some((verb) => VERB_MICROS[verb.class].length > 0);
  const heard = top !== undefined && top.score > 0 && playable;
  // P61 T4: slyšená obecná buňka s počítaným cílem („seber N věcí“) hraje jednu hru i se dvěma slovesy – „collect three keys
  // … while dodging ghosts“ je `arena.escape` celá (sbírat a uhýbat), řetěz z ní dělal běžce s branami (soudce 0,15).
  // Počet musí patřit věci, kterou věta sbírá: „eight swords“, „three forest lanes“ cíl nejsou.
  const item = read.item === null ? null : singular(read.item.toLowerCase()).split(' ').at(-1);
  const counted = heard && GENERIC_CELLS.has(`${top.genre}.${top.mode}`) && readCountedNouns(sentence).some(({ noun }) => singular(noun) === item);
  if (verbControls(read) >= 2 && !counted && !drivesAndShoots(sentence, read)) reasons.push('multi_verb');
  // P61 T4: `generic` jen pro neslyšenou větu. Dřív i slyšená obecná buňka s náskokem pod 3 („skateboard“ → běžec 2).
  if (!heard) reasons.push('generic');
  if (CHAIN_CUES.test(sentence.toLowerCase())) reasons.push('cue');
  return reasons;
}

export function chainOrSingle(sentence: string, read: SentenceRead, ranking: GenreRanking): 'chain' | 'single' {
  return chainReasons(sentence, read, ranking).length > 0 ? 'chain' : 'single';
}
