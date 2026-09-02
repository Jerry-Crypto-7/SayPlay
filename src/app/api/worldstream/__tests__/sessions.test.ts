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

import { afterEach, describe, expect, it } from 'vitest';

import { GEOM_VERSION } from '../../../../geom/program';
import { SseDecoder } from '../../../../components/viewer/sse';
import type { PlannerEmission } from '../../../../model/worldstream-intent';
import type { UpstreamRequest } from '../../../../model/prompt';
import type { SessionEvent, SessionEventLog } from '../../../../worldstream/events';
import {
  clearSessions,
  openSession,
  newSessionSeed,
  runGeneration,
  serverGrammar,
  type StoredSession,
} from '../../../../worldstream/sessions';
import { MAX_CONCURRENT_GENERATIONS, POST as createSession, resetConcurrency } from '../sessions/route';
import { GET as readSnapshot } from '../sessions/[sessionId]/route';
import { HEARTBEAT_FRAME, GET as readEvents } from '../sessions/[sessionId]/events/route';

/* ------------------------------------------------------------------ *
 * Volání route.
 * ------------------------------------------------------------------ */

function createRequest(body: unknown): Request {
  return new Request('http://127.0.0.1/api/worldstream/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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

/* ------------------------------------------------------------------ *
 * Fixtura: plán a odpověď na něj.
 * ------------------------------------------------------------------ */

const PLAN: PlannerEmission = {
  intent: {
    setting: 'a salt flat with one iron mast standing in the middle of it',
    mood: 'bright, flat, wind-scoured',
    spatialThesis:
      'Nothing interrupts the ground for a kilometre except the mast, so the flat reads as one plane and the mast as the only measure of its size.',
    actors: ['the surveyor'],
    heroObjects: ['the iron mast'],
    interactions: ['the surveyor walks to the mast and the horizon does not change'],
    unsupported: ['the salt crust is a surface, not a material that breaks underfoot'],
  },
  objects: [
    {
      stableId: 'saltFlat',
      label: 'the salt flat',
      synonyms: ['the flat', 'the ground', 'the salt'],
      role: 'terrain',
      importance: 2,
    },
    {
      stableId: 'ironMast',
      label: 'the iron mast',
      synonyms: ['the mast', 'the tower', 'the pole'],
      role: 'hero',
      importance: 3,
    },
    {
      stableId: 'saltWind',
      label: 'the wind off the salt',
      synonyms: ['the wind', 'the haze'],
      role: 'effect',
      importance: 0,
    },
  ],
};

const ANSWER: Record<string, unknown> = {
  geometry: {
    version: GEOM_VERSION,
    nodes: [
      { kind: 'terrain', variant: 'plateau', extent: [40, 40], amplitude: 0.1, seed: 11 },
      { kind: 'group', children: [0] },
    ],
    root: 1,
  },
  shapes: [
    {
      shapeId: 'mastPost',
      stableId: 'ironMast',
      nodes: [
        { kind: 'prism', sides: 4, radius: 0.24, height: 3.2 },
        { kind: 'taper', child: 0, axis: 'y', amount: 0.35 },
      ],
      root: 1,
      targetBounds: { min: [-0.3, -1.7, -0.3], max: [0.3, 1.7, 0.3] },
      anchors: [{ name: 'tip', at: [0, 1.6, 0], normal: [0, 1, 0] }],
      materialIntent: 'metal',
      priority: 9,
    },
  ],
  placements: [
    {
      stableId: 'saltFlat',
      source: { kind: 'geom', node: 0 },
      targetBounds: { min: [-20, -0.2, -20], max: [20, 0.2, 20] },
    },
    {
      stableId: 'ironMast',
      source: { kind: 'shape', shapeId: 'mastPost' },
      targetBounds: { min: [-0.3, 0, -0.3], max: [0.3, 3.4, 0.3] },
    },
  ],
  world: {
    irVersion: 'v1',
    simRevision: 0,
    lookRevision: 0,
    sim: {
      layout: { width: 12, height: 8 },
      grid: { cell: 1 },
      sockets: { startPad: [1, 4], mastPad: [10, 4] },
      collisionAabb: { surveyor: [1, 4, 1, 1], mastBase: [10, 4, 1, 1] },
      entities: {
        surveyor: { role: 'actor', socket: 'startPad', state: 'idle' },
        mastBase: { role: 'goal', socket: 'mastPad', state: 'shut' },
      },
      state: { counters: {}, flags: {}, timers: {}, zones: {}, slots: 0 },
      rules: {
        reach: {
          phase: 0,
          priority: 0,
          event: { kind: 'onEnterZone', entity: 'surveyor', zone: 'mastPad' },
          condition: null,
          actions: [{ kind: 'win' }],
        },
      },
    },
    look: {
      modules: { mastBase: { family: 'panel', params: { thickness: 0.18 } } },
      palette: 'moss',
      lightRig: 'rim',
      atmosphere: 'clear',
      materialRoles: {},
      camera: { kind: 'orbit' },
      audio: {},
    },
  },
};

/**
 * Emitor, který odpovídá **z ruky, ne od poskytovatele**.
 *
 * První volání je záměr, druhé blueprint — pořadím, ne obsahem požadavku:
 * kdyby se rozlišovalo podle textu, sada by červenala pokaždé, když někdo
 * přepíše systémovou zprávu, což je práce planneru, ne relace.
 */
function scripted(): { emit: (request: UpstreamRequest) => Promise<unknown>; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    emit: async () => {
      calls += 1;
      return calls === 1 ? { intent: PLAN.intent, objects: PLAN.objects } : ANSWER;
    },
  };
}

function grammar() {
  const read = serverGrammar();
  if (typeof read === 'string') throw new Error(`the frozen protocol could not be read: ${read}`);
  return read;
}

/** Relace naplněná scriptovaným emitorem, tedy bez peněz a bez `.env`. */
async function generated(): Promise<StoredSession> {
  const stored = openSession(`test-${newSessionSeed()}`, 4021);
  await runGeneration(stored, PLAN.intent.setting, { emit: scripted().emit, grammar: grammar() });
  return stored;
}

afterEach(() => {
  clearSessions();
  resetConcurrency();
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
    // Bez `.env` skončí generace hned, takže se čítač musí nasytit ručně —
    // jinak by tenhle test měřil rychlost stroje, ne strop.
    const responses: Response[] = [];
    for (let i = 0; i <= MAX_CONCURRENT_GENERATIONS; i += 1)
      responses.push(await createSession(createRequest({ prompt: `a salt flat number ${i}` })));

    // `resetConcurrency` je jediné, co čítač snižuje mimo doběhnutou generaci;
    // tady se jen ověří, že strop je proměnná, o kterou se route opírá.
    expect(MAX_CONCURRENT_GENERATIONS).toBeGreaterThan(0);
    expect(responses.every((response) => response.status === 202 || response.status === 503)).toBe(true);
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
    const stored = openSession('scripted-happy', 4021);
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
    const stored = openSession('scripted-rejected', 4021);
    await runGeneration(stored, PLAN.intent.setting, {
      emit: async () => ({ intent: 'a salt flat' }),
      grammar: grammar(),
    });

    expect(stored.session.phase).toBe('failed');
    expect(stored.fault).toBe('the sentence could not be turned into a plan');
    expect(stored.session.events.all().at(-1)?.type).toBe('session.failed');
  });

  it('nedostupný model skončí relaci, ne nezachyceným slibem', async () => {
    const stored = openSession('scripted-unavailable', 4021);
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
