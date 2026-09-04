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
    expect(callerKey(forwarded), 'první položka je klient, zbytek jsou proxy').toBe(ME);

    const real = new Request('http://x/', { headers: { 'x-real-ip': SOMEONE_ELSE } });
    expect(callerKey(real)).toBe(SOMEONE_ELSE);

    // Bez hlaviček spadnou všichni do jednoho jména — lokální běh je jeden
    // stroj a jeden návštěvník.
    expect(callerKey(new Request('http://x/'))).toBe('unknown');

    // **Klíč je vstup od volajícího, takže se ořezává.** Bez toho by stačilo
    // posílat kilobajtové hlavičky a mapa oken by byla úložiště zdarma.
    const huge = new Request('http://x/', { headers: { 'x-forwarded-for': 'a'.repeat(5_000) } });
    expect(callerKey(huge).length).toBe(45);
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
