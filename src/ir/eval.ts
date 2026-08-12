import { nodeValueKind } from './schema';
import { MAX_OPERANDS, NO_TARGET, type IrDoc, type LiteralValue, type StateRef } from './types';

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
  /** Trvalé odvozené fakty — platí, dokud trvá stav, který je vyrábí. */
  readonly facts: ReadonlySet<string>;
  /** Události doručené v TOMHLE tiku. Přes hranici tiku nepřecházejí. */
  readonly pulses: ReadonlySet<string>;
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
  pulses: new Set<string>(),
  zoneCounts: {},
};

/**
 * Pozorování posunuté přes hranici tiku: trvalé fakty zůstávají, doručené
 * události mizí. `onEdge` čte pre-stav tímhle filtrem, takže pulzní fakt má
 * v pre-stavu vždy hodnotu `false` a hrana nad ním vyjde na přítomnost.
 */
export function atTickBoundary(obs: Observation): Observation {
  return obs.pulses.size === 0 ? obs : { ...obs, pulses: EMPTY_OBSERVATION.pulses };
}

/** Kanonický klíč odvozeného faktu. Sdílené instalatérství, ne sémantika. */
export function factKey(fact: string, args: readonly string[]): string {
  return `${fact}(${args.join(',')})`;
}

/**
 * Scéna je popis světa v jednom tiku **v doménových pojmech** — entity, zóny,
 * sloty, doručené akce. Kanonický tvar klíčů odvozených faktů z ní vyrábí
 * `observationOf`, takže nikdo mimo tenhle soubor ho nemusí znát.
 *
 * Existuje kvůli tomu, aby se dala napsat časová osa tiků, aniž by ji autor
 * musel psát ve stejném kódování, ve kterém ji čte vyhodnocovač.
 */
export interface Scene {
  readonly started?: boolean;
  readonly counters?: Readonly<Record<string, number>>;
  readonly flags?: Readonly<Record<string, boolean>>;
  readonly timers?: Readonly<Record<string, number>>;
  readonly inventory?: Readonly<Record<string, string>>;
  readonly memory?: Readonly<Record<string, string>>;
  readonly entityStates?: Readonly<Record<string, string>>;
  readonly locked?: Readonly<Record<string, boolean>>;
  readonly zoneCounts?: Readonly<Record<string, number>>;
  /** `[entita, zóna]` */
  readonly inZone?: readonly (readonly [string, string])[];
  /** `[a, b]` — kvantizovaná AABB kolize */
  readonly overlapping?: readonly (readonly [string, string])[];
  /** `[agent, cíl]` */
  readonly visible?: readonly (readonly [string, string])[];
  /** `[slot, položka]` */
  readonly carrying?: readonly (readonly [string, string])[];
  /** `[socket, položka]` */
  readonly socketHolds?: readonly (readonly [string, string])[];
  /** Entity, na které hráč v tomhle tiku klikl. */
  readonly clicked?: readonly string[];
  /** Signály doručené v tomhle tiku. */
  readonly signals?: readonly string[];
  /** `[aktér, actionId, cíl?]` — kanonické akce z konečné abecedy. */
  readonly actions?: readonly (readonly [string, string, string?])[];
  /** `[entita, commandId, výsledek]` */
  readonly completed?: readonly (readonly [string, string, string])[];
}

export function observationOf(scene: Scene): Observation {
  const facts = new Set<string>();
  if (scene.started) facts.add(factKey('started', []));
  for (const [entity, zone] of scene.inZone ?? []) facts.add(factKey('inZone', [entity, zone]));
  for (const [a, b] of scene.overlapping ?? []) facts.add(factKey('overlapping', [a, b]));
  for (const [agent, target] of scene.visible ?? []) facts.add(factKey('visible', [agent, target]));
  for (const [slot, item] of scene.carrying ?? []) facts.add(factKey('hasItem', [slot, item]));
  for (const [socket, item] of scene.socketHolds ?? []) facts.add(factKey('socketHolds', [socket, item]));

  const pulses = new Set<string>();
  for (const entity of scene.clicked ?? []) pulses.add(factKey('clicked', [entity]));
  for (const name of scene.signals ?? []) pulses.add(factKey('signalled', [name]));
  for (const [actor, actionId, target] of scene.actions ?? [])
    pulses.add(factKey('acted', [actor, actionId, target ?? NO_TARGET]));
  for (const [entity, commandId, result] of scene.completed ?? [])
    pulses.add(factKey('commandDone', [entity, commandId, result]));

  return {
    counters: scene.counters ?? {},
    flags: scene.flags ?? {},
    timers: scene.timers ?? {},
    inventory: scene.inventory ?? {},
    memory: scene.memory ?? {},
    entityStates: scene.entityStates ?? {},
    locked: scene.locked ?? {},
    facts,
    pulses,
    zoneCounts: scene.zoneCounts ?? {},
  };
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
    case 'pulse':
      return obs.pulses.has(factKey(ref.fact, ref.args));
    default: {
      // Nový prostor v `StateRef` se do `never` nepřiřadí (TS2322). Spoléhat
      // místo toho na „funkci chybí návrat" je slabší: propadne, jakmile se pod
      // přepínač připíše jediný řádek.
      const exhaustive: never = ref;
      return exhaustive;
    }
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
      const op = node.op;
      switch (op) {
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
        default: {
          const exhaustive: never = op;
          return exhaustive;
        }
      }
    }
    // Indexovaná smyčka s mezí v podmínce, ne `.every` / `.some`.
    //
    // `evalNode` leží na **tikové cestě** — `step()` ho volá přes `evalBool` na
    // každý spouštěč a stráž. Iterace bez podmínky nemá kam mez napsat, takže by
    // práce uvnitř jednoho vyhodnocení rostla s délkou pole v dokumentu. Mez je
    // `MAX_OPERANDS` a je to **tentýž** strop, který vynucuje zod schéma; delší
    // pole se sem nedostane a kdyby se dostalo, smyčka ho neprojde celé.
    case 'allOf': {
      const operands = node.operands;
      for (let i = 0; i < MAX_OPERANDS && i < operands.length; i += 1) {
        if (evalNode(doc, operands[i], obs) !== true) return false;
      }
      return true;
    }
    case 'anyOf': {
      const operands = node.operands;
      for (let i = 0; i < MAX_OPERANDS && i < operands.length; i += 1) {
        if (evalNode(doc, operands[i], obs) === true) return true;
      }
      return false;
    }
    case 'not':
      return evalNode(doc, node.operand, obs) !== true;
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
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
 *
 * Pre-stav se čte přes `atTickBoundary`. U trvalých faktů to nic nemění, u
 * pulzních je to celý rozdíl: doručená událost v předchozím tiku už neplatí,
 * takže hrana vyjde i na druhé doručení v řadě.
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
  const before = evalBool(doc, predicate.expr, atTickBoundary(previous));
  const after = evalBool(doc, predicate.expr, current);
  return became ? !before && after : before && !after;
}
