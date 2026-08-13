import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { findDanglingReferences, type DanglingReference } from '../references';

function frozenLines(...parts: string[]): Record<string, any>[] {
  return readFileSync(join(process.cwd(), 'evals', 'frozen', ...parts), 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
}

const malformed = frozenLines('malformed', 'index.jsonl');
const responses = frozenLines('responses', 'index.jsonl');

/**
 * Očekávaný nález je vypsaný celý, ne jen „něco spadlo". Podřetězec v anotaci
 * defektu by prošel i resolveru, který navíc hlásí `win` (id pravidla) nebo
 * `entities` — obojí v té české větě totiž taky stojí.
 *
 * **Sada se prochází celá, ne filtrovaná na `defectClass === 'dangling_reference'`.**
 * Ten filtr vypadal jako zúžení na relevantní případy, ale byl to výpadek
 * pokrytí: M03 je zmrazený osiřelý **socket** (`zone: "s9"` v pravidle a týž
 * cíl ve svědkovi) vedený jako `index_out_of_range`, takže se přes filtr nikdy
 * nespustil — a socketový prostor tím zůstal bez jediné zmrazené aserce.
 * Zbylých 27 fixture nemá zásah, což je zároveň negativní kontrola: resolver,
 * který hlásí příliš, spadne tady.
 */
const EXPECTED_DANGLING: Readonly<Record<string, readonly DanglingReference[]>> = {
  M03: [
    { where: 'sim.rules[win].event.zone', namespace: 'socket', name: 's9' },
    { where: 'sim.witness.ops[0].target', namespace: 'entityOrSocket', name: 's9' },
  ],
  M15: [{ where: 'sim.rules[win].event.ref', namespace: 'counter', name: 'coins' }],
  M16: [{ where: 'look.modules.lamp', namespace: 'entity', name: 'lamp' }],
};

describe('osiřelé odkazy ve zmrazených vadných emisích', () => {
  it('prochází celou zmrazenou sadu, ne jen deklarovanou třídu', () => {
    expect(malformed).toHaveLength(30);
  });

  it.each(malformed.map((entry) => [entry.id, entry] as const))(
    '%s dá přesně očekávaný nález',
    (id, entry) => {
      expect(findDanglingReferences(entry.body)).toEqual([...(EXPECTED_DANGLING[id] ?? [])]);
    },
  );
});

/**
 * Bez týhle kontroly by testem prošel i resolver, který hlásí příliš. Vyloučeny
 * jsou jen `NO_FIT` emise, protože ty podle protokolu `sim` vůbec nenesou.
 */
describe('negativní kontrola nad zmrazenými syntetickými odpověďmi', () => {
  const worlds = responses.filter((entry) => entry.branch === 'create' && entry.expectedVerdict !== 'NO_FIT');

  it('pokrývá všechny zmrazené světy tvorby, které simulaci nesou', () => {
    expect(worlds).toHaveLength(13);
    expect(worlds.every((entry) => entry.body?.sim)).toBe(true);
  });

  it.each(worlds.map((entry) => [entry.forPrompt, entry] as const))(
    '%s nemá jediný osiřelý odkaz',
    (_prompt, entry) => {
      expect(findDanglingReferences(entry.body)).toEqual([]);
    },
  );
});

describe('rozpouštění jmen', () => {
  const world: Record<string, any> = {
    sim: {
      sockets: { s0: [1, 1] },
      entities: { player: { role: 'actor', socket: 's0', state: 'idle' } },
      state: { counters: { score: { min: 0, max: 9, init: 0 } }, flags: {}, timers: {} },
      // **Záznam klíčovaný `id`, ne pole** — kanonický tvar povrchového `sim`
      // po přemrazení na `evals-frozen-v2`. Fixtury tady byly polem, což je tvar,
      // který korpus opustil; `ruleEntries` obojí uneslo, takže se rozdíl nikde
      // neprojevil a celá socketová sada níž běžela nad opuštěným tvarem.
      // Pole má vlastní případ dole — podpora obou tvarů je záměr, ne shoda okolností.
      rules: {
        win: {
          id: 'win',
          event: { kind: 'onCounterReaches', ref: 'score', threshold: 3 },
          condition: null,
          actions: [{ kind: 'win' }],
        },
      },
      witness: { ops: [] },
    },
    look: { modules: { player: { family: 'actor', params: {} } } },
  };

  it('deklarovaný dokument projde', () => {
    expect(findDanglingReferences(world)).toEqual([]);
  });

  it('pravidlo nad nedeklarovaným counterem je osiřelý odkaz', () => {
    const broken = structuredClone(world);
    broken.sim.rules.win.event.ref = 'coins';
    expect(findDanglingReferences(broken)).toEqual([
      { where: 'sim.rules[win].event.ref', namespace: 'counter', name: 'coins' },
    ]);
  });

  it('vzhledový modul bez odpovídající entity je osiřelý odkaz', () => {
    const broken = structuredClone(world);
    broken.look.modules.lamp = { family: 'fixture', params: {} };
    expect(findDanglingReferences(broken)).toEqual([
      { where: 'look.modules.lamp', namespace: 'entity', name: 'lamp' },
    ]);
  });
});

/**
 * Socketový prostor a `entityOrSocket` neměly ani jednu pozitivní aserci — každý
 * nález v sadě byl `counter`, `flag`, `entity` nebo `slot`, a negativní kontrola
 * nad zmrazenými světy asertuje prázdno, což tiché vypnutí prostoru splní.
 * Reprodukce toho výpadku: nahradit `const sockets = union(...)` za
 * `UNRESOLVABLE`, nebo smazat celou smyčku přes `witness.ops`, neshodilo nic.
 * Každá cesta, která do socketového prostoru ukazuje, tu proto má vlastní případ.
 */
describe('socketový a smíšený prostor je pinutý na každé cestě, která do něj ukazuje', () => {
  const base = (): Record<string, any> => ({
    sim: {
      sockets: { s0: [1, 1], s1: [4, 4] },
      entities: { player: { role: 'actor', socket: 's0', state: 'idle' } },
      state: { counters: {}, flags: {}, timers: {}, zones: { z0: [2, 2] }, slots: 1 },
      rules: {
        r1: {
          id: 'r1',
          event: { kind: 'onEnterZone', entity: 'player', zone: 'z0' },
          condition: { kind: 'inZone', entity: 'player', zone: 's1' },
          actions: [{ kind: 'moveTo', target: 'player', socket: 's1' }],
        },
        r2: {
          id: 'r2',
          event: { kind: 'onDrop', socket: 's0', slot: 0 },
          condition: { kind: 'countInZone', zone: 'z0', n: 1 },
          actions: [{ kind: 'setState', target: 'player', value: 'idle' }],
        },
      },
      witness: { ops: [{ tick: 0, actionId: 'moveTo', target: 's1' }] },
    },
  });

  it('plně deklarovaný svět projde', () => {
    expect(findDanglingReferences(base())).toEqual([]);
  });

  const cases: Array<[string, (world: Record<string, any>) => void, DanglingReference]> = [
    [
      'onEnterZone.zone',
      (world) => {
        world.sim.rules.r1.event.zone = 's9';
      },
      { where: 'sim.rules[r1].event.zone', namespace: 'socket', name: 's9' },
    ],
    [
      'inZone.zone',
      (world) => {
        world.sim.rules.r1.condition.zone = 's9';
      },
      { where: 'sim.rules[r1].condition.zone', namespace: 'socket', name: 's9' },
    ],
    [
      'moveTo.socket',
      (world) => {
        world.sim.rules.r1.actions[0].socket = 's9';
      },
      { where: 'sim.rules[r1].actions[0].socket', namespace: 'socket', name: 's9' },
    ],
    [
      'onDrop.socket',
      (world) => {
        world.sim.rules.r2.event.socket = 's9';
      },
      { where: 'sim.rules[r2].event.socket', namespace: 'socket', name: 's9' },
    ],
    [
      'countInZone.zone',
      (world) => {
        world.sim.rules.r2.condition.zone = 's9';
      },
      { where: 'sim.rules[r2].condition.zone', namespace: 'socket', name: 's9' },
    ],
    [
      'witness.ops[].target',
      (world) => {
        world.sim.witness.ops[0].target = 's9';
      },
      { where: 'sim.witness.ops[0].target', namespace: 'entityOrSocket', name: 's9' },
    ],
  ];

  it.each(cases)('%s nad nedeklarovaným socketem je osiřelý odkaz', (_path, breakIt, expected) => {
    const world = base();
    breakIt(world);
    expect(findDanglingReferences(world)).toEqual([expected]);
  });

  it('zóna z `state.zones` je socket jako každý jiný — prostor je sjednocení', () => {
    // Kdyby se četly jen `sim.sockets`, `z0` by osiřelo na obou místech naráz.
    const world = base();
    delete world.sim.state.zones;
    expect(findDanglingReferences(world)).toEqual([
      { where: 'sim.rules[r1].event.zone', namespace: 'socket', name: 'z0' },
      { where: 'sim.rules[r2].condition.zone', namespace: 'socket', name: 'z0' },
    ]);
  });

  it('svědek smí mířit i na entitu, ne jen na socket', () => {
    const world = base();
    world.sim.witness.ops[0].target = 'player';
    expect(findDanglingReferences(world)).toEqual([]);
  });

  /**
   * **Pole je podporované SCHVÁLNĚ a od teď to má vlastní aserci.**
   *
   * Kanonický tvar je záznam, ale `ruleEntries` (`references.ts`) nese i větev pro
   * pole — a je to úmysl: kontrola osiřelých odkazů má mluvit i nad emisí, která
   * tvar splete, místo aby nad ní zmlkla. Dokud ale všechny fixtury byly polem,
   * měřila se **jen** ta větev; po převodu na záznam by se bez tohohle případu
   * nemeřila žádná. Popisek se v ní bere z `rule.id`, ne z klíče — proto stejný
   * `where` jako u záznamu.
   */
  it('a tentýž svět zapsaný POLEM dá tentýž nález — obě větve `ruleEntries` žijí', () => {
    const asRecord = base();
    // **`structuredClone`, ne `Object.values`.** To by do pole propašovalo tytéž
    // objekty pravidel, na které ukazuje záznam — jeden objektový graf ve dvou
    // kontejnerech. Mutace níž by pak sáhla dvakrát na totéž pravidlo a test by
    // porovnával jeden svět sám se sebou, ne dva zápisy téhož.
    const asArray = structuredClone(asRecord);
    asArray.sim.rules = Object.values(structuredClone(asRecord.sim.rules));
    expect(Array.isArray(asArray.sim.rules)).toBe(true);

    // Důkaz, že jsou to dva stromy, musí porovnávat IDENTITU. Čtení hodnoty
    // z `r1` to nedokáže — `r1` nemutuje ani jedna větev, takže by ta aserce
    // prošla i nad sdíleným grafem, tedy přesně v tom případě, před kterým
    // varuje komentář výš.
    expect(asArray.sim.rules[0]).not.toBe(asRecord.sim.rules.r1);
    expect(asArray.sim.rules[1]).not.toBe(asRecord.sim.rules.r2);

    asRecord.sim.rules.r2.event.socket = 's9';
    asArray.sim.rules[1].event.socket = 's9';

    // Popisek `r2` vzniká u pole z `rule.id`, u záznamu z klíče — dvě různé cesty
    // ke stejnému výsledku, což je přesně to, co má tenhle test držet.
    const expected = [{ where: 'sim.rules[r2].event.socket', namespace: 'socket', name: 's9' }];
    expect(findDanglingReferences(asArray)).toEqual(expected);
    expect(findDanglingReferences(asRecord)).toEqual(expected);
  });
});

/**
 * Tvarová vada je jiná třída než osiřelý odkaz, a dělí je jedna otázka: jsou
 * jména zapsaná jinak (pole, skalár — vlastní schéma, čtení by hádalo), nebo
 * nejsou zapsaná vůbec (chybí, `null`, `{}` — prázdný prostor)?
 *
 * **Neopírá se to o opravitelnost, protože ta nejde ani jedním směrem.** Ve
 * zmrazené sadě je `type_coercion` opravitelná u M07 a M08, ale ne u M09, a
 * `dangling_reference` je neopravitelný u M15, ale opravitelný u M16.
 */
describe('deklarace špatného tvaru', () => {
  const shaped = (state: unknown, entities: unknown = { player: { role: 'actor' } }) => ({
    sim: {
      sockets: { s0: [1, 1] },
      entities,
      state,
      rules: {
        r1: {
          id: 'r1',
          event: { kind: 'onCounterReaches', ref: 'score', threshold: 3 },
          condition: { kind: 'flagIs', ref: 'lit', value: true },
          actions: [{ kind: 'setState', target: 'player', value: 'idle' }],
        },
      },
      witness: { ops: [] },
    },
  });

  it('countery zapsané polem místo objektu nehlásí osiřelý odkaz', () => {
    expect(
      findDanglingReferences(shaped({ counters: ['score'], flags: { lit: false }, timers: {} })),
    ).toEqual([]);
  });

  it('celý state špatného tvaru zneplatní všechny prostory, které v něm bydlí', () => {
    expect(findDanglingReferences(shaped(['score']))).toEqual([]);
  });

  it('null kontejner znamená totéž co chybějící, protože kóduje tentýž záměr', () => {
    // Rozlišit je by znamenalo dát dvěma zápisům „žádné countery" opačnou třídu
    // defektu — a zmrazená sada pro to rozlišení nemá jediný fixture.
    const asNull = findDanglingReferences(shaped({ counters: null, flags: { lit: false }, timers: {} }));
    const asMissing = findDanglingReferences(shaped({ flags: { lit: false }, timers: {} }));
    expect(asNull).toEqual([{ where: 'sim.rules[r1].event.ref', namespace: 'counter', name: 'score' }]);
    expect(asNull).toEqual(asMissing);
  });

  it('null místo celého state se chová jako chybějící state, ne jako pole', () => {
    const asNull = findDanglingReferences(shaped(null));
    const asMissing = findDanglingReferences(shaped(undefined));
    expect(asNull).toEqual([
      { where: 'sim.rules[r1].event.ref', namespace: 'counter', name: 'score' },
      { where: 'sim.rules[r1].condition.ref', namespace: 'flag', name: 'lit' },
    ]);
    expect(asNull).toEqual(asMissing);
    // A protipól, aby test nedokazoval jen to, že se všechno chová stejně.
    expect(findDanglingReferences(shaped(['score']))).toEqual([]);
  });

  it('null entities se chovají jako chybějící i směrem od části vzhledu', () => {
    const look = { modules: { lamp: {}, torch: {}, banner: {} } };
    // Chybějící kontejner se **maže**, nepředává se `undefined`. Druhý parametr
    // `shaped` má výchozí hodnotu, takže `withEntities(undefined)` dosadilo
    // deklarované `player` a porovnávalo `null` proti *deklaraci*, ne proti
    // chybějícímu klíči. Filtr na `look.` to schoval: nad deklarovanou entitou
    // vyjdou obě větve na týchž třech vzhledových nálezech.
    const build = (mutate: (sim: Record<string, any>) => void) => {
      const world: Record<string, any> = { ...shaped({ counters: {}, flags: {} }), look };
      mutate(world.sim);
      return world;
    };
    // A bez filtru vůbec: zahazoval sim-side nálezy, takže by test prošel, i
    // kdyby detekce entit uvnitř `sim` přestala fungovat úplně. Nález na
    // `actions[0].target` je ta odhozená polovina.
    const asNull = findDanglingReferences(
      build((sim) => {
        sim.entities = null;
      }),
    );
    const asMissing = findDanglingReferences(
      build((sim) => {
        delete sim.entities;
      }),
    );
    expect(asNull).toEqual([
      { where: 'sim.rules[r1].event.ref', namespace: 'counter', name: 'score' },
      { where: 'sim.rules[r1].condition.ref', namespace: 'flag', name: 'lit' },
      { where: 'sim.rules[r1].actions[0].target', namespace: 'entity', name: 'player' },
      { where: 'look.modules.lamp', namespace: 'entity', name: 'lamp' },
      { where: 'look.modules.torch', namespace: 'entity', name: 'torch' },
      { where: 'look.modules.banner', namespace: 'entity', name: 'banner' },
    ]);
    expect(asMissing).toEqual(asNull);
  });

  it('prázdný objekt naopak prázdný prostor JE — a odkaz do něj je osiřelý', () => {
    expect(findDanglingReferences(shaped({ counters: {}, flags: { lit: false }, timers: {} }))).toEqual([
      { where: 'sim.rules[r1].event.ref', namespace: 'counter', name: 'score' },
    ]);
  });

  it('entity zapsané polem nehlásí osiřelý odkaz na akci', () => {
    const found = findDanglingReferences(shaped({ counters: { score: {} }, flags: { lit: false } }, ['player']));
    expect(found).toEqual([]);
  });

  it('chybějící deklarace naopak osiřelý odkaz JE', () => {
    const found = findDanglingReferences(shaped({ flags: { lit: false }, timers: {} }));
    expect(found).toEqual([{ where: 'sim.rules[r1].event.ref', namespace: 'counter', name: 'score' }]);
  });
});

/**
 * Inventární sloty se v zmrazeném kontraktu adresují indexem a `state.slots` je
 * jejich pevný počet. Osiřelý odkaz je tu index mimo rozsah.
 */
describe('inventární sloty se adresují indexem', () => {
  const withSlot = (slot: unknown, slots: unknown = 3) => ({
    sim: {
      sockets: {},
      entities: { player: { role: 'actor' } },
      state: { counters: {}, flags: {}, timers: {}, slots },
      rules: {
        r1: {
          id: 'r1',
          event: { kind: 'onPickup', slot },
          condition: { kind: 'hasItem', slot, item: 'key' },
          actions: [{ kind: 'giveItem', slot, item: 'key' }],
        },
      },
      witness: { ops: [] },
    },
  });

  it('index uvnitř deklarovaného počtu projde', () => {
    expect(findDanglingReferences(withSlot(0))).toEqual([]);
  });

  it('index nad deklarovaným počtem je osiřelý odkaz na všech třech místech', () => {
    expect(findDanglingReferences(withSlot(9)).map((entry) => entry.where)).toEqual([
      'sim.rules[r1].event.slot',
      'sim.rules[r1].condition.slot',
      'sim.rules[r1].actions[0].slot',
    ]);
  });

  it('bez deklarovaného počtu se nerozpouští, místo aby se hádalo', () => {
    expect(findDanglingReferences(withSlot(9, null))).toEqual([]);
  });
});
