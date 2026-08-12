import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { EMPTY_OBSERVATION, edgeFires, type Observation } from '../eval';
import goldenSet from '../__fixtures__/golden.json';
import {
  NodeTable,
  lowerEvent,
  predicateIdFor,
  surfaceFires,
  type LoweringWorld,
  type SurfaceEventSpec,
} from '../lower';
import { validateIrDoc, worldIr } from '../schema';
import {
  IR_PRIMITIVES,
  IR_VERSION,
  SURFACE_EVENTS,
  SURFACE_EVENT_SIGNATURES,
  type IrDoc,
  type IrNode,
  type SurfaceEventName,
} from '../types';

const compiled = () => z.toJSONSchema(worldIr, { cycles: 'throw' });

/** Typovaný pohled na zkompilovaný JSON Schema — jen kvůli navigaci v testu. */
interface CompiledView {
  readonly additionalProperties: boolean;
  readonly properties: Record<string, { items: { oneOf: Array<Record<string, any>> } }>;
}

const compiledView = () => compiled() as unknown as CompiledView;

// ---------------------------------------------------------------------------
// Schema kontrakt
// ---------------------------------------------------------------------------

describe('schema kontrakt', () => {
  it('se zkompiluje s cycles:"throw"', () => {
    expect(() => compiled()).not.toThrow();
  });

  it('nemá v outputu jediný $ref, tedy ani cyklický', () => {
    expect(JSON.stringify(compiled())).not.toContain('$ref');
  });

  it('má plochou tabulku uzlů — potomek je celé číslo, ne vnořený objekt', () => {
    const nodes = compiledView().properties.nodes.items.oneOf;
    const compareShape = nodes.find((variant) => variant.properties.kind.const === 'compare');
    const allOfShape = nodes.find((variant) => variant.properties.kind.const === 'allOf');
    expect(compareShape?.properties.lhs.type).toBe('integer');
    expect(compareShape?.properties.rhs.type).toBe('integer');
    expect(allOfShape?.properties.operands.items.type).toBe('integer');
  });

  it('zakazuje neznámá pole na kořeni i v uzlech', () => {
    const schema = compiledView();
    expect(schema.additionalProperties).toBe(false);
    for (const variant of schema.properties.nodes.items.oneOf) {
      expect(variant.additionalProperties).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Golden set
// ---------------------------------------------------------------------------

describe('golden set', () => {
  it('má 20 validních a 20 nevalidních dokumentů', () => {
    expect(goldenSet.valid).toHaveLength(20);
    expect(goldenSet.invalid).toHaveLength(20);
  });

  it.each(goldenSet.valid.map((entry) => [entry.id, entry] as const))('%s je validní', (_id, entry) => {
    const verdict = validateIrDoc(entry.doc);
    expect(verdict.issues).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it.each(goldenSet.invalid.map((entry) => [entry.id, entry] as const))(
    '%s je odmítnut z deklarovaného důvodu',
    (_id, entry) => {
      const verdict = validateIrDoc(entry.doc);
      expect(verdict.ok).toBe(false);
      // Nestačí, že dokument spadl — musí spadnout na TOM, co `why` tvrdí.
      // Jinak by golden set prošel i s validátorem, který odmítá všechno.
      expect(verdict.issues.join('\n')).toContain(entry.expect);
    },
  );

  it('nevalidní dokumenty jsou navzájem různé', () => {
    const bodies = goldenSet.invalid.map((entry) => JSON.stringify(entry.doc));
    expect(new Set(bodies).size).toBe(bodies.length);
  });
});

// ---------------------------------------------------------------------------
// Povrchový slovník
// ---------------------------------------------------------------------------

describe('povrchový slovník', () => {
  it('má 14 událostí včetně onAction a onCommandComplete', () => {
    expect(SURFACE_EVENTS).toHaveLength(14);
    expect(SURFACE_EVENTS).toContain('onAction');
    expect(SURFACE_EVENTS).toContain('onCommandComplete');
  });

  it('deklaruje signatury obou událostí z v1.1 doslova', () => {
    expect(SURFACE_EVENT_SIGNATURES.onAction).toBe('onAction(actor, actionId, target?)');
    expect(SURFACE_EVENT_SIGNATURES.onCommandComplete).toBe(
      'onCommandComplete(entity, commandId, result)',
    );
  });

  it('má právě tři IR primitiva', () => {
    expect([...IR_PRIMITIVES]).toEqual(['onEdge', 'compare', 'assign']);
  });
});

// ---------------------------------------------------------------------------
// Snížení všech 14 událostí
// ---------------------------------------------------------------------------

const WORLD: LoweringWorld = { inventorySlots: ['hand', 'belt'] };

const SPECS: Readonly<Record<SurfaceEventName, SurfaceEventSpec>> = {
  onStart: { event: 'onStart' },
  onClick: { event: 'onClick', entity: 'vault' },
  onEnterZone: { event: 'onEnterZone', entity: 'hero', zone: 'atrium' },
  onExitZone: { event: 'onExitZone', entity: 'hero', zone: 'atrium' },
  onCollide: { event: 'onCollide', a: 'hero', b: 'spike' },
  onPickup: { event: 'onPickup', item: 'key' },
  onDrop: { event: 'onDrop', item: 'gem', socket: 's.pedestal' },
  onTimerEnd: { event: 'onTimerEnd', timer: 'fuse' },
  onCounterReaches: { event: 'onCounterReaches', counter: 'shards', n: 5 },
  onStateEnter: { event: 'onStateEnter', entity: 'vault', state: 'open' },
  onSignal: { event: 'onSignal', name: 'sig.gotKey' },
  onSeen: { event: 'onSeen', agent: 'guard', target: 'hero' },
  onAction: { event: 'onAction', actor: 'hero', actionId: 'use', target: 'vault' },
  onCommandComplete: { event: 'onCommandComplete', entity: 'hero', commandId: 'cmd.move', result: 'ok' },
};

/** Deklarace, na které se snížené predikáty odkazují. */
function documentFor(spec: SurfaceEventSpec): IrDoc {
  const table = new NodeTable();
  const lowered = lowerEvent(spec, table, WORLD);
  const predicateId = predicateIdFor(spec);
  return {
    irVersion: IR_VERSION,
    limits: {
      maxEntities: 8,
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
      { space: 'inventory', id: 'hand', values: ['empty', 'key'], initial: 'empty' },
      { space: 'inventory', id: 'belt', values: ['empty', 'key'], initial: 'empty' },
    ],
    entities: [
      {
        stableId: 'vault',
        role: 'prop',
        socket: 's.vault',
        states: ['closed', 'open'],
        initialState: 'closed',
        initialLocked: true,
      },
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

function observation(partial: Partial<Observation>): Observation {
  return { ...EMPTY_OBSERVATION, ...partial };
}

const facts = (...keys: string[]) => observation({ facts: new Set(keys) });

/** Kandidátní pozorování na událost. Testuje se každá uspořádaná dvojice. */
function observationsFor(name: SurfaceEventName): Observation[] {
  switch (name) {
    case 'onStart':
      return [facts(), facts('started()')];
    case 'onClick':
      return [facts(), facts('clicked(vault)'), facts('clicked(lever)')];
    case 'onEnterZone':
    case 'onExitZone':
      return [facts(), facts('inZone(hero,atrium)'), facts('inZone(hero,cellar)')];
    case 'onCollide':
      return [facts(), facts('overlapping(hero,spike)'), facts('overlapping(spike,hero)')];
    case 'onPickup':
      return [facts(), facts('hasItem(hand,key)'), facts('hasItem(belt,key)'), facts('hasItem(hand,gem)')];
    case 'onDrop':
      return [facts(), facts('socketHolds(s.pedestal,gem)'), facts('socketHolds(s.altar,gem)')];
    case 'onTimerEnd':
      return [
        observation({ timers: { fuse: 0 } }),
        observation({ timers: { fuse: 1 } }),
        observation({ timers: { fuse: 120 } }),
      ];
    case 'onCounterReaches':
      return [0, 4, 5, 6, 8].map((value) => observation({ counters: { shards: value } }));
    case 'onStateEnter':
      return ['closed', 'open'].map((state) => observation({ entityStates: { vault: state } }));
    case 'onSignal':
      return [facts(), facts('signalled(sig.gotKey)'), facts('signalled(sig.other)')];
    case 'onSeen':
      return [facts(), facts('visible(guard,hero)'), facts('visible(hero,guard)')];
    case 'onAction':
      return [facts(), facts('acted(hero,use,vault)'), facts('acted(hero,use,none)')];
    case 'onCommandComplete':
      return [facts(), facts('commandDone(hero,cmd.move,ok)'), facts('commandDone(hero,cmd.move,blocked)')];
  }
}

describe('snížení povrchových událostí do IR', () => {
  it.each(SURFACE_EVENTS.map((name) => [name] as const))(
    '%s se sníží do validního dokumentu',
    (name) => {
      const verdict = validateIrDoc(documentFor(SPECS[name]));
      expect(verdict.issues).toEqual([]);
    },
  );

  it.each(SURFACE_EVENTS.map((name) => [name] as const))(
    '%s vyhodnotí zpětně shodně s povrchovou sémantikou',
    (name) => {
      const spec = SPECS[name];
      const doc = documentFor(spec);
      const predicateId = predicateIdFor(spec);
      const became = doc.rules[0].trigger.became;
      const candidates = observationsFor(name);

      // Matice VŠECH uspořádaných dvojic, ne jen té jedné, která má spustit.
      // Shoda musí platit i tam, kde nespouští ani jedna cesta.
      let firedAtLeastOnce = false;
      for (const previous of candidates) {
        for (const current of candidates) {
          const surface = surfaceFires(spec, previous, current, WORLD);
          const ir = edgeFires(doc, predicateId, became, previous, current);
          expect({ surface, ir }).toEqual({ surface, ir: surface });
          firedAtLeastOnce ||= surface;
        }
      }
      // Bez tohohle by test prošel i na matici, kde nikdy nic nespustí.
      expect(firedAtLeastOnce).toBe(true);
    },
  );

  it('používá výhradně tři IR primitiva a AST operátory nad nimi', () => {
    const allowed = new Set<IrNode['kind']>(['literal', 'ref', 'query', 'compare', 'allOf', 'anyOf', 'not']);
    for (const name of SURFACE_EVENTS) {
      const doc = documentFor(SPECS[name]);
      expect(doc.rules[0].trigger.kind).toBe('onEdge');
      for (const node of doc.nodes) {
        expect(allowed.has(node.kind)).toBe(true);
      }
    }
  });

  it('nemá pro žádnou událost vlastní spouštěcí primitivum', () => {
    const triggerKinds = new Set(SURFACE_EVENTS.map((name) => documentFor(SPECS[name]).rules[0].trigger.kind));
    expect([...triggerKinds]).toEqual(['onEdge']);
  });
});

// ---------------------------------------------------------------------------
// Rozhodnutá sémantika z protokolu
// ---------------------------------------------------------------------------

describe('rozhodnutá sémantika', () => {
  it('onCounterReaches se spustí při překročení, ne jen při rovnosti', () => {
    const spec = SPECS.onCounterReaches;
    const doc = documentFor(spec);
    const compare = doc.nodes.find((node) => node.kind === 'compare');
    expect(compare).toMatchObject({ op: '>=' });

    const from4 = observation({ counters: { shards: 4 } });
    const to6 = observation({ counters: { shards: 6 } });
    expect(edgeFires(doc, predicateIdFor(spec), true, from4, to6)).toBe(true);
  });

  it('onCounterReaches se rearmuje až návratem pod práh', () => {
    const spec = SPECS.onCounterReaches;
    const doc = documentFor(spec);
    const predicateId = predicateIdFor(spec);
    const at6 = observation({ counters: { shards: 6 } });
    const at8 = observation({ counters: { shards: 8 } });
    const at0 = observation({ counters: { shards: 0 } });
    expect(edgeFires(doc, predicateId, true, at6, at8)).toBe(false);
    expect(edgeFires(doc, predicateId, true, at0, at6)).toBe(true);
  });

  it('onCollide a onSeen jsou hrany vstupu, ne každý tik', () => {
    for (const name of ['onCollide', 'onSeen'] as const) {
      const spec = SPECS[name];
      const doc = documentFor(spec);
      const key = name === 'onCollide' ? 'overlapping(hero,spike)' : 'visible(guard,hero)';
      const held = facts(key);
      expect(edgeFires(doc, predicateIdFor(spec), true, held, held)).toBe(false);
      expect(edgeFires(doc, predicateIdFor(spec), true, facts(), held)).toBe(true);
    }
  });

  it('freeze se počítá v ticích — sekundová varianta neprojde schématem', () => {
    const seconds = goldenSet.invalid.find((entry) => entry.id === 'I17-freeze-in-seconds');
    expect(validateIrDoc(seconds?.doc).ok).toBe(false);
    expect(JSON.stringify(compiled())).not.toContain('seconds');
  });

  it('spawn připouští jedinou, deterministickou volbu instance', () => {
    const spawn = compiledView().properties.effects.items.oneOf.find(
      (variant) => variant.properties.op.const === 'spawn',
    );
    expect(spawn?.properties.selection.const).toBe('lowest-inactive');
  });
});

// ---------------------------------------------------------------------------
// Paměť
// ---------------------------------------------------------------------------

describe('paměťové sloty', () => {
  const memoryDoc = goldenSet.valid.find((entry) => entry.id === 'V15-memory-read-and-write');

  it('umí compare(memory[...]) i assign(memory[...])', () => {
    expect(validateIrDoc(memoryDoc?.doc).ok).toBe(true);
    const doc = memoryDoc?.doc as unknown as IrDoc;
    const reads = doc.nodes.some((node) => node.kind === 'ref' && node.ref.space === 'memory');
    const writes = doc.effects.some((effect) => effect.op === 'assign' && effect.ref.space === 'memory');
    expect({ reads, writes }).toEqual({ reads: true, writes: true });
  });
});

// ---------------------------------------------------------------------------
// Část vzhledu do IR nevstupuje
// ---------------------------------------------------------------------------

describe('oddělení od části vzhledu', () => {
  const irDir = join(process.cwd(), 'src', 'ir');

  // Skenují se moduly IR, ne testy: test, který zákaz vynucuje, tu věc musí
  // pojmenovat, jinak by nešel napsat.
  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(full);
      return entry.name.endsWith('.ts') ? [full] : [];
    });
  }

  it('nemá ve zkompilovaném schématu jediné pole vzhledu', () => {
    // Strukturální oracle: do IR se ta část nedá zapsat, protože pro ni schéma
    // nemá místo. Golden set to potvrzuje z druhé strany případem I01.
    expect(JSON.stringify(compiled()).toLowerCase()).not.toContain('look');
  });

  it('zmiňuje ji ve zdrojích IR jen ve větě o stableId', () => {
    const offenders: string[] = [];
    for (const file of sources(irDir)) {
      readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .forEach((line, position) => {
          if (/look/i.test(line) && !line.includes('stableId')) {
            offenders.push(`${file}:${position + 1}: ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});
