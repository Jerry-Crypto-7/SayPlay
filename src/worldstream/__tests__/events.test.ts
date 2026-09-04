/**
 * Log rámců jedné relace — a jediná vlastnost, kterou oko nepokryje: **co se
 * smí sloučit s koncem logu a co ne.**
 *
 * Sloučení je z odpovědi na požadavek neviditelné (server odpoví úplně stejně)
 * a projeví se až tím, že klient o rámec přijde, nebo naopak tím, že log roste
 * bez konce. Obojí se pozná jedině počítáním rámců.
 */

import { describe, expect, it } from 'vitest';

import { COALESCABLE_EVENT_TYPES, createEventLog } from '../events';

const SESSION_ID = 'session-events';

function log() {
  return createEventLog(SESSION_ID);
}

describe('slučování s koncem logu', () => {
  it('opakované odmítnutí téhož subjektu je JEDEN rámec, ne N', () => {
    // **Nález nezávislé revize 4. 9. 2026 (`T22-rejectflood`).** Od
    // `b398521` odmítnuté preview přežije, takže N POSTů na tentýž `changeId`
    // vyrobilo N rámců, přestože se za ně zaplatilo jedno volání modelu — a
    // pole `entries` strop nemá.
    const events = log();
    for (let attempt = 0; attempt < 20; attempt += 1)
      events.append('patch.rejected', { stableId: 'ironMast', attempt }, 'ironMast');

    expect(events.length, 'log roste s počtem pokusů, ne s počtem plateb').toBe(1);
    expect(events.sequence).toBe(1);
    // Sloučený rámec nese **poslední** obsah: novější odmítnutí je to, které
    // platí, a starší už nikoho nezajímá.
    expect(events.all()[0].payload).toMatchObject({ attempt: 19 });
  });

  it('odmítnutí dvou různých objektů se neslévá', () => {
    // Sloučení je vázané na `subject`, jinak by druhá věta nad jiným objektem
    // umlčela odmítnutí nad tím prvním.
    const events = log();
    events.append('patch.rejected', { stableId: 'ironMast' }, 'ironMast');
    events.append('patch.rejected', { stableId: 'saltFlat' }, 'saltFlat');

    expect(events.length).toBe(2);
    expect(events.all().map((event) => event.sequence)).toEqual([1, 2]);
  });

  it('slučuje se jen s KONCEM logu, což je mez téhle opravy', () => {
    // ⚠ Napsané schválně jako tvrzení o tom, co oprava **neumí**: kdo drží dvě
    // preview a odmítnutí střídá, dostane rámec za každý pokus. Tvrdou mez
    // dává strop frekvence na dveřích `commit` (`T28-editrate`), ne tenhle
    // soubor — a kdyby se ta mez někdy měla přesunout sem, tenhle test
    // ukazuje, co by musela zavřít.
    const events = log();
    events.append('patch.rejected', { stableId: 'ironMast' }, 'ironMast');
    events.append('patch.rejected', { stableId: 'saltFlat' }, 'saltFlat');
    events.append('patch.rejected', { stableId: 'ironMast' }, 'ironMast');

    expect(events.length).toBe(3);
  });

  it('stavový přechod se nesloučí ani sám se sebou', () => {
    // `world.ready` dvakrát za sebou znamená dvě relace hotové, ne jednu
    // hlasitější — a §20 tenhle typ jmenuje mezi těmi, které se nesmějí
    // slučovat nikdy.
    const events = log();
    events.append('world.ready', { first: true });
    events.append('world.ready', { first: false });

    expect(events.length).toBe(2);
    expect(COALESCABLE_EVENT_TYPES).not.toContain('world.ready');
  });

  it('sloučený rámec dostane i odběratel, se stejným číslem a novějším obsahem', () => {
    // Přímý důsledek §20: klientský reducer musí být idempotentní na rámec,
    // který už jednou viděl (T17). Kdyby se sloučený rámec neposlal, divák by
    // o změně nevěděl vůbec.
    const events = log();
    const seen: { sequence: number; payload: unknown }[] = [];
    events.subscribe((event) => seen.push({ sequence: event.sequence, payload: event.payload }));

    events.append('patch.rejected', { attempt: 1 }, 'ironMast');
    events.append('patch.rejected', { attempt: 2 }, 'ironMast');

    expect(seen).toEqual([
      { sequence: 1, payload: { attempt: 1 } },
      { sequence: 1, payload: { attempt: 2 } },
    ]);
  });

  it('vrátivší se klient sloučený rámec dostane jednou, ne dvakrát', () => {
    const events = log();
    events.append('world.ready', {});
    events.append('patch.rejected', { attempt: 1 }, 'ironMast');
    events.append('patch.rejected', { attempt: 2 }, 'ironMast');

    expect(events.since(1).map((event) => event.sequence)).toEqual([2]);
    expect(events.since(2)).toEqual([]);
  });
});
