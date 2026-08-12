import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import goldenSet from '../__fixtures__/golden.json';
import { validateIrDoc, worldIr } from '../schema';
import { IR_PRIMITIVES, IR_VERSION, SURFACE_EVENTS, SURFACE_EVENT_SIGNATURES, type IrDoc } from '../types';

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
    expect(SURFACE_EVENT_SIGNATURES.onCommandComplete).toBe('onCommandComplete(entity, commandId, result)');
  });

  it('má právě tři IR primitiva', () => {
    expect([...IR_PRIMITIVES]).toEqual(['onEdge', 'compare', 'assign']);
  });
});

// ---------------------------------------------------------------------------
// Rozhodnutá sémantika, kterou drží samo schéma
//
// Chování snížení v čase ověřuje `lower.test.ts` proti ručně psané tabulce
// tiků. Tady zůstává jen to, co je vlastnost tvaru, ne běhu.
// ---------------------------------------------------------------------------

describe('rozhodnutá sémantika ve tvaru', () => {
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
// Strukturální kontroly, které schéma vyjádřit neumí
// ---------------------------------------------------------------------------

/** Minimální kostra, do které se dosazuje právě ta jedna vlastnost, která se zkoumá. */
function docWith(patch: Partial<IrDoc>): IrDoc {
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
    slots: [],
    entities: [],
    nodes: [],
    predicates: [],
    effects: [],
    rules: [],
    ...patch,
  };
}

describe('acykličnost', () => {
  const cyclic = docWith({
    nodes: [
      { kind: 'not', operand: 1 },
      { kind: 'not', operand: 0 },
    ],
  });

  // Komentář u `worldIr` tvrdí přesně tohle rozdělení rolí. Kdyby si schéma
  // s cyklem poradilo samo, byl by ten komentář zbytečný; kdyby ho nechytil
  // ani validátor, byl by nepravdivý.
  it('cyklus tabulkou uzlů PROJDE schématem — tvar ho nezakazuje', () => {
    expect(worldIr.safeParse(cyclic).success).toBe(true);
  });

  it('cyklus odmítne až kontrola monotonie indexů', () => {
    const verdict = validateIrDoc(cyclic);
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.join('\n')).toContain('references node 1 at or above itself');
  });
});

describe('osiřelé odkazy', () => {
  const inZoneDoc = (entities: IrDoc['entities']) =>
    docWith({
      entities,
      nodes: [{ kind: 'ref', ref: { space: 'observed', fact: 'inZone', args: ['hero', 'atrium'] } }],
      predicates: [{ predicateId: 'p.inZone', source: 'onEnterZone', expr: 0 }],
    });

  const hero: IrDoc['entities'][number] = {
    stableId: 'hero',
    role: 'agent',
    socket: 's.start',
    states: ['idle'],
    initialState: 'idle',
    initialLocked: false,
  };

  it('inZone(hero, atrium) s prázdným entities je odmítnut', () => {
    const verdict = validateIrDoc(inZoneDoc([]));
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.join('\n')).toContain('unknown entity hero');
  });

  it('týž dokument s deklarovanou entitou projde', () => {
    expect(validateIrDoc(inZoneDoc([hero])).issues).toEqual([]);
  });

  it('pulzní fakt odkazující na nedeklarovanou entitu je odmítnut', () => {
    const verdict = validateIrDoc(
      docWith({
        entities: [hero],
        nodes: [{ kind: 'ref', ref: { space: 'pulse', fact: 'acted', args: ['hero', 'use', 'vault'] } }],
        predicates: [{ predicateId: 'p.acted', source: 'onAction', expr: 0 }],
      }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.join('\n')).toContain('unknown entity vault');
  });

  it('nepřítomný cíl onAction je kanonická hodnota, ne osiřelý odkaz', () => {
    expect(
      validateIrDoc(
        docWith({
          entities: [hero],
          nodes: [{ kind: 'ref', ref: { space: 'pulse', fact: 'acted', args: ['hero', 'use', 'none'] } }],
          predicates: [{ predicateId: 'p.acted', source: 'onAction', expr: 0 }],
        }),
      ).issues,
    ).toEqual([]);
  });

  it('pulzní prostor není zapisovatelný — graf si nesmí psát vlastní vstupy', () => {
    const verdict = validateIrDoc(
      docWith({
        entities: [hero],
        nodes: [{ kind: 'literal', value: true }],
        effects: [
          { op: 'assign', ref: { space: 'pulse', fact: 'clicked', args: ['hero'] }, value: 0 },
        ],
      }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.join('\n')).toContain('pulse is not assignable');
  });

  it('hasItem nad nedeklarovaným slotem je odmítnut', () => {
    const verdict = validateIrDoc(
      docWith({
        nodes: [{ kind: 'ref', ref: { space: 'observed', fact: 'hasItem', args: ['hand', 'key'] } }],
        predicates: [{ predicateId: 'p.hasItem', source: 'onPickup', expr: 0 }],
      }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.join('\n')).toContain('unknown slot hand');
  });
});

describe('assign do timeru', () => {
  const assignDoc = (value: number) =>
    docWith({
      slots: [{ space: 'timer', id: 'fuse', maxTicks: 200, initial: 0 }],
      nodes: [{ kind: 'literal', value }],
      effects: [{ op: 'assign', ref: { space: 'timer', slot: 'fuse' }, value: 0 }],
    });

  it('hodnota nad deklarovaným maxTicks je odmítnuta', () => {
    const verdict = validateIrDoc(assignDoc(500));
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.join('\n')).toContain('assign value outside timer bounds');
  });

  it('záporná hodnota je odmítnuta', () => {
    expect(validateIrDoc(assignDoc(-1)).ok).toBe(false);
  });

  it('hodnota uvnitř mezí projde', () => {
    expect(validateIrDoc(assignDoc(200)).issues).toEqual([]);
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
//
// Zákaz se dá vynutit jen tak, že ho někdo pojmenuje. Cesta snížení a
// vyhodnocení ho pojmenovat nesmí vůbec; `references.ts` ho pojmenovat MUSÍ,
// protože kontroluje jedinou vazbu, kterou §13.1 povoluje — a čte přitom jen
// klíče `modules`, tedy `stableId`.
// ---------------------------------------------------------------------------

describe('oddělení od části vzhledu', () => {
  const irDir = join(process.cwd(), 'src', 'ir');
  const IR_PATH_MODULES = ['types.ts', 'schema.ts', 'lower.ts', 'eval.ts'];

  const linesOf = (file: string) => readFileSync(join(irDir, file), 'utf8').split(/\r?\n/);

  it('nemá ve zkompilovaném schématu jediné pole vzhledu', () => {
    // Strukturální oracle: do IR se ta část nedá zapsat, protože pro ni schéma
    // nemá místo. Golden set to potvrzuje z druhé strany případem I01.
    expect(JSON.stringify(compiled()).toLowerCase()).not.toContain('look');
  });

  it('cesta snížení a vyhodnocení ji nezmiňuje ani slovem', () => {
    const offenders: string[] = [];
    for (const file of IR_PATH_MODULES) {
      linesOf(file).forEach((line, position) => {
        if (/look/i.test(line)) offenders.push(`${file}:${position + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('modul `src/ir` obsahuje právě čtyři soubory cesty snížení plus resolver', () => {
    // Kdyby přibyl pátý produkční modul, předchozí test by ho tiše minul.
    const produced = readdirSync(irDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => entry.name)
      .sort();
    expect(produced).toEqual([...IR_PATH_MODULES, 'references.ts'].sort());
  });

  it('resolver ji jmenuje výhradně u klíčů modulů', () => {
    const offenders = linesOf('references.ts')
      .map((line, position) => [position + 1, line.trim()] as const)
      .filter(([, line]) => /look/i.test(line))
      .filter(([, line]) => !line.startsWith('*') && !line.startsWith('//') && !/modules/.test(line));
    expect(offenders).toEqual([]);
  });
});
