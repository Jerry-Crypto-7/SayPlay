import { essentialTriples, type Intent, type IntentTriple } from '@/play/intent/contract';
import { type ActionWitness, matchesWitness } from '@/play/arcade/witness';

const equal = (a: IntentTriple, b: IntentTriple): boolean => a.actor === b.actor && a.verb === b.verb && a.object === b.object;

/** Přiznané vynechání odstraní ticho, nikdy ztrátu podstatné akce. */
export function scoreTriples(triples: readonly IntentTriple[], witnesses: readonly ActionWitness[], unmet: readonly IntentTriple[] = []) {
  const missing = triples.filter(triple => !witnesses.some(witness => matchesWitness(triple, witness)));
  return { preserved: missing.length === 0, total: triples.length, proved: triples.length - missing.length, missing, silent: missing.filter(triple => !unmet.some(item => equal(item, triple))) };
}

export const scoreIntent = (intent: Pick<Intent, 'items'>, witnesses: readonly ActionWitness[], unmet: readonly IntentTriple[] = []) => scoreTriples(essentialTriples(intent), witnesses, unmet);
