/**
 * **Registr relací pouští to, na co se nikdo nedívá** (P15 T16-evictworld).
 *
 * Strop `MAX_LIVE_SESSIONS` byl do 3. 9. 2026 dekorace: `evict()` uvolňoval jen
 * fáze `complete` a `failed`, jenže úspěšná generace končí ve `world` a
 * `session.complete` neemituje nikdo. Jediná relace, kterou registr uměl
 * uvolnit, byla ta **neúspěšná** — a přesně tu dnešní sada vyrábí, protože bez
 * `.env` selže každá. Vada se tedy zapne až na nasazení, kde relace začnou
 * uspívat, a v zelené sadě není vidět vůbec.
 *
 * Testy proto **vstřikují hodiny**. Odčekat hodinu nejde a `Date.now()` se
 * posunout nedá; kdyby se stárnutí soudilo podle skutečného času, tenhle soubor
 * by tvrdil jen to, že relace za jednu milisekundu nezestárla.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearSessions,
  getSession,
  IDLE_SESSION_MS,
  liveSessionCount,
  MAX_LIVE_SESSIONS,
  openSession,
  putChange,
  SESSION_FAULTS,
  watchedSessionCount,
} from '../sessions';
import type { PendingChange } from '@/model/worldstream-refine';

/** Půlnoc, ať se v aserci pozná hodina od milisekundy. */
const T0 = 1_760_000_000_000;

beforeEach(() => {
  clearSessions();
});

/** Relace dovedená do fáze `world` — tedy tam, kde končí úspěšná generace. */
function worldSession(id: string, at: number) {
  const stored = openSession(id, 1234, at);
  stored.session.advance('intent', {});
  stored.session.advance('blueprint', {});
  stored.session.advance('world', {});
  // Bez registrace by `queue()` mlčky vrátilo `false` a rámec by nevznikl —
  // test „běžící relace" by pak měřil ticho a prošel by ze špatného důvodu.
  stored.session.register(TVARY);
  return stored;
}

const TVARY = Array.from({ length: 48 }, (_, i) => `tvar-${i + 1}`);

describe('relace, které se hodinu nepohnul proud, registr pustí', () => {
  it('úspěšná relace ve fázi `world` se po hodině ticha uvolní', () => {
    worldSession('tichá', T0);
    expect(getSession('tichá')).not.toBeNull();

    // O minutu později se nic neděje: hodina to ještě není.
    openSession('budička-1', 1, T0 + 60_000);
    expect(getSession('tichá'), 'relace odešla po minutě').not.toBeNull();

    // Od téhohle zametení už proud stojí a hodina běží. Padesát devět minut
    // ticha je pořád ticho, které se počítá — ne důvod relaci zavřít. Bez téhle
    // aserce projde i verze, která pustí každou relaci, jejíž proud se mezi
    // dvěma zameteními nepohnul (naměřeno mutací 3. 9. 2026).
    openSession('budička-2', 1, T0 + 60_000 + IDLE_SESSION_MS - 60_000);
    expect(getSession('tichá'), 'relace odešla po 59 minutách ticha').not.toBeNull();

    // Hodina se počítá od chvíle, kdy registr uviděl proud **stát** — tedy od
    // zametení, které přišlo po posledním rámci, ne od založení relace.
    openSession('budička-3', 1, T0 + 60_000 + IDLE_SESSION_MS);
    expect(getSession('tichá'), 'relace ve `world` se po hodině ticha neuvolnila').toBeNull();
  });

  it('relace, které rámce pořád přibývají, se nedotkne ani po dnech', () => {
    const běžící = worldSession('běžící', T0);

    for (let hodina = 1; hodina <= 48; hodina += 1) {
      // Prohlížeč hlásí další tvar — přesně to, kvůli čemu relace ve `world`
      // právem zůstává otevřená.
      expect(běžící.session.queue(`tvar-${hodina}`, 32), 'rámec nevznikl').toBe(true);
      openSession(`budička-${hodina}`, 1, T0 + hodina * IDLE_SESSION_MS);
    }

    expect(getSession('běžící'), 'běžící relaci utnul strop').not.toBeNull();
  });

  it('rámec po 59 minutách hodinu resetuje, neposčítá se', () => {
    const stored = worldSession('pomalá', T0);

    openSession('budička-1', 1, T0 + IDLE_SESSION_MS - 60_000);
    expect(stored.session.queue('tvar-1', 32), 'rámec nevznikl').toBe(true);
    openSession('budička-2', 1, T0 + IDLE_SESSION_MS + 60_000);

    expect(getSession('pomalá'), 'hodina se počítala od začátku, ne od rámce').not.toBeNull();
  });

  it('uvolněná relace vezme své previewy s sebou', () => {
    const stored = worldSession('s-previewy', T0);
    putChange(stored, { changeId: 'zm-1' } as PendingChange);
    putChange(stored, { changeId: 'zm-2' } as PendingChange);
    expect(stored.changes.size).toBe(2);

    openSession('budička-1', 1, T0 + 1);
    openSession('budička-2', 1, T0 + 1 + IDLE_SESSION_MS);

    // Preview visí na `StoredSession`, takže ho registr nemá kde nechat ležet:
    // jediná mapa, která na něj ukazuje, odešla s relací.
    expect(getSession('s-previewy')).toBeNull();
  });
});

describe('strop registru drží i tehdy, když nikdo nedokončí', () => {
  // ⚠ **Milisekundy, ne hodiny, a je to celý smysl tohohle testu.** Nález
  // nezávislé revize 3. 9. 2026: první verze rozestoupila relace po hodině,
  // takže je uvolnilo stárnutí a strop se nikdy nezkoušel. Dvě stě požadavků
  // v jedné hodině je přitom přesně to, co vyrobí den, na který se produkt
  // chystá — a nad nimi držela mapa dvě stě relací proti stropu 64.
  it('dvě stě relací v jedné hodině se do stropu vejde', () => {
    for (let i = 0; i < 200; i += 1) worldSession(`relace-${i}`, T0 + i);

    expect(liveSessionCount()).toBeLessThanOrEqual(MAX_LIVE_SESSIONS);
  });

  // ⚠ **Pohybuje se ta NEJSTARŠÍ, schválně.** Nález nezávislé revize
  // 3. 9. 2026: první verze nechala téct rámce do nejnovější relace, takže
  // aserce držela i nad mutantem, který `watched` ignoruje a maže prostě podle
  // pořadí vzniku — jedna proměnná tam měnila dvě věci naráz a test prošel ze
  // špatného důvodu. Pořadí vzniku je tady proto konstantní a liší se **jen**
  // pohyb proudu, tedy přesně ta vlastnost, o které je řeč.
  it('obětuje se ta, která stojí nejdéle, ne ta, do které se právě píše', () => {
    const nejstarší = worldSession('stará-0', T0);
    for (let i = 1; i < MAX_LIVE_SESSIONS; i += 1) worldSession(`stará-${i}`, T0 + i);

    for (let i = 1; i <= 20; i += 1) {
      expect(nejstarší.session.queue(`tvar-${i}`, 32), 'rámec nevznikl').toBe(true);
      worldSession(`nová-${i}`, T0 + MAX_LIVE_SESSIONS + i);
    }

    expect(getSession('stará-0'), 'strop utnul relaci, do které se právě psalo').not.toBeNull();
    expect(getSession('stará-1'), 'nejdéle stojící relace přežila').toBeNull();
    expect(liveSessionCount()).toBeLessThanOrEqual(MAX_LIVE_SESSIONS);
  });

  // Nález nezávislé revize 3. 9. 2026, `VERDICT: blocking`: smazání ze dvou map
  // paměť neuvolní, dokud si otevřený SSE proud drží odběr a časovač. Odběratel
  // se o konci dozví jedině z koncového rámce, tak ho registr musí vydat.
  it('uvolněná relace vydá koncový rámec, aby se její proud dozvěděl, že skončil', () => {
    const stored = worldSession('sledovaná', T0);

    const viděno: string[] = [];
    let odhlášen = false;
    const unsubscribe = stored.session.events.subscribe((event) => {
      viděno.push(event.type);
      // Tohle je přesně to, co dělá route: koncová fáze → `finish()`, tedy
      // `clearInterval` a odhlášení.
      if (stored.session.phase === 'failed' || stored.session.phase === 'complete') {
        unsubscribe();
        odhlášen = true;
      }
    });

    // ⚠ **Tlačící relace mají diváka taky, a je to nutné.** Od 4. 9. 2026 je
    // otevřený proud známkou života, takže první kolo sledovanou relaci
    // přeskočí a v pořadí třetího kola ji posune dozadu. Kdyby diváka měla
    // jediná, byla by to poslední oběť a test by měřil ticho. Takhle je
    // `since` u všech stejné, pořadí rozhodne vznik — a sledovaná je nejstarší.
    for (let i = 0; i < MAX_LIVE_SESSIONS + 2; i += 1) {
      worldSession(`tlačí-${i}`, T0 + 1 + i).session.events.subscribe(() => {});
    }

    expect(getSession('sledovaná'), 'relace se vůbec neuvolnila').toBeNull();
    expect(viděno, 'proud nedostal koncový rámec, takže se nikdy neuklidí').toContain(
      'session.failed',
    );
    expect(odhlášen).toBe(true);
    expect(stored.fault, 'klient se nedozví důvod').toBe(SESSION_FAULTS.SESSION_RELEASED);
  });

  it('mapa, kterou si registr vede na stárnutí, neroste vedle té hlavní', () => {
    for (let i = 0; i < 200; i += 1) worldSession(`relace-${i}`, T0 + i * IDLE_SESSION_MS);

    // Druhá mapa je druhé místo pro tentýž únik. Uvolněná relace z ní musí
    // zmizet taky, jinak se `T16-evictworld` jen přestěhoval o patro níž.
    expect(watchedSessionCount()).toBe(liveSessionCount());
  });

  it('neúspěšná relace se pořád uvolňuje stropem, ne až časem', () => {
    for (let i = 0; i < MAX_LIVE_SESSIONS + 5; i += 1) {
      const stored = openSession(`padlá-${i}`, 1, T0);
      stored.session.fail('the model could not be reached');
    }

    expect(liveSessionCount()).toBeLessThanOrEqual(MAX_LIVE_SESSIONS);
  });
});

/**
 * **Otevřený proud je první signál života, `sequence` až druhý** — nález
 * nezávislé revize 4. 9. 2026, `VERDICT: blocking`.
 *
 * Stárnutí se do téhle revize soudilo výhradně podle `sequence`, jenže tím
 * v provozu po `world.ready` nehne nic: meshuje prohlížeč, žádná route mu
 * rámec nevrací a tep SSE se píše rovnou do proudu, ne do logu. Číslo tedy
 * zamrzne pár vteřin po založení **každé** relaci a hodina se počítá odtamtud.
 * Sada to neviděla, protože všechny tři testy nahoře hýbou proudem přes
 * `session.queue()`, což je API, na které se žádnými dveřmi nedá dosáhnout.
 * Tenhle blok proto `queue()` **nevolá vůbec** a měří jen odběr logu — přesně
 * to, co drží `sessions/[sessionId]/events/route.ts`, dokud klient neodejde.
 */
describe('relace, na kterou se někdo dívá, nezestárne', () => {
  it('otevřený proud drží relaci naživu i tři hodiny bez jediného rámce', () => {
    const stored = worldSession('sledovaná', T0);
    // Přesně to, co dělá route: odběr logu, který žije, dokud žije spojení.
    stored.session.events.subscribe(() => {});

    openSession('budička-1', 1, T0 + 1);
    openSession('budička-2', 1, T0 + IDLE_SESSION_MS + 1);
    openSession('budička-3', 1, T0 + 3 * IDLE_SESSION_MS);

    expect(getSession('sledovaná'), 'relaci s otevřeným proudem utnulo stárnutí').not.toBeNull();
    expect(stored.fault, 'divákovi se relace zavřela pod rukama').toBeNull();
  });

  it('jakmile divák odejde, hodina začne běžet a relace se uvolní', () => {
    const stored = worldSession('opuštěná', T0);
    const unsubscribe = stored.session.events.subscribe(() => {});

    openSession('budička-1', 1, T0 + 1);
    // Klient zavřel kartu: route se uklidila a odběr pustila.
    unsubscribe();

    openSession('budička-2', 1, T0 + 2);
    expect(getSession('opuštěná'), 'relace odešla dřív, než uplynula hodina').not.toBeNull();

    openSession('budička-3', 1, T0 + 2 + IDLE_SESSION_MS);
    expect(getSession('opuštěná'), 'relace bez diváka nezestárla vůbec').toBeNull();
  });

  it('sledováním se strop obejít nedá — třetí kolo pustí i relace s divákem', () => {
    for (let i = 0; i < 200; i += 1) {
      const stored = worldSession(`sledovaná-${i}`, T0 + i);
      stored.session.events.subscribe(() => {});
    }

    // Kdyby divák relaci vyjímal ze všech tří kol, byl by to nový, pohodlnější
    // způsob, jak registr přeplnit: `/events` nemá admission ani strop
    // (`T16-streamadmit`), takže proudů může viset libovolně mnoho.
    expect(liveSessionCount()).toBeLessThanOrEqual(MAX_LIVE_SESSIONS);
    expect(watchedSessionCount()).toBe(liveSessionCount());
  });
});
