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
  MAX_SESSIONS_PER_CALLER,
  openSession,
  QUOTA_ENGAGES_AT,
  putChange,
  SESSION_FAULTS,
  watchedSessionCount,
} from '../sessions';
import type { PendingChange } from '@/model/worldstream-refine';
import { UNIDENTIFIED_CALLER } from '@/server/rate-limit';

/** Půlnoc, ať se v aserci pozná hodina od milisekundy. */
const T0 = 1_760_000_000_000;

beforeEach(() => {
  clearSessions();
});

/**
 * Relace dovedená do fáze `world` — tedy tam, kde končí úspěšná generace.
 *
 * `!` je tu bezpečné a je to tvrzení, ne pohodlí: bez čtvrtého argumentu je
 * vlastníkem `sessionId`, takže každá tahle relace stojí ve vlastním kbelíku
 * a kvóta volajícího na ni nemá jak dosáhnout. Kvótu zkouší až vlastní
 * `describe` dole, a ten má vlastní helper.
 */
function worldSession(id: string, at: number) {
  const stored = openSession(id, 1234, at)!;
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

    expect(getSession('s-previewy')).toBeNull();
    // ⚠ **„Visí na `StoredSession`" nestačí** (`T22-previewleak`). Route druhé
    // věty si ten objekt drží přes celé volání modelu, takže dokud se mapa
    // nevyprázdní doopravdy, osm plánů včetně `ShapeProgram` uvolnění přežije.
    expect(stored.changes.size, 'previewy zůstaly viset na objektu, který drží route').toBe(0);
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
      const stored = openSession(`padlá-${i}`, 1, T0)!;
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

  /**
   * ⚠ **Předchozí verze tohohle testu procházela z jiného důvodu, než tvrdil
   * její titulek** — nález nezávislé revize 4. 9. 2026, `VERDICT: blocking`.
   * Zametení s divákem a `unsubscribe()` v ní ležely na téže milisekundě,
   * takže „hodina od odchodu" a „hodina od posledního cizího POSTu" nešly
   * rozlišit. Odchod je proto od zametení **hodinu daleko**: jedině tak se
   * pozná, od čeho se ta hodina počítá.
   */
  it('hodina běží od odchodu diváka, ne od posledního cizího POSTu', () => {
    const stored = worldSession('opuštěná', T0);
    const unsubscribe = stored.session.events.subscribe(() => {});

    // Jediné zametení, které tuhle relaci vidí s divákem. Pak se hodinu neděje
    // nic — přesně jako když jeden porotce drží jednu kartu.
    openSession('budička-1', 1, T0 + 1);

    // Spojení spadlo o hodinu později: proxy, uspaný notebook, reload. SSE padá
    // běžně, proto existuje tep.
    unsubscribe();

    openSession('budička-2', 1, T0 + IDLE_SESSION_MS + 1000);
    expect(
      getSession('opuštěná'),
      'relace odešla vteřinu po odchodu diváka, protože hodina běžela od cizího POSTu',
    ).not.toBeNull();

    openSession('budička-3', 1, T0 + 2 * IDLE_SESSION_MS + 2000);
    expect(getSession('opuštěná'), 'relace bez diváka nezestárla vůbec').toBeNull();
  });

  /**
   * **Strop je zvenčí ovladatelná páka** (`T16-evictkill`). `POST` na založení
   * relace nemá účet a `acquireSlot()` omezuje jen **souběžné** generace, takže
   * sekvenční požadavky zakládají relace bez omezení. Do 4. 9. 2026 tím šlo
   * porotci zavřít svět, na který se právě dívá.
   */
  it('nápor nesledovaných požadavků nezavře cizí relaci s divákem', () => {
    const oběť = worldSession('sledovaná', T0);
    oběť.session.events.subscribe(() => {});

    for (let i = 0; i < MAX_LIVE_SESSIONS + 5; i += 1) openSession(`útok-${i}`, 1, T0 + 1 + i);

    expect(getSession('sledovaná'), 'strop zavřel relaci, na kterou se někdo díval').not.toBeNull();
    expect(oběť.fault, 'divákovi se relace zavřela pod rukama').toBeNull();
    expect(liveSessionCount()).toBeLessThanOrEqual(MAX_LIVE_SESSIONS);
  });

  /**
   * **Nová relace vždycky projde** — doktrína registru, a od 4. 9. 2026 je to
   * jediné místo, kde se dá porušit. Divák si proud otevírá až po odpovědi na
   * POST, takže v okamžiku vlastního zametení je nová relace jediná
   * nesledovaná v registru; kolo, které obětuje nesledované, by ji tedy
   * v registru samých sledovaných relací vybralo pokaždé.
   */
  it('v registru samých sledovaných relací projde nová relace, ne naopak', () => {
    for (let i = 0; i < MAX_LIVE_SESSIONS; i += 1) {
      const stored = worldSession(`sledovaná-${i}`, T0 + i);
      stored.session.events.subscribe(() => {});
    }

    // Přesně to, co dělá route: relace vznikne a proud se k ní připojí až potom.
    const nová = openSession('nová', 1, T0 + MAX_LIVE_SESSIONS)!;

    expect(getSession('nová'), 'nová relace padla za oběť vlastnímu zametení').not.toBeNull();
    expect(nová.fault, 'volající dostal 202 na relaci, která už neexistuje').toBeNull();
    expect(liveSessionCount()).toBeLessThanOrEqual(MAX_LIVE_SESSIONS);
  });

  /**
   * **Mezi samými sledovanými relacemi rozhoduje pohyb proudu, ne pořadí
   * vzniku** (`T16-agesignal`). Řadicí klíč třetího kola byl do 4. 9. 2026
   * `since`, jenže ten se sledované relaci obnovuje při každém zametení —
   * všechny klíče proto byly stejné, stabilní řazení spadlo na pořadí vložení
   * a obětí byla vždycky relace #0.
   */
  it('mezi sledovanými padne ta, jejíž proud stojí nejdéle, ne ta nejstarší', () => {
    for (let i = 0; i < MAX_LIVE_SESSIONS; i += 1) {
      const stored = worldSession(`sledovaná-${i}`, T0 + i);
      stored.session.events.subscribe(() => {});
    }

    // Nejstarší relaci se hnul proud: prohlížeč ohlásil hotový tvar (T18).
    const nejstarší = getSession('sledovaná-0');
    expect(nejstarší?.session.queue('tvar-1', 32), 'rámec nevznikl').toBe(true);

    openSession('přetečení', 1, T0 + MAX_LIVE_SESSIONS + 100);

    expect(
      getSession('sledovaná-0'),
      'obětí byla relace #0, vybraná podle vzniku místo podle pohybu proudu',
    ).not.toBeNull();
    expect(getSession('sledovaná-1'), 'padla jiná než ta, jejíž proud stojí nejdéle').toBeNull();
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

/**
 * Kvóta na klíč volajícího (`T16-evictworld`, pátá a šestá nezávislá revize
 * 4. 9. 2026, obě `VERDICT: blocking`).
 *
 * **Pátá** našla, proč kvóta musí existovat: rozdělení „nejdřív nesledované"
 * se obejde tím, že si útočník své relace sám sleduje, a pak se řadí podle
 * `moved`, kde nejstarší je relace porotce (1 sledovaná oběť + 64 útočníkových
 * → padla **jen** ta oběť).
 *
 * **Šestá** našla, proč kvóta musí odmítat místo uklízet: kbelík si vybírá
 * volající. S úklidem stačilo napsat `x-forwarded-for: <IP oběti>` na osm
 * vlastních POSTů a devátý zavřel svět oběti — osm požadavků místo 65
 * požadavků a 65 proudů. Obě sondy téhle revize jsou dole jako testy.
 */
describe('kvóta volajícího odmítá nováčka, ne cizí relaci', () => {
  /** Relace ve fázi `world` s určeným vlastníkem, nebo `null`, když ji kvóta odmítla. */
  function ownedWorld(id: string, at: number, owner: string) {
    const stored = openSession(id, 1234, at, owner);
    if (stored === null) return null;
    stored.session.advance('intent', {});
    stored.session.advance('blueprint', {});
    stored.session.advance('world', {});
    stored.session.register(TVARY);
    return stored;
  }

  /** Totéž, ale test tvrdí, že projít **musí** — a řekne to, když neprojde. */
  function admitted(id: string, at: number, owner: string) {
    const stored = ownedWorld(id, at, owner);
    expect(stored, `relaci ${id} odmítla kvóta, ačkoli se vejít měla`).not.toBeNull();
    return stored!;
  }

  /**
   * Zaplní registr na práh, od kterého kvóta vůbec odmítá.
   *
   * Klíče jsou cizí a po jedné relaci, takže do žádného zkoušeného kbelíku
   * nemluví. **Sledované schválně:** nesledované by zametení uvolnilo a
   * obsazenost by spadla pod práh uprostřed testu, takže by pak zelená
   * neznamenala nic.
   */
  function naPráh(): void {
    for (let i = 0; i < QUOTA_ENGAGES_AT; i += 1) {
      const stored = admitted(`dav-${i}`, T0 - QUOTA_ENGAGES_AT + i, `dav-klíč-${i}`);
      stored.session.events.subscribe(() => {});
    }
    expect(liveSessionCount()).toBe(QUOTA_ENGAGES_AT);
  }

  /**
   * ⚠ **Nález sedmé nezávislé revize, `VERDICT: blocking`, změřený.** Kvóta
   * bez prahu odmítala i na prázdné instanci, a klíč je odchozí adresa — devět
   * porotců za jednou firemní NATkou je **jeden** klíč. Devátý dostával 429 ve
   * chvíli, kdy bylo volných 56 slotů z 64, a vyčistit si to neuměl (koncový
   * bod „zavři mi relaci" neexistuje).
   */
  it('na klidné instanci drží jeden sdílený klíč víc, než je kvóta', () => {
    for (let i = 0; i < MAX_SESSIONS_PER_CALLER + 4; i += 1) {
      admitted(`porotce-${i}`, T0 + i, 'ip:sdílená-natka');
    }

    expect(
      liveSessionCount(),
      'kvóta odmítla na instanci, kde o slot nikdo nesoupeřil',
    ).toBe(MAX_SESSIONS_PER_CALLER + 4);
  });

  /**
   * ⚠ **Nález osmé nezávislé revize, `VERDICT: blocking`.** Hodnotu prahu
   * nedržel žádný test: mutace `QUOTA_ENGAGES_AT = MAX_LIVE_SESSIONS` nechala
   * **74 ze 74 zelených**, protože všechny ostatní testy plní registr „na
   * práh" symbolicky – přes tu konstantu – a změnu jejího čísla proto
   * uvidět nemůžou. S tím mutantem přitom jeden klíč drží všech 64 slotů,
   * tedy přesně to, o čem `sessions.ts` píše „to je jediná vlastnost, na
   * které stojí ochrana proti páce".
   *
   * Tvrzení jsou proto **dvě a schválně obě**. Mez se **nesmí** odvozovat
   * z `QUOTA_ENGAGES_AT` – s mutantem by se posunula spolu s ním a test by
   * zase neměřil nic.
   */
  it('jeden klíč se ani na prázdném registru nedostane přes polovinu', () => {
    let přijato = 0;
    for (let i = 0; i < MAX_LIVE_SESSIONS + MAX_SESSIONS_PER_CALLER; i += 1) {
      const stored = ownedWorld(`sám-${i}`, T0 + i, `ip:jediný-klíč`);
      if (stored === null) break;
      stored.session.events.subscribe(() => {});
      přijato += 1;
    }

    expect(
      přijato,
      'jeden klíč naplnil registr — může ho použít jako páku i bez podvrhu',
    ).toBeLessThan(MAX_LIVE_SESSIONS);
    expect(přijato, 'práh se pohnul; zapiš proč se pohnul, nepřepisuj to číslo').toBe(32);
  });

  /**
   * ⚠ **Tenhle test tvrdí ZBYTEK kladně, ne ochranu.** Osmá nezávislá revize
   * naměřila, že pravidlo „největší kbelík" zůstalo zaměřovač: útočník vloží
   * do kbelíku oběti **jednu** relaci s její IP, tím je ten kbelík největší,
   * a protože jsou obě jeho relace sledované, přetečení sáhne po nejstarší –
   * po oběti. Cena je naplnění registru, ne ta jedna relace.
   *
   * **Zelená tady znamená „páka je pořád otevřená" (`T16-evictkill`).** Až ji
   * zavře klíč z důvěryhodného konce řetězu (`T16-trustedkey`), tenhle test
   * zčervená – a to je jeho účel: doktrína u `QUOTA_ENGAGES_AT` se pak musí
   * přepsat vědomě, ne se tiše rozejít s kódem.
   */
  it('nad plným registrem jedna podvržená relace zavře oběti svět', () => {
    for (let i = 0; i < MAX_LIVE_SESSIONS - 2; i += 1) {
      admitted(`dav-${i}`, T0 + i, `ip:dav-${i}`).session.events.subscribe(() => {});
    }

    const oběť = admitted('oběť', T0 + MAX_LIVE_SESSIONS, 'ip:oběť');
    oběť.session.events.subscribe(() => {});
    // Jediná podvržená relace navíc: kbelík oběti má dva členy proti jednomu
    // u všech ostatních, takže je největší.
    admitted('podvrh', T0 + MAX_LIVE_SESSIONS + 1, 'ip:oběť').session.events.subscribe(() => {});
    expect(liveSessionCount()).toBe(MAX_LIVE_SESSIONS);

    admitted('spouštěč', T0 + MAX_LIVE_SESSIONS + 2, 'ip:kdokoli');

    expect(
      getSession('oběť'),
      'páka je zavřená — přepiš doktrínu u QUOTA_ENGAGES_AT, tenhle zbytek už neplatí',
    ).toBeNull();
    expect(getSession('podvrh'), 'padla útočníkova relace, ne oběť').not.toBeNull();
  });

  /**
   * ⚠ **Druhý test, který tvrdí ZBYTEK kladně** (`T16-idleforever`, sedmá
   * nezávislá revize 4. 9. 2026). Doktrína u `MAX_SESSIONS_PER_CALLER` říká,
   * že podvržený klíč umí oběti zablokovat zakládání světů. Není tam, jak
   * dlouho — a odpověď je **po celou životnost procesu**, ne hodinu:
   * `idleFor()` obnovuje `since` při každém zametení, dokud `watchers > 0`,
   * a dveře `GET /events` žádné ověření nemají.
   *
   * **Úspěšná relace je tu schválně, a je to opravený tvar útoku.** První
   * verze tohohle testu držela proud nad relací `failed`, což provozem
   * neprošlo: `events/route.ts` zavírá proud sám na koncovém rámci
   * (`session.failed`), takže `watchers` spadne na nulu a relace zestárne
   * normálně. Nezavře se naopak relace ve fázi `world`: `advance('complete')`
   * nemá v provozu jediného volajícího (ověřeno greppem 4. 9. 2026), takže
   * **úspěšná generace končí ve `world` a její proud zůstává otevřený.**
   * Tam útok drží.
   *
   * **Zelená tady znamená „páka je pořád otevřená“.** Zavře ji klíč
   * z důvěryhodného konce řetězu (`T16-trustedkey`), ne stárnutí — stárnout
   * podle fáze sem nemá kdo dopsat, protože fáze, na které to drží, je
   * `world`, a tu chrání vlastní pinnutá vlastnost („otevřený proud drží
   * relaci naživu i tři hodiny"). Až se páka zavře, tenhle test zčervená
   * a doktrínu je pak nutné přepsat vědomě.
   */
  it('osm podvržených relací s drženým proudem drží oběti kbelík plný i po třiceti dnech', () => {
    const TŘICET_DNÍ = 30 * 24 * 60 * 60 * 1000;
    // **Práh je část útoku, ne kulisa** — nezávislá revize 4. 9. 2026. Pod
    // `QUOTA_ENGAGES_AT` kvóta neodmítá vůbec, takže osm podvržených POSTů
    // samo o sobě neblokuje nikoho; útočník musí registr na prahu i držet.
    naPráh();
    for (let i = 0; i < MAX_SESSIONS_PER_CALLER; i += 1) {
      // Útočník píše IP oběti a na každou svou relaci otevře proud — dveře
      // `GET /events` žádné ověření nemají a `sessionId` mu přišlo v 202.
      admitted(`podvrh-${String(i)}`, T0 + i, 'ip:oběť').session.events.subscribe(() => {});
    }

    // Oběť se po třiceti dnech pokusí založit svůj první svět. `putSession()`
    // předtím zamete stárnutí, takže tohle je zároveň to zametení.
    const nový = ownedWorld('oběť-nový', T0 + TŘICET_DNÍ, 'ip:oběť');

    expect(
      nový,
      'páka je zavřená — přepiš doktrínu u MAX_SESSIONS_PER_CALLER, tenhle zbytek už neplatí',
    ).toBeNull();
    expect(getSession('podvrh-0'), 'sledovaná relace přece zestárla').not.toBeNull();
  });

  it('devátá relace jednoho klíče se nad prahem odmítne a osm předchozích zůstane', () => {
    naPráh();
    for (let i = 0; i < MAX_SESSIONS_PER_CALLER; i += 1) {
      admitted(`moje-${i}`, T0 + i, 'volající-A');
    }
    expect(liveSessionCount()).toBe(QUOTA_ENGAGES_AT + MAX_SESSIONS_PER_CALLER);

    const devátá = ownedWorld('devátá', T0 + MAX_SESSIONS_PER_CALLER, 'volající-A');

    expect(devátá, 'kvóta nedrží — devátá relace prošla').toBeNull();
    expect(getSession('devátá'), 'odmítnutá relace zůstala v registru').toBeNull();
    expect(getSession('moje-0'), 'kvóta zaplatila relací místo odmítnutím').not.toBeNull();
    expect(liveSessionCount()).toBe(QUOTA_ENGAGES_AT + MAX_SESSIONS_PER_CALLER);
  });

  /**
   * ⚠ **Stárnutí se zametá dřív, než se kbelík spočítá.** Bez toho pořadí by
   * volajícího zamklo osm jeho **vlastních** hodinu stojících relací: kbelík by
   * se počítal nad relacemi, které tentýž průchod zrovna pouští, a devátá by
   * dostala 429, přestože po ní v registru nezůstane nic.
   */
  it('vlastní hodinu stojící relace volajícího na devátou nezamknou', () => {
    // Práh drží sledovaný dav, takže kvóta zůstane zapnutá i po zametení —
    // jinak by devátá prošla proto, že obsazenost spadla, ne proto, že se
    // kbelík uvolnil, a test by měřil něco jiného, než tvrdí.
    naPráh();
    for (let i = 0; i < MAX_SESSIONS_PER_CALLER; i += 1) {
      admitted(`moje-${i}`, T0 + i, 'volající-A');
    }
    // Jedno cizí zametení, aby registr uviděl všech osm proudů **stát**.
    admitted('budička', T0 + MAX_SESSIONS_PER_CALLER, 'jiný-klíč');

    const devátá = ownedWorld(
      'devátá',
      T0 + MAX_SESSIONS_PER_CALLER + IDLE_SESSION_MS + 1,
      'volající-A',
    );

    expect(devátá, 'kvóta se počítala nad relacemi, které zametení zrovna pouští').not.toBeNull();
    expect(getSession('moje-0'), 'hodinu stojící relace se neuvolnila').toBeNull();
    expect(liveSessionCount(), 'kvóta se zapnula, ale osm vlastních se neuvolnilo').toBe(
      QUOTA_ENGAGES_AT + 2,
    );
  });

  it('devátá relace jednoho klíče nesáhne na relaci cizího klíče', () => {
    naPráh();
    const cizí = admitted('cizí', T0, 'volající-B');
    cizí.session.events.subscribe(() => {});

    for (let i = 0; i < MAX_SESSIONS_PER_CALLER + 1; i += 1) {
      ownedWorld(`moje-${i}`, T0 + 1 + i, 'volající-A');
    }

    expect(getSession('cizí'), 'kvóta cizího klíče zaplatila cizí relací').not.toBeNull();
    expect(cizí.fault, 'divákovi se relace zavřela pod rukama').toBeNull();
  });

  /**
   * ⚠ **Tohle je první sonda šesté nezávislé revize a je to důvod, proč kvóta
   * odmítá místo aby uklízela** (`VERDICT: blocking`, naměřeno přes skutečnou
   * route: 8 POSTů → oběť `RELEASED`, `live = 8`).
   *
   * Klíč se bere z `x-forwarded-for`, tedy z hodnoty, kterou píše volající.
   * Útočník proto napsal IP oběti, tím své relace vložil do **jejího** kbelíku,
   * a devátá uvolnila nejstaršího člena toho kbelíku — oběť. Kbelík byl
   * zaměřovač, ne ochrana.
   */
  /**
   * ⚠ **Název je schválně užší, než by se chtělo psát** – stejně jako u
   * route dvojčete. Obecné „podvržená hlavička cizí svět nezavře" **neplatí**;
   * vyvrací ho test `nad plným registrem jedna podvržená relace zavře oběti
   * svět` o pár desítek řádků výš. Zavřený je jen tenhle levný případ.
   */
  it('osm POSTů do kbelíku oběti jí zaplní kvótu, svět nezavře', () => {
    naPráh();
    const oběť = admitted('porotce', T0, 'ip:203.0.113.7');
    oběť.session.events.subscribe(() => {});

    // Útočník píše týž klíč na svých osm POSTů. Žádný proud není potřeba.
    for (let i = 0; i < MAX_SESSIONS_PER_CALLER; i += 1) {
      ownedWorld(`podvrh-${i}`, T0 + 1 + i, 'ip:203.0.113.7');
    }

    expect(getSession('porotce'), 'osm podvržených POSTů zavřelo oběti svět').not.toBeNull();
    expect(oběť.fault, 'oběti se svět zavřel pod rukama').toBeNull();
    expect(liveSessionCount()).toBe(QUOTA_ENGAGES_AT + MAX_SESSIONS_PER_CALLER);

    // ⚠ **A tohle je zbytek, který ta oprava NEZAVÍRÁ, tak ať je změřený.**
    // Útočník oběti pořád umí zaplnit kbelík, takže si nezaloží **nový** svět.
    // Zavře to až klíč z důvěryhodného konce řetězu — samostatná úloha nad
    // `callerKey()`. Kdyby se tahle aserce jednou rozsvítila zeleně z opačného
    // důvodu, znamená to, že se ochrana zesílila: pak se přepíše doktrína
    // u `MAX_SESSIONS_PER_CALLER`, ne tenhle řádek.
    expect(
      ownedWorld('nový-svět-oběti', T0 + 100, 'ip:203.0.113.7'),
      'ochrana zesílila nad to, co je o ní napsané — přepiš doktrínu u MAX_SESSIONS_PER_CALLER',
    ).toBeNull();
  });

  /**
   * ⚠ **Druhá sonda šesté revize** (`VERDICT: blocking`, naměřeno: 12
   * návštěvníků přes skutečnou route → `live = 8` a svět prvního se uvolnil).
   *
   * Bez proxy hlaviček vrací `callerKey()` sentinel **všem**, takže sdílený
   * kbelík by z kvóty udělal strop 8 na celou instanci — osmkrát přísnější než
   * strop registru, který má chránit. Týká se to každého běhu bez proxy
   * (`next start`, demo z notebooku) i sdílené odchozí IP na Vercelu, tedy
   * devíti porotců za jednou firemní NATkou.
   */
  it('nerozeznaný volající dostane vlastní kbelík, ne společný strop 8', () => {
    naPráh();
    for (let i = 0; i < 12; i += 1) {
      admitted(`návštěvník-${i}`, T0 + i, UNIDENTIFIED_CALLER);
    }

    expect(liveSessionCount(), 'strop instance klesl ze 64 na kvótu jednoho kbelíku').toBe(
      QUOTA_ENGAGES_AT + 12,
    );
    expect(getSession('návštěvník-0'), 'svět prvního návštěvníka se zavřel pod ním').not.toBeNull();
  });

  /**
   * ⚠ **Tenhle test pinuje, co kvóta u nerozeznaného volajícího NEDĚLÁ** —
   * nález sedmé nezávislé revize, `VERDICT: blocking`. Kbelík na `sessionId`
   * je jeden kbelík na **relaci**, takže na nasazení bez proxy hlaviček
   * (`next start`, demo z notebooku) je `MAX_SESSIONS_PER_CALLER` vypnutá
   * a jediná mez je strop registru. Kdyby tenhle test jednou zčervenal proto,
   * že se čísla srovnala na kvótu, ochrana se zesílila — pak se přepíše
   * doktrína u `openSession()`, ne tenhle řádek.
   */
  it('bez proxy hlaviček kvóta neomezuje nic — mez dává jedině strop registru', () => {
    for (let i = 0; i < MAX_LIVE_SESSIONS + 4; i += 1) {
      ownedWorld(`anonym-${i}`, T0 + i, UNIDENTIFIED_CALLER);
    }

    expect(
      liveSessionCount(),
      'kvóta u nerozeznaného volajícího najednou drží — přepiš doktrínu u openSession()',
    ).toBe(MAX_LIVE_SESSIONS);
  });
});

/**
 * Strop **registru** pořád uklízí, ne odmítá — a s kvótou ho přeplní teprve
 * několik klíčů dohromady (`T16-evictworld`, páté a šesté kolo revize).
 */
describe('strop registru není páka na cizí relace', () => {
  function ownedWorld(id: string, at: number, owner: string) {
    const stored = openSession(id, 1234, at, owner);
    if (stored === null) return null;
    stored.session.advance('intent', {});
    stored.session.advance('blueprint', {});
    stored.session.advance('world', {});
    stored.session.register(TVARY);
    return stored;
  }

  /** Osm klíčů po osmi relacích = plný registr. Vrací id, které zbylo nesledované. */
  function plnýRegistr(nesledovaná: number): void {
    let pořadí = 0;
    for (let klíč = 0; klíč < MAX_LIVE_SESSIONS / MAX_SESSIONS_PER_CALLER; klíč += 1) {
      for (let i = 0; i < MAX_SESSIONS_PER_CALLER; i += 1) {
        const stored = ownedWorld(`plný-${klíč}-${i}`, T0 + 1 + pořadí, `klíč-${klíč}`);
        expect(stored, `relace plný-${klíč}-${i} se do registru nevešla`).not.toBeNull();
        if (pořadí !== nesledovaná) stored!.session.events.subscribe(() => {});
        pořadí += 1;
      }
    }
  }

  /**
   * **Uvnitř kbelíku je nesledovaná relace levnější ztráta**, i když stojí
   * kratší dobu než sledované. Bez kvóty šlo tohle kolo obejít tím, že si
   * útočník své relace sám sleduje (pátá revize); dnes ho přes kbelík pustí
   * teprve několik klíčů, ale pořadí uvnitř zůstává stejné.
   */
  it('uvnitř největšího kbelíku padne nejdřív ta, na kterou se nikdo nedívá', () => {
    // Nesledovaná je až padesátá, tedy zdaleka ne nejdéle stojící.
    plnýRegistr(50);
    expect(liveSessionCount()).toBe(MAX_LIVE_SESSIONS);

    // Devátý klíč přetečení způsobí, ale sám platit nemá — je to `keep`.
    ownedWorld('přetečení', T0 + 1000, 'klíč-nový');

    expect(getSession('plný-6-2'), 'obětí nebyla nesledovaná relace').toBeNull();
    expect(getSession('plný-0-0'), 'padla sledovaná dřív než nesledovaná').not.toBeNull();
    expect(getSession('přetečení'), 'nová relace padla za oběť vlastnímu zametení').not.toBeNull();
    expect(liveSessionCount()).toBe(MAX_LIVE_SESSIONS);
  });

  /**
   * **Kbelíky nestejné velikosti: platí ten větší.** Tohle je jediná cesta,
   * kterou třetí kolo `evict()` vůbec rozhoduje — jeden klíč se přes kvótu
   * nedostane, takže registr přeplní teprve několik klíčů dohromady.
   */
  it('nad stropem registru platí klíč, který drží nejvíc relací', () => {
    const oběť = ownedWorld('porotce', T0, 'volající-porotce');
    expect(oběť).not.toBeNull();
    oběť!.session.events.subscribe(() => {});

    plnýRegistr(-1);

    expect(getSession('porotce'), 'platil kbelík o jedné relaci místo toho o osmi').not.toBeNull();
    expect(oběť!.fault).toBeNull();
    expect(liveSessionCount()).toBeLessThanOrEqual(MAX_LIVE_SESSIONS);
  });

  /**
   * ⚠ **Tenhle test pinuje mez té ochrany, ne její sílu — a je to schválně.**
   * Klíč volajícího se bere z `x-forwarded-for` a jde podvrhnout. Kdo si
   * vymyslí hlavičku na každou relaci, srovná kbelíky na jedničku a vybírá se
   * zase přes celý registr. Kdyby se tenhle test jednou rozsvítil zeleně
   * z opačného důvodu, znamená to, že se ochrana zesílila — pak se přepíše
   * i doktrína u `MAX_SESSIONS_PER_CALLER`, ne jen tohle číslo.
   */
  it('podvržená hlavička na každou relaci kvótu obejde — mez je změřená, ne tvrzená', () => {
    const oběť = ownedWorld('porotce', T0, 'volající-porotce');
    expect(oběť).not.toBeNull();
    oběť!.session.events.subscribe(() => {});

    for (let i = 0; i < MAX_LIVE_SESSIONS; i += 1) {
      const stored = ownedWorld(`podvrh-${i}`, T0 + 1 + i, `vymyšlený-klíč-${i}`);
      stored?.session.events.subscribe(() => {});
    }

    expect(
      getSession('porotce'),
      'ochrana zesílila nad to, co je o ní napsané — přepiš doktrínu u MAX_SESSIONS_PER_CALLER',
    ).toBeNull();
  });
});
