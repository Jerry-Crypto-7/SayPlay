/**
 * Log rámců jedné relace — a jediná vlastnost, kterou oko nepokryje: **co se
 * smí sloučit s koncem logu a co ne.**
 *
 * Sloučení je z odpovědi na požadavek neviditelné (server odpoví úplně stejně)
 * a projeví se až tím, že klient o rámec přijde, nebo naopak tím, že log roste
 * bez konce. Obojí se pozná jedině počítáním rámců.
 */

import { describe, expect, it } from 'vitest';

import { COALESCABLE_EVENT_TYPES, createEventLog, MAX_LOG_EVENTS } from '../events';

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

/**
 * **Strop na délku logu** (`T22-previewleak`).
 *
 * Do 4. 9. 2026 strop nebyl a odůvodňovalo ho „desítky rámců, ne
 * desetitisíce". Naměřeno: každé přijaté preview druhé věty je jeden
 * nesloučitelný rámec `patch.preview` a dveře `changes` pouštějí 50 požadavků
 * za 10 vteřin, takže hodina, kterou relaci dává registr, se vejde do řádově
 * 18 000 rámců — krát 64 relací je to únik paměti dosažitelný zvenčí bez účtu.
 */
describe('log má strop a ztráta není tichá', () => {
  it('přes strop se zahazuje od začátku, takže čísla zbylých rámců jsou souvislá', () => {
    const events = log();
    for (let i = 0; i < MAX_LOG_EVENTS + 10; i += 1) events.append('shape.queued', { i }, `tvar-${i}`);

    expect(events.length, 'log roste dál a strop nedělá nic').toBe(MAX_LOG_EVENTS);
    // Čísla musí zůstat souvislá: `reducer.ts` mezeru uprostřed proudu zabíjí,
    // takže zahazovat z prostředka by rozbilo i klienta, který nic nezmeškal.
    const čísla = events.all().map((event) => event.sequence);
    expect(čísla[0]).toBe(11);
    expect(čísla[čísla.length - 1]).toBe(MAX_LOG_EVENTS + 10);
  });

  it('zahozený rámec je v `floor` zapsaný, ne jen chybějící', () => {
    const events = log();
    expect(events.floor, 'prázdný log už něco zahodil').toBe(0);

    for (let i = 0; i < MAX_LOG_EVENTS; i += 1) events.append('shape.queued', { i }, `tvar-${i}`);
    expect(events.floor, 'strop kousl dřív, než měl').toBe(0);

    events.append('shape.queued', { i: 'navíc' }, 'tvar-navíc');
    // Klient s `after < floor` má v proudu díru. Sám ji pozná — `reducer.ts`
    // chybějící číslo hlásí jako vadu a sáhne si pro snapshot — ale modul o ní
    // musí vědět taky, jinak je „zahodilo se" jen dovozené z délky pole.
    expect(events.floor).toBe(1);
    expect(events.since(0)[0].sequence, 'první rámec po zahození je jiný než floor+1').toBe(2);
  });
});
