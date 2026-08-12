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

/** Zmrazená třída defektu „osiřelý odkaz". Je jich málo — a to je důvod je jmenovat. */
const DANGLING = malformed.filter((entry) => entry.defectClass === 'dangling_reference');

/**
 * Očekávaný nález je vypsaný celý, ne jen „něco spadlo". Podřetězec v anotaci
 * defektu by prošel i resolveru, který navíc hlásí `win` (id pravidla) nebo
 * `entities` — obojí v té české větě totiž taky stojí.
 */
const EXPECTED_DANGLING: Readonly<Record<string, readonly DanglingReference[]>> = {
  M15: [{ where: 'sim.rules[win].event.ref', namespace: 'counter', name: 'coins' }],
  M16: [{ where: 'look.modules.lamp', namespace: 'entity', name: 'lamp' }],
};

describe('osiřelé odkazy ve zmrazených vadných emisích', () => {
  it('pokrývá celou zmrazenou třídu dangling_reference', () => {
    expect(DANGLING.map((entry) => entry.id).sort()).toEqual(Object.keys(EXPECTED_DANGLING).sort());
  });

  it.each(DANGLING.map((entry) => [entry.id, entry] as const))(
    '%s dá přesně očekávaný nález',
    (id, entry) => {
      expect(findDanglingReferences(entry.body)).toEqual([...EXPECTED_DANGLING[id]]);
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
      rules: [
        {
          id: 'win',
          event: { kind: 'onCounterReaches', ref: 'score', threshold: 3 },
          condition: null,
          actions: [{ kind: 'win' }],
        },
      ],
      witness: { ops: [] },
    },
    look: { modules: { player: { family: 'actor', params: {} } } },
  };

  it('deklarovaný dokument projde', () => {
    expect(findDanglingReferences(world)).toEqual([]);
  });

  it('pravidlo nad nedeklarovaným counterem je osiřelý odkaz', () => {
    const broken = structuredClone(world);
    broken.sim.rules[0].event.ref = 'coins';
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
 * Tvarová vada je jiná třída než osiřelý odkaz. `type_coercion` je ve zmrazené
 * sadě opravitelná, odkaz na nedeklarovaný counter není — takže záměna jednoho
 * za druhé by z jedné opravitelné vady vyrobila hromadu neopravitelných.
 */
describe('deklarace špatného tvaru', () => {
  const shaped = (state: unknown, entities: unknown = { player: { role: 'actor' } }) => ({
    sim: {
      sockets: { s0: [1, 1] },
      entities,
      state,
      rules: [
        {
          id: 'r1',
          event: { kind: 'onCounterReaches', ref: 'score', threshold: 3 },
          condition: { kind: 'flagIs', ref: 'lit', value: true },
          actions: [{ kind: 'setState', target: 'player', value: 'idle' }],
          },
      ],
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

  it('null je tvarová vada, ne prázdný prostor — ani u kontejneru, ani u celého state', () => {
    expect(findDanglingReferences(shaped({ counters: null, flags: { lit: false }, timers: {} }))).toEqual(
      [],
    );
    expect(findDanglingReferences(shaped(null))).toEqual([]);
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
      rules: [
        {
          id: 'r1',
          event: { kind: 'onPickup', slot },
          condition: { kind: 'hasItem', slot, item: 'key' },
          actions: [{ kind: 'giveItem', slot, item: 'key' }],
        },
      ],
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
