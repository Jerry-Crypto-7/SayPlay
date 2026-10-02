import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_DARE_REQUESTS_PER_WINDOW_PER_INSTANCE,
  MAX_REQUESTS_PER_WINDOW,
  MAX_REQUESTS_PER_WINDOW_PER_GROUP,
  MAX_REQUESTS_PER_WINDOW_PER_INSTANCE,
  RATE_WINDOW_MS,
  callerKey,
  isGroupedCaller,
  rateLimitCode,
  rateLimitedResponse,
  resetRateWindows,
  takeRateSlot,
  trustedCallerKey,
  UNIDENTIFIED_CALLER,
} from '../rate-limit';

/** Začátek okna, aby se v případech počítalo od kulatého čísla. */
const T0 = 1_000 * RATE_WINDOW_MS;
const ME = '203.0.113.7';
const SOMEONE_ELSE = '198.51.100.4';
/** Klíč, jaký složí `trustedKeyFor()` z IPv6: celé přidělení, ne jeden člověk. */
const ROOM = 'net:2001:db8:0:0::/64';

/** Vystřelí `count` požadavků do téhož okamžiku a vrátí poslední verdikt. */
function burst(door: 'edit' | 'emit', caller: string, count: number, atMs: number) {
  let last = takeRateSlot(door, caller, atMs);
  for (let i = 1; i < count; i += 1) last = takeRateSlot(door, caller, atMs);
  return last;
}

describe('strop na frekvenci veřejných dveří', () => {
  afterEach(() => {
    resetRateWindows();
  });

  it('pustí přesně tolik požadavků, kolik říká strop, a další odmítne', () => {
    expect(burst('edit', ME, MAX_REQUESTS_PER_WINDOW, T0).allowed).toBe(true);
    const over = takeRateSlot('edit', ME, T0);
    expect(over).toMatchObject({
      allowed: false,
      count: MAX_REQUESTS_PER_WINDOW + 1,
      limit: MAX_REQUESTS_PER_WINDOW,
      scope: 'caller',
    });
  });

  it('výzvy: odmítnutý volající ani skupina neubírá strop instance, další člověk projde', () => {
    for (const flooder of [ME, ROOM]) {
      resetRateWindows();
      for (let i = 0; i < 2 * MAX_DARE_REQUESTS_PER_WINDOW_PER_INSTANCE; i += 1) takeRateSlot('play/dare', flooder, T0);
      expect(takeRateSlot('play/dare', flooder, T0)).toMatchObject({ allowed: false, scope: 'caller' });
      expect(takeRateSlot('play/dare', SOMEONE_ELSE, T0)).toMatchObject({ allowed: true });
    }
  });

  it('flooder zavře dveře SOBĚ, ne ostatním', () => {
    // **Nález nezávislé revize 4. 9. 2026, `VERDICT: blocking`.** Dokud byl
    // čítač jeden na dveře, stačilo 5,1 požadavku za sekundu a dveře byly
    // zavřené všem — tedy obrana levnější než útok, proti kterému stojí
    // (naměřených ~66 req/s). Tohle je ten rozdíl, a proto se soudí zvlášť.
    burst('edit', ME, MAX_REQUESTS_PER_WINDOW + 50, T0);
    expect(takeRateSlot('edit', ME, T0).allowed).toBe(false);
    expect(takeRateSlot('edit', SOMEONE_ELSE, T0).allowed).toBe(true);
  });

  it('nad strop instance se odmítá jinou hláškou, protože je to kapacita, ne volající', () => {
    // Druhý strop existuje proto, že podvržená adresa jinak obejde ten první.
    // Rozdává se ale poctivě: kdo poslal jeden požadavek, nesmí se dozvědět,
    // že jich posílá moc.
    for (let sent = 0; sent < MAX_REQUESTS_PER_WINDOW_PER_INSTANCE; sent += 1)
      takeRateSlot('edit', `10.0.0.${String(sent % 250)}`, T0);

    const over = takeRateSlot('emit', 'someone-brand-new', T0);
    expect(over).toMatchObject({ allowed: false, scope: 'instance' });
    expect(over.limit).toBe(MAX_REQUESTS_PER_WINDOW_PER_INSTANCE);
  });

  /**
   * **Sál není jeden člověk** — `T29-netfloor`, routovaný nález druhého kola
   * nezávislé revize 6. 9. 2026.
   *
   * `trustedKeyFor()` sráží IPv6 na `/64`, protože jinak se mez obejde výměnou
   * spodních 64 bitů. Do téhle úlohy měl ale takový kbelík **týž strop jako
   * jedna ruka na klávesnici**, takže celá kancelář nebo sál sdílely 50
   * požadavků za okno.
   */
  it('kbelík celé /64 pustí víc než jedna adresa, a nekousne na jejím stropu', () => {
    expect(burst('edit', ROOM, MAX_REQUESTS_PER_WINDOW + 1, T0).allowed).toBe(true);
    expect(burst('edit', ME, MAX_REQUESTS_PER_WINDOW + 1, T0).allowed).toBe(false);
  });

  it('skupina má vlastní strop, ne vypnutou mez', () => {
    expect(burst('edit', ROOM, MAX_REQUESTS_PER_WINDOW_PER_GROUP, T0).allowed).toBe(true);
    expect(takeRateSlot('edit', ROOM, T0)).toMatchObject({
      allowed: false,
      count: MAX_REQUESTS_PER_WINDOW_PER_GROUP + 1,
      limit: MAX_REQUESTS_PER_WINDOW_PER_GROUP,
      scope: 'caller',
    });
  });

  it('strop instance zůstává nad stropem skupiny, takže nejhorší případ smyčky se nehnul', () => {
    expect(MAX_REQUESTS_PER_WINDOW_PER_INSTANCE).toBeGreaterThan(MAX_REQUESTS_PER_WINDOW_PER_GROUP);
    expect(MAX_REQUESTS_PER_WINDOW_PER_GROUP).toBeGreaterThan(MAX_REQUESTS_PER_WINDOW);
  });

  it('volnější kbelík si volající vybrat neumí — z jeho hlavičky `net:` nevyjde', () => {
    // Předponu skládá jedině důvěryhodná cesta. Doslovný opis skončí pod
    // `xff:`, takže volnější strop není dosažitelný zvenčí; je to táž třída,
    // kterou u kvóty relací zavřely oddělené předpony.
    const opis = new Request('http://worldsmith.test/api/edit', {
      headers: { 'x-forwarded-for': 'net:2001:db8:0:0::/64' },
    });
    expect(isGroupedCaller(callerKey(opis))).toBe(false);
    expect(trustedCallerKey(opis, { VERCEL: '1' })).toBeNull();

    const platforma = new Request('http://worldsmith.test/api/edit', {
      headers: { 'x-vercel-forwarded-for': '2001:db8::1' },
    });
    expect(isGroupedCaller(trustedCallerKey(platforma, { VERCEL: '1' }) ?? '')).toBe(true);
  });

  it('strop instance je nad stropem volajícího, ne pod ním', () => {
    // Kdyby byl pod ním, kousl by první a strop na volajícího by nikdy nesepnul
    // — což je přesně ta sdílená mez, kterou tahle remediace odstraňuje.
    expect(MAX_REQUESTS_PER_WINDOW_PER_INSTANCE).toBeGreaterThan(MAX_REQUESTS_PER_WINDOW);
  });

  it('odmítnutý požadavek se POČÍTÁ, takže mlácením na dveře se okno nekupuje', () => {
    burst('edit', ME, MAX_REQUESTS_PER_WINDOW + 20, T0);
    expect(takeRateSlot('edit', ME, T0)).toMatchObject({
      allowed: false,
      count: MAX_REQUESTS_PER_WINDOW + 21,
    });
  });

  it('další okno začíná načisto', () => {
    burst('edit', ME, MAX_REQUESTS_PER_WINDOW + 1, T0);
    expect(takeRateSlot('edit', ME, T0 + RATE_WINDOW_MS)).toMatchObject({
      allowed: true,
      count: 1,
    });
  });

  it('okno je ukotvené na absolutním čase, ne na prvním požadavku', () => {
    // **Kotva na prvním požadavku by se dala posouvat.** Kdo pošle jeden
    // požadavek na konci okna, posunul by si tím celé následující okno.
    burst('edit', ME, MAX_REQUESTS_PER_WINDOW, T0 + RATE_WINDOW_MS - 1);
    expect(takeRateSlot('edit', ME, T0 + RATE_WINDOW_MS - 1).allowed).toBe(false);
    expect(takeRateSlot('edit', ME, T0 + RATE_WINDOW_MS).allowed).toBe(true);
  });

  it('každé dveře mají vlastní okno — nápor na jedny nezavře druhé', () => {
    burst('edit', ME, MAX_REQUESTS_PER_WINDOW + 1, T0);
    expect(takeRateSlot('emit', ME, T0).allowed).toBe(true);
  });

  it('staré okno se zahazuje celé, takže mapa klíčů neroste s provozem', () => {
    // Klíč je hlavička od volajícího, takže bez tohohle by šlo mapu nafouknout
    // střídáním adres. Strop instance navíc drží počet klíčů v jednom okně.
    for (let sent = 0; sent < 300; sent += 1) takeRateSlot('edit', `10.1.0.${String(sent)}`, T0);
    expect(takeRateSlot('edit', ME, T0 + RATE_WINDOW_MS)).toMatchObject({
      allowed: true,
      count: 1,
      scope: 'caller',
    });
  });

  it('retry-after je zbytek okna, nikdy nula a nikdy víc než celé okno', () => {
    const wholeWindow = RATE_WINDOW_MS / 1000;
    expect(takeRateSlot('edit', ME, T0).retryAfterSeconds).toBe(wholeWindow);
    expect(takeRateSlot('edit', ME, T0 + RATE_WINDOW_MS - 1).retryAfterSeconds).toBe(1);
    for (const offset of [0, 1, 4_999, RATE_WINDOW_MS - 1]) {
      const { retryAfterSeconds } = takeRateSlot('edit', ME, T0 + offset);
      expect(retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(retryAfterSeconds).toBeLessThanOrEqual(wholeWindow);
    }
  });

  it('volající se bere z hlavičky proxy, a je ořezaný', () => {
    const forwarded = new Request('http://x/', {
      headers: { 'x-forwarded-for': `${ME}, 70.41.3.18, 150.172.238.178` },
    });
    expect(callerKey(forwarded), 'první položka je klient, zbytek jsou proxy').toContain(ME);

    const real = new Request('http://x/', { headers: { 'x-real-ip': SOMEONE_ELSE } });
    expect(callerKey(real)).toContain(SOMEONE_ELSE);

    // Bez hlaviček spadnou všichni do jednoho jména — lokální běh je jeden
    // stroj a jeden návštěvník.
    expect(callerKey(new Request('http://x/'))).toBe(UNIDENTIFIED_CALLER);

    // **Klíč je vstup od volajícího, takže se ořezává.** Bez toho by stačilo
    // posílat kilobajtové hlavičky a mapa oken by byla úložiště zdarma.
    const huge = new Request('http://x/', { headers: { 'x-forwarded-for': 'a'.repeat(5_000) } });
    expect(huge.headers.get('x-forwarded-for')?.length).toBe(5_000);
    expect(callerKey(huge).length).toBeLessThan(60);
  });

  it('sentinel nerozeznaných se z hlavičky NEDÁ složit', () => {
    // **Obejití naměřené nezávislou revizí 4. 9. 2026, ověřené spuštěním.**
    // Klíč se skládal z hodnoty, kterou píše volající, takže se dalo
    // dobrovolně vstoupit do kbelíku nerozeznaných — a ten má v `body.ts`
    // osmkrát vyšší strop souběžných čtení, tedy celý rozpočet paměti
    // instance pro jednoho klienta.
    const spoofed: Record<string, string>[] = [
      { 'x-forwarded-for': UNIDENTIFIED_CALLER },
      { 'x-forwarded-for': `${UNIDENTIFIED_CALLER}, 203.0.113.7` },
      // Prázdná první položka: `split(',')[0].trim()` z ní udělá `''`, což
      // dřív spadlo rovnou na sentinel.
      { 'x-forwarded-for': ' , 203.0.113.7' },
      // A hlavička prázdná úplně — pořád je to vstup od volajícího.
      { 'x-forwarded-for': '' },
      { 'x-forwarded-for': '   ' },
      { 'x-real-ip': UNIDENTIFIED_CALLER },
      { 'x-real-ip': '' },
    ];
    for (const headers of spoofed) {
      const key = callerKey(new Request('http://x/', { headers }));
      expect(key, `${JSON.stringify(headers)} se vydal za nerozeznaného`).not.toBe(
        UNIDENTIFIED_CALLER,
      );
    }

    // Polarita: chybějící hlavička sentinel pořád dát MUSÍ, jinak by se
    // kbelík nerozeznaných nedal naplnit vůbec a test výš by byl zelený
    // nad `callerKey`, který vrací pokaždé něco jiného.
    expect(callerKey(new Request('http://x/'))).toBe(UNIDENTIFIED_CALLER);
  });


  /**
   * **Pád a důvěryhodná cesta nesmějí umět složit tentýž klíč** — nález
   * druhého kola nezávislé revize 6. 9. 2026 (`T29-freeunbounded`), CONFIRMED
   * spuštěním nad `891e9c1`.
   *
   * Od té chvíle klíčuje sedmero dveří i čítač rozečtených těl
   * `trustedCallerKey(request) ?? callerKey(request)`, takže oba klíče leží
   * v jedné mapě. Dokud obě cesty psaly `ip:`, stačilo poslat požadavek **bez**
   * platformní hlavičky a s `x-forwarded-for: <oběť>, <útočník>` — pád složil
   * `ip:<oběť>`, tedy kbelík počestné oběti. Útok, který se tím commitem
   * zavíral, tudy chodil dál.
   */
  it('nedůvěryhodný klíč se do důvěryhodného kbelíku netrefí ani doslovným opisem', () => {
    const OBĚŤ = '198.51.100.4';
    // Vlastní stavitel: pomocník `požadavek()` bydlí až v sousedním bloku.
    const s = (headers: Record<string, string>): Request =>
      new Request('http://worldsmith.test/api/edit', { method: 'POST', headers });

    const důvěryhodný = trustedCallerKey(s({ 'x-vercel-forwarded-for': OBĚŤ }), { VERCEL: '1' });
    expect(důvěryhodný).toBe(`ip:${OBĚŤ}`);

    // Útočník, který platformní hlavičku vynechá, spadne na `callerKey()`.
    const pádem = callerKey(s({ 'x-forwarded-for': `${OBĚŤ}, 203.0.113.99` }));
    expect(pádem, 'pád složil klíč z důvěryhodné cesty — kolize je zpátky').not.toBe(důvěryhodný);

    // A ani doslovný opis celého klíče se do něj netrefí, protože předpona
    // je součást klíče, ne popisek.
    expect(callerKey(s({ 'x-forwarded-for': důvěryhodný! }))).not.toBe(důvěryhodný);
    expect(
      callerKey(s({ 'x-forwarded-for': 'net:2001:db8:0:0::/64' })),
      'doslovný opis seskupeného klíče se trefil do seskupeného kbelíku',
    ).not.toBe('net:2001:db8:0:0::/64');
  });

  /**
   * **Kam ty nepoužitelné hlavičky spadnou, když ne na sentinel**
   * (`T28-emptyxff`, nezávislá revize 4. 9. 2026). Test výš tvrdí jen to,
   * čím **nejsou**. Skončí všechny v jediném kbelíku `xff:`, tedy bez adresy —
   * a od `2fad718` je to kbelík **odmítající**, takže osm požadavků ho zamčne
   * komukoli dalšímu, kdo do něj spadne.
   *
   * ⚠ **Změřeno, že tam ale nespadne nikdo počestný, a proto se to neopravuje.**
   * Na Vercelu je `x-forwarded-for` vždycky vyplněné; bez proxy (`next start`,
   * demo z notebooku) nepřijde ani jedna hlavička a klíč je sentinel. Do `xff:`
   * se tedy dá dostat **jedině hlavičkou, kterou nikdo neposílá omylem** —
   * obsazují ho jen ti, kdo si ho vybrali. Zamčnout ho znamená zamčnout sebe.
   *
   * **Obě alternativy jsou měřitelně horší.** Pustit takový požadavek na
   * sentinel je přesně to obejití, které zavírá test o řádek výš (osmkrát
   * vyšší strop souběžných čtení). Dát každému takovému požadavku vlastní
   * klíč je mez zrušit. Skutečný zavírač je klíč z důvěryhodného konce
   * řetězu (`T16-trustedkey`); tenhle test řekne, co do té doby platí.
   */
  it('nepoužitelná hlavička dá kbelík bez adresy, do kterého se dá jen vstoupit schválně', () => {
    // ⚠ **`xff:`, ne `ip:` — od 6. 9. 2026 a je to bezpečnostní rozdíl,
    // ne přejmenování** (`T29-freeunbounded`). `ip:` skládá důvěryhodná
    // cesta a obě cesty dnes žijí v jedné mapě; sdílená předpona by dala
    // volajícímu vybrat si, které pravidlo klíčování se na něj použije.
    const BEZ_ADRESY = 'xff:';

    const nepoužitelné: Record<string, string>[] = [
      { 'x-forwarded-for': '' },
      { 'x-forwarded-for': '   ' },
      { 'x-forwarded-for': ' , ' },
      { 'x-real-ip': '' },
    ];
    for (const headers of nepoužitelné) {
      expect(
        callerKey(new Request('http://x/', { headers })),
        `${JSON.stringify(headers)} už nespadá do sdíleného kbelíku — přepiš doktrínu u callerKey()`,
      ).toBe(BEZ_ADRESY);
    }

    // **Polarita, a je to celá obhajoba té zelené výš.** Ani jeden tvar, který
    // používá poctivý provoz, do toho kbelíku nevede: s proxy přijde adresa,
    // bez proxy nepřijde hlavička žádná.
    expect(callerKey(new Request('http://x/', { headers: { 'x-forwarded-for': ME } }))).not.toBe(
      BEZ_ADRESY,
    );
    expect(
      callerKey(new Request('http://x/', { headers: { 'x-forwarded-for': ` , ${ME}` } })),
      'první prázdná položka zahodila i použitelnou adresu za ní',
    ).not.toBe(BEZ_ADRESY);
    expect(callerKey(new Request('http://x/')), 'běh bez proxy skončil v kbelíku bez adresy').toBe(
      UNIDENTIFIED_CALLER,
    );
  });

  it('odpověď nese 429, retry-after a NEPROZRADÍ, kde ten strop je', async () => {
    // Číslo stropu je přesně ten údaj, ze kterého se počítá nejlevnější způsob,
    // jak dveře držet zavřené.
    const verdict = takeRateSlot('edit', ME, T0);
    const response = rateLimitedResponse('req-9', verdict);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe(String(verdict.retryAfterSeconds));

    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(body.error.message).toBe('too many requests from this client');
    expect(body.error.message).not.toContain(String(MAX_REQUESTS_PER_WINDOW));

    // A pod stropem instance to je kapacita serveru, ne vina volajícího.
    const capacity = rateLimitedResponse('req-10', { ...verdict, scope: 'instance' });
    const capacityBody = (await capacity.json()) as { error: { code: string } };
    expect(capacityBody.error.code).toBe('SERVER_AT_CAPACITY');
  });
});

describe('kód odmítnutí je jeden pro odpověď i pro log', () => {
  it('operátor se o plné instanci nedozví, že za to může volající', async () => {
    // **Nález nezávislé revize 4. 9. 2026.** Do té doby psalo všech šest dveří
    // do `logRateLimited` napevno `TOO_MANY_REQUESTS`, takže naplněný strop
    // instance dal operátorovi tvrzení o volajícím, které odpověď o řádek níž
    // zrovna opravila — a `logRateLimited` klíčuje `(dveře, kód)`, takže se
    // navíc oba případy slily do jednoho promlčovacího okna.
    const caller = takeRateSlot('edit', ME, T0);
    expect(rateLimitCode(caller)).toBe('TOO_MANY_REQUESTS');
    expect(rateLimitCode({ ...caller, scope: 'instance' })).toBe('SERVER_AT_CAPACITY');

    // A je to **týž** kód, jaký odejde ven — jedno rozhodnutí, dvě hlášení.
    for (const scope of ['caller', 'instance'] as const) {
      const verdict = { ...caller, scope };
      const sent = (await rateLimitedResponse('req-11', verdict).json()) as {
        error: { code: string };
      };
      expect(sent.error.code, `${scope}: log a odpověď se rozešly`).toBe(rateLimitCode(verdict));
    }
  });
});

/**
 * **Dosah obou mezí je tvrzení pro člověka, a rozešlo se už jednou**
 * (`T28-fleetrate`, rozhodnuto 4. 9. 2026: sdílený čítač se nestaví).
 *
 * Strop platí na instanci, ne na nasazení, a flotila o N instancích propustí
 * N násobek. To se nedá zkontrolovat běhovým testem — je to věta v hlavičce,
 * a věta se dá při příští úpravě tiše ztratit nebo obrátit. Popis téhle
 * hranice přitom žije ve **třech** souborech naráz.
 *
 * ⚠ **Pinuje se přítomnost správné odpovědi, ne nepřítomnost špatné.**
 * Blocklist slov se v tomhle repu už jednou vyzkoušel u stropu utrácení
 * (`T30-capfloor`) a zahodil se: dal se obejít pořadím slov i cizím jazykem
 * a naopak červenal na správně napsaném záporu. Značka `T28-fleetrate`
 * v žádném z těch bloků být nemohla, dokud ji tam někdo nenapsal vědomě.
 */
describe('všechny tři popisy dosahu vědí, že mez platí na instanci', () => {
  const bloky = [
    ['src/server/rate-limit.ts', 'Co tenhle soubor tedy NEDĚLÁ'],
    // ⚠ Kotva nesmí obsahovat samotné tvrzení, jinak si aserce na „na instanci"
    // měří vlastní kotvu a mutace se zabije dvakrát na témže místě. `retry-after`
    // je odpověď toho mechanismu, ne věta o něm.
    ['src/http/body.ts', '`retry-after`'],
    ['src/app/api/edit/route.ts', 'Obě jsou meze'],
  ] as const;

  it('každý blok nese značku úlohy i samotné omezení na instanci', () => {
    for (const [path, kotva] of bloky) {
      const text = readFileSync(path, 'utf8');
      const start = text.indexOf(kotva);
      expect(start, `${path}: kotva „${kotva}" zmizela — oprav kotvu, ne test`).toBeGreaterThan(-1);
      // Okno je 900 znaků, tedy celý odstavec i s odůvodněním.
      const blok = text.slice(start, start + 900);
      expect(blok, `${path}: popis dosahu neříká, že mez platí na instanci`).toContain(
        'na instanci',
      );
      expect(
        blok,
        `${path}: popis dosahu nenese značku — dopiš, že sdílený čítač se vědomě nestaví`,
      ).toContain('T28-fleetrate');
    }
  });
});

/* ------------------------------------------------------------------ *
 * Klíč z důvěryhodného konce řetězu (P15 `T16-trustedkey`).
 * ------------------------------------------------------------------ */

/**
 * **Tenhle klíč nesmí jít vnutit zvenčí — na tom stojí kvóta relací.**
 *
 * `callerKey()` výš podvrhnout jde a je to vědomé: u frekvence vrací
 * podvržený klíč útočníka nanejvýš tam, kde by byl bez meze. U kvóty je to
 * zbraň — cizí klíč míří na cizí relace a zavře porotci svět (naměřeno
 * 5 z 5, `T16-evictkill`). Proto druhá funkce a proto se tady soudí
 * **nedosažitelnost**, ne tvar.
 */
describe('klíč z důvěryhodného konce řetězu', () => {
  function požadavek(headers: Record<string, string>): Request {
    return new Request('http://x/', { headers });
  }

  it('hlavička platformy rozhoduje a volající do ní nemluví', () => {
    const key = trustedCallerKey(
      požadavek({
        'x-vercel-forwarded-for': '198.51.100.4',
        // Celá lež volajícího. Na výsledek nesmí mít vliv žádný.
        'x-forwarded-for': '203.0.113.99, 10.0.0.1',
        'x-real-ip': '203.0.113.99',
      }),
      { VERCEL: '1' },
    );

    expect(key).toContain('198.51.100.4');
    expect(key, 'do klíče se dostala hodnota od volajícího').not.toContain('203.0.113.99');

    // **Bere se KONEC řetězu, ne začátek — a bez tohohle je to tvrzení
    // dekorativní.** Naměřeno 5. 9. 2026: mutace „vezmi první položku"
    // přežila celou sadu, protože každý dosavadní případ posílal
    // `x-vercel-forwarded-for` s jedinou položkou, kde se první a poslední
    // neliší. Kdyby edge připisoval místo přepisoval, byla by první položka
    // zase volba volajícího — tedy přesně ta vada, kterou funkce zavírá.
    const řetěz = trustedCallerKey(
      požadavek({ 'x-vercel-forwarded-for': '203.0.113.99, 198.51.100.4' }),
      { VERCEL: '1' },
    );
    expect(řetěz, 'vzala se první položka, tedy to, co mohl napsat volající').toBe(
      'ip:198.51.100.4',
    );
  });

  it('prázdná důvěryhodná položka je neznámo, ne sdílený kbelík', () => {
    // **Přežilo revert `1354f04` schválně.** Vlastnost je starší než
    // `T16-singleentry` a na „poslední versus jediná položka" nezávisí:
    // stráž `value === ''` stojí v obou podobách. Naměřeno mutací
    // 5. 9. 2026 — bez téhle aserce nechala mutace „prázdnou položku pusť"
    // celou sadu zelenou, ačkoli pod ní prázdná hlavička spadne do
    // sdíleného kbelíku `ip:` místo do `null`. Rozdíl je celý v tom, kdo
    // tam s ní je: `null` dá relaci vlastní kbelík, kdežto `ip:` je jeden
    // kbelík pro každého, kdo si prázdnou hlavičku napíše.
    const klíč = (hlavička: string) =>
      trustedCallerKey(požadavek({ 'x-vercel-forwarded-for': hlavička }), { VERCEL: '1' });

    expect(klíč(''), 'prázdná hlavička dala kbelík místo neznáma').toBeNull();

    // ⚠ **Případ `klíč('   ')` tu stál do 6. 9. 2026 a byl to TÝŽ případ**
    // (`T16-trimdecor`, nález nezávislé revize). `Headers` normalizuje HTTP
    // mezery, takže se hodnota ze samých mezer dostane do funkce jako prázdný
    // řetězec — naměřeno: `'   '` → `''`, `'  1.2.3.4  '` → `'1.2.3.4'`.
    // Aserce tedy pinovala normalizaci v Node, ne stráž v našem kódu, a číst
    // se dala jako dvě vlastnosti místo jedné.
    //
    // **Nahrazuje ji vstup, který normalizací PROJDE a `.trim()` doopravdy
    // zaměstná:** vnitřní mezeru za čárkou `Headers` nechává být (`'1.1.1.1,
    // 2.2.2.2'` dorazí beze změny), takže poslední položka je ` 2.2.2.2`.
    // Bez `.trim()` by z ní vznikl klíč s mezerou uvnitř, tedy jiný kbelík než
    // pro tutéž adresu poslanou samotnou.
    expect(klíč('1.1.1.1, 2.2.2.2'), 'mezera za čárkou zůstala v klíči').toBe('ip:2.2.2.2');
    expect(klíč('1.1.1.1,	2.2.2.2'), 'tabulátor za čárkou zůstal v klíči').toBe('ip:2.2.2.2');
    expect(klíč('1.1.1.1, 2.2.2.2'), 'týž volající skončil ve dvou kbelících').toBe(klíč('2.2.2.2'));

    // ⚠ **Stráž `value === ''` se přes `Request` dá vyvolat JEDINĚ prázdnou
    // hlavičkou, ne mezerami.** Poslední položka ze samých mezer neexistuje:
    // koncové mezery celé hodnoty normalizace ustřihne (`'1.1.1.1,   '` → 
    // `'1.1.1.1,'`). Kdo sem přidá další případ „samé mezery", ať to změří
    // dřív, než napíše hlášku.
  });

  it('bez důvěryhodného zdroje je to `null`, ne odhad z hlavičky volajícího', () => {
    // **Fail-closed, a je to celý smysl.** Vrátit sem první položku XFF
    // znamená vrátit vadu, kterou tahle funkce zavírá; `null` říká „neumím
    // rozeznat" a volající si z toho musí udělat konzervativní závěr.
    expect(trustedCallerKey(požadavek({ 'x-forwarded-for': '203.0.113.99' }), {})).toBeNull();
    expect(trustedCallerKey(požadavek({ 'x-real-ip': '203.0.113.99' }), {})).toBeNull();
    expect(trustedCallerKey(požadavek({}), {})).toBeNull();
  });

  it('sentinel z důvěryhodné hlavičky složit nejde a klíč se ořezává', () => {
    // Táž vlastnost a týž důvod jako u `callerKey()`: kdo se dostane do
    // kbelíku nerozeznaných, dostane se k volnějším mezím.
    expect(
      trustedCallerKey(požadavek({ 'x-vercel-forwarded-for': UNIDENTIFIED_CALLER }), {
        VERCEL: '1',
      }),
    ).not.toBe(UNIDENTIFIED_CALLER);

    const huge = požadavek({ 'x-vercel-forwarded-for': 'a'.repeat(5_000) });
    expect(trustedCallerKey(huge, { VERCEL: '1' })!.length).toBeLessThan(60);
  });

  /**
   * **`T16-addrshape`, 5. 9. 2026.** Hodnota z důvěryhodného konce se do té
   * doby jen usekla na délku, takže `[2001:db8::1]:51234` prošlo i s portem.
   * Za proxy, která do řetězu píše `ip:port`, měl pak **každý požadavek jiný
   * klíč** — kvóta relací nezakousla nikdy a přetečení registru sáhlo po
   * nejdéle stojící sledované relaci, tedy po porotci. Týž efekt na Vercelu
   * z jediné IPv6 `/64`, kde 64 adres nestojí nic.
   */
  it('port, velikost písmen ani hostitel uvnitř /64 nerozdělí jeden volající na tisíc', () => {
    const klíč = (adresa: string) =>
      trustedCallerKey(požadavek({ 'x-vercel-forwarded-for': adresa }), { VERCEL: '1' });

    // Pět zápisů téhož odběratele. Musí to být jeden klíč, ne pět.
    //
    // ⚠ **`2001:0db8:…` s vodicí nulou je tam po nálezu revize, a přežil bez
    // něj mutant.** Bez zápisu s vodicí nulou nebyl krok, který skupiny
    // zkracuje, připíchnutý ničím: mutace „nezkracuj" nechala celou sadu
    // zelenou, ačkoli `2001:db8::1` a `2001:0db8:0:0:0:0:0:1` pod ní dají dva
    // klíče. Proxy, která nuly doplňuje, by tím původní vadu otevřela zpátky.
    const seskupené = new Set([
      klíč('[2001:db8::1]:51234'),
      klíč('2001:db8::1'),
      klíč('2001:DB8:0:0:aaaa:bbbb:cccc:dddd'),
      klíč('2001:0db8:0:0:0:0:0:1'),
      klíč('2001:db8::1%eth0'),
    ]);
    expect(seskupené, `pět zápisů jednoho /64 dalo ${String(seskupené.size)} klíčů`).toHaveLength(
      1,
    );

    // **Vlastní předpona `net:`, ne `ip:`** — jinak by stačilo poslat ten
    // řetězec doslova a trefit se do kbelíku celého cizího přidělení.
    expect([...seskupené][0]).toBe('net:2001:db8:0:0::/64');
    expect(klíč('net:2001:db8:0:0::/64'), 'doslovný klíč se trefil do seskupeného kbelíku').not.toBe(
      'net:2001:db8:0:0::/64',
    );

    // IPv4 s portem. Port je u téhle proxy zdroj entropie, ne identita.
    expect(klíč('198.51.100.4:51234')).toBe(klíč('198.51.100.4'));
    expect(klíč('198.51.100.4')).toBe('ip:198.51.100.4');
  });

  /**
   * ⚠ **Selhávající cesty, a každá z nich je vlastní vada, kdyby se sráželo
   * víc, než se má.** Seskupení, které sežere i to, co adresa není, vyrobí
   * z kvóty odepření služby počestným — tedy přesně to, co má zavírat.
   */
  it('sráží se jenom to, co je doopravdy jedno přidělení', () => {
    const klíč = (adresa: string) =>
      trustedCallerKey(požadavek({ 'x-vercel-forwarded-for': adresa }), { VERCEL: '1' });

    // **IPv4 se NESESKUPUJE.** Sousední IPv4 adresy jsou cizí lidé, kdežto
    // sousední adresy v jednom IPv6 `/64` jsou jeden odběratel.
    expect(klíč('198.51.100.4')).not.toBe(klíč('198.51.100.5'));

    // **Ani IPv4 zapsaná jako IPv6, a to v OBOU zápisech.** Seskupit
    // `::ffff:…` na `/64` by slilo všechny IPv4 volající do jednoho kbelíku.
    // ⚠ Šestnáctkový zápis sem doplnil nález nezávislé revize: tečkovaný
    // neprojde přes soud na hexadecimální skupinu, ale `cb00:7109` je platná
    // skupina, takže se seskupoval — a padal do jednoho kbelíku i s `::1`.
    expect(klíč('::ffff:203.0.113.9')).not.toBe(klíč('::ffff:203.0.113.10'));
    expect(klíč('::ffff:cb00:7109')).not.toBe(klíč('::ffff:cb00:710a'));
    expect(klíč('::ffff:cb00:7109')).not.toBe(klíč('::1'));

    // ⚠ **Šířka té stráže, tedy PĚT nulových skupin, ne čtyři —
    // `T16-mappedwidth`, přeživší mutant naměřený nezávislou revizí.**
    // `::ffff:0:0/96` znamená pět nulových skupin a pak `ffff`. Dokud se
    // měřilo jen `groups[5] === 0xffff`, nechala mutace `slice(0, 5)` →
    // `slice(0, 4)` celou sadu zelenou, ačkoli pod ní tahle adresa přeskočí
    // ze seskupeného klíče na doslovný. Adresa má pátou skupinu nenulovou,
    // takže do `::ffff:0:0/96` **nepatří** a seskupit se má.
    expect(
      klíč('0:0:0:0:1:ffff:cb00:7109'),
      'stráž na ::ffff:0:0/96 je o skupinu širší, než má být',
    ).toBe('net:0:0:0:0::/64');

    // Rozbitý zápis (dvakrát `::`) není adresa, takže se neseskupuje.
    expect(klíč('2001:db8::1::2')).not.toBe('net:2001:db8:0:0::/64');

    // **Mez délky řetězu.** `::` musí zastupovat aspoň jednu nulovou skupinu,
    // takže sedm položek kolem něj se ještě seskupí a osm už ne. Bez obou
    // stran té meze přežije mutace hranice.
    expect(klíč('1:2:3:4:5:6::7'), 'sedm položek kolem :: se neseskupilo').toBe('net:1:2:3:4::/64');
    expect(klíč('1:2:3:4:5:6:7::8'), 'osm položek kolem :: se přesto seskupilo').toBe(
      'ip:1:2:3:4:5:6:7::8',
    );
  });

  /**
   * ⚠ **Nerozpoznaná hodnota klíč NEZRUŠÍ, a je to ta bezpečná strana.**
   * `null` znamená vypnutou kvótu, tedy přesně tam, kam chce volající hodnotu
   * dotlačit.
   *
   * ⚠ **Ořez na délku dělá `lastEntry()`, ne seskupování — a předchozí podoba
   * téhle hlášky tvrdila opak.** Nález nezávislé revize: druhý ořez uvnitř
   * `normalizeAddress()` byl mrtvý kód (mazání ho nechalo celou sadu zelenou),
   * protože hodnota přijde useknutá už z `lastEntry()` a seskupení řetězec
   * jedině zkracuje. Test tedy pinuje tu obranu, která existuje, a jménem
   * říká, kde bydlí.
   */
  it('nerozpoznaná hodnota klíč nezruší, jen ji lastEntry ořízne na délku', () => {
    const klíč = (adresa: string) =>
      trustedCallerKey(požadavek({ 'x-vercel-forwarded-for': adresa }), { VERCEL: '1' });

    expect(klíč('tohle není adresa'), 'nerozpoznaná hodnota vypnula kvótu').not.toBeNull();
    expect(klíč('tohle není adresa')).toBe('ip:tohle není adresa');

    // Malá písmena i na nerozpoznané cestě: `HOST:80` a `host:80` je jeden
    // volající. Dokud se sráželo jen uvnitř seskupování, byli to dva.
    expect(klíč('HOST:80')).toBe(klíč('host:80'));

    // Kilobajtová hlavička nesmí být úložiště zdarma. Mez je 45 znaků
    // z `lastEntry()` plus předpona.
    const dlouhá = klíč('g'.repeat(5_000))!;
    expect(dlouhá.length, 'ořez v lastEntry() zmizel').toBe('ip:'.length + 45);
  });

  it('mimo Vercel je klíč vždycky `null`, ať si volající napíše cokoli', () => {
    // **Druhý blokující nález nezávislé revize 5. 9. 2026 — a tenhle se
    // nezáplatoval, zrušil se celý režim.** `WORLDSMITH_TRUSTED_PROXY_HOPS`
    // uměl jen počítat pozici v `x-forwarded-for`. Nedokázal ověřit, že tolik
    // položek doopravdy PŘIPSALA proxy, a adresu protistrany z `Request`
    // v Next App Routeru přečíst nejde. Za nginx, která píše `X-Real-IP`
    // a XFF propouští, si tedy klíč vybral volající — a ten klíč je zbraň
    // (`T16-evictkill`: cizí relace, zavřený porotcův svět, 5 z 5).
    //
    // **Obě silnější opravy jsou měřením vyvrácené, proto ta škrtací.**
    // (a) „řetěz musí mít víc položek než hloubka" položí PRÁVĚ ten poctivý
    // případ: poctivý volající XFF neposílá vůbec, nginx připíše jedinou
    // položku, řetěz má délku 1 — a při `HOPS=1` by vyšel `null`, tedy kvóta
    // vypnutá všem. (b) „ověř, že peer socketu je nakonfigurovaná proxy"
    // nejde postavit: `Request` adresu protistrany nenese.
    //
    // Zbylo tedy jediné poctivé chování: **mimo Vercel žádný důvěryhodný
    // konec řetězu není**, takže `null` a kvóta vypnutá. Je to horší mez,
    // ale míří na nikoho — a to je ta správná strana.
    // ⚠ **Nestačí `VERCEL` nedefinované — třetí kolo revize (5. 9. 2026)
    // naměřilo, že fail-open je KAŽDÁ jiná hodnota, ne jen prázdná.**
    // `{VERCEL:'0'}` + `x-vercel-forwarded-for: 203.0.113.9` vracelo
    // `ip:203.0.113.9`, takže operátor, který si mimo Vercel napíše
    // `VERCEL=0` ve smyslu „tady Vercel není", tuhle větev naopak ZAPNE.
    // Proto se tady tvrdí celá trojice `''`, `'0'`, `'false'` a strážce je
    // rovnost na `'1'`, tedy na hodnotu, kterou tam píše platforma.
    // ⚠ **`isServerless()` ve `spend-store.ts` zůstává na `!== undefined`
    // schválně** — tam je týž výraz fail-**CLOSED** (zavírá peněžní cestu),
    // takže zúžit ho na rovnost by placené volání naopak pustilo.
    for (const env of [
      {},
      { VERCEL: '' },
      { VERCEL: '0' },
      { VERCEL: 'false' },
      { WORLDSMITH_TRUSTED_PROXY_HOPS: '1' },
      { WORLDSMITH_TRUSTED_PROXY_HOPS: '2' },
      { VERCEL: '0', WORLDSMITH_TRUSTED_PROXY_HOPS: '1' },
    ]) {
      expect(
        trustedCallerKey(
          požadavek({
            'x-forwarded-for': '198.51.100.4',
            'x-real-ip': '198.51.100.4',
            'x-vercel-forwarded-for': '198.51.100.4',
          }),
          env,
        ),
        `prostředí ${JSON.stringify(env)} pustilo klíč vybraný volajícím`,
      ).toBeNull();
    }
  });
});

/**
 * **`T30-readdoorrate`, 5. 9. 2026.** Troje čtecí dveře nemají strop frekvence
 * vůbec, a AC té úlohy nabízela dvě cesty: buď jim slot dát a e2e ukázat, že
 * se reconnect SSE o něj nezasekne, nebo napsat, **proč** ho nemají. Vybrala
 * se druhá — u `/events` je totiž naměřené, že proti páce, kvůli které by ten
 * strop někdo chtěl, nezavře nic (útok drží otevřené proudy, ne frekvenci).
 *
 * ⚠ **Rozhodnutí bez pinu je jen komentář.** Tenhle test drží obojí: že ty
 * troje dveře slot doopravdy nemají, a že u seznamu dveří stojí odůvodnění.
 * Kdo některým z nich slot dá, položí to tady — a to je celý účel: doktrína
 * se pak přepíše vědomě, místo aby zůstala tiše nepravdivá.
 */
describe('troje čtecí dveře nemají slot, a je to rozhodnutí', () => {
  const ČTECÍ_DVEŘE = [
    'src/app/api/worldstream/snapshots/[hash]/route.ts',
    'src/app/api/worldstream/sessions/[sessionId]/route.ts',
    'src/app/api/worldstream/sessions/[sessionId]/events/route.ts',
  ] as const;

  it('ani jedny z nich nesahají po slotu', () => {
    for (const path of ČTECÍ_DVEŘE) {
      expect(
        readFileSync(path, 'utf8'),
        `${path}: přibyl strop frekvence — přepiš doktrínu u RateLimitedDoor a dolož e2e na reconnect SSE`,
      ).not.toContain('takeRateSlot');
    }
  });

  it('u seznamu dveří stojí, proč tam ty troje nejsou', () => {
    const text = readFileSync('src/server/rate-limit.ts', 'utf8');
    const start = text.indexOf('T30-readdoorrate');
    expect(start, 'odůvodnění u RateLimitedDoor zmizelo').toBeGreaterThan(-1);
    const blok = text.slice(start, start + 2200);
    // Tři jména dveří, aby se nedalo odůvodnit jen jedny a na dvoje zapomenout.
    for (const jméno of ['snapshots/[hash]', 'sessions/[sessionId]', 'events']) {
      expect(blok, `odůvodnění nejmenuje ${jméno}`).toContain(jméno);
    }
    // A samotný důvod, ne jen jejich výčet.
    expect(blok, 'odůvodnění neříká, že SSE se reconnectuje samo').toContain('reconnect');
    expect(blok, 'odůvodnění neveze flotilové číslo').toContain('flotilové');
  });
});

/**
 * **Připíchnutá CENA rozdělení klíčů — `T16-keydoctrine`, kolo revize 5. 9. 2026.**
 *
 * `callerKey()` bere **první** položku `x-forwarded-for`, tedy hodnotu, kterou
 * píše volající, a route si slot frekvence bere **dřív** než kvótu. Cizí
 * člověk tak umí držet kbelík frekvence oběti a odrážet její požadavky na 429.
 * Je to **vědomá cena**: podvrh u frekvence vrací útočníka nanejvýš tam, kde
 * by byl bez meze, a rozeznatelnější klíč mimo Vercel neexistuje. Cizí relaci
 * to nezavře — jen odmítne novou.
 *
 * ⚠ **Píše se to sem proto, že to doktrína u kvóty jednou zamlčela.** První
 * podoba přepsané doktríny tvrdila, že „zablokovat oběti zakládání" je po
 * `trustedCallerKey()` minulý čas; nezávislá revize to spuštěním vyvrátila.
 *
 * ⛔ **Tenhle test tu cenu NEHLÍDÁ — je to doplněk, ne pin, a druhá podoba
 * téhle věty to tvrdila obráceně.** Volá `callerKey()` a `takeRateSlot()`
 * napřímo, takže se route nedotkne: mutace `sessions/route.ts` na
 * `takeRateSlot('sessions', trustedCallerKey(request) ?? callerKey(request))`
 * ho nechá zelený (naměřeno 5. 9. 2026, 828/828). Soudí se tady jen to, že
 * `callerKey()` bere první položku a že společný kbelík odmítá.
 *
 * **Pin, který doopravdy zčervená, jde přes route** a bydlí v
 * `src/app/api/worldstream/__tests__/sessions.test.ts`, test „útočník
 * s hlavičkou oběti jí přes tyhle dveře odrazí požadavek na 429". Až tam
 * zčervená, přepíše se doktrína v `sessions.ts` i tabulka v hlavičce
 * `rate-limit.ts` — vědomě, ne mlčky.
 */
describe('podvržený klíč frekvence je vědomá cena, ne uzavřená díra', () => {
  afterEach(() => {
    resetRateWindows();
  });

  it('útočník s hlavičkou oběti jí odrazí vlastní požadavek na 429', () => {
    const OBĚŤ = '198.51.100.4';
    const požadavekS = (xff: string): Request =>
      new Request('http://127.0.0.1/api/worldstream/sessions', {
        method: 'POST',
        headers: { 'x-forwarded-for': xff },
      });

    // Útočník mluví pod svou adresou, ale píše adresu oběti. `callerKey()`
    // bere první položku, takže oba skončí v témž kbelíku.
    const útok = požadavekS(`${OBĚŤ}, 203.0.113.99`);
    expect(callerKey(útok), 'podvrh se do klíče frekvence nedostal').toContain(OBĚŤ);

    for (let i = 0; i < MAX_REQUESTS_PER_WINDOW; i += 1) {
      takeRateSlot('sessions', callerKey(útok), T0);
    }

    // Oběť posílá svůj úplně první požadavek.
    const verdikt = takeRateSlot('sessions', callerKey(požadavekS(OBĚŤ)), T0);
    expect(verdikt.allowed, 'cena je zavřená — přepiš doktrínu v sessions.ts, nemaž tenhle test').toBe(
      false,
    );
    expect(verdikt.scope, 'oběť odmítla kapacita instance, ne cizí kbelík').toBe('caller');
  });
});
