import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_REQUESTS_PER_WINDOW,
  RATE_WINDOW_MS,
  rateLimitedResponse,
  resetRateWindows,
  takeRateSlot,
} from '../rate-limit';

/** Začátek okna, aby se v případech počítalo od kulatého čísla. */
const T0 = 1_000 * RATE_WINDOW_MS;

/** Vystřelí `count` požadavků do téhož okamžiku a vrátí poslední verdikt. */
function burst(door: 'edit' | 'emit' | 'sessions', count: number, atMs: number) {
  let last = takeRateSlot(door, atMs);
  for (let i = 1; i < count; i += 1) last = takeRateSlot(door, atMs);
  return last;
}

describe('strop na frekvenci veřejných dveří', () => {
  afterEach(() => {
    resetRateWindows();
  });

  it('pustí přesně tolik požadavků, kolik říká strop, a další odmítne', () => {
    expect(burst('edit', MAX_REQUESTS_PER_WINDOW, T0).allowed).toBe(true);
    const over = takeRateSlot('edit', T0);
    expect(over.allowed).toBe(false);
    expect(over.count).toBe(MAX_REQUESTS_PER_WINDOW + 1);
    expect(over.limit).toBe(MAX_REQUESTS_PER_WINDOW);
  });

  it('odmítnutý požadavek se POČÍTÁ, takže mlácením na dveře se okno nekupuje', () => {
    // Kdyby se počítaly jen propuštěné, útočník na maximu by dostal na začátku
    // každého okna čerstvý strop a odmítnutí by ho nestálo nic.
    burst('edit', MAX_REQUESTS_PER_WINDOW + 20, T0);
    expect(takeRateSlot('edit', T0)).toMatchObject({
      allowed: false,
      count: MAX_REQUESTS_PER_WINDOW + 21,
    });
  });

  it('další okno začíná načisto', () => {
    burst('edit', MAX_REQUESTS_PER_WINDOW + 1, T0);
    const next = takeRateSlot('edit', T0 + RATE_WINDOW_MS);
    expect(next).toMatchObject({ allowed: true, count: 1 });
  });

  it('okno je ukotvené na absolutním čase, ne na prvním požadavku', () => {
    // **Kotva na prvním požadavku by se dala posouvat.** Kdo pošle jeden
    // požadavek na konci okna, posunul by si tím celé následující okno a
    // strop by se dal donekonečna odkládat. Hranice je proto násobek délky.
    burst('edit', MAX_REQUESTS_PER_WINDOW, T0 + RATE_WINDOW_MS - 1);
    expect(takeRateSlot('edit', T0 + RATE_WINDOW_MS - 1).allowed).toBe(false);
    expect(takeRateSlot('edit', T0 + RATE_WINDOW_MS).allowed).toBe(true);
  });

  it('každé dveře mají vlastní okno — nápor na jedny nezavře druhé', () => {
    // Kdyby byl čítač jeden, nejlevnější dveře by uměly vypnout ty ostatní,
    // včetně zakládání relace, tedy hlavní věci, kterou má porotce vidět.
    burst('edit', MAX_REQUESTS_PER_WINDOW + 1, T0);
    expect(takeRateSlot('emit', T0).allowed).toBe(true);
    expect(takeRateSlot('sessions', T0).allowed).toBe(true);
  });

  it('retry-after je zbytek okna, nikdy nula a nikdy víc než celé okno', () => {
    // Nula by byla pozvánka zpátky do téhož odmítnutí ve stejném taktu.
    const wholeWindow = RATE_WINDOW_MS / 1000;
    expect(takeRateSlot('edit', T0).retryAfterSeconds).toBe(wholeWindow);
    expect(takeRateSlot('edit', T0 + RATE_WINDOW_MS - 1).retryAfterSeconds).toBe(1);
    for (const offset of [0, 1, 4_999, RATE_WINDOW_MS - 1]) {
      const { retryAfterSeconds } = takeRateSlot('edit', T0 + offset);
      expect(retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(retryAfterSeconds).toBeLessThanOrEqual(wholeWindow);
    }
  });

  it('strop je odvozený z naměřeného p95, ne vybraný', () => {
    // 50 za 10 s = 5/s; při p95 27,7 ms je to ~138 ms práce na sekundu smyčky.
    // Troje dveře dohromady drží 15/s, tedy čtyřnásobnou rezervu proti
    // naměřeným ~66/s, kde se instance zastaví. Pinuje se ten výpočet, aby se
    // číslo nedalo posunout bez toho, že by se posunula i tahle úvaha.
    const perSecondPerDoor = MAX_REQUESTS_PER_WINDOW / (RATE_WINDOW_MS / 1000);
    expect(perSecondPerDoor).toBe(5);
    expect(perSecondPerDoor * 3).toBeLessThan(66 / 4 + 1);
    expect(perSecondPerDoor * 27.7).toBeLessThan(200);
  });

  it('odpověď nese 429, retry-after a kód, který nemluví o volajícím', async () => {
    const verdict = takeRateSlot('edit', T0);
    const response = rateLimitedResponse('req-9', verdict);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe(String(verdict.retryAfterSeconds));
    expect(await response.json()).toEqual({
      requestId: 'req-9',
      error: {
        code: 'TOO_MANY_REQUESTS',
        message: `too many requests: at most ${String(MAX_REQUESTS_PER_WINDOW)} per ${String(
          RATE_WINDOW_MS / 1000,
        )} seconds`,
      },
    });
  });
});
