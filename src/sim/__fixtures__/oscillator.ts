import type { WorldDocRuntime } from '../interpreter';

/** Lichý tik uvnitř živého okna kruhu — obojí je pro `trace` níž podstatné. */
export const INPUT_TICK = 151;

export interface OscillatorOptions {
  /**
   * Když je `false`, `r.eb.up` přestane přičítat k čítači. Je to **změna
   * jediného pravidla**: sloty, entity, symboly i prostor zůstanou na chlup
   * stejné, takže se z ní dá odbočit uprostřed běhu (`rebranchAt`).
   */
  readonly ebCounts?: boolean;
  /**
   * Přidá inventářový slot. Jeho hodnoty jsou **tabulka symbolů**: slot drží
   * index do ní, takže přejmenovaná hodnota nechá meze slotu na místě a vymění
   * jen význam čísla — vada, kterou kontrola rozvržení z principu nevidí.
   */
  readonly carriesItem?: boolean;
  /** Druhá hodnota inventáře. Přejmenovat ji je změna symbolu, ne rozvržení. */
  readonly itemName?: string;
  /**
   * Přidá socket, na kterém **nesedí žádná entita**. Rozvržení stavu ho proto
   * nevidí — souřadnice se do slotů sázejí jen za entity — a přesto ho čte
   * `spawn` i `moveTo` pokaždé, když spustí. Je to jediný způsob, jak posunout
   * socket, aniž se pohne počáteční hodnota kteréhokoli slotu.
   */
  readonly spareSocket?: boolean;
}

/**
 * Svět, který se nikdy nedohraje a přesto se každý tik mění jinak.
 *
 * Dvě entity překlápějí `s1 ↔ s2`, což drží běh v pohybu donekonečna — a každé
 * překlopení přičte k čítači, takže stav je **monotónní**, ne periodický. To je
 * na téhle fixture to podstatné: nad oscilací s periodou dva by skok na špatný
 * tik trefil shodný hash čirou náhodou a test by neprokázal nic.
 *
 * `r.ea.up` navíc vysílá signál a `r.tock` na něj reaguje **až v příštím tiku**,
 * takže fronta je na hranici tiku střídavě neprázdná. Bez toho by byl stav
 * funkcí jediného pole a snímek, který frontu zapomene, by testem prošel.
 */
export function oscillator({
  ebCounts = true,
  carriesItem = false,
  itemName = 'key',
  spareSocket = false,
}: OscillatorOptions = {}): WorldDocRuntime {
  return {
    // Vstup leží na LICHÉM tiku, kde už ve frontě čeká `tock`, a strop fronty
    // je přesně dva. Snímek, který si frontu jen půjčí místo aby ji zkopíroval,
    // do ní ten vstup nechá dopsat — a replay téhož tiku ho dopíše podruhé, což
    // je se stropem dva přetečení fronty a `runtimeFault`, který přímý běh nemá.
    trace: [{ tick: INPUT_TICK, actor: 'ea', actionId: 'poke' }],
    space: {
      sockets: spareSocket ? { s_a: [0, 0], s_b: [1, 0], s_spare: [2, 0] } : { s_a: [0, 0], s_b: [1, 0] },
      zones: {},
      blocked: [],
      tags: {},
    },
    ir: {
      irVersion: 'world-ir-v1',
      limits: {
        maxEntities: 2,
        maxZones: 1,
        maxSlots: 4,
        maxRules: 8,
        maxRuleFiringsPerTick: 4,
        maxQueueDepth: 2,
        maxAgents: 0,
        memorySlotsPerAgent: 0,
        gridWidth: 4,
        gridHeight: 4,
      },
      slots: carriesItem
        ? [
            { space: 'counter', id: 'beat', min: 0, max: 999, initial: 0 },
            { space: 'counter', id: 'echo', min: 0, max: 999, initial: 0 },
            { space: 'inventory', id: 'hand', values: ['empty', itemName], initial: 'empty' },
          ]
        : [
            { space: 'counter', id: 'beat', min: 0, max: 999, initial: 0 },
            { space: 'counter', id: 'echo', min: 0, max: 999, initial: 0 },
          ],
      entities: [
        { stableId: 'ea', role: 'prop', socket: 's_a', states: ['s1', 's2'], initialState: 's1', initialLocked: false },
        { stableId: 'eb', role: 'prop', socket: 's_b', states: ['s1', 's2'], initialState: 's1', initialLocked: false },
      ],
      nodes: [
        { kind: 'ref', ref: { space: 'entityState', entity: 'ea' } },
        { kind: 'literal', value: 's1' },
        { kind: 'compare', lhs: 0, op: '=', rhs: 1 },
        { kind: 'literal', value: 's2' },
        { kind: 'compare', lhs: 0, op: '=', rhs: 3 },
        { kind: 'ref', ref: { space: 'entityState', entity: 'eb' } },
        { kind: 'compare', lhs: 5, op: '=', rhs: 1 },
        { kind: 'compare', lhs: 5, op: '=', rhs: 3 },
        { kind: 'ref', ref: { space: 'pulse', fact: 'signalled', args: ['tock'] } },
      ],
      predicates: [
        { predicateId: 'p.ea.s1', source: 'onStateEnter', expr: 2 },
        { predicateId: 'p.ea.s2', source: 'onStateEnter', expr: 4 },
        { predicateId: 'p.eb.s1', source: 'onStateEnter', expr: 6 },
        { predicateId: 'p.eb.s2', source: 'onStateEnter', expr: 7 },
        { predicateId: 'p.tock', source: 'onSignal', expr: 8 },
      ],
      effects: [
        { op: 'assign', ref: { space: 'entityState', entity: 'ea' }, value: 3 },
        { op: 'assign', ref: { space: 'entityState', entity: 'ea' }, value: 1 },
        { op: 'assign', ref: { space: 'entityState', entity: 'eb' }, value: 3 },
        { op: 'assign', ref: { space: 'entityState', entity: 'eb' }, value: 1 },
        { op: 'addCounter', slot: 'beat', delta: 1 },
        { op: 'emit', signal: 'tock' },
        { op: 'addCounter', slot: 'echo', delta: 1 },
      ],
      rules: [
        {
          ruleId: 'r.ea.up',
          phase: 0,
          priority: 0,
          trigger: { kind: 'onEdge', predicate: 'p.ea.s1', became: true },
          guard: null,
          effects: [0, 4, 5],
        },
        {
          ruleId: 'r.ea.down',
          phase: 0,
          priority: 1,
          trigger: { kind: 'onEdge', predicate: 'p.ea.s2', became: true },
          guard: null,
          effects: [1, 4],
        },
        {
          ruleId: 'r.eb.up',
          phase: 0,
          priority: 2,
          trigger: { kind: 'onEdge', predicate: 'p.eb.s1', became: true },
          guard: null,
          effects: ebCounts ? [2, 4] : [2],
        },
        {
          ruleId: 'r.eb.down',
          phase: 0,
          priority: 3,
          trigger: { kind: 'onEdge', predicate: 'p.eb.s2', became: true },
          guard: null,
          effects: [3, 4],
        },
        {
          ruleId: 'r.tock',
          phase: 0,
          priority: 4,
          trigger: { kind: 'onEdge', predicate: 'p.tock', became: true },
          guard: null,
          effects: [6],
        },
      ],
    },
  } as unknown as WorldDocRuntime;
}

