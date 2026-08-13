/**
 * Dosah patche — **co se doopravdy pohnulo a jak**.
 *
 * Oracle je ručně napsaná dvojice stavů a ručně napsaná očekávaná množina
 * adres. Ne diff proti druhé implementaci diffu: `scope.ts` je jediné místo,
 * kde se dosah počítá, takže porovnávat ho s vlastním klonem by dokazovalo jen
 * to, že se dva opisy shodnou. Zmrazený protokol žádá měření diffem stavu
 * (`editContract.changedLeafRule`) a tenhle soubor měří přesně to.
 *
 * **Odkud tenhle soubor je.** Brána nad T14 (13. 8. 2026) našla, že `canonical`
 * serializuje chybějící klíč i `null` shodně na `"null"`, takže smazání klíče
 * s hodnotou `null` vyšlo jako nulový dosah. Zmrazené create světy nesou
 * 23 takových listů, všechny `/sim/rules/<id>/condition` — zápis mimo
 * `allowedPaths` tou dírou procházel neviděn.
 */

import { describe, expect, it } from 'vitest';

import { canonical } from '../../ir/worlddoc';
import { changedLeafEffects, changedLeaves } from '../scope';

describe('`null` a chybějící klíč jsou dvě různé adresy', () => {
  it('reprodukce nálezu: `canonical` je pro tu dvojici slepá', () => {
    // Tohle NENÍ vada `canonical` — hash obě hodnoty sjednotit smí, popisují
    // týž stav světa. Vada byla stavět na téhle rovnosti dosah, který mluví
    // o adresách. Aserce tu stojí proto, aby se předpoklad testu nerozešel
    // s implementací potichu.
    expect(canonical(null)).toBe(canonical(undefined));
  });

  it('smazání `null` listu je `remove`, ne nulový dosah', () => {
    const before = { rules: { patrol: { id: 'patrol', condition: null } } };
    const after = { rules: { patrol: { id: 'patrol' } } };

    expect(changedLeaves(before, after, '/sim')).toEqual(['/sim/rules/patrol/condition']);
    expect(changedLeafEffects(before, after, '/sim')).toEqual([
      { path: '/sim/rules/patrol/condition', effect: 'remove' },
    ]);
  });

  it('doplnění `null` listu je `add`, ne nulový dosah', () => {
    const before = { rules: { patrol: { id: 'patrol' } } };
    const after = { rules: { patrol: { id: 'patrol', condition: null } } };

    expect(changedLeafEffects(before, after, '/sim')).toEqual([
      { path: '/sim/rules/patrol/condition', effect: 'add' },
    ]);
  });

  it('`null` proti `null` a chybějící proti chybějícímu jsou pořád nula', () => {
    const doc = { rules: { patrol: { condition: null } } };
    expect(changedLeaves(doc, structuredClone(doc), '/sim')).toEqual([]);
    expect(changedLeaves({ a: 1 }, { a: 1 }, '/sim')).toEqual([]);
  });
});

describe('účinek se rozhoduje na adrese rozchodu, ne členstvím v množinách', () => {
  it('`null` nahrazený objektem je `replace` na té adrese, ne `remove`', () => {
    // Naměřeno na zmrazeném `E25`: kontrakt deklaruje `replace` nad
    // `/sim/rules/win/condition`, kde v `C03` leží `null`. Kdyby se účinek
    // odvozoval z toho, že stará listová adresa v nové množině listů chybí
    // (je z ní vnitřní uzel), vyšel by `remove` a legální tah by se ohlásil
    // jako porušení vlastního kontraktu.
    const before = { rules: { win: { condition: null } } };
    const after = { rules: { win: { condition: { kind: 'countInZone', value: 2 } } } };

    // Vykáže se stará adresa (byl to list) i obě nové (jsou z něj listy teď) —
    // a všechny tři jako `replace`. Ta první je ta podstatná: kontrakt `E25`
    // deklaruje dvojici `replace` + `/sim/rules/win/condition` a shoduje se
    // s ní právě na ní.
    const effects = changedLeafEffects(before, after, '/sim');
    expect(effects).toEqual([
      { path: '/sim/rules/win/condition', effect: 'replace' },
      { path: '/sim/rules/win/condition/kind', effect: 'replace' },
      { path: '/sim/rules/win/condition/value', effect: 'replace' },
    ]);
  });

  it('objekt nahrazený skalárem vykáže obě strany, obojí jako `replace`', () => {
    const before = { timers: { flood: { init: 0, durationTicks: 600 } } };
    const after = { timers: { flood: 7 } };

    expect(changedLeafEffects(before, after, '/sim')).toEqual([
      { path: '/sim/timers/flood', effect: 'replace' },
      { path: '/sim/timers/flood/durationTicks', effect: 'replace' },
      { path: '/sim/timers/flood/init', effect: 'replace' },
    ]);
  });

  it('vznik a zánik celého podstromu dědí účinek z kořene rozchodu', () => {
    // `/sim/rules` sám se nevykazuje: obě strany jsou objekt, takže se do něj
    // sestoupí a rozchod nastane až o patro níž, na `tag`. Prázdný kontejner je
    // list jen tam, kde se tvary opravdu rozešly.
    const grown = changedLeafEffects({ rules: {} }, { rules: { tag: { id: 'tag', phase: 1 } } }, '/sim');
    expect(grown).toEqual([
      { path: '/sim/rules/tag/id', effect: 'add' },
      { path: '/sim/rules/tag/phase', effect: 'add' },
    ]);

    const gone = changedLeafEffects({ rules: { tag: { id: 'tag' } } }, { rules: {} }, '/sim');
    expect(gone).toEqual([{ path: '/sim/rules/tag/id', effect: 'remove' }]);
  });
});

describe('dosah se nedá zmenšit přepsáním předka', () => {
  it('`replace` celého timeru ukáže i sourozence, kterého kontrakt nejmenuje', () => {
    const before = { state: { timers: { flood: { durationTicks: 600, init: 0, min: 0, max: 600 } } } };
    const after = { state: { timers: { flood: { durationTicks: 2400, init: 1, min: 0, max: 2400 } } } };

    expect(changedLeaves(before, after, '/sim')).toEqual([
      '/sim/state/timers/flood/durationTicks',
      '/sim/state/timers/flood/init',
      '/sim/state/timers/flood/max',
    ]);
  });

  it('vložení prvku doprostřed pole pohne vším za ním — index je součást adresy', () => {
    expect(changedLeaves({ route: ['a', 'c'] }, { route: ['a', 'b', 'c'] }, '/sim')).toEqual([
      '/sim/route/1',
      '/sim/route/2',
    ]);
  });
});
