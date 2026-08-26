/**
 * Opravná vrstva.
 *
 * Polovina těchhle testů hlídá, co oprava **dělá**, druhá půlka to důležitější:
 * co dělat **nesmí**. Oprava, která by uhodla chybějící entitu nebo přejmenovala
 * osiřelý odkaz na podobný existující, by shodila jedinou dokázanou vlastnost
 * projektu — a udělala by to tiše, protože výsledek by se certifikoval.
 */

import { describe, expect, it } from 'vitest';

import { EXAMPLE_MARKER, buildEmissionRequest, type Grammar } from '../prompt';
import { repairEmission } from '../repair';

const grammar = (): Grammar => ({
  surfaceEvents: ['onStart', 'onEnterZone', 'onCollide', 'onAction', 'onPickup'],
  conditions: ['flagIs', 'stateIs', 'hasItem'],
  actions: ['setState', 'setFlag', 'setLocked', 'giveItem', 'despawn', 'win'],
  simFields: ['layout', 'sockets', 'entities', 'state', 'rules', 'witness'],
  lookFields: ['modules', 'palette'],
});

type Doc = { sim: Record<string, unknown>; look: Record<string, unknown> };

function example(): Doc {
  const system = buildEmissionRequest('cokoli', grammar()).system;
  const at = system.indexOf(EXAMPLE_MARKER);
  return JSON.parse(system.slice(system.indexOf('{', at))) as Doc;
}

const kinds = (result: ReturnType<typeof repairEmission>) => result.notes.map((note) => note.kind);

describe('co oprava dělá', () => {
  it('dohledá svědka, kterého model nenapsal', () => {
    const result = repairEmission(example());
    const sim = (result.document as Doc).sim;
    const ops = (sim.witness as { ops: readonly unknown[] }).ops;

    expect(kinds(result)).toContain('witnessSolved');
    expect(ops.length, 'svědek zůstal prázdný').toBeGreaterThan(0);
  });

  it('nahradí svědka, který nedojde do výhry', () => {
    // Bez téhle aserce projde oprava, která si vlastního svědka nechá vždycky —
    // a to je přesně ta vada, kvůli které vznikla (`witness/NO_WIN` v bráně vlny).
    const doc = example();
    const stunted = {
      ...doc,
      sim: { ...doc.sim, witness: { tier: 'short', H_cert: 600, ops: [{ tick: 0, actionId: 'moveTo', target: 'card' }] } },
    };
    const result = repairEmission(stunted);
    const ops = ((result.document as Doc).sim.witness as { ops: readonly unknown[] }).ops;

    expect(kinds(result)).toContain('witnessSolved');
    expect(kinds(result)).not.toContain('witnessKept');
    expect(ops.length).toBeGreaterThan(1);
  });

  it('nechá svědka od modelu, když jeho vlastní obstojí', () => {
    const solved = repairEmission(example()).document as Doc;
    // Podruhé už dokument svědka nese — a ten se přepisovat nemá.
    const again = repairEmission(solved);

    expect(kinds(again)).toContain('witnessKept');
    expect(kinds(again)).not.toContain('witnessSolved');
  });

  it('zahodí vzhledový modul, který nejmenuje entitu', () => {
    const doc = example();
    const withOrphan = { ...doc, look: { ...doc.look, modules: { ...(doc.look.modules as object), garden: {} } } };
    const result = repairEmission(withOrphan);
    const modules = ((result.document as Doc).look.modules ?? {}) as Record<string, unknown>;

    expect(kinds(result)).toContain('lookModuleDropped');
    expect(modules).not.toHaveProperty('garden');
    expect(modules, 'oprava zahodila i modul, který entitu jmenuje').toHaveProperty('gate');
  });

  it('přečte srážku s místem jako vstup do zóny', () => {
    const doc = example();
    const rules = {
      ...(doc.sim.rules as Record<string, unknown>),
      touch: {
        phase: 0,
        priority: 2,
        event: { kind: 'onCollide', a: 'player', b: 'cardPad' },
        condition: null,
        actions: [{ kind: 'setFlag', flag: 'powered', value: true }],
      },
    };
    const result = repairEmission({ ...doc, sim: { ...doc.sim, rules } });
    const repaired = ((result.document as Doc).sim.rules as Record<string, { event: Record<string, unknown> }>).touch;

    expect(kinds(result)).toContain('collideToZone');
    expect(repaired.event).toEqual({ kind: 'onEnterZone', entity: 'player', zone: 'cardPad' });
  });

  it('přečte stav vlajky jako flagIs', () => {
    const doc = example();
    const rules = {
      ...(doc.sim.rules as Record<string, unknown>),
      check: {
        phase: 0,
        priority: 3,
        event: { kind: 'onStart' },
        condition: { kind: 'stateIs', target: 'powered', value: true },
        actions: [{ kind: 'setState', target: 'lever', value: 'up' }],
      },
    };
    const result = repairEmission({ ...doc, sim: { ...doc.sim, rules } });
    const repaired = ((result.document as Doc).sim.rules as Record<string, { condition: unknown }>).check;

    expect(kinds(result)).toContain('stateToFlag');
    expect(repaired.condition).toEqual({ kind: 'flagIs', flag: 'powered', value: true });
  });
});

describe('co oprava dělat nesmí', () => {
  it('nedeklaruje entitu, kterou pravidlo jmenuje a svět nemá', () => {
    const doc = example();
    const rules = {
      ...(doc.sim.rules as Record<string, unknown>),
      ghost: {
        phase: 0,
        priority: 4,
        event: { kind: 'onAction', actionId: 'use', target: 'lantern' },
        condition: null,
        actions: [{ kind: 'setFlag', flag: 'powered', value: true }],
      },
    };
    const result = repairEmission({ ...doc, sim: { ...doc.sim, rules } });
    const entities = (result.document as Doc).sim.entities as Record<string, unknown>;

    expect(entities, 'oprava si domyslela entitu').not.toHaveProperty('lantern');
  });

  it('nepřejmenuje osiřelý odkaz na podobné existující jméno', () => {
    const doc = example();
    const rules = {
      ...(doc.sim.rules as Record<string, unknown>),
      typo: {
        phase: 0,
        priority: 5,
        // `levers` je o jedno písmeno vedle `lever`. Právě tenhle druh záchrany
        // se 21. 8. 2026 zamítl: je to systém hádající význam.
        event: { kind: 'onAction', actionId: 'use', target: 'levers' },
        condition: null,
        actions: [{ kind: 'setFlag', flag: 'powered', value: true }],
      },
    };
    const result = repairEmission({ ...doc, sim: { ...doc.sim, rules } });
    const repaired = ((result.document as Doc).sim.rules as Record<string, { event: { target: string } }>).typo;

    expect(repaired.event.target).toBe('levers');
  });

  it('nedoplní chybějící pravidlo výhry', () => {
    const doc = example();
    const rules = { ...(doc.sim.rules as Record<string, unknown>) };
    delete rules.win;
    const result = repairEmission({ ...doc, sim: { ...doc.sim, rules } });
    const repaired = (result.document as Doc).sim.rules as Record<string, unknown>;

    expect(repaired, 'oprava si vyrobila výhru, kterou model nenapsal').not.toHaveProperty('win');
    expect(kinds(result), 'hledač tvrdí, že našel cestu ve světě bez výhry').not.toContain('witnessSolved');
  });

  it('nepřepíše srážku dvou entit ani srážku dvou míst', () => {
    const doc = example();
    const rules = {
      ...(doc.sim.rules as Record<string, unknown>),
      things: {
        phase: 0,
        priority: 6,
        event: { kind: 'onCollide', a: 'player', b: 'card' },
        condition: null,
        actions: [{ kind: 'setFlag', flag: 'powered', value: true }],
      },
      places: {
        phase: 0,
        priority: 7,
        event: { kind: 'onCollide', a: 'cardPad', b: 'gatePad' },
        condition: null,
        actions: [{ kind: 'setFlag', flag: 'powered', value: true }],
      },
    };
    const result = repairEmission({ ...doc, sim: { ...doc.sim, rules } });
    const repaired = (result.document as Doc).sim.rules as Record<string, { event: Record<string, unknown> }>;

    expect(repaired.things.event, 'srážka dvou entit se přepsala').toEqual({
      kind: 'onCollide',
      a: 'player',
      b: 'card',
    });
    expect(repaired.places.event, 'srážka dvou míst se přepsala, i když není kdo vstupuje').toEqual({
      kind: 'onCollide',
      a: 'cardPad',
      b: 'gatePad',
    });
  });

  it('nesahá na poctivé odmítnutí sim: null', () => {
    const declined = { irVersion: 'v1', simRevision: 0, lookRevision: 0, sim: null, look: {}, simOutcome: 'NO_FIT' };
    const result = repairEmission(declined);

    expect(result.document).toBe(declined);
    expect(result.notes).toEqual([]);
  });

  it('nemění vstupní objekt, ani když sáhne na všechno, na co smí', () => {
    // Musí projít **každou** větví opravy, jinak by test měřil jen tu, která se
    // sama vypnula. Bez toho přežije mutace, která maže rovnou z originálu.
    const doc = example();
    const loaded = {
      ...doc,
      sim: {
        ...doc.sim,
        rules: {
          ...(doc.sim.rules as Record<string, unknown>),
          touch: {
            phase: 0,
            priority: 2,
            event: { kind: 'onCollide', a: 'player', b: 'cardPad' },
            condition: { kind: 'stateIs', target: 'powered', value: true },
            actions: [{ kind: 'setFlag', flag: 'powered', value: true }],
          },
        },
      },
      look: { ...doc.look, modules: { ...(doc.look.modules as object), garden: { family: 'hedge' } } },
    };
    const before = JSON.stringify(loaded);
    const result = repairEmission(loaded);

    expect(kinds(result)).toEqual(
      expect.arrayContaining(['collideToZone', 'stateToFlag', 'lookModuleDropped', 'witnessSolved']),
    );
    expect(JSON.stringify(loaded), 'oprava přepsala to, co napsal model').toBe(before);
  });
});

/**
 * Podmínky, za kterých je zásah **přesný, ne pravděpodobný**.
 *
 * Docblock `repair.ts` u každého ze čtyř zásahů jednu takovou podmínku slibuje.
 * Testy výš dokládají, že zásah proběhne; tyhle dokládají, že se nespustí, když
 * podmínka neplatí — a to je ta půlka, na které stojí „nic vadného neprojde".
 * Každý z nich byl napsán proti podstrčené chybě, která bez něj přežila.
 */
describe('kde přesně je hranice zásahu', () => {
  it('nechá srážku být, když je jméno místa zároveň jménem entity', () => {
    // `card` je entita i soket najednou. Věc má přednost před místem: jinak by
    // se ze srážky dvou věcí stal vstup do zóny a rozhodlo by o tom rozvržení.
    const doc = example();
    const sockets = { ...(doc.sim.sockets as Record<string, unknown>), card: [7, 4] };
    const rules = {
      ...(doc.sim.rules as Record<string, unknown>),
      bump: {
        phase: 0,
        priority: 8,
        event: { kind: 'onCollide', a: 'player', b: 'card' },
        condition: null,
        actions: [{ kind: 'setFlag', flag: 'powered', value: true }],
      },
    };
    const result = repairEmission({ ...doc, sim: { ...doc.sim, sockets, rules } });
    const repaired = (result.document as Doc).sim.rules as Record<string, { event: Record<string, unknown> }>;

    expect(kinds(result)).not.toContain('collideToZone');
    expect(repaired.bump.event).toEqual({ kind: 'onCollide', a: 'player', b: 'card' });
  });

  it('nepřepíše srážku, jejíž druhá strana není deklarovaná entita', () => {
    // Přepis by tu vyrobil `onEnterZone` s nedeklarovaným vstupujícím: emise se
    // odmítne stejně, ale panel by přitom hlásil provedenou opravu.
    const doc = example();
    const rules = {
      ...(doc.sim.rules as Record<string, unknown>),
      haunt: {
        phase: 0,
        priority: 9,
        event: { kind: 'onCollide', a: 'cardPad', b: 'ghost' },
        condition: null,
        actions: [{ kind: 'setFlag', flag: 'powered', value: true }],
      },
    };
    const result = repairEmission({ ...doc, sim: { ...doc.sim, rules } });
    const repaired = (result.document as Doc).sim.rules as Record<string, { event: Record<string, unknown> }>;

    expect(kinds(result)).not.toContain('collideToZone');
    expect(repaired.haunt.event).toEqual({ kind: 'onCollide', a: 'cardPad', b: 'ghost' });
  });

  it('nechá stav být, když je jméno vlajky zároveň jménem entity', () => {
    const doc = example();
    const entities = {
      ...(doc.sim.entities as Record<string, unknown>),
      powered: { role: 'prop', socket: 'leverPad', state: 'off' },
    };
    const rules = {
      ...(doc.sim.rules as Record<string, unknown>),
      look: {
        phase: 0,
        priority: 10,
        event: { kind: 'onStart' },
        condition: { kind: 'stateIs', target: 'powered', value: true },
        actions: [{ kind: 'setFlag', flag: 'powered', value: true }],
      },
    };
    const result = repairEmission({ ...doc, sim: { ...doc.sim, entities, rules } });
    const repaired = ((result.document as Doc).sim.rules as Record<string, { condition: unknown }>).look;

    expect(kinds(result)).not.toContain('stateToFlag');
    expect(repaired.condition).toEqual({ kind: 'stateIs', target: 'powered', value: true });
  });

  it('nechá stav být, když porovnávaná hodnota není boolean', () => {
    // Vlajka je dvouhodnotová. `stateIs(powered, "on")` je buď stav entity, nebo
    // vada — a uhodnout, které z toho, není zásah, který nemění význam.
    const doc = example();
    const rules = {
      ...(doc.sim.rules as Record<string, unknown>),
      phrase: {
        phase: 0,
        priority: 11,
        event: { kind: 'onStart' },
        condition: { kind: 'stateIs', target: 'powered', value: 'on' },
        actions: [{ kind: 'setFlag', flag: 'powered', value: true }],
      },
    };
    const result = repairEmission({ ...doc, sim: { ...doc.sim, rules } });
    const repaired = ((result.document as Doc).sim.rules as Record<string, { condition: unknown }>).phrase;

    expect(kinds(result)).not.toContain('stateToFlag');
    expect(repaired.condition).toEqual({ kind: 'stateIs', target: 'powered', value: 'on' });
  });

  it('opraví stav i uvnitř složené podmínky', () => {
    // Bez rekurze se `stateIs` opraví jen tehdy, když stojí v pravidle samo —
    // a model ho běžně píše pod `allOf` nebo pod `not`.
    const doc = example();
    const stateIs = { kind: 'stateIs', target: 'powered', value: true };
    const rules = {
      ...(doc.sim.rules as Record<string, unknown>),
      both: {
        phase: 0,
        priority: 12,
        event: { kind: 'onStart' },
        condition: { kind: 'allOf', operands: [stateIs, { kind: 'not', operand: stateIs }] },
        actions: [{ kind: 'setFlag', flag: 'powered', value: true }],
      },
    };
    const result = repairEmission({ ...doc, sim: { ...doc.sim, rules } });
    const repaired = ((result.document as Doc).sim.rules as Record<string, { condition: unknown }>).both;
    const asFlag = { kind: 'flagIs', flag: 'powered', value: true };

    expect(kinds(result)).toContain('stateToFlag');
    expect(repaired.condition).toEqual({ kind: 'allOf', operands: [asFlag, { kind: 'not', operand: asFlag }] });
  });

  it('zapíše, kolik tiků nalezená cesta potřebovala', () => {
    // Panel překladu čte `L_witness` a bez něj napíše porotci „win at tick 0"
    // nad stopou, která vyhrála o čtyřicet tiků později. Naměřeno 26. 8. 2026
    // na živém běhu: hláška opravy hlásila tik 41, panel vedle ní nulu.
    const result = repairEmission(example());
    const witness = (result.document as Doc).sim.witness as { L_witness?: number };
    const solved = result.notes.find((note) => note.kind === 'witnessSolved');

    expect(solved, 'test neměří nic — hledač se nespustil').toBeDefined();
    expect(witness.L_witness).toBeGreaterThan(0);
    expect(solved!.detail, 'panel a hláška hlásí jiný tik').toContain(`tick ${String(witness.L_witness)}`);
  });

  it('hledá v horizontu tieru, ne v tom, o který si model řekl', () => {
    // `build.ts` předává `witness.H_cert` nezměněné, takže přání pod stropem
    // tieru by hledání zkrátilo a svět s výhrou by vyšel jako nedohratelný.
    // Certifikace pak stejně měří stropem tieru — hledalo by se v jiné míře.
    const doc = example();
    const shortsighted = { ...doc, sim: { ...doc.sim, witness: { tier: 'short', H_cert: 10, ops: [] } } };
    const result = repairEmission(shortsighted);
    const witness = (result.document as Doc).sim.witness as { H_cert: number; ops: readonly unknown[] };

    expect(kinds(result)).toContain('witnessSolved');
    expect(witness.H_cert, 'přání modelu zůstalo horizontem hledání').toBe(600);
    expect(witness.ops.length).toBeGreaterThan(0);
  });
});
