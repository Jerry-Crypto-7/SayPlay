/**
 * **Tři route relace: založit, přečíst, poslouchat** (P13 T16, §20 a §21).
 *
 * Do 2. 9. 2026 byly všechny tři **bez oracle**: zelený byl `tsc --noEmit` a
 * testy modulů pod nimi. To je proxy, ne důkaz — modul může být v pořádku a
 * route ho zapojit obráceně, a právě u proudu se to nepozná pohledem: hlavičky
 * odejdou dřív než první rámec, takže mlčící kanál vypadá zvenčí jako úspěch.
 *
 * ## Co se tu soudí a co ne
 *
 * Soudí se **kontrakt tří dveří**: co projde dovnitř, co se vrátí ven a co
 * uvidí klient, který se připojil pozdě nebo se vrátil po výpadku. Nesoudí se
 * kvalita světa — tu měří compiler a jeho vlastní sada, a živě `T14`.
 *
 * Šťastná cesta `intent.ready → blueprint.ready → world.ready` jede přes
 * **scriptovaný emitor**, ne přes poskytovatele. Je to jediný způsob, jak ji
 * ověřit bez `.env` a bez placeného volání; vzor je
 * `src/model/__tests__/worldstream-repair.test.ts`.
 *
 * ## Fixtura je malá schválně
 *
 * Blueprint níž má tři objekty, ne pět. Nesoudí se jím geometrie — jen to, že
 * generace dojde na konec a vydá po cestě tři rámce ve správném pořadí. Kdyby
 * fixtura rostla, začne tenhle soubor červenat na změnách compileru, které se
 * route netýkají.
 */

import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SseDecoder } from '../../../../components/viewer/sse';
import type { SessionEvent, SessionEventLog } from '../../../../worldstream/events';
import {
  clearSessions,
  getSession,
  liveSessionCount,
  MAX_LIVE_SESSIONS,
  MAX_SESSIONS_PER_CALLER,
  openSession,
  QUOTA_ENGAGES_AT,
  runGeneration,
  serverGrammar,
} from '../../../../worldstream/sessions';
import { ANSWER, PLAN, generated, grammar, scripted } from './world-fixture';

// `serverGrammar` se obaluje, ne nahrazuje: propouští skutečné čtení protokolu
// a jediný test níž ho na jedno volání přepne na nečitelný, aby se dala
// změřit odmítnutá cesta, která jinak zevnitř procesu žádný pozorovatelný
// následek nemá.
vi.mock('../../../../worldstream/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../worldstream/sessions')>();
  return { ...actual, serverGrammar: vi.fn(actual.serverGrammar) };
});
import { resetFaultLog } from '../../../../server/public-faults';
import { MAX_REQUESTS_PER_WINDOW, resetRateWindows, takeRateSlot } from '../../../../server/rate-limit';
import { DEFAULT_CAP_USD } from '../../../../server/spend-cap';
import {
  acquireSlot,
  MAX_CONCURRENT_GENERATIONS,
  MAX_WORLD_GENERATIONS,
  POST as createSession,
  WORLDSTREAM_SPEND_CAP,
  cloudEmitter,
  resetConcurrency,
} from '../sessions/route';
import { GET as readSnapshot } from '../sessions/[sessionId]/route';
import {
  HEARTBEAT_FRAME,
  MAX_STREAM_SUBSCRIBERS,
  GET as readEvents,
  resetStreamSubscribers,
  streamedSessionCount,
} from '../sessions/[sessionId]/events/route';

/* ------------------------------------------------------------------ *
 * Volání route.
 * ------------------------------------------------------------------ */

function createRequest(body: unknown, caller?: string): Request {
  return new Request('http://127.0.0.1/api/worldstream/sessions', {
    method: 'POST',
    headers:
      caller === undefined
        ? { 'content-type': 'application/json' }
        : { 'content-type': 'application/json', 'x-forwarded-for': caller },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function params(sessionId: string): { params: Promise<{ sessionId: string }> } {
  return { params: Promise.resolve({ sessionId }) };
}

function events(sessionId: string, query = '', headers: Record<string, string> = {}): Promise<Response> {
  return readEvents(
    new Request(`http://127.0.0.1/api/worldstream/sessions/${sessionId}/events${query}`, { headers }),
    params(sessionId),
  );
}

/* ------------------------------------------------------------------ *
 * Čtení proudu.
 * ------------------------------------------------------------------ */

/**
 * Rámce z proudu, dokud jich není `atLeast` nebo dokud proud neskončí.
 *
 * Proud běžící relace **nikdy sám neskončí**, takže čtení bez horní meze by
 * sadu zaseklo na timeoutu vitestu místo toho, aby ji shodilo na tvrzení.
 * `cancel()` po dosažení počtu je zároveň jediný způsob, jak se v testu dostat
 * na větev `cancel` samotné route.
 */
async function readFrames(response: Response, atLeast = Number.POSITIVE_INFINITY): Promise<SessionEvent[]> {
  if (response.body === null) throw new Error('the stream carried no body');

  const reader = response.body.getReader();
  const decoder = new SseDecoder();
  const text = new TextDecoder();
  const frames: SessionEvent[] = [];

  for (;;) {
    if (frames.length >= atLeast) {
      await reader.cancel();
      break;
    }
    const { done, value } = await reader.read();
    if (done) break;
    for (const frame of decoder.push(text.decode(value, { stream: true })))
      frames.push(JSON.parse(frame.data) as SessionEvent);
  }

  return frames;
}

/** Syrový text proudu, bez dekódování. Kvůli tvrzením o `id:` a komentářích. */
async function readRaw(response: Response, chunks = 1): Promise<string> {
  if (response.body === null) throw new Error('the stream carried no body');
  const reader = response.body.getReader();
  const text = new TextDecoder();
  let raw = '';
  for (let read = 0; read < chunks; read += 1) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += text.decode(value, { stream: true });
  }
  await reader.cancel();
  return raw;
}


afterEach(() => {
  clearSessions();
  resetConcurrency();
  // Počty odběratelů proudu jsou stav modulu stejně jako čítač souběhu: proud,
  // který si test nechal otevřený, by jinak ubral slot každému dalšímu testu.
  resetStreamSubscribers();
  // Počítadlo okna v `public-faults` je stav modulu: bez vynulování by druhý
  // producent téže dvojice (dveře, kód) byl `occurrence 2`, tedy mimo milník,
  // a tvrzení „řádek odešel" by mlčky zčervenalo v cizím testu.
  resetFaultLog();
  // Špionáž na `console.error` (odmítnutí náporem) nesmí přežít do dalšího
  // testu — tichý log by z něj udělal zelenou z jiného důvodu.
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ *
 * POST /api/worldstream/sessions
 * ------------------------------------------------------------------ */

describe('založení relace', () => {
  it('vrací 202 a obě adresy, ne hotový svět', async () => {
    const response = await createSession(createRequest({ prompt: 'a salt flat with one iron mast' }));
    const body = (await response.json()) as Record<string, string>;

    expect(response.status).toBe(202);
    expect(body.sessionId).toMatch(/[0-9a-f-]{36}/);
    expect(body.events).toBe(`/api/worldstream/sessions/${body.sessionId}/events`);
    expect(body.snapshot).toBe(`/api/worldstream/sessions/${body.sessionId}`);
    // Odpověď **nenese svět**. Kdyby ho nesla, byla by to synchronní route
    // s jiným rozpočtem, a proud i snapshot vedle by byly na ozdobu.
    expect(body).not.toHaveProperty('blueprint');
  });

  it('geometrii od klienta odmítne, místo aby ji tiše zahodila', async () => {
    // Nosné tvrzení celého endpointu: kdyby se klíč navíc ignoroval, dal by se
    // `ShapeProgram` podstrčit zvenčí a produkt by pořád tvrdil, že geometrii
    // píše model.
    for (const smuggled of ['shapes', 'geometry', 'placements', 'world']) {
      const response = await createSession(
        createRequest({ prompt: 'a salt flat', [smuggled]: ANSWER[smuggled] ?? {} }),
      );
      const body = (await response.json()) as { error: { code: string; message: string } };

      expect(response.status).toBe(400);
      expect(body.error.code).toBe('UNEXPECTED_FIELDS');
      expect(body.error.message).toContain(smuggled);
    }
  });

  it('odmítne tělo, které není JSON objekt', async () => {
    for (const [body, code] of [
      ['{ not json', 'BODY_NOT_JSON'],
      ['[]', 'BODY_NOT_AN_OBJECT'],
      ['"a salt flat"', 'BODY_NOT_AN_OBJECT'],
      ['', 'BODY_NOT_AN_OBJECT'],
    ] as const) {
      const response = await createSession(createRequest(body));
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
    }
  });

  it('relace vzniká až za moderací', async () => {
    for (const [prompt, category] of [
      ['', 'EMPTY'],
      ['   ', 'EMPTY'],
      [42, 'NOT_TEXT'],
    ] as const) {
      const response = await createSession(createRequest({ prompt }));
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(category);
    }
    // Nic z toho nesmělo založit relaci — kdyby ano, moderace by běžela až za
    // registrem a odmítnutá věta by po sobě nechala stopu.
    const snapshot = await readSnapshot(new Request('http://127.0.0.1/x'), params('anything'));
    expect(snapshot.status).toBe(404);
  });

  it('nad stropem souběhu odmítne, místo aby platila za všechny naráz', async () => {
    // ⚠ **Do 3. 9. 2026 tenhle test nemohl spadnout.** Posílal `MAX + 1`
    // požadavků za sebou a soudil `202 || 503`, jenže bez `.env` generace
    // doběhne hned a `work.finally` slot vrátí dřív, než se pošle další —
    // čítač se tak nikdy nenasytil a obě povolené odpovědi byly pravda.
    // Nález nezávislé revize. Slot se proto bere **ručně**, což je jediný
    // způsob, jak strop v jednom procesu doopravdy nasytit.
    // **Odmítnutí musí být vidět v operátorském logu**, jinak je brána na
    // nasazené adrese nepozorovatelná: 503 vidí jen ten, kdo ho dostal, a
    // „strop nás ochránil" se nedá odlišit od „nikdo nepřišel". Je to jediný
    // producent tohohle klíče v celém souboru, takže výskyt je první a
    // `logRateLimited` ho vydá i s promlčením.
    const log: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      log.push(String(line));
    });
    // Nasytí se **strop těchhle dveří**, ne celý čítač: zakládání se zastaví
    // o slot dřív, aby čtyři pomalé generace nevypnuly druhou větu.
    for (let i = 0; i < MAX_WORLD_GENERATIONS; i += 1)
      expect(acquireSlot('world'), `slot ${i} měl být volný`).toBe(true);

    const response = await createSession(createRequest({ prompt: 'a salt flat' }));

    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'TOO_MANY_SESSIONS',
    );

    const refusals = log.filter((line) => line.includes('TOO_MANY_SESSIONS'));
    expect(refusals, 'odmítnutí náporem neodešlo operátorovi').toHaveLength(1);
    expect(refusals[0]).toContain('[worldstream/sessions]');
  });

  it('odmítnutí nad stropem nesáhne na disk — brána je před čtením protokolu', () => {
    // Tehdy `serverGrammar()` cachované nebylo: dva `readFileSync`, sha256 a
    // `JSON.parse` nad 26 kB, všechno blokuje smyčku událostí. Naměřeno
    // nezávislou revizí 3. 9. 2026: s bránou až za čtením stál požadavek
    // odsouzený k `503` **2,223 ms**, tedy 2,2 s zablokovaného Node na tisíc
    // odmítnutí — a s ním stály i SSE proudy a preview. **Od `f5b1b49`
    // cachované je**, takže tu cenu platí jen první požadavek na instanci —
    // což je pořád důvod, proč brána zůstává před čtením.
    //
    // Soudí se **pořadí ve zdroji**, protože zevnitř jednoho procesu to jinak
    // změřit nejde: čtení protokolu nemá pozorovatelný následek, na kterém by
    // se odmítnutá cesta dala chytit, a časové měření by soudilo stroj.
    //
    // **Komentáře se odstřihnou.** Zakomentovaný `releaseSlot();` by jinak
    // bránu prošel – přesně tenhle mutant přežil 3. 9. 2026, dokud se soudil
    // surový zdroj. Totéž dělá lexikální brána v `spend-cap.test.ts`.
    const source = readFileSync('src/app/api/worldstream/sessions/route.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const gate = source.indexOf("if (!acquireSlot('world'))");
    const grammarRead = source.indexOf('const grammar = serverGrammar();');

    expect(gate, 'brána souběhu ve zdroji chybí').toBeGreaterThan(-1);
    expect(grammarRead, 'čtení protokolu ve zdroji chybí').toBeGreaterThan(-1);
    expect(gate, 'brána souběhu je až za čtením protokolu').toBeLessThan(grammarRead);

  });

  it('nečitelný protokol vrátí slot, a vrátí ho právě jednou', async () => {
    // Druhá polovina té výměny: slot vzatý před čtením se musí vrátit, když
    // protokol přečíst nejde. Bez toho by nečitelný protokol slot spolkl a po
    // čtyřech požadavcích by neprošel nikdo.
    //
    // Soudí se **chování**, ne zdroj. Lexikální brána nad `releaseSlot();`
    // pustila 3. 9. 2026 dva mutanty: vrácení smazané a nahrazené koncovým
    // komentářem, a vrácení přesunuté před podmínku, které by každý úspěšný
    // požadavek vracelo dvakrát a čítač zahnalo do záporu — po čemž by strop
    // souběhu už nikdy neodmítl. Počet volných slotů po odmítnutí obojí odliší.
    vi.mocked(serverGrammar).mockReturnValueOnce('protocol unreadable for this test');

    const response = await createSession(createRequest({ prompt: 'a salt flat' }));
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'GRAMMAR_UNREADABLE',
    );

    // **Ptá se to čítače, který mohl uplavat — tedy `world`.** Do 4. 9. 2026
    // se sonda ptala levných dveří, a nezávislá revize ji spustila jako
    // dekorativní: jakmile dostalo `refine` vlastní strop pod dnem, odmítalo
    // poslední pokus **vlastním** stropem, ať byl `running.world` nula, nebo
    // mínus tři. Oba mutanty, které ten komentář jmenuje, tím přežily.
    for (let i = 0; i < MAX_WORLD_GENERATIONS; i += 1)
      expect(acquireSlot('world'), `slot ${i} měl být volný — odmítnutí ho nevrátilo`).toBe(true);
    expect(acquireSlot('world'), 'čítač je v záporu — slot se vrátil víckrát než jednou').toBe(
      false,
    );
  });

  it('přijatý požadavek vrátí slot právě jednou, a to až ve `finally`', async () => {
    // Druhý mutant z revize 3. 9. 2026: `releaseSlot()` přesunuté před
    // podmínku nečitelného protokolu. Odmítnutá cesta vypadá správně, ale
    // každý **přijatý** požadavek pak vrací dvakrát — jednou hned, jednou ve
    // `finally` — a čítač jde do záporu, po čemž strop souběhu už neodmítne.
    const response = await createSession(createRequest({ prompt: 'a salt flat' }));
    expect(response.status).toBe(202);

    // Bez `.env` generace selže čistě v mikrotascích; jedna makrotasková
    // hranice ji nechá doběhnout i s `finally`, aniž se měří čas.
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Sonda se ptá **týchž dveří, kterými slot odešel** — jinak ji odmítne
    // vlastní strop těch druhých a nezměří nic. Viz test nad tímhle.
    for (let i = 0; i < MAX_WORLD_GENERATIONS; i += 1)
      expect(acquireSlot('world'), `slot ${i} měl být volný — finally ho nevrátilo`).toBe(true);
    expect(acquireSlot('world'), 'čítač je v záporu — slot se vrátil dvakrát').toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * GET /api/worldstream/sessions/:id
 * ------------------------------------------------------------------ */

describe('snapshot relace', () => {
  it('neznámá relace je 404, ne prázdný stav', async () => {
    const response = await readSnapshot(new Request('http://127.0.0.1/x'), params('no-such-session'));
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('UNKNOWN_SESSION');
  });

  it('vydá celý stav jedním kusem a nekešuje se', async () => {
    const stored = await generated();
    const response = await readSnapshot(new Request('http://127.0.0.1/x'), params(stored.session.sessionId));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body.phase).toBe('world');
    // Klient si po reconnectu vyžádá události **za tímhle číslem**, takže musí
    // odpovídat tomu, kam došel log — ne počtu objektů nebo fází.
    expect(body.sequence).toBe(stored.session.events.sequence);
    expect(body.blueprint).not.toBeNull();
    expect(body.fault).toBeNull();
    expect(body.representations).toHaveLength(2);
  });

  it('ven nejde nic z konfigurace poskytovatele', async () => {
    const stored = await generated();
    stored.fault = 'the model could not be reached';
    const response = await readSnapshot(new Request('http://127.0.0.1/x'), params(stored.session.sessionId));
    const raw = await response.text();

    // Text výjimky `fetch` nese celou adresu koncového bodu včetně pověření
    // v dotazu. Ven jde věta ze slovníku, do logu operátora všechno ostatní.
    expect(raw).not.toMatch(/WORLDSMITH_|apiKey|Bearer|https?:\/\//i);
    expect(JSON.parse(raw).fault).toBe('the model could not be reached');
  });
});

/* ------------------------------------------------------------------ *
 * GET /api/worldstream/sessions/:id/events
 * ------------------------------------------------------------------ */

describe('proud relace', () => {
  it('hlavičky brání bufferování stejně jako u /api/emit/stream', async () => {
    const stored = await generated();
    const response = await events(stored.session.sessionId);

    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    // `no-transform` je proti kompresi v procesu, `x-accel-buffering` proti
    // obrácené proxy. Jedno druhé nenahrazuje a bez obou dorazí průběh naráz.
    expect(response.headers.get('cache-control')).toBe('no-store, no-transform');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    await readFrames(response, 1);
  });

  it('neznámá relace je 404 a JSON, ne prázdný proud', async () => {
    const response = await events('no-such-session');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('UNKNOWN_SESSION');
  });

  it('přehraje celou relaci v pořadí a čísla jdou po jedné', async () => {
    const stored = await generated();
    stored.session.fail('done for the test');
    // Proud koncové relace se zavře sám, takže se dá dočíst do konce.
    const frames = await readFrames(await events(stored.session.sessionId));

    expect(frames.map((frame) => frame.type)).toEqual([
      'session.accepted',
      'intent.ready',
      'blueprint.ready',
      'world.ready',
      'session.failed',
    ]);
    expect(frames.map((frame) => frame.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(frames.map((frame) => frame.sessionId))).toEqual(
      new Set([stored.session.sessionId]),
    );
  });

  it('rámec nese `id:` se sequence, aby EventSource uměl navázat sám', async () => {
    const stored = await generated();
    const raw = await readRaw(await events(stored.session.sessionId));

    expect(raw).toMatch(/^id: 1\nevent: session\.accepted\ndata: \{/);
  });

  it('`?since=` nezopakuje stavový přechod, který klient už viděl', async () => {
    const stored = await generated();
    stored.session.fail('done for the test');
    const frames = await readFrames(await events(stored.session.sessionId, '?since=3'));

    expect(frames.map((frame) => frame.type)).toEqual(['world.ready', 'session.failed']);
    expect(frames.map((frame) => frame.sequence)).toEqual([4, 5]);
  });

  it('`Last-Event-ID` dělá totéž, protože ho posílá prohlížeč sám', async () => {
    const stored = await generated();
    stored.session.fail('done for the test');
    const frames = await readFrames(
      await events(stored.session.sessionId, '', { 'last-event-id': '3' }),
    );

    expect(frames.map((frame) => frame.sequence)).toEqual([4, 5]);
  });

  it('výslovný `?since=` přebije hlavičku od prohlížeče', async () => {
    const stored = await generated();
    stored.session.fail('done for the test');
    const frames = await readFrames(
      await events(stored.session.sessionId, '?since=4', { 'last-event-id': '1' }),
    );

    expect(frames.map((frame) => frame.sequence)).toEqual([5]);
  });

  it('`?since=` bez hodnoty neumlčí hlavičku a nepřehraje relaci od nuly', async () => {
    // Nález nezávislé revize 2. 9. 2026, ověřený nad handlerem: `??` bere `''`
    // jako přítomnou odpověď, takže prázdný dotaz udělal obojí naráz —
    // zahodil `Last-Event-ID`, který klient poslal, a spadl na nulu. Klient,
    // který se obnovoval, tak dostal každý stavový přechod podruhé.
    const stored = await generated();
    stored.session.fail('done for the test');
    const frames = await readFrames(
      await events(stored.session.sessionId, '?since=', { 'last-event-id': '3' }),
    );

    expect(frames.map((frame) => frame.sequence)).toEqual([4, 5]);
  });

  it('opakovaný `?since=` navazuje na první použitelný kurzor, ne na nulu', async () => {
    // Nález nezávislé revize 2. 9. 2026. `searchParams.get()` vrací **první**
    // výskyt, takže `?since=&since=3` spadlo na prázdný řetězec, a s ním na
    // `after: 0` — klient se obnovoval a dostal celou relaci znovu. Adresu
    // staví klient z toho, co mu vydal server, takže to zvenčí vnutit nejde;
    // drží to vlastnost, ne díru.
    const stored = await generated();
    stored.session.fail('done for the test');
    const frames = await readFrames(await events(stored.session.sessionId, '?since=&since=3'));

    expect(frames.map((frame) => frame.sequence)).toEqual([4, 5]);
  });

  it('prázdný dotaz i prázdná hlavička znamenají první připojení, ne chybu', async () => {
    // Druhá polovina téhož: klient bez kurzoru relaci od začátku dostat MÁ.
    const stored = await generated();
    stored.session.fail('done for the test');
    const frames = await readFrames(
      await events(stored.session.sessionId, '?since=', { 'last-event-id': '' }),
    );

    expect(frames.map((frame) => frame.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it('useknutý požadavek vrátí odběr logu, ne až čtenář proudu', async () => {
    // `next` proud podle `dist/server/pipe-readable.js` nezačne číst vůbec,
    // když je odpověď v tu chvíli už zničená — takže `cancel()` nemusí přijít
    // nikdy a bez druhých dveří by odběr i časovač přežily požadavek.
    // Soudí se **vrácení odběru**, ne počet odběratelů: ten log zvenčí
    // nezveřejňuje, a tvrzení nad vlastní sondou by neměřilo route.
    const stored = await generated();
    const log = stored.session.events;
    const subscribe = log.subscribe.bind(log);
    let released = false;
    (log as { subscribe: SessionEventLog['subscribe'] }).subscribe = (listener) => {
      const off = subscribe(listener);
      return () => {
        released = true;
        off();
      };
    };

    const controller = new AbortController();
    const response = await readEvents(
      new Request(`http://127.0.0.1/api/worldstream/sessions/${stored.session.sessionId}/events`, {
        signal: controller.signal,
      }),
      params(stored.session.sessionId),
    );
    expect(response.status).toBe(200);
    expect(released, 'odběr se vrátil dřív, než klient odešel').toBe(false);

    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(released, 'odběr logu přežil useknutý požadavek').toBe(true);
    await response.body?.cancel().catch(() => undefined);
  });

  it('požadavek, který dorazí už useknutý, odběr nedostane vůbec', async () => {
    // Druhá polovina téhož nálezu, a ta dražší: na signálu, který je zrušený
    // dřív, než se route rozběhne, se `abort` už nikdy nevystřelí — posluchač
    // zapsaný na hotovou událost nedostane nic. `start()` přitom běží
    // synchronně uvnitř `new ReadableStream`, takže odběr i patnáctivteřinový
    // časovač v tu chvíli existují a bez dotazu na `aborted` by přežily do
    // restartu procesu. Zvenčí to nejde poznat: odpověď je 200 jako každá jiná.
    const stored = await generated();
    const log = stored.session.events;
    const subscribe = log.subscribe.bind(log);
    let subscribed = false;
    let released = false;
    (log as { subscribe: SessionEventLog['subscribe'] }).subscribe = (listener) => {
      subscribed = true;
      const off = subscribe(listener);
      return () => {
        released = true;
        off();
      };
    };

    const controller = new AbortController();
    controller.abort();
    const response = await readEvents(
      new Request(`http://127.0.0.1/api/worldstream/sessions/${stored.session.sessionId}/events`, {
        signal: controller.signal,
      }),
      params(stored.session.sessionId),
    );

    expect(subscribed, 'odběr vůbec nevznikl, takže test neměří, co si myslí').toBe(true);
    expect(released, 'odběr logu přežil požadavek, který dorazil zrušený').toBe(true);
    await response.body?.cancel().catch(() => undefined);
  });

  it('klient, který předběhl proud, nedostane nic — ne relaci od nuly', async () => {
    const stored = await generated();
    stored.session.fail('done for the test');
    const frames = await readFrames(await events(stored.session.sessionId, '?since=99'));

    expect(frames).toEqual([]);
  });

  it('nesmysl v bodě obnovení je 400, ne tichá nula', async () => {
    // Tohle je celý důvod, proč se parametr čte přísně. Tiché „neumím to
    // přečíst, beru od nuly" znamená přehrát relaci od začátku klientovi,
    // který se právě obnovoval — tedy zopakovat každý stavový přechod.
    const stored = await generated();
    for (const since of ['abc', '-1', '3.5', ' 3', '0x3', '1e3', '99999999999999999999']) {
      const response = await events(stored.session.sessionId, `?since=${encodeURIComponent(since)}`);
      expect(response.status, since).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'BAD_RESUME_POINT',
      );
    }
  });

  it('rámec zapsaný po připojení dorazí živě', async () => {
    const stored = await generated();
    const response = await events(stored.session.sessionId, '?since=4');

    // Čtyři rámce už proud viděl, takže backlog je prázdný a tohle je jediné,
    // co může dorazit — kdyby odběr nebyl zapojený, test spadne na timeoutu
    // vitestu, ne na tvrzení.
    stored.session.queue('ironMast', 32);
    const frames = await readFrames(response, 1);

    expect(frames.map((frame) => frame.type)).toEqual(['shape.queued']);
    expect(frames[0].sequence).toBe(5);
  });

  it('proud se zavře sám, když relace skončí', async () => {
    const stored = await generated();
    const response = await events(stored.session.sessionId, '?since=4');

    stored.session.fail('the model could not be reached');
    // Bez zavření by tohle čtení běželo do timeoutu — a e2e sada by červenala
    // nad relací, která doběhla správně.
    const frames = await readFrames(response);

    expect(frames.map((frame) => frame.type)).toEqual(['session.failed']);
  });

  it('relace, která doběhla dřív než se klient připojil, se přehraje a zavře', async () => {
    const stored = await generated();
    stored.session.fail('the model could not be reached');

    const frames = await readFrames(await events(stored.session.sessionId));

    expect(frames.at(-1)?.type).toBe('session.failed');
    expect(frames).toHaveLength(5);
  });

  it('heartbeat je komentář, který dekodér zahodí', async () => {
    // §20: potvrzuje živé spojení, **ne pokrok**. Kdyby to byla pojmenovaná
    // událost, reducer by dostal rámec bez `sequence` a musel by pro něj mít
    // výjimku — tedy díru v posloupnosti, na které stojí celý reconnect.
    expect(HEARTBEAT_FRAME.startsWith(':')).toBe(true);
    expect(new SseDecoder().push(HEARTBEAT_FRAME)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Šťastná cesta se scriptovaným emitorem.
 * ------------------------------------------------------------------ */

describe('generace se scriptovaným emitorem', () => {
  it('projde tři fáze v pořadí a dvěma voláními modelu', async () => {
    const emitter = scripted();
    const stored = openSession('scripted-happy', 4021)!;
    await runGeneration(stored, PLAN.intent.setting, { emit: emitter.emit, grammar: grammar() });

    expect(stored.session.phase).toBe('world');
    expect(stored.fault).toBeNull();
    expect(emitter.calls()).toBe(2);
    expect(stored.session.events.all().map((event) => event.type)).toEqual([
      'session.accepted',
      'intent.ready',
      'blueprint.ready',
      'world.ready',
    ]);
  });

  it('`world.ready` dorazí, i když žádný tvar ještě neexistuje', async () => {
    const stored = await generated();

    // Tvrzení §21 „meshing nemá route". Kdyby server na tvary čekal, hrubý svět
    // by se objevil až za nejpomalejším meshem a rozpočet 3 s by padl.
    const types = stored.session.events.all().map((event) => event.type);
    expect(types).toContain('world.ready');
    expect(types.filter((type) => type.startsWith('shape.'))).toEqual([]);
    expect(stored.session.representations.map((record) => record.state.kind)).toEqual([
      'planned',
      'planned',
    ]);
  });

  it('model, který nedodá záměr, skončí relaci veřejnou větou', async () => {
    const stored = openSession('scripted-rejected', 4021)!;
    await runGeneration(stored, PLAN.intent.setting, {
      emit: async () => ({ intent: 'a salt flat' }),
      grammar: grammar(),
    });

    expect(stored.session.phase).toBe('failed');
    expect(stored.fault).toBe('the sentence could not be turned into a plan');
    expect(stored.session.events.all().at(-1)?.type).toBe('session.failed');
  });

  it('nedostupný model skončí relaci, ne nezachyceným slibem', async () => {
    const stored = openSession('scripted-unavailable', 4021)!;
    await runGeneration(stored, PLAN.intent.setting, {
      emit: async () => {
        throw new Error('connect ECONNREFUSED https://provider.example/v1?key=sk-secret');
      },
      grammar: grammar(),
    });

    expect(stored.session.phase).toBe('failed');
    // Ven jde věta ze slovníku. Adresa a klíč z textu výjimky patří do logu
    // operátora, ne do relace, kterou čte kdokoli s odkazem.
    expect(stored.fault).toBe('the model could not be reached');
    expect(JSON.stringify(stored.session.events.all())).not.toContain('sk-secret');
  });

  it('proud spojený s doběhlou relací ukáže celou cestu v pořadí', async () => {
    const stored = await generated();
    stored.session.fail('done for the test');
    const frames = await readFrames(await events(stored.session.sessionId));

    // Konec konců je tohle to jediné, co porotce uvidí: pořadí, ve kterém se
    // svět staví. Modul to umí a route to musí donést až k němu.
    const ladder = frames.map((frame) => frame.type).filter((type) => type !== 'session.failed');
    expect(ladder).toEqual(['session.accepted', 'intent.ready', 'blueprint.ready', 'world.ready']);
  });
});

/* ------------------------------------------------------------------ *
 * Strop utrácení
 * ------------------------------------------------------------------ */

describe('strop utrácení placené větve', () => {
  it('je jeden na modul, ne nový na každý požadavek', async () => {
    vi.stubEnv('WORLDSMITH_MODEL_ENDPOINT', 'https://model.invalid/v1/messages');
    vi.stubEnv('WORLDSMITH_MODEL_KEY', 'not-a-real-key');
    vi.stubEnv('WORLDSMITH_USD_PER_MTOK_OUT', '15');

    // Rozpočet spolkne rezervace **mimo** emitor. Kdyby si emitor stavěl strop
    // sám, začal by na nule, tuhle rezervaci by nikdy neviděl a volání pustil —
    // a přesně tak se to chovalo do 3. 9. 2026: sdílený strop odmítl na volání
    // #38, strop na požadavek neodmítl ani po šedesáti.
    const held = await WORLDSTREAM_SPEND_CAP.reserve(DEFAULT_CAP_USD);
    expect(held.ok).toBe(true);

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const emit = await cloudEmitter();
      expect(emit).not.toBeNull();
      await expect(
        emit!({ model: 'claude-opus-5', system: 'system', user: 'a salt flat with one iron mast' }),
      ).rejects.toThrow(/CAP_EXHAUSTED/);

      // Odmítnutí je **před** voláním, ne po něm. Strop, který se ptá až
      // potom, není strop — je to účetnictví.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      if (held.ok) await held.settle(0);
      vi.unstubAllEnvs();
    }
  });
});

/**
 * **Práce za odpovědí 202 se předává platformě, ne holému `void`.**
 *
 * Nález nezávislé revize 3. 9. 2026 nad `4ee2b3d`. `vercel.json` nasazuje
 * serverless a instance se po odeslání odpovědi **zmrazí**, takže rezervace
 * stropu se zapsala a vyrovnání už neproběhlo. Do P15 T29 to stálo jen paměť
 * procesu a umřelo to s ním; od T29 je účetní kniha sdílená a trvalá, takže
 * každá opuštěná rezervace strop **natrvalo utáhne** — dvacet po výchozím
 * nejhorším případu 0,2585 USD vyčerpá strop 5 USD a další instance začne
 * rovnou na `CAP_EXHAUSTED`.
 *
 * ⚠ **Soudí se zdroj, protože zevnitř jednoho procesu se to změřit nedá.**
 * Zmrazení instance je vlastnost platformy; vitest volá `POST()` přímo, takže
 * `after()` tam vyhodí „outside a request scope" a route spadne do stejné
 * záložní větve, jakou má `next start`. Chování obou větví je tím pádem
 * nerozlišitelné a jediné, co tuhle vlastnost drží, je tenhle test.
 */
describe('generace za odpovědí přežije zmrazení instance', () => {
  it('předává rozdělanou práci `after()`, ne jen `void`', () => {
    // Komentáře se odstřihnou — zakomentované `after(` by bránu jinak prošlo.
    const source = readFileSync('src/app/api/worldstream/sessions/route.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    expect(source, 'route neimportuje `after` z `next/server`').toContain(
      "import { after } from 'next/server'",
    );
    // Ta práce, a ne nějaká jiná: je to tentýž `Promise`, na kterém visí
    // `releaseSlot()`, takže se na platformu předává i vrácení slotu.
    expect(source, 'rozdělaná generace se nepředává `after()`').toMatch(
      /after\(settled\)/,
    );
    expect(source, 'na `settled` nevisí vrácení slotu').toMatch(
      /const settled = work\.finally\(\(\) => \{\s*releaseSlot\('world'\);\s*\}\);/,
    );
  });
});

/* ------------------------------------------------------------------ *
 * Strop na počet posluchačů proudu (P15 T16-streamadmit).
 * ------------------------------------------------------------------ */

describe('proud relace má strop na počet posluchačů', () => {
  /**
   * Otevře proud a vrátí odpověď i způsob, jak ho zavřít.
   *
   * Zavírá se `body.cancel()`, protože to je jediné, co v testu spustí větev
   * `cancel()` na proudu — tedy tutéž cestu úklidu, kterou v provozu spustí
   * odchod diváka.
   */
  async function listen(sessionId: string): Promise<{ response: Response; close: () => Promise<void> }> {
    const response = await events(sessionId);
    return {
      response,
      close: async () => {
        await response.body?.cancel();
      },
    };
  }

  it(`${MAX_STREAM_SUBSCRIBERS + 1}. proud téže relace dostane 503 a stabilní kód`, async () => {
    openSession('crowded', 11);
    const open = [];
    for (let i = 0; i < MAX_STREAM_SUBSCRIBERS; i += 1) {
      const stream = await listen('crowded');
      expect(stream.response.status, `proud #${i + 1} neprošel`).toBe(200);
      open.push(stream);
    }

    const refused = await events('crowded');
    expect(refused.status).toBe(503);
    // Kód se čte strojově (klient podle něj rozhodne, jestli zkusit znovu),
    // takže se pinuje on, ne věta vedle něj.
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'TOO_MANY_STREAMS',
    );

    for (const stream of open) await stream.close();
  });

  it('odpojení uvolní slot, takže další divák projde', async () => {
    openSession('revolving', 12);
    const open = [];
    for (let i = 0; i < MAX_STREAM_SUBSCRIBERS; i += 1) open.push(await listen('revolving'));

    expect((await events('revolving')).status, 'plno se nepoznalo').toBe(503);
    await open[0].close();

    const after = await events('revolving');
    expect(after.status, 'odchod diváka slot nevrátil').toBe(200);

    await after.body?.cancel();
    for (const stream of open.slice(1)) await stream.close();
  });

  it('přerušený požadavek uvolní slot stejně jako odchod diváka', async () => {
    openSession('aborted', 13);
    const controller = new AbortController();
    const response = await readEvents(
      new Request('http://127.0.0.1/api/worldstream/sessions/aborted/events', {
        signal: controller.signal,
      }),
      params('aborted'),
    );
    expect(response.status).toBe(200);

    controller.abort();
    // Slot se vrátil, takže se dá naplnit celý strop znovu a teprve pak je plno.
    const open = [];
    for (let i = 0; i < MAX_STREAM_SUBSCRIBERS; i += 1) {
      const stream = await listen('aborted');
      expect(stream.response.status, `po přerušení nezbyl slot #${i + 1}`).toBe(200);
      open.push(stream);
    }
    expect((await events('aborted')).status).toBe(503);

    for (const stream of open) await stream.close();
  });

  it('slot se vrací právě jednou, i když proud odejde dvěma cestami naráz', async () => {
    // ⚠ **Tenhle případ dopsala nezávislá revize, protože její mutant PŘEŽIL.**
    // Závora `holdsSlot` v `release()` je nosná půlka tvrzení „slot se vrací
    // právě jednou", a do 4. 9. 2026 ji nepinovalo nic: revize ji nahradila
    // holým `releaseStream(sessionId)` a **všech 41 testů zůstalo zelených**,
    // přičemž strop čtyř pak pustil pátý proud. Komentář to tvrdil, test ne.
    //
    // Dvě cesty úklidu naráz jsou přesně to, co se v provozu děje běžně:
    // prohlížeč zavře kartu (`abort`) a čtečka nad ní ještě zruší reader
    // (`cancel`). Kdyby každá vrátila slot zvlášť, počítadlo by šlo pod nulu
    // a strop by přestal držet po prvním obyčejném odchodu diváka.
    openSession('double-exit', 15);
    // **Vedle musí stát druhý proud, jinak se ta závora neprojeví.**
    // `releaseStream()` se sama brání jen tehdy, když klíč po prvním snížení
    // z mapy zmizí — tedy když šel počet na nulu. Se dvěma proudy jde první
    // snížení na 1, klíč zůstane, a druhé projde. Naměřeno: bez souseda mutant
    // bez závory tenhle případ **přežil**.
    const neighbour = await listen('double-exit');
    expect(neighbour.response.status).toBe(200);

    const controller = new AbortController();
    const doubled = await readEvents(
      new Request('http://127.0.0.1/api/worldstream/sessions/double-exit/events', {
        signal: controller.signal,
      }),
      params('double-exit'),
    );
    expect(doubled.status).toBe(200);

    controller.abort();
    await doubled.body?.cancel();

    // Odešel JEDEN divák ze dvou, takže se smí vrátit JEDEN slot: k sousedovi
    // se vejdou přesně `MAX_STREAM_SUBSCRIBERS - 1` další, ne o jednoho víc.
    const open = [];
    for (let i = 0; i < MAX_STREAM_SUBSCRIBERS - 1; i += 1) {
      const stream = await listen('double-exit');
      expect(stream.response.status, `slot #${i + 1} chyběl`).toBe(200);
      open.push(stream);
    }
    expect(
      (await events('double-exit')).status,
      'slot se vrátil dvakrát, takže strop pustil o jednoho víc',
    ).toBe(503);

    await neighbour.close();
    for (const stream of open) await stream.close();
  });

  it('odmítnutý požadavek slot nezabere — 404 ani 400 nesmí ubrat místo', async () => {
    openSession('unspent', 14);

    // Neznámá relace (404) a nesmyslný bod obnovení (400) se vracejí dřív, než
    // by měly co uklízet. Kdyby si přesto braly slot, nikdo by ho nevrátil a
    // strop by šlo vyčerpat požadavky, které proud vůbec neotevřou.
    for (let i = 0; i < 20; i += 1) {
      expect((await events('nikdy-nebyla')).status).toBe(404);
      expect((await events('unspent', '?since=abc')).status).toBe(400);
    }

    const open = [];
    for (let i = 0; i < MAX_STREAM_SUBSCRIBERS; i += 1) {
      const stream = await listen('unspent');
      expect(stream.response.status, `odmítnutí ukradlo slot #${i + 1}`).toBe(200);
      open.push(stream);
    }

    for (const stream of open) await stream.close();
  });

  it('součet přes celý proces drží registr, ne druhý strop', async () => {
    // ⚠ **Tenhle případ pinuje, PROČ tu druhý strop (na celý proces) není.**
    // První podoba úlohy ho měla, protože se předpokládalo, že strop na relaci
    // součet nedrží. Sonda ukázala opak: registr uvolní nejdéle stojící relaci
    // (`evict()` → `release()` → `session.fail(SESSION_RELEASED)`), a na tom
    // koncovém rámci se proud té relace **sám zavře a slot vrátí**. Součet je
    // proto shora omezený `MAX_LIVE_SESSIONS` × `MAX_STREAM_SUBSCRIBERS`.
    //
    // Kdyby tenhle test zčervenal, přestal platit důvod, proč se druhý strop
    // nestaví — pak se má přidat on, ne přepsat tenhle test.
    const open = [];
    for (let i = 0; i < MAX_LIVE_SESSIONS; i += 1) {
      openSession(`crowd-${i}`, 100 + i);
      const stream = await listen(`crowd-${i}`);
      expect(stream.response.status, `proud #${i + 1} neprošel`).toBe(200);
      open.push(stream);
    }
    expect(streamedSessionCount(), 'registr pustil víc relací, než deklaruje').toBe(
      MAX_LIVE_SESSIONS,
    );

    // 65. relace vytlačí tu nejdéle stojící — a s ní její proud i jeho slot.
    openSession('one-too-many', 999);
    const stream = await listen('one-too-many');
    expect(stream.response.status).toBe(200);
    expect(
      streamedSessionCount(),
      'vytlačená relace si nechala proud, takže počet časovačů roste bez konce',
    ).toBe(MAX_LIVE_SESSIONS);

    await stream.close();
    for (const held of open) await held.close();
    // Mapa se maže na nule; kdyby držela klíče na nule, je to táž netěsnost
    // o patro níž.
    expect(streamedSessionCount(), 'po odchodu všech diváků zůstal klíč v mapě').toBe(0);
  });
});

describe('strop na frekvenci dorazí až k zakládání relace', () => {
  it('padesátý první požadavek v okně je 429, a čítač souběhu tím nezůstane rozbitý', async () => {
    // Okno se plní přímo čítačem — měří se zapojení meze do těchhle dveří,
    // ne mez sama (`src/server/__tests__/rate-limit.test.ts`).
    for (let taken = 0; taken < MAX_REQUESTS_PER_WINDOW; taken += 1) takeRateSlot('sessions', 'unknown');
    try {
      const response = await createSession(createRequest({ prompt: 'a salt flat with one iron mast' }));
      expect(response.status).toBe(429);
      expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'TOO_MANY_REQUESTS',
      );
    } finally {
      resetRateWindows();
    }

    // **Odmítnutí musí být PŘED slotem placeného souběhu.** Kdyby se bralo
    // dřív, každý odmítnutý požadavek by ukousl jeden ze tří slotů a nevrátil
    // ho — a padesát jedna požadavků by zavřelo stavbu světů natrvalo.
    const after = await createSession(createRequest({ prompt: 'a salt flat with one iron mast' }));
    expect(after.status, 'čítač souběhu zůstal po odmítnutí obsazený').toBe(202);
  });
});


/**
 * **Kvóta na klíč volajícího dojde až sem, nebo nedojde nikam** — pátá
 * nezávislá revize `T16-evictworld`, `VERDICT: blocking`.
 *
 * Registr má výchozí hodnotu vlastníka `sessionId`, tedy vlastní kbelík. Ta
 * je konzervativní schválně, ale znamená, že kdyby route klíč nepředala,
 * **kvóta by mlčky nedělala nic** a celá ochrana by byla dekorace. Tenhle
 * soubor je jediné místo, kde se dá pinovat, že provoz posílá skutečný klíč.
 */
describe('relaci zakládá klíč volajícího, ne anonym', () => {
  /**
   * Zaplní registr na práh, od kterého kvóta vůbec odmítá
   * (`QUOTA_ENGAGES_AT`). Zakládá se přímo v registru, ne přes route: tyhle
   * relace nejsou to, co se měří, a 32 průchodů celým handlerem by jen stálo
   * čas a čtyřicet řádků okna stropu frekvence.
   *
   * **Sledované schválně** — nesledované by zametení uvolnilo a obsazenost by
   * spadla pod práh uprostřed testu.
   */
  function naPráh(): void {
    for (let i = 0; i < QUOTA_ENGAGES_AT; i += 1) {
      const stored = openSession(`dav-${String(i)}`, 100 + i, Date.now(), `dav-klíč-${String(i)}`);
      expect(stored, 'dav se do registru nevešel').not.toBeNull();
      stored!.session.events.subscribe(() => {});
    }
  }

  /**
   * ⚠ **Nález sedmé nezávislé revize, `VERDICT: blocking`.** Klíč volajícího je
   * odchozí adresa, takže devět porotců za jednou firemní NATkou má **jeden**
   * klíč. Dokud kvóta odmítala i na prázdné instanci, devátý dostal 429 ve
   * chvíli, kdy bylo volných 55 slotů z 64 — a vyčistit si to neuměl.
   */
  it('devět porotců za jednou NATkou dostane na klidné instanci devět světů', async () => {
    resetRateWindows();
    for (let i = 0; i < MAX_SESSIONS_PER_CALLER + 1; i += 1) {
      const odpověď = await createSession(
        createRequest({ prompt: `porotce ${String(i)}` }, '198.51.100.77'),
      );
      expect(odpověď.status, `porotce ${String(i)} dostal odmítnutí na prázdné instanci`).toBe(202);
    }

    expect(liveSessionCount()).toBe(MAX_SESSIONS_PER_CALLER + 1);
  });

  it('devátá relace z jedné hlavičky dostane nad prahem 429 a osm předchozích zůstane', async () => {
    resetRateWindows();
    naPráh();
    const první = await createSession(createRequest({ prompt: 'svět 0' }, '203.0.113.7'));
    const { sessionId } = (await první.json()) as { sessionId: string };
    for (let i = 1; i < MAX_SESSIONS_PER_CALLER; i += 1) {
      await createSession(createRequest({ prompt: `svět ${String(i)}` }, '203.0.113.7'));
    }

    const devátá = await createSession(createRequest({ prompt: 'devátý' }, '203.0.113.7'));

    expect(devátá.status, 'kvóta nedrží — devátá relace prošla').toBe(429);
    expect(((await devátá.json()) as { error: { code: string } }).error.code).toBe(
      'TOO_MANY_SESSIONS_PER_CALLER',
    );
    expect(
      liveSessionCount(),
      'route klíč nepředala — kvóta je dekorace a strop 64 jde naplnit z jedné smyčky',
    ).toBe(QUOTA_ENGAGES_AT + MAX_SESSIONS_PER_CALLER);
    expect(getSession(sessionId), 'kvóta zaplatila vlastní relací místo odmítnutím').not.toBeNull();
  });

  // **Odmítnutí vrací slot placeného souběhu.** Ten `return` přibyl mezi
  // `acquireSlot('world')` a `work.finally`, takže bez `releaseSlot` by tři
  // odmítnutí natrvalo zavřela stavbu světů komukoli. Naměří to jedině jiný
  // volající, protože ten původní je nad kvótou pořád.
  it('odmítnutí nad kvótou nezabere slot, který má chránit', async () => {
    resetRateWindows();
    naPráh();
    for (let i = 0; i < MAX_SESSIONS_PER_CALLER; i += 1) {
      await createSession(createRequest({ prompt: `svět ${String(i)}` }, '203.0.113.9'));
    }
    for (let i = 0; i < MAX_WORLD_GENERATIONS + 1; i += 1) {
      const odmítnutá = await createSession(createRequest({ prompt: 'navíc' }, '203.0.113.9'));
      expect(odmítnutá.status).toBe(429);
    }

    const jiný = await createSession(createRequest({ prompt: 'jiný člověk' }, '198.51.100.9'));
    expect(jiný.status, 'odmítnutí ukousla sloty dveří world a nevrátila je').toBe(202);
  });

  it('dvě různé hlavičky jsou dva kbelíky, takže si relace nezavřou navzájem', async () => {
    resetRateWindows();
    naPráh();
    const první = await createSession(createRequest({ prompt: 'porotce' }, '198.51.100.4'));
    const { sessionId } = (await první.json()) as { sessionId: string };

    for (let i = 0; i < MAX_SESSIONS_PER_CALLER + 1; i += 1) {
      await createSession(createRequest({ prompt: `útok ${String(i)}` }, '203.0.113.7'));
    }

    expect(getSession(sessionId), 'cizí kvóta zaplatila relací porotce').not.toBeNull();
  });

  /**
   * ⚠ **Sonda šesté nezávislé revize, doslova.** Naměřeno tehdy přes tuhle
   * route: 8 POSTů s hlavičkou oběti → oběť `RELEASED`, `live = 8`. Kbelík si
   * vybírá volající, takže dokud kvóta uklízela, byla zaměřovač.
   */
  it('útočník s hlavičkou oběti její běžící svět nezavře', async () => {
    resetRateWindows();
    naPráh();
    const oběť = await createSession(createRequest({ prompt: 'porotce' }, '198.51.100.4'));
    const { sessionId } = (await oběť.json()) as { sessionId: string };

    // Útočník píše IP oběti na svých osm POSTů, aby své relace dostal do
    // jejího kbelíku. Žádný proud k tomu není potřeba.
    for (let i = 0; i < MAX_SESSIONS_PER_CALLER; i += 1) {
      await createSession(createRequest({ prompt: `podvrh ${String(i)}` }, '198.51.100.4'));
    }

    expect(getSession(sessionId), 'osm podvržených POSTů zavřelo oběti svět').not.toBeNull();
    expect(liveSessionCount()).toBe(QUOTA_ENGAGES_AT + MAX_SESSIONS_PER_CALLER);
  });

  /**
   * ⚠ **Druhá sonda šesté revize.** Naměřeno tehdy: 12 návštěvníků bez proxy
   * hlaviček → `live = 8` a svět prvního se uvolnil pod ním, protože sentinel
   * `UNIDENTIFIED_CALLER` byl jeden sdílený kbelík pro celou instanci. Týká se
   * to každého běhu bez proxy i devíti porotců za jednou firemní NATkou.
   */
  it('dvanáct návštěvníků bez proxy hlaviček si světy nezavře navzájem', async () => {
    resetRateWindows();
    naPráh();
    const první = await createSession(createRequest({ prompt: 'návštěvník 0' }));
    const { sessionId } = (await první.json()) as { sessionId: string };
    for (let i = 1; i < 12; i += 1) {
      await createSession(createRequest({ prompt: `návštěvník ${String(i)}` }));
    }

    expect(liveSessionCount(), 'strop instance klesl ze 64 na kvótu jednoho kbelíku').toBe(
      QUOTA_ENGAGES_AT + 12,
    );
    expect(getSession(sessionId), 'svět prvního návštěvníka se zavřel pod ním').not.toBeNull();
  });
});
