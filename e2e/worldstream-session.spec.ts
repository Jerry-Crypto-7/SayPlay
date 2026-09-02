import { expect, test, type Page } from '@playwright/test';

import { SseDecoder } from '../src/components/viewer/sse';
import type { SessionEvent } from '../src/worldstream/events';
import { deployedTarget } from './smoke-target';

/**
 * **Tři route relace přes skutečný `next start`** (P13 T16, §20 a §21).
 *
 * Jednotková sada vedle (`src/app/api/worldstream/__tests__/sessions.test.ts`)
 * volá handlery přímo a soudí jejich kontrakt. Tenhle soubor soudí to, co
 * jednotkový test soudit **nemůže**: že mezi handlerem a prohlížečem stojí
 * produkční server, který má vlastní názor na komprimaci a na to, kdy rámec
 * pustí ven. Právě tam se proud rozbije tiše — hlavičky odejdou první, takže
 * kanál, který drží rámce do konce, vypadá zvenčí jako úspěch.
 *
 * ## Co se tu dá ověřit a co ne
 *
 * ⚠ **Šťastná cesta `intent.ready → blueprint.ready → world.ready` tady není
 * a nemůže být.** Vyžaduje volání modelu, tedy `.env` s koncovým bodem, klíčem
 * a cenou (brána `G2` a úloha `T14`). Bez něj `cloudEmitter()` vrátí `null`,
 * relace vznikne a **poctivě skončí** `session.failed` — a to je maximum, které
 * jde dokázat zadarmo. Ověřuje ji jednotkový test se scriptovaným emitorem.
 *
 * Co tedy platí v obou konfiguracích a soudí se tady:
 *
 *  - `202` a obě adresy, ne hotový svět v odpovědi,
 *  - hlavičky proti bufferování **tak, jak dorazí ze sítě**,
 *  - žebřík je monotónní a začíná `session.accepted`,
 *  - obnovení od poslední sequence **nezopakuje** jediný stavový přechod,
 *  - snapshot vydá tentýž stav jako proud,
 *  - ven neteče nic z konfigurace poskytovatele.
 *
 * ## Proč se naviguje na `/api/build-id`, a ne na aplikaci
 *
 * Potřebný je jen **stejný původ**, aby šel z prohlížeče poslat relativní
 * `fetch`. Hlavní stránka by k tomu navíc nastartovala `ModelProgress`, tedy
 * stahování vah modelu, a tenhle soubor by pak měřil čas stahování místo
 * proudu. `/api/build-id` je jeden JSON řádek.
 */

/** Rámce z proudu, čtené v prohlížeči, s vlastním časovým rozpočtem. */
async function collect(
  page: Page,
  path: string,
  options: { readonly budgetMs?: number; readonly headers?: Record<string, string> } = {},
): Promise<{ readonly status: number; readonly headers: Record<string, string>; readonly events: SessionEvent[] }> {
  const read = await page.evaluate(
    async ({ url, budgetMs, headers }) => {
      const response = await fetch(url, { headers });
      const collected: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        collected[key] = value;
      });
      if (response.body === null || !response.ok)
        return { status: response.status, headers: collected, raw: await response.text() };

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const deadline = Date.now() + budgetMs;
      let raw = '';

      // Proud běžící relace sám neskončí, takže se čte na rozpočet. `race`
      // s časovačem je jediný způsob — `reader.read()` se zrušit nedá jinak
      // než `cancel()`, a ten se musí zavolat zvenčí čekání.
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const chunk = await Promise.race([
          reader.read(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
        ]);
        if (chunk === null) break;
        if (chunk.done) break;
        raw += decoder.decode(chunk.value, { stream: true });
      }
      await reader.cancel().catch(() => undefined);

      return { status: response.status, headers: collected, raw };
    },
    { url: path, budgetMs: options.budgetMs ?? 8_000, headers: options.headers ?? {} },
  );

  const decoder = new SseDecoder();
  const events = read.status === 200
    ? decoder.push(read.raw).map((frame) => JSON.parse(frame.data) as SessionEvent)
    : [];

  return { status: read.status, headers: read.headers, events };
}

interface Opened {
  readonly sessionId: string;
  readonly events: string;
  readonly snapshot: string;
}

async function open(page: Page, prompt: string): Promise<Opened> {
  const opened = await page.evaluate(async (sentence) => {
    const response = await fetch('/api/worldstream/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: sentence }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, string> };
  }, prompt);

  expect(opened.status, 'relace se zakládá odpovědí 202, ne hotovým světem').toBe(202);
  expect(opened.body.blueprint, 'odpověď na POST nesmí nést svět').toBeUndefined();

  return {
    sessionId: opened.body.sessionId,
    events: opened.body.events,
    snapshot: opened.body.snapshot,
  };
}

/**
 * ⛔ **Proti nasazené adrese tenhle soubor běžet nesmí.**
 *
 * `playwright.config.ts` přesměruje celý projekt `chromium` na
 * `FALLBACK_SMOKE_URL`, jakmile je nastavená. Každý test níž zakládá **skutečnou
 * relaci**, takže na nasazení s klíčem by jeden běh koupil čtyři generace
 * z živého stropu utrácení — a nikde by to nebylo vidět, protože sada by
 * zůstala zelená. Lokálně je to zadarmo (`cloudEmitter()` bez `.env` vrátí
 * `null`), a to je jediná konfigurace, ve které se to smí pouštět.
 * Nález nezávislé revize 2. 9. 2026.
 */
test.skip(
  deployedTarget() !== undefined,
  'zakládá skutečné relace, takže proti nasazené adrese by utrácel',
);

test.beforeEach(async ({ page }) => {
  await page.goto('/api/build-id');
});

test('věta založí relaci a proud ji vydá jako monotónní žebřík', async ({ page }) => {
  const session = await open(page, 'a salt flat with one iron mast standing in the middle of it');

  expect(session.events).toBe(`/api/worldstream/sessions/${session.sessionId}/events`);
  expect(session.snapshot).toBe(`/api/worldstream/sessions/${session.sessionId}`);

  const stream = await collect(page, session.events);

  expect(stream.status).toBe(200);
  expect(stream.headers['content-type']).toBe('text/event-stream; charset=utf-8');
  // **Tohle jednotkový test ověřit nemůže.** `next start` prohání každou
  // odpověď vestavěnou komprimací a `text/event-stream` spadne pod pravidlo
  // `^text/`; bez `no-transform` zlib rámce zadrží, dokud nenaplní vyrovnávací
  // paměť. Naměřeno na `/api/emit/stream`: sedm rámců psaných po 30 ms odešlo
  // jako jeden kus po 243 ms.
  expect(stream.headers['cache-control']).toBe('no-store, no-transform');
  expect(stream.headers['x-accel-buffering']).toBe('no');

  expect(stream.events.length, 'proud nevydal jediný rámec').toBeGreaterThan(0);
  expect(stream.events[0].type).toBe('session.accepted');
  expect(stream.events[0].sequence).toBe(1);
  expect(new Set(stream.events.map((event) => event.sessionId))).toEqual(
    new Set([session.sessionId]),
  );

  // Monotónnost je celý §20: `sequence` rozhoduje pořadí, `at` je observační.
  const sequences = stream.events.map((event) => event.sequence);
  expect(sequences).toEqual([...sequences].sort((a, b) => a - b));

  // Bez `.env` je tohle konec cesty a je poctivý: relace vznikla, prošla
  // moderací i admission a skončila veřejnou větou. S `.env` dojde dál —
  // proto se soudí obojí, ne jedna z těch dvou konfigurací.
  const last = stream.events.at(-1)!;
  expect(['session.failed', 'intent.ready', 'blueprint.ready', 'world.ready']).toContain(last.type);
});

test('obnovení od poslední sequence nezopakuje stavový přechod', async ({ page }) => {
  const session = await open(page, 'a drowned cathedral with its bells still above the water');

  const first = await collect(page, session.events);
  expect(first.events.length, 'z prázdného proudu se obnovovat nedá').toBeGreaterThan(0);
  const seen = first.events.at(-1)!.sequence;

  // Přesně to, co dělá klient po výpadku spojení: navázat za posledním číslem,
  // které autoritativně viděl.
  const resumed = await collect(page, `${session.events}?since=${seen}`, { budgetMs: 3_000 });
  const repeated = resumed.events.filter((event) => event.sequence <= seen);
  expect(repeated, 'obnovený proud zopakoval rámec, který klient už viděl').toEqual([]);

  // Táž otázka hlavičkou, protože `EventSource` ji posílá sám a klient o ní neví.
  const byHeader = await collect(page, session.events, {
    budgetMs: 3_000,
    headers: { 'last-event-id': String(seen) },
  });
  expect(byHeader.events.filter((event) => event.sequence <= seen)).toEqual([]);
});

test('nesmyslný bod obnovení je 400, ne relace přehraná od nuly', async ({ page }) => {
  const session = await open(page, 'a rope bridge over a canyon of red rock');

  // Tichá nula by znamenala přehrát relaci od začátku klientovi, který se
  // právě obnovoval — tedy zopakovat každý stavový přechod, což je přesně ta
  // vada, kvůli které ten parametr existuje.
  const rejected = await collect(page, `${session.events}?since=abc`, { budgetMs: 2_000 });
  expect(rejected.status).toBe(400);
});

test('neznámá relace je 404 na proudu i na snapshotu', async ({ page }) => {
  const missing = await page.evaluate(async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const stream = await fetch(`/api/worldstream/sessions/${id}/events`);
    const snapshot = await fetch(`/api/worldstream/sessions/${id}`);
    return {
      stream: { status: stream.status, body: await stream.text() },
      snapshot: { status: snapshot.status, body: await snapshot.text() },
    };
  });

  expect(missing.stream.status).toBe(404);
  expect(missing.snapshot.status).toBe(404);
  // 404 na proudu musí být JSON s kódem, ne prázdný `text/event-stream` —
  // prázdný proud je od mlčícího serveru nerozeznatelný.
  expect(JSON.parse(missing.stream.body).error.code).toBe('UNKNOWN_SESSION');
});

test('snapshot vydá tentýž stav jako proud a nic z konfigurace poskytovatele', async ({ page }) => {
  const session = await open(page, 'a lighthouse on a spit of black sand');

  const stream = await collect(page, session.events);
  const snapshot = await page.evaluate(async (url) => {
    const response = await fetch(url);
    return {
      status: response.status,
      cacheControl: response.headers.get('cache-control'),
      raw: await response.text(),
    };
  }, session.snapshot);

  expect(snapshot.status).toBe(200);
  expect(snapshot.cacheControl).toBe('no-store');

  const body = JSON.parse(snapshot.raw) as Record<string, unknown>;
  expect(body.sessionId).toBe(session.sessionId);
  // Klient si po reconnectu vyžádá události **za tímhle číslem**, takže se
  // snapshot a proud nesmějí rozejít ani o jeden rámec.
  expect(body.sequence).toBe(stream.events.at(-1)!.sequence);

  // Text výjimky `fetch` nese celou adresu koncového bodu a ta umí nést
  // pověření (`?key=`, `https://user:heslo@…`). Ven jde věta ze slovníku.
  expect(snapshot.raw).not.toMatch(/WORLDSMITH_|Bearer|api[_-]?key|https?:\/\//i);
  expect(JSON.stringify(stream.events)).not.toMatch(/WORLDSMITH_|Bearer|api[_-]?key/i);
});
