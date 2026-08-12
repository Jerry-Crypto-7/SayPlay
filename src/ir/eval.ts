import { nodeValueKind } from './schema';
import type { IrDoc, LiteralValue, StateRef } from './types';

/**
 * Referenční vyhodnocení ploché tabulky uzlů. Není to interpret — ten staví T9.
 * Tohle je minimum potřebné k tomu, aby šlo prokázat, že snížení povrchové
 * události do `onEdge` + `compare` dává stejnou odpověď jako povrchová
 * sémantika z `DESIGN-BOOK.md` §5.
 */

/**
 * Pozorování světa v jednom tiku. Odvozené fakty jsou množina kanonických
 * klíčů, protože přesně takhle je runtime v T9 dostane — jako doručené události,
 * ne jako dotazovatelnou strukturu.
 */
export interface Observation {
  readonly counters: Readonly<Record<string, number>>;
  readonly flags: Readonly<Record<string, boolean>>;
  /** Zbývající tiky. `timerRunning` je `> 0`. */
  readonly timers: Readonly<Record<string, number>>;
  readonly inventory: Readonly<Record<string, string>>;
  /** Klíč je `agent#index`. */
  readonly memory: Readonly<Record<string, string>>;
  readonly entityStates: Readonly<Record<string, string>>;
  readonly locked: Readonly<Record<string, boolean>>;
  readonly facts: ReadonlySet<string>;
  /** Klíč je `zone#tag`. */
  readonly zoneCounts: Readonly<Record<string, number>>;
}

export const EMPTY_OBSERVATION: Observation = {
  counters: {},
  flags: {},
  timers: {},
  inventory: {},
  memory: {},
  entityStates: {},
  locked: {},
  facts: new Set<string>(),
  zoneCounts: {},
};

/** Kanonický klíč odvozeného faktu. Sdílené instalatérství, ne sémantika. */
export function factKey(fact: string, args: readonly string[]): string {
  return `${fact}(${args.join(',')})`;
}

export function readRef(ref: StateRef, obs: Observation): LiteralValue {
  switch (ref.space) {
    case 'counter':
      return obs.counters[ref.slot] ?? 0;
    case 'flag':
      return obs.flags[ref.slot] ?? false;
    case 'timer':
      return obs.timers[ref.slot] ?? 0;
    case 'inventory':
      return obs.inventory[ref.slot] ?? 'empty';
    case 'memory':
      return obs.memory[`${ref.agent}#${ref.index}`] ?? 'empty';
    case 'entityState':
      return obs.entityStates[ref.entity] ?? 'none';
    case 'locked':
      return obs.locked[ref.entity] ?? false;
    case 'observed':
      return obs.facts.has(factKey(ref.fact, ref.args));
  }
}

export function evalNode(doc: IrDoc, index: number, obs: Observation): LiteralValue {
  const node = doc.nodes[index];
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'ref':
      return readRef(node.ref, obs);
    case 'query':
      return obs.zoneCounts[`${node.zone}#${node.tag}`] ?? 0;
    case 'compare': {
      const lhs = evalNode(doc, node.lhs, obs);
      const rhs = evalNode(doc, node.rhs, obs);
      switch (node.op) {
        case '=':
          return lhs === rhs;
        case '<':
          return (lhs as number) < (rhs as number);
        case '<=':
          return (lhs as number) <= (rhs as number);
        case '>=':
          return (lhs as number) >= (rhs as number);
        case '>':
          return (lhs as number) > (rhs as number);
      }
    }
    case 'allOf':
      return node.operands.every((operand) => evalNode(doc, operand, obs) === true);
    case 'anyOf':
      return node.operands.some((operand) => evalNode(doc, operand, obs) === true);
    case 'not':
      return evalNode(doc, node.operand, obs) !== true;
  }
}

export function evalBool(doc: IrDoc, index: number, obs: Observation): boolean {
  if (nodeValueKind(doc.nodes, index) !== 'bool') {
    throw new Error(`node ${index} is not boolean`);
  }
  return evalNode(doc, index, obs) === true;
}

/**
 * `onEdge(predicateId, became)` — jediné spouštěcí primitivum. Hodnota
 * predikátu se čte z pre-stavu tiku a z aktuálního stavu; spouští se výhradně
 * na změně, takže návrat predikátu do `false` ho rearmuje.
 */
export function edgeFires(
  doc: IrDoc,
  predicateId: string,
  became: boolean,
  previous: Observation,
  current: Observation,
): boolean {
  const predicate = doc.predicates.find((candidate) => candidate.predicateId === predicateId);
  if (!predicate) {
    throw new Error(`unknown predicate: ${predicateId}`);
  }
  const before = evalBool(doc, predicate.expr, previous);
  const after = evalBool(doc, predicate.expr, current);
  return became ? !before && after : before && !after;
}
