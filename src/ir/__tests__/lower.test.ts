import { describe, expect, it } from 'vitest';

import { EMPTY_OBSERVATION, edgeFires, observationOf, type Scene } from '../eval';
import {
  NodeTable,
  lowerEvent,
  predicateIdFor,
  type LoweringWorld,
  type SurfaceEventSpec,
} from '../lower';
import { validateIrDoc } from '../schema';
import { IR_VERSION, SURFACE_EVENTS, type IrDoc, type IrNode, type SurfaceEventName } from '../types';

/**
 * Oracle snížení je **ručně psaná tabulka tiků**, ne druhá implementace téže
 * sémantiky. Pro každou ze 14 povrchových událostí je tu časová osa scén
 * (doménový popis světa v jednom tiku) a vedle ní seznam indexů tiků, ve
 * kterých se pravidlo podle `DESIGN-BOOK.md` §5 a podle `resolvedSemantics`
 * ve zmrazeném protokolu **má** spustit.
 *
 * Předchozí verze porovnávala snížení s druhou ručně psanou tabulkou
 * (`surfaceHolds`), která ovšem sahala na odvozené fakty úplně stejným voláním
 * jako vyhodnocovač. Shoda dvou tabulek psaných jednou rukou není důkaz; tenhle
 * soubor proto do kanonického tvaru klíčů nevidí vůbec a mluví jen o entitách,
 * zónách a doručených akcích.
 */

const WORLD: LoweringWorld = { inventorySlots: ['hand', 'belt'] };

function documentFor(spec: SurfaceEventSpec): IrDoc {
  const table = new NodeTable();
  const lowered = lowerEvent(spec, table, WORLD);
  const predicateId = predicateIdFor(spec);
  const entity = (stableId: string, states: readonly string[]): IrDoc['entities'][number] => ({
    stableId,
    role: 'prop',
    socket: `s.${stableId}`,
    states,
    initialState: states[0],
    initialLocked: false,
  });
  return {
    irVersion: IR_VERSION,
    limits: {
      maxEntities: 8,
      maxZones: 8,
      maxSlots: 32,
      maxRules: 16,
      maxRuleFiringsPerTick: 64,
      maxQueueDepth: 32,
      maxAgents: 0,
      memorySlotsPerAgent: 0,
      gridWidth: 16,
      gridHeight: 16,
    },
    slots: [
      { space: 'counter', id: 'shards', min: 0, max: 8, initial: 0 },
      { space: 'timer', id: 'fuse', maxTicks: 200, initial: 0 },
      { space: 'inventory', id: 'hand', values: ['empty', 'key', 'gem'], initial: 'empty' },
      { space: 'inventory', id: 'belt', values: ['empty', 'key', 'gem'], initial: 'empty' },
    ],
    entities: [
      entity('vault', ['closed', 'open']),
      entity('hero', ['idle']),
      entity('guard', ['idle']),
      entity('spike', ['idle']),
    ],
    nodes: table.list(),
    predicates: [{ predicateId, source: spec.event, expr: lowered.expr }],
    effects: [{ op: 'win' }],
    rules: [
      {
        ruleId: 'r.fire',
        phase: 0,
        priority: 0,
        trigger: { kind: 'onEdge', predicate: predicateId, became: lowered.became },
        guard: null,
        effects: [0],
      },
    ],
  };
}

interface EventCase {
  readonly spec: SurfaceEventSpec;
  /** Scéna pro každý tik; index v poli je index tiku. Pre-stav tiku 0 je prázdný svět. */
  readonly timeline: readonly Scene[];
  /** Ručně odvozené indexy tiků, ve kterých pravidlo spustí. */
  readonly firesAtTicks: readonly number[];
  readonly why: string;
}

const CASES: Readonly<Record<SurfaceEventName, EventCase>> = {
  onStart: {
    spec: { event: 'onStart' },
    timeline: [{ started: true }, { started: true }, { started: true }],
    firesAtTicks: [0],
    why: 'svět se spustí jednou; `started` pak platí dál a hrana se nerearmuje',
  },
  onClick: {
    spec: { event: 'onClick', entity: 'vault' },
    timeline: [{}, { clicked: ['vault'] }, { clicked: ['vault'] }, {}, { clicked: ['guard'] }],
    firesAtTicks: [1, 2],
    why: 'kliknutí je doručená událost jednoho tiku — dvě po sobě jdoucí kliknutí jsou dvě spuštění',
  },
  onEnterZone: {
    spec: { event: 'onEnterZone', entity: 'hero', zone: 'atrium' },
    timeline: [
      {},
      { inZone: [['hero', 'atrium']] },
      { inZone: [['hero', 'atrium']] },
      {},
      { inZone: [['hero', 'atrium']] },
    ],
    firesAtTicks: [1, 4],
    why: 'vstup do zóny je hrana nahoru; setrvání nespouští, opuštění predikát rearmuje',
  },
  onExitZone: {
    spec: { event: 'onExitZone', entity: 'hero', zone: 'atrium' },
    timeline: [
      {},
      { inZone: [['hero', 'atrium']] },
      { inZone: [['hero', 'atrium']] },
      {},
      { inZone: [['hero', 'atrium']] },
    ],
    firesAtTicks: [3],
    why: 'táž hrana s became:false — jeden predikát, dvě povrchové události',
  },
  onCollide: {
    spec: { event: 'onCollide', a: 'hero', b: 'spike' },
    timeline: [{}, { overlapping: [['hero', 'spike']] }, { overlapping: [['hero', 'spike']] }, {}],
    firesAtTicks: [1],
    why: 'protokol, resolvedSemantics.onCollide: spouští se PŘI VSTUPU, ne každý tik',
  },
  onPickup: {
    spec: { event: 'onPickup', item: 'key' },
    timeline: [
      {},
      { carrying: [['hand', 'key']] },
      { carrying: [['belt', 'key']] },
      {},
      { carrying: [['hand', 'gem']] },
    ],
    firesAtTicks: [1],
    why: 'disjunkce přes sloty drží dál, když klíč přejde z ruky na pás; jiná položka predikát nesplní',
  },
  onDrop: {
    spec: { event: 'onDrop', item: 'gem', socket: 's.pedestal' },
    timeline: [{}, { socketHolds: [['s.pedestal', 'gem']] }, {}, { socketHolds: [['s.pedestal', 'gem']] }],
    firesAtTicks: [1, 3],
    why: 'položení do socketu je hrana nahoru; sebrání zpět predikát rearmuje',
  },
  onTimerEnd: {
    spec: { event: 'onTimerEnd', timer: 'fuse' },
    timeline: [
      { timers: { fuse: 3 } },
      { timers: { fuse: 2 } },
      { timers: { fuse: 1 } },
      { timers: { fuse: 0 } },
      { timers: { fuse: 5 } },
      { timers: { fuse: 0 } },
    ],
    firesAtTicks: [3, 5],
    why: 'doběhnutí je PÁD hrany timerRunning; znovu spuštěný časovač doběhne znovu',
  },
  onCounterReaches: {
    spec: { event: 'onCounterReaches', counter: 'shards', n: 5 },
    timeline: [
      { counters: { shards: 0 } },
      { counters: { shards: 4 } },
      { counters: { shards: 6 } },
      { counters: { shards: 8 } },
      { counters: { shards: 0 } },
      { counters: { shards: 5 } },
    ],
    firesAtTicks: [2, 5],
    why: 'přírůstek ze 4 na 6 práh 5 PŘEKROČÍ a spustí; návrat pod práh predikát rearmuje',
  },
  onStateEnter: {
    spec: { event: 'onStateEnter', entity: 'vault', state: 'open' },
    timeline: [
      { entityStates: { vault: 'closed' } },
      { entityStates: { vault: 'open' } },
      { entityStates: { vault: 'open' } },
      { entityStates: { vault: 'closed' } },
      { entityStates: { vault: 'open' } },
    ],
    firesAtTicks: [1, 4],
    why: 'vstup do stavu je hrana; setrvání ve stavu nespouští',
  },
  onSignal: {
    spec: { event: 'onSignal', name: 'sig.gotKey' },
    timeline: [
      {},
      { signals: ['sig.gotKey'] },
      { signals: ['sig.gotKey'] },
      { signals: ['sig.other'] },
      { signals: ['sig.gotKey'] },
    ],
    firesAtTicks: [1, 2, 4],
    why: '§5: signálem se pravidla ŘETĚZÍ — každé doručení musí spustit, jinak řetěz utne',
  },
  onSeen: {
    spec: { event: 'onSeen', agent: 'guard', target: 'hero' },
    timeline: [
      {},
      { visible: [['guard', 'hero']] },
      { visible: [['guard', 'hero']] },
      {},
      { visible: [['hero', 'guard']] },
    ],
    firesAtTicks: [1],
    why: 'vstup do viditelnosti je hrana; dvojice je uspořádaná, obrácená viditelnost je jiný fakt',
  },
  onAction: {
    spec: { event: 'onAction', actor: 'hero', actionId: 'use', target: 'vault' },
    timeline: [
      {},
      { actions: [['hero', 'use', 'vault']] },
      { actions: [['hero', 'use', 'vault']] },
      { actions: [['hero', 'use']] },
      { actions: [['hero', 'open', 'vault']] },
    ],
    firesAtTicks: [1, 2],
    why: 'kanonická akce je záměr doručený v jednom tiku; dvě stejná stisknutí jsou dvě spuštění',
  },
  onCommandComplete: {
    spec: { event: 'onCommandComplete', entity: 'hero', commandId: 'cmd.move', result: 'ok' },
    timeline: [
      {},
      { completed: [['hero', 'cmd.move', 'ok']] },
      { completed: [['hero', 'cmd.move', 'ok']] },
      { completed: [['hero', 'cmd.move', 'blocked']] },
    ],
    firesAtTicks: [1, 2],
    why: 'dokončení příkazu je doručená událost; dva stejné příkazy po sobě jsou dvě spuštění',
  },
};

/** Indexy tiků, ve kterých snížený dokument spustí. Pre-stav tiku 0 je prázdný svět. */
function firingTicks(kase: EventCase): number[] {
  const doc = documentFor(kase.spec);
  const predicateId = predicateIdFor(kase.spec);
  const { became } = doc.rules[0].trigger;
  const fired: number[] = [];
  let previous = EMPTY_OBSERVATION;
  kase.timeline.forEach((scene, tick) => {
    const current = observationOf(scene);
    if (edgeFires(doc, predicateId, became, previous, current)) fired.push(tick);
    previous = current;
  });
  return fired;
}

describe('snížení povrchových událostí do IR', () => {
  it.each(SURFACE_EVENTS.map((name) => [name] as const))('%s se sníží do validního dokumentu', (name) => {
    expect(validateIrDoc(documentFor(CASES[name].spec)).issues).toEqual([]);
  });

  it.each(SURFACE_EVENTS.map((name) => [name] as const))(
    '%s spustí přesně v tick indexech z ručně psané tabulky',
    (name) => {
      const kase = CASES[name];
      expect({ event: name, fired: firingTicks(kase) }).toEqual({
        event: name,
        fired: [...kase.firesAtTicks],
      });
    },
  );

  it('používá výhradně tři IR primitiva a AST operátory nad nimi', () => {
    const allowed = new Set<IrNode['kind']>(['literal', 'ref', 'query', 'compare', 'allOf', 'anyOf', 'not']);
    for (const name of SURFACE_EVENTS) {
      for (const node of documentFor(CASES[name].spec).nodes) {
        expect(allowed.has(node.kind)).toBe(true);
      }
    }
  });

  it('nemá pro žádnou událost vlastní spouštěcí primitivum', () => {
    const kinds = new Set(SURFACE_EVENTS.map((name) => documentFor(CASES[name].spec).rules[0].trigger.kind));
    expect([...kinds]).toEqual(['onEdge']);
  });
});

// ---------------------------------------------------------------------------
// Pulzní události
// ---------------------------------------------------------------------------

/**
 * Čtyři události, které §5 nejmenuje mezi osmi, které `onEdge` nahrazuje. Jsou
 * to doručené události, ne trvalé fakty — a náběžná hrana nad trvalým faktem by
 * druhé doručení v řadě spolkla.
 */
const PULSE_EVENTS = ['onClick', 'onSignal', 'onAction', 'onCommandComplete'] as const;

describe('pulzní události', () => {
  it.each(PULSE_EVENTS.map((name) => [name] as const))(
    '%s spustí dvakrát, když přijde ve dvou po sobě jdoucích ticích',
    (name) => {
      const kase = CASES[name];
      const twice = { ...kase, timeline: [kase.timeline[1], kase.timeline[1]], firesAtTicks: [0, 1] };
      expect(firingTicks(twice)).toEqual([0, 1]);
    },
  );

  it('trvalé fakty se naopak druhým tikem nerearmují', () => {
    for (const name of ['onEnterZone', 'onCollide', 'onSeen', 'onDrop'] as const) {
      const kase = CASES[name];
      const held = kase.timeline[1];
      expect({ name, fired: firingTicks({ ...kase, timeline: [held, held], firesAtTicks: [] }) }).toEqual({
        name,
        fired: [0],
      });
    }
  });
});
