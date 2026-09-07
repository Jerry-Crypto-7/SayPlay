/**
 * Opravná vrstva.
 *
 * Polovina těchhle testů hlídá, co oprava **dělá**, druhá půlka to důležitější:
 * co dělat **nesmí**. Oprava, která by uhodla chybějící entitu nebo přejmenovala
 * osiřelý odkaz na podobný existující, by shodila jedinou dokázanou vlastnost
 * projektu — a udělala by to tiše, protože výsledek by se certifikoval.
 */

import { describe, expect, it } from 'vitest';

import { buildRuntimeWorld } from '../../ir/build';
import { ID_PATTERN } from '../../ir/types';
import { ruleKeyFault } from '../../ir/worlddoc';
import { SHAPE_IDENTIFIER_PATTERN } from '../../shape/schema';
import { EXAMPLE_MARKER, buildEmissionRequest, type Grammar } from '../prompt';
import { repairEmission, toIdentifier } from '../repair';

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

describe('co oprava nesmí ztratit', () => {
  it('pravidlo pod klíčem __proto__ nezmizí — pojmenuje se jako vada', () => {
    // **Nález nezávislé revize 4. 9. 2026, ověřený spuštěním v node.** Tabulka
    // pravidel se skládala přiřazením do `{}`, a `repaired['__proto__'] = {…}`
    // vlastní klíč nezaloží: zavolá setter prototypu. Pravidlo tedy z tabulky
    // **zmizelo** a hotové tabulce se navíc vyměnil prototyp — svět se pak
    // certifikuje o jeden zákon chudší, aniž kdokoli řekne proč.
    //
    // Vstup se skládá `Object.fromEntries`, protože ta zakládá vlastnosti
    // definicí, ne přiřazením — přesně jako `JSON.parse`, kterým odpověď modelu
    // doopravdy přichází. Napsat `{ __proto__: … }` v literálu by vyrobilo něco
    // jiného: prototyp, ne klíč.
    const doc = example();
    const rules = doc.sim.rules as Record<string, unknown>;
    const [firstKey] = Object.keys(rules);
    const poisoned = Object.fromEntries([...Object.entries(rules), ['__proto__', rules[firstKey]]]);
    expect(Object.keys(poisoned), 'fixtura ten klíč ztratila už na vstupu').toContain('__proto__');

    const repaired = (
      repairEmission({ ...doc, sim: { ...doc.sim, rules: poisoned } }).document as Doc
    ).sim;
    const table = repaired.rules as Record<string, unknown>;

    expect(Object.keys(table), 'zákon zmizel z tabulky').toContain('__proto__');
    expect(Object.keys(table)).toHaveLength(Object.keys(poisoned).length);
    expect(Object.getPrototypeOf(table), 'tabulce se vyměnil prototyp').toBe(Object.prototype);

    // A druhá polovina toho slibu: **nezakládá se nový invariant**. Klíč, na
    // který se rozbor cesty nedostane, pojmenuje ta větev, která na to už je —
    // stejně jako `constructor` a `prototype`, které tudy chodí správně dnes.
    expect(ruleKeyFault(repaired)?.detail).toContain('__proto__');
  });
});

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

/**
 * **Každý řetězec níž je naměřený, ne vymyšlený.** Pochází z archivu běhu `T14`
 * (`evals/worldstream/create-raw.json`, 104 odpovědí, 6. 9. 2026), který je
 * gitignorovaný — proto jsou hodnoty opsané sem. Poměry z toho archivu, které
 * tenhle blok hlídá: `materialIntent` 60 vadných ze 112, `role` 3 ze 479,
 * a **528 platných hodnot, na které se nesmí sáhnout**.
 */
describe('narovnání identifikátoru', () => {
  const MEASURED_PHRASES: readonly (readonly [string, string])[] = [
    ['weathered corrugated steel', 'weatheredCorrugatedSteel'],
    ['wet projecting eaves', 'wetProjectingEaves'],
    ['stagnant floodwater', 'stagnantFloodwater'],
    ['rain-darkened courtyard curb', 'rainDarkenedCourtyardCurb'],
    ['patched timber homes with iron hangers', 'patchedTimberHomesWithIronHangers'],
  ];

  /** Naměřené hodnoty, které prošly. Byte za byte je vrátí obě vrstvy. */
  const MEASURED_VALID: readonly string[] = [
    'weathered_stone',
    'living_bark_and_hewn_timber',
    'agedClockworkMetal',
    'actor',
    'traversableMachinery',
  ];

  it('přečte frázi jako identifikátor platný na obou vrstvách naráz', () => {
    for (const [wrote, read] of MEASURED_PHRASES) {
      expect(toIdentifier(wrote, SHAPE_IDENTIFIER_PATTERN), wrote).toBe(read);
      expect(toIdentifier(wrote, ID_PATTERN), wrote).toBe(read);
      // Celý smysl jednoho pravidla místo dvou: co vyleze, projde oběma vzory.
      expect(SHAPE_IDENTIFIER_PATTERN.test(read), read).toBe(true);
      expect(ID_PATTERN.test(read), read).toBe(true);
    }
  });

  it('nesáhne na hodnotu, která už platná je', () => {
    // Bez téhle aserce projde narovnání, které rozpadá na slova vždycky — a
    // `weathered_stone` by z něj vylezlo jako `weatheredStone`, tedy jiný
    // materiál než ten, který model napsal.
    for (const value of MEASURED_VALID) {
      const pattern = SHAPE_IDENTIFIER_PATTERN.test(value) ? SHAPE_IDENTIFIER_PATTERN : ID_PATTERN;
      expect(toIdentifier(value, pattern), value).toBe(value);
    }
  });

  it('nechá být hodnotu, kterou přijímá vrstva, na které stojí', () => {
    // ⚠ **`outdoor-space` je naměřený případ obojího naráz.** Je to jediná
    // vadná `role` celého běhu (3 výskyty ze 479), takže IR ji odmítne a
    // narovná se — jenže tvarová vrstva pomlčku bere. Kdyby se obě vrstvy
    // narovnávaly přísnějším vzorem, přepsala by se hodnota, kterou nikdo
    // neodmítl. Vzor rozhoduje o obojím: co je vada i co z ní vznikne.
    expect(toIdentifier('outdoor-space', ID_PATTERN)).toBe('outdoorSpace');
    expect(toIdentifier('outdoor-space', SHAPE_IDENTIFIER_PATTERN)).toBe('outdoor-space');

    expect(toIdentifier('9lives', SHAPE_IDENTIFIER_PATTERN)).toBe('9lives');
    expect(toIdentifier('geom:panel.floor', SHAPE_IDENTIFIER_PATTERN)).toBe('geom:panel.floor');
  });

  it('nevymýšlí identifikátor tam, kde žádný nevznikne', () => {
    // Selhání jsou stejně důležitá jako úspěchy: dopsat předponu k `3rd floor`
    // nebo useknout konec dlouhého řetězce je hádání, ne oprava.
    expect(toIdentifier('', ID_PATTERN), 'prázdný řetězec').toBeNull();
    expect(toIdentifier('   ', ID_PATTERN), 'samé mezery').toBeNull();
    expect(toIdentifier('— · —', ID_PATTERN), 'samá interpunkce').toBeNull();
    expect(toIdentifier(42, ID_PATTERN), 'nebyl to řetězec').toBeNull();
    expect(toIdentifier(null, ID_PATTERN), 'nebyl to řetězec').toBeNull();
    expect(toIdentifier('3rd floor', ID_PATTERN), 'IR chce první písmeno').toBeNull();
    expect(toIdentifier('weathered '.repeat(9), ID_PATTERN), 'delší než 64 znaků').toBeNull();
  });

  it('narovná roli u entity i v pravidle, které se jí drží', () => {
    // ⚠ **Tohle je celý důvod, proč je narovnání dokumentové, ne polní.**
    // `onPickup` se smí klíčovat rolí a `entitiesWithRole()` porovnává řetězce
    // na rovnost, takže přepis jen u entity vyrobí pravidlo, které nikoho
    // nenajde — a lowering spadne na `no entity matches role`.
    const doc = example();
    const entities = doc.sim.entities as Record<string, Record<string, unknown>>;
    const rules = doc.sim.rules as Record<string, Record<string, unknown>>;
    const [ruleId, byRole] =
      Object.entries(rules).find(
        ([, rule]) => (rule.event as Record<string, unknown>).kind === 'onPickup',
      ) ?? [];
    expect(byRole, 'fixtura ztratila pravidlo klíčované rolí').toBeDefined();

    const sim = {
      ...doc.sim,
      entities: { ...entities, card: { ...entities.card, role: 'loose pickup' } },
      rules: {
        ...rules,
        [ruleId as string]: { ...byRole, event: { kind: 'onPickup', role: 'loose pickup' } },
      },
    };

    const result = repairEmission({ ...doc, sim });
    const repaired = (result.document as Doc).sim;
    const repairedEntities = repaired.entities as Record<string, Record<string, unknown>>;
    const repairedRules = repaired.rules as Record<string, Record<string, unknown>>;

    expect(kinds(result).filter((kind) => kind === 'roleStraightened'), 'nota má být jedna na roli').toHaveLength(1);
    expect(repairedEntities.card.role).toBe('loosePickup');
    expect((repairedRules[ruleId as string].event as Record<string, unknown>).role).toBe('loosePickup');

    const built = buildRuntimeWorld(repaired);
    expect(built.ok ? [] : built.issues, 'svět se po narovnání nepostavil').toEqual([]);
  });

  it('nechá roli být, když identifikátor už je', () => {
    const result = repairEmission(example());
    expect(kinds(result)).not.toContain('roleStraightened');
  });
});
