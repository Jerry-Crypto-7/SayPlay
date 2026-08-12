import {
  NO_TARGET,
  type IrNode,
  type NodeIndex,
  type ObservedFact,
  type PulseFact,
  type SurfaceEventName,
} from './types';

/**
 * Snížení povrchového slovníku do IR.
 *
 * `DESIGN-BOOK.md` §5 dává `onEdge` jako jediné spouštěcí primitivum. Tenhle
 * soubor to bere doslova: **všech 14 povrchových událostí** se snižuje na
 * dvojici (predikát, hrana). Predikát sám je `compare` nebo AST operátor nad
 * `compare` — žádná událost si nepřináší vlastní primitivum.
 *
 * Oracle správnosti snížení je ručně psaná tabulka tiků v
 * `__tests__/lower.test.ts`, ne druhá implementace téhle sémantiky. Druhá
 * implementace tady dřív byla a četla fakty toutéž cestou jako vyhodnocovač,
 * takže dokazovala jen shodu dvou tabulek mezi sebou.
 */

export { NO_TARGET };

export type SurfaceEventSpec =
  | { readonly event: 'onStart' }
  | { readonly event: 'onClick'; readonly entity: string }
  | { readonly event: 'onEnterZone'; readonly entity: string; readonly zone: string }
  | { readonly event: 'onExitZone'; readonly entity: string; readonly zone: string }
  | { readonly event: 'onCollide'; readonly a: string; readonly b: string }
  | { readonly event: 'onPickup'; readonly item: string }
  | { readonly event: 'onDrop'; readonly item: string; readonly socket: string }
  | { readonly event: 'onTimerEnd'; readonly timer: string }
  | { readonly event: 'onCounterReaches'; readonly counter: string; readonly n: number }
  | { readonly event: 'onStateEnter'; readonly entity: string; readonly state: string }
  | { readonly event: 'onSignal'; readonly name: string }
  | { readonly event: 'onSeen'; readonly agent: string; readonly target: string }
  | { readonly event: 'onAction'; readonly actor: string; readonly actionId: string; readonly target?: string }
  | {
      readonly event: 'onCommandComplete';
      readonly entity: string;
      readonly commandId: string;
      readonly result: string;
    };

/** Deklarace světa, kterou snížení potřebuje. Inventář je pevný počet slotů. */
export interface LoweringWorld {
  readonly inventorySlots: readonly string[];
}

/** Plochá tabulka s deduplikací. Potomek dostane index dřív než rodič. */
export class NodeTable {
  private readonly entries: IrNode[] = [];
  private readonly seen = new Map<string, NodeIndex>();

  add(node: IrNode): NodeIndex {
    const key = JSON.stringify(node);
    const existing = this.seen.get(key);
    if (existing !== undefined) return existing;
    const index = this.entries.length;
    this.entries.push(node);
    this.seen.set(key, index);
    return index;
  }

  list(): readonly IrNode[] {
    return this.entries;
  }
}

function observedFactNode(table: NodeTable, fact: ObservedFact, args: readonly string[]): NodeIndex {
  return table.add({ kind: 'ref', ref: { space: 'observed', fact, args } });
}

/** Doručená událost jednoho tiku. Hrana nad ní vyjde na přítomnost, ne na náběh. */
function pulseFactNode(table: NodeTable, fact: PulseFact, args: readonly string[]): NodeIndex {
  return table.add({ kind: 'ref', ref: { space: 'pulse', fact, args } });
}

export interface LoweredEvent {
  readonly expr: NodeIndex;
  readonly became: boolean;
}

/**
 * Snížení. `became` je směr hrany: `onExitZone` a `onTimerEnd` jsou jediné dvě
 * události, které se spouštějí na pádu predikátu — ztráta viditelnosti je podle
 * §5 taky `onEdge(became: false)`, ale nemá vlastní povrchový název.
 */
export function lowerEvent(spec: SurfaceEventSpec, table: NodeTable, world: LoweringWorld): LoweredEvent {
  switch (spec.event) {
    case 'onStart':
      return { expr: observedFactNode(table, 'started', []), became: true };
    case 'onClick':
      return { expr: pulseFactNode(table, 'clicked', [spec.entity]), became: true };
    case 'onEnterZone':
      return { expr: observedFactNode(table, 'inZone', [spec.entity, spec.zone]), became: true };
    case 'onExitZone':
      return { expr: observedFactNode(table, 'inZone', [spec.entity, spec.zone]), became: false };
    case 'onCollide':
      // Hrana, ne každý tik (protokol, `resolvedSemantics.onCollide`).
      return { expr: observedFactNode(table, 'overlapping', [spec.a, spec.b]), became: true };
    case 'onPickup': {
      // Signatura je `onPickup(item)`, drží se ale po slotech. Disjunkce přes
      // pevný počet deklarovaných slotů je ohraničená a nezavádí nové primitivum.
      const operands = world.inventorySlots.map((slot) =>
        observedFactNode(table, 'hasItem', [slot, spec.item]),
      );
      return { expr: table.add({ kind: 'anyOf', operands }), became: true };
    }
    case 'onDrop':
      return { expr: observedFactNode(table, 'socketHolds', [spec.socket, spec.item]), became: true };
    case 'onTimerEnd': {
      // `timerRunning` je `> 0`; doběhnutí je pád téhle hrany.
      const lhs = table.add({ kind: 'ref', ref: { space: 'timer', slot: spec.timer } });
      const rhs = table.add({ kind: 'literal', value: 0 });
      return { expr: table.add({ kind: 'compare', lhs, op: '>', rhs }), became: false };
    }
    case 'onCounterReaches': {
      // `>=`, ne `=`. Přírůstek ze 4 na 6 s prahem 5 se SPUSTÍ, protože hrana
      // predikátu `counter >= n` se změnila z false na true. Návrat pod práh
      // predikát rearmuje. Rovnost by celý ten případ tiše minula.
      const lhs = table.add({ kind: 'ref', ref: { space: 'counter', slot: spec.counter } });
      const rhs = table.add({ kind: 'literal', value: spec.n });
      return { expr: table.add({ kind: 'compare', lhs, op: '>=', rhs }), became: true };
    }
    case 'onStateEnter': {
      const lhs = table.add({ kind: 'ref', ref: { space: 'entityState', entity: spec.entity } });
      const rhs = table.add({ kind: 'literal', value: spec.state });
      return { expr: table.add({ kind: 'compare', lhs, op: '=', rhs }), became: true };
    }
    case 'onSignal':
      // Pulz, ne trvalý fakt. §5 na signálu staví řetězení pravidel — kdyby se
      // snížil na náběžnou hranu, druhá emise v řadě by se ztratila a řetěz by
      // se utnul právě tam, kde má držet.
      return { expr: pulseFactNode(table, 'signalled', [spec.name]), became: true };
    case 'onSeen':
      // Hrana vstupu do viditelnosti; ztráta je táž hrana s `became: false`.
      return { expr: observedFactNode(table, 'visible', [spec.agent, spec.target]), became: true };
    case 'onAction':
      // Nosič vstupní hranice: kanonická akce z konečné abecedy, nikdy kamera
      // ani vykreslená geometrie. Stisk je pulz — dvě stejná stisknutí po sobě
      // jsou dva záměry.
      return {
        expr: pulseFactNode(table, 'acted', [spec.actor, spec.actionId, spec.target ?? NO_TARGET]),
        became: true,
      };
    case 'onCommandComplete':
      return {
        expr: pulseFactNode(table, 'commandDone', [spec.entity, spec.commandId, spec.result]),
        became: true,
      };
  }
}

export function predicateIdFor(spec: SurfaceEventSpec): string {
  const parts: readonly string[] = (() => {
    switch (spec.event) {
      case 'onStart':
        return [];
      case 'onClick':
        return [spec.entity];
      case 'onEnterZone':
      case 'onExitZone':
        return [spec.entity, spec.zone];
      case 'onCollide':
        return [spec.a, spec.b];
      case 'onPickup':
        return [spec.item];
      case 'onDrop':
        return [spec.item, spec.socket];
      case 'onTimerEnd':
        return [spec.timer];
      case 'onCounterReaches':
        return [spec.counter, String(spec.n)];
      case 'onStateEnter':
        return [spec.entity, spec.state];
      case 'onSignal':
        return [spec.name];
      case 'onSeen':
        return [spec.agent, spec.target];
      case 'onAction':
        return [spec.actor, spec.actionId, spec.target ?? NO_TARGET];
      case 'onCommandComplete':
        return [spec.entity, spec.commandId, spec.result];
    }
  })();
  return ['p', spec.event, ...parts].join('.');
}

export function eventNameOf(spec: SurfaceEventSpec): SurfaceEventName {
  return spec.event;
}
