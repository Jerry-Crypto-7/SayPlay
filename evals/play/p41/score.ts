import { ACTIONS, MOVES, OBJECTIVES, THREATS, essentialTriples, type Intent, type IntentTriple } from '@/play/intent/contract';
import { type ActionWitness, matchesWitness } from '@/play/arcade/witness';

const equal = (a: IntentTriple, b: IntentTriple): boolean => a.actor === b.actor && a.verb === b.verb && a.object === b.object;

/** Supported actions require witnesses; P42 permits visible admissions only for unknown verbs. */
const supported = new Set<string>([...ACTIONS, ...MOVES, ...OBJECTIVES, ...THREATS]);
export function scoreTriples(triples: readonly IntentTriple[], witnesses: readonly ActionWitness[], unmet: readonly IntentTriple[] = [], options: { unsupported?: boolean; visibleAdmission?: boolean } = {}) {
  const missing = triples.filter(triple => !witnesses.some(witness => matchesWitness(triple, witness)));
  const admitted = (triple: IntentTriple) => unmet.some(item => equal(item, triple));
  const honestUnsupported = options.unsupported === true && options.visibleAdmission === true && missing.every(triple => !supported.has(triple.verb) && admitted(triple));
  return { preserved: missing.length === 0 || honestUnsupported, total: triples.length, proved: triples.length - missing.length, missing, silent: missing.filter(triple => !admitted(triple)) };
}

/** Compare only the head noun and singular number; no setting synonyms. */
export function environmentNoun(value: string): string {
  const phrase = value.normalize('NFKC').toLowerCase().trim().split(/\s+(?:at|in|on|under|over|with|during|against|through|by|near)\s+/)[0]!;
  const noun = phrase.split(/\s+/).at(-1)!;
  if (/ies$/.test(noun)) return noun.slice(0, -3) + 'y';
  if (/(?:ches|shes|xes|zes|sses)$/.test(noun)) return noun.slice(0, -2);
  return /s$/.test(noun) && !/(?:ss|us)$/.test(noun) ? noun.slice(0, -1) : noun;
}

export const sameEnvironment = (actual: string, expected: string) => environmentNoun(actual) === environmentNoun(expected);

export const scoreIntent = (intent: Pick<Intent, 'items'>, witnesses: readonly ActionWitness[], unmet: readonly IntentTriple[] = []) => scoreTriples(essentialTriples(intent), witnesses, unmet);
