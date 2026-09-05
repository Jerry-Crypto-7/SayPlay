import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_REQUESTS_PER_WINDOW,
  MAX_REQUESTS_PER_WINDOW_PER_INSTANCE,
  RATE_WINDOW_MS,
  callerKey,
  rateLimitCode,
  rateLimitedResponse,
  resetRateWindows,
  takeRateSlot,
  TRUSTED_PROXY_HOPS,
  trustedCallerKey,
  UNIDENTIFIED_CALLER,
} from '../rate-limit';

/** Začátek okna, aby se v případech počítalo od kulatého čísla. */
const T0 = 1_000 * RATE_WINDOW_MS;
const ME = '203.0.113.7';
const SOMEONE_ELSE = '198.51.100.4';

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
   * **Kam ty nepoužitelné hlavičky spadnou, když ne na sentinel**
   * (`T28-emptyxff`, nezávislá revize 4. 9. 2026). Test výš tvrdí jen to,
   * čím **nejsou**. Skončí všechny v jediném kbelíku `ip:`, tedy bez adresy —
   * a od `2fad718` je to kbelík **odmítající**, takže osm požadavků ho zamčne
   * komukoli dalšímu, kdo do něj spadne.
   *
   * ⚠ **Změřeno, že tam ale nespadne nikdo počestný, a proto se to neopravuje.**
   * Na Vercelu je `x-forwarded-for` vždycky vyplněné; bez proxy (`next start`,
   * demo z notebooku) nepřijde ani jedna hlavička a klíč je sentinel. Do `ip:`
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
    const BEZ_ADRESY = 'ip:';

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
  });

  it('bez důvěryhodného zdroje je to `null`, ne odhad z hlavičky volajícího', () => {
    // **Fail-closed, a je to celý smysl.** Vrátit sem první položku XFF
    // znamená vrátit vadu, kterou tahle funkce zavírá; `null` říká „neumím
    // rozeznat" a volající si z toho musí udělat konzervativní závěr.
    expect(trustedCallerKey(požadavek({ 'x-forwarded-for': '203.0.113.99' }), {})).toBeNull();
    expect(trustedCallerKey(požadavek({ 'x-real-ip': '203.0.113.99' }), {})).toBeNull();
    expect(trustedCallerKey(požadavek({}), {})).toBeNull();
  });

  it('při vyplněné hloubce rozhoduje položka, kterou připsala proxy', () => {
    // Jedna proxy: cokoli si napsal volající zůstane vlevo od toho, co
    // připsala ona, takže poslední položka je skutečná adresa.
    const jedna = trustedCallerKey(
      požadavek({ 'x-forwarded-for': '198.51.100.4, 203.0.113.99' }),
      { [TRUSTED_PROXY_HOPS]: '1' },
    );
    expect(jedna).toContain('203.0.113.99');
    expect(jedna, 'vzala se první položka, tedy lež volajícího').not.toContain('198.51.100.4');

    // Dvě proxy: skutečná adresa je předposlední.
    const dvě = trustedCallerKey(
      požadavek({ 'x-forwarded-for': 'client-written, 203.0.113.99, 10.0.0.1' }),
      { [TRUSTED_PROXY_HOPS]: '2' },
    );
    expect(dvě).toContain('203.0.113.99');
  });

  it('volající neposune počítání od konce vlastními položkami', () => {
    // **Tohle je ta vlastnost, kvůli které se počítá od konce a ne od
    // začátku.** Útočník si do hlavičky napíše, co chce — prázdné položky,
    // čárky navíc, cizí adresy. Všechno to skončí vlevo od toho, co připsala
    // proxy, takže klíč se nehne.
    for (const lie of ['', ' ', ' , , ', 'unknown', '198.51.100.4, , 1.2.3.4']) {
      const key = trustedCallerKey(
        požadavek({ 'x-forwarded-for': `${lie}, 203.0.113.99` }),
        { [TRUSTED_PROXY_HOPS]: '1' },
      );
      expect(key, `lež "${lie}" pohnula klíčem`).toContain('203.0.113.99');
    }
  });

  it('nesmyslná nebo přestřelená hloubka dá `null`, ne vedlejší položku', () => {
    // Vyplněný nesmysl je pokus hloubku nastavit, a ten se nepovedl — to je
    // jiný stav než nevyplněno a odpověď je stejná: nevíme.
    for (const hloubka of ['0', '-1', '1.5', 'abc', '', ' ']) {
      expect(
        trustedCallerKey(požadavek({ 'x-forwarded-for': 'a, b' }), { [TRUSTED_PROXY_HOPS]: hloubka }),
        `hloubka "${hloubka}" prošla`,
      ).toBeNull();
    }

    // Hloubka větší než řetěz: proxy tolik položek nepřipsala, takže se
    // nesmí sáhnout po té, kterou napsal volající.
    expect(
      trustedCallerKey(požadavek({ 'x-forwarded-for': '203.0.113.99' }), {
        [TRUSTED_PROXY_HOPS]: '3',
      }),
    ).toBeNull();

    // Prázdná položka na spočítaném místě: „nevíme", ne „vezmi vedlejší".
    expect(
      trustedCallerKey(požadavek({ 'x-forwarded-for': '203.0.113.99, ' }), {
        [TRUSTED_PROXY_HOPS]: '1',
      }),
    ).toBeNull();
  });

  it('mimo Vercel je hlavička platformy obyčejná lež a hloubku nepřebije', () => {
    // **Blokující nález nezávislé revize 5. 9. 2026.** `x-vercel-forwarded-for`
    // přepisuje jedině vercelský edge. Kdekoli jinde si ji volající napíše sám,
    // a protože měla přednost před vyplněnou hloubkou, obcházela i správně
    // nastavenou nginx — tedy přesně ten režim, který `.env.example` prodává
    // jako chráněný.
    const zaNginx = trustedCallerKey(
      požadavek({
        'x-vercel-forwarded-for': '198.51.100.4',
        'x-forwarded-for': 'lie, 203.0.113.99',
      }),
      { [TRUSTED_PROXY_HOPS]: '1' },
    );
    expect(zaNginx, 'podvržená hlavička platformy přebila hloubku proxy').not.toContain(
      '198.51.100.4',
    );
    expect(zaNginx).toContain('203.0.113.99');

    // Bez proxy a mimo Vercel nezbývá důvěryhodný konec vůbec — `null`,
    // tedy kvóta vypnutá, ne klíč vybraný volajícím.
    expect(trustedCallerKey(požadavek({ 'x-vercel-forwarded-for': '198.51.100.4' }), {})).toBeNull();
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
});
