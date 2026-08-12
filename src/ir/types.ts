/**
 * Zploštěné indexované IR (`world-ir-v1`).
 *
 * Dvě vrstvy z `DESIGN-BOOK.md` §5: nahoře povrchový slovník, který se modelu
 * dobře generuje, dole malé typované IR pro verifikátor. Tenhle soubor popisuje
 * spodní vrstvu a signatury té horní.
 *
 * Klíčová vlastnost: **výrazy nejsou rekurzivní**. Všechny uzly leží v jedné
 * ploché tabulce `nodes` a potomek se adresuje celočíselným indexem, který musí
 * být menší než index rodiče. Cyklus tím není zakázaný pravidlem, ale
 * nevyjádřitelný — a `z.toJSONSchema(..., { cycles: "throw" })` nemá kde
 * narazit na `$ref` smyčku.
 */

export const IR_VERSION = 'world-ir-v1';

/** Ohraničený identifikátor. Neomezené řetězce protokol zakazuje. */
export const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;

/** Symbol z deklarovaného enumu (stav entity, položka, hodnota paměti). */
export const SYMBOL_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

// ---------------------------------------------------------------------------
// Povrchový slovník — 14 událostí (§5 + v1.1)
// ---------------------------------------------------------------------------

export const SURFACE_EVENTS = [
  'onStart',
  'onClick',
  'onEnterZone',
  'onExitZone',
  'onCollide',
  'onPickup',
  'onDrop',
  'onTimerEnd',
  'onCounterReaches',
  'onStateEnter',
  'onSignal',
  'onSeen',
  'onAction',
  'onCommandComplete',
] as const;

export type SurfaceEventName = (typeof SURFACE_EVENTS)[number];

/**
 * Signatury povrchových událostí. Jsou tu jako data, ne jako komentář, protože
 * `onAction` a `onCommandComplete` přibyly v `DESIGN-BOOK.md` v1.1 a §5 na nich
 * staví vstupní hranici — test je kontroluje doslova.
 */
export const SURFACE_EVENT_SIGNATURES: Readonly<Record<SurfaceEventName, string>> = {
  onStart: 'onStart()',
  onClick: 'onClick(entity)',
  onEnterZone: 'onEnterZone(entity, zone)',
  onExitZone: 'onExitZone(entity, zone)',
  onCollide: 'onCollide(a, b)',
  onPickup: 'onPickup(item)',
  onDrop: 'onDrop(item, socket)',
  onTimerEnd: 'onTimerEnd(timer)',
  onCounterReaches: 'onCounterReaches(counter, n)',
  onStateEnter: 'onStateEnter(entity, state)',
  onSignal: 'onSignal(name)',
  onSeen: 'onSeen(agent, target)',
  onAction: 'onAction(actor, actionId, target?)',
  onCommandComplete: 'onCommandComplete(entity, commandId, result)',
};

/** Tři IR primitiva, do kterých se povrch snižuje (§5). */
export const IR_PRIMITIVES = ['onEdge', 'compare', 'assign'] as const;
export type IrPrimitive = (typeof IR_PRIMITIVES)[number];

// ---------------------------------------------------------------------------
// Odkazy do stavu
// ---------------------------------------------------------------------------

/**
 * Odvozené fakty, které runtime udržuje mimo skalární stav. Právě přes ně se
 * snižují události, které nejsou přímo hranou nad čítačem nebo stavem —
 * kliknutí, signál, kolize, viditelnost, kanonická akce hráče.
 */
export const OBSERVED_FACTS = {
  started: 0,
  clicked: 1,
  acted: 3,
  commandDone: 3,
  signalled: 1,
  overlapping: 2,
  visible: 2,
  inZone: 2,
  hasItem: 2,
  socketHolds: 2,
} as const;

export type ObservedFact = keyof typeof OBSERVED_FACTS;

export type StateRef =
  | { readonly space: 'counter'; readonly slot: string }
  | { readonly space: 'flag'; readonly slot: string }
  | { readonly space: 'timer'; readonly slot: string }
  | { readonly space: 'inventory'; readonly slot: string }
  | { readonly space: 'memory'; readonly agent: string; readonly index: number }
  | { readonly space: 'entityState'; readonly entity: string }
  | { readonly space: 'locked'; readonly entity: string }
  | { readonly space: 'observed'; readonly fact: ObservedFact; readonly args: readonly string[] };

/** Prostory, do kterých smí `assign` zapisovat. `observed` mezi nimi není. */
export const ASSIGNABLE_SPACES = [
  'counter',
  'flag',
  'timer',
  'inventory',
  'memory',
  'entityState',
  'locked',
] as const;

/** Prostory, jejichž hodnota je boolean. */
export const BOOLEAN_SPACES = ['flag', 'locked', 'observed'] as const;

// ---------------------------------------------------------------------------
// Plochá tabulka uzlů
// ---------------------------------------------------------------------------

export type CompareOp = '<' | '<=' | '=' | '>=' | '>';
export const COMPARE_OPS: readonly CompareOp[] = ['<', '<=', '=', '>=', '>'];

export type LiteralValue = number | boolean | string;

/**
 * Index do `IrDoc.nodes`. Musí být **menší** než index uzlu, který ho drží —
 * tím je acykličnost strukturální, ne kontrolovaná průchodem.
 */
export type NodeIndex = number;

export type IrNode =
  | { readonly kind: 'literal'; readonly value: LiteralValue }
  | { readonly kind: 'ref'; readonly ref: StateRef }
  /** Ohraničená agregace nad deklarovanou množinou — povrchové `countInZone`. */
  | { readonly kind: 'query'; readonly query: 'countInZone'; readonly zone: string; readonly tag: string }
  | { readonly kind: 'compare'; readonly lhs: NodeIndex; readonly op: CompareOp; readonly rhs: NodeIndex }
  | { readonly kind: 'allOf'; readonly operands: readonly NodeIndex[] }
  | { readonly kind: 'anyOf'; readonly operands: readonly NodeIndex[] }
  | { readonly kind: 'not'; readonly operand: NodeIndex };

// ---------------------------------------------------------------------------
// Deklarace stavu, entit, predikátů, efektů a pravidel
// ---------------------------------------------------------------------------

export type SlotDecl =
  | {
      readonly space: 'counter';
      readonly id: string;
      readonly min: number;
      readonly max: number;
      readonly initial: number;
    }
  | { readonly space: 'flag'; readonly id: string; readonly initial: boolean }
  | { readonly space: 'timer'; readonly id: string; readonly maxTicks: number; readonly initial: number }
  | {
      readonly space: 'inventory';
      readonly id: string;
      readonly values: readonly string[];
      readonly initial: string;
    }
  | {
      readonly space: 'memory';
      readonly id: string;
      readonly agent: string;
      readonly index: number;
      readonly values: readonly string[];
      readonly initial: string;
    };

export interface EntityDecl {
  readonly stableId: string;
  readonly role: string;
  readonly socket: string;
  readonly states: readonly string[];
  readonly initialState: string;
  readonly initialLocked: boolean;
}

/**
 * Pojmenovaný predikát. `onEdge` sleduje výhradně tohle — hodnotu `expr`
 * z minulého a z aktuálního tiku. `source` je provenience: která povrchová
 * událost se do tohohle predikátu snížila.
 */
export interface PredicateDecl {
  readonly predicateId: string;
  readonly source: SurfaceEventName;
  readonly expr: NodeIndex;
}

export type IrEffect =
  /** IR primitivum: pokrývá `setState`, `setFlag`, `setLocked`, reset čítače i zápis do paměti. */
  | { readonly op: 'assign'; readonly ref: StateRef; readonly value: NodeIndex }
  /** Clampuje na deklarované meze; clamp není chyba (protokol, `resolvedSemantics`). */
  | { readonly op: 'addCounter'; readonly slot: string; readonly delta: number }
  | { readonly op: 'startTimer'; readonly slot: string; readonly durationTicks: number }
  | { readonly op: 'stopTimer'; readonly slot: string }
  /** Vybírá **nejnižší neaktivní ID** z předalokovaného poolu, deterministicky (§5). */
  | {
      readonly op: 'spawn';
      readonly poolTag: string;
      readonly socket: string;
      readonly selection: 'lowest-inactive';
    }
  | { readonly op: 'despawn'; readonly entity: string }
  | { readonly op: 'moveTo'; readonly entity: string; readonly socket: string; readonly ticks: number }
  /** Doba je v **ticích**, ne v sekundách (§5, opravené chyby). */
  | { readonly op: 'freeze'; readonly entity: string; readonly ticks: number }
  | { readonly op: 'giveItem'; readonly slot: string; readonly item: string }
  | { readonly op: 'takeItem'; readonly slot: string; readonly item: string }
  | { readonly op: 'emit'; readonly signal: string }
  | { readonly op: 'playEffect'; readonly effectId: string; readonly target: string | null }
  | { readonly op: 'win' }
  | { readonly op: 'lose' };

export type EffectIndex = number;

export interface IrTrigger {
  readonly kind: 'onEdge';
  readonly predicate: string;
  readonly became: boolean;
}

/**
 * Pořadí vykonání je **explicitní** `(phase, priority, ruleId)`. §7 krok 1 na tom
 * stojí: bez něj by textové přeuspořádání pravidel bylo potenciálně sémantické.
 */
export interface IrRule {
  readonly ruleId: string;
  readonly phase: number;
  readonly priority: number;
  readonly trigger: IrTrigger;
  readonly guard: NodeIndex | null;
  readonly effects: readonly EffectIndex[];
}

/** Deklarované meze světa. Každá fáze tiku se z nich shora omezuje (T9). */
export interface IrLimits {
  readonly maxEntities: number;
  readonly maxRules: number;
  readonly maxRuleFiringsPerTick: number;
  readonly maxQueueDepth: number;
  readonly maxAgents: number;
  readonly memorySlotsPerAgent: number;
  readonly gridWidth: number;
  readonly gridHeight: number;
}

export interface IrDoc {
  readonly irVersion: typeof IR_VERSION;
  readonly limits: IrLimits;
  readonly slots: readonly SlotDecl[];
  readonly entities: readonly EntityDecl[];
  readonly nodes: readonly IrNode[];
  readonly predicates: readonly PredicateDecl[];
  readonly effects: readonly IrEffect[];
  readonly rules: readonly IrRule[];
}
