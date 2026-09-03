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

  it('obětuje se ta, která stojí nejdéle, ne ta, do které se právě píše', () => {
    for (let i = 0; i < MAX_LIVE_SESSIONS; i += 1) worldSession(`stará-${i}`, T0 + i);
    const čerstvá = worldSession('čerstvá', T0 + MAX_LIVE_SESSIONS);

    // Do téhle jediné pořád tečou rámce, tak ji strop přeskočí a sáhne po
    // nejstarší stojící.
    for (let i = 1; i <= 20; i += 1) {
      expect(čerstvá.session.queue(`tvar-${i}`, 32), 'rámec nevznikl').toBe(true);
      worldSession(`nová-${i}`, T0 + MAX_LIVE_SESSIONS + i);
    }

    expect(getSession('čerstvá'), 'strop utnul relaci, do které se právě psalo').not.toBeNull();
    expect(getSession('stará-0'), 'nejstarší stojící relace přežila').toBeNull();
    expect(liveSessionCount()).toBeLessThanOrEqual(MAX_LIVE_SESSIONS);
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
