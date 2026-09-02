/**
 * **Klientský reducer a čtečka proudu** (P15 T17).
 *
 * ## Fixtura je skutečná relace, ne ručně psané rámce
 *
 * Rámce sem chodí z `createSession()` přes `sessionFrame()` — tedy přes tentýž
 * automat a tentýž formátovač, jaké běží v provozu. Je to přímé poučení z kola
 * 2 `T9-streamsilent`: pět mutantů z pěti zabitých a sada byla přesto vadná,
 * protože fixtura vyráběla jinou hodnotu než provoz. Ručně napsaný rámec by tu
 * potvrzoval, že reducer umí číst to, co jsme mu napsali — ne to, co mu server
 * pošle.
 *
 * ## Scriptovaný `fetch` drží signál jako opravdový
 *
 * `AbortSignal` u skutečného `fetch` shodí **tělo odpovědi**, ne jen následující
 * volání. Kdyby ho fixtura ignorovala, test na zrušení by měřil jen to, že se
 * po zrušení nezavolá další URL — a minul by celé místo, kde se čte.
 */

import { describe, expect, it } from 'vitest';

import { sessionFrame } from '../../app/api/worldstream/sessions/[sessionId]/events/route';
import { createSession, type GenerationSession } from '../session';
import type { MeshArtifact } from '../cache';
import type { SessionEvent } from '../events';
import { followSession, openWorldstreamSession, SseDecoder, type SessionHandle } from '../client';
import {
  applySnapshot,
  initialClientState,
  reduceEvent,
  type ClientSnapshot,
  type ClientState,
} from '../reducer';

/* ------------------------------------------------------------------ *
 * Fixtura: jedna relace, která doopravdy proběhla.
 * ------------------------------------------------------------------ */

const SESSION_ID = 'ses-00000000';

function artifact(contentHash: string, triangles: number): MeshArtifact {
  return {
    shapeId: 'leviathan-ribs',
    contentHash,
    resolution: 64,
    vertices: triangles * 3,
    triangles,
    bounds: { min: [-1, 0, -1], max: [1, 2, 1] },
    buildMs: 180,
  };
}

/** Relace od `session.accepted` po `world.ready` plus jeden hotový tvar. */
function generation(): { session: GenerationSession; events: readonly SessionEvent[] } {
  let tick = 0;
  const session = createSession({
    sessionId: SESSION_ID,
    sessionSeed: 7,
    now: () => `2026-09-02T00:00:${String(tick++).padStart(2, '0')}.000Z`,
  });

  session.advance('intent', { theme: 'a drowned cathedral' });
  session.advance('blueprint', { blueprint: { title: 'Drowned cathedral' }, rounds: 1 });
  session.register(['hero', 'pillar']);
  session.advance('world', { title: 'Drowned cathedral', objects: 2, shapes: 2 });
  session.queue('hero', 64);
  session.apply({
    sessionId: SESSION_ID,
    stableId: 'hero',
    representationRevision: 0,
    next: { kind: 'coarse', artifact: artifact('hash-coarse', 4_000) },
  });
  session.apply({
    sessionId: SESSION_ID,
    stableId: 'hero',
    representationRevision: 0,
    next: { kind: 'refining', from: artifact('hash-coarse', 4_000) },
  });

  return { session, events: session.events.all() };
}

function feed(events: readonly SessionEvent[], from: ClientState = initialClientState()): ClientState {
  let state = from;
  for (const event of events) {
    const step = reduceEvent(state, event);
    expect(step.ok, `rámec ${event.sequence} (${event.type}) neprošel reducerem`).toBe(true);
    if (step.ok) state = step.state;
  }
  return state;
}

function shape(state: ClientState, stableId: string) {
  const found = state.shapes.find((entry) => entry.stableId === stableId);
  expect(found, `objekt ${stableId} ve stavu není`).toBeDefined();
  return found!;
}

/* ------------------------------------------------------------------ *
 * Reducer.
 * ------------------------------------------------------------------ */

describe('reduceEvent', () => {
  it('složí fáze i podobu objektu z rámců, které vydala skutečná relace', () => {
    const { events } = generation();
    const state = feed(events);

    expect(state.sessionId).toBe(SESSION_ID);
    expect(state.phase).toBe('world');
    expect(state.sequence).toBe(events[events.length - 1].sequence);
    expect(state.blueprint).toEqual({ title: 'Drowned cathedral' });
    expect(shape(state, 'hero').rung).toBe('refining');
    expect(state.shapes.map((entry) => entry.stableId)).toEqual(['hero']);
  });

  it('je idempotentní: tentýž rámec podruhé stavem nehne', () => {
    const { events } = generation();
    const state = feed(events);

    const again = reduceEvent(state, events[events.length - 1]);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.state).toEqual(state);
  });

  it('sloučený průběh dorazí pod týmž číslem a přepíše obsah, ne pořadí', () => {
    const { session, events } = generation();
    const state = feed(events);
    const before = state.sequence;

    // Log slučuje `shape.refining` téhož objektu přepisem konce — číslo zůstává.
    const merged = session.apply({
      sessionId: SESSION_ID,
      stableId: 'hero',
      representationRevision: 0,
      next: { kind: 'refining', from: artifact('hash-newer', 9_000) },
    });
    expect(merged.ok).toBe(true);
    if (!merged.ok || merged.event === null) throw new Error('sloučený rámec nevznikl');
    expect(merged.event.sequence).toBe(before);

    const step = reduceEvent(state, merged.event);
    expect(step.ok).toBe(true);
    if (step.ok) {
      expect(step.state.sequence).toBe(before);
      expect(step.state.phase).toBe('world');
    }
  });

  it('starší číslo je kopie: zahodí se a hlásí, že se nic nezměnilo', () => {
    const { events } = generation();
    const state = feed(events);

    const step = reduceEvent(state, events[1]);
    expect(step.ok).toBe(true);
    if (step.ok) {
      expect(step.applied).toBe(false);
      expect(step.state).toBe(state);
    }
  });

  it('mezera v číslování proud zabíjí a stav nechá netknutý', () => {
    const { events } = generation();
    const state = feed(events.slice(0, 2));

    const step = reduceEvent(state, events[4]);
    expect(step.ok).toBe(false);
    if (!step.ok) {
      expect(step.fault).toBe('SEQUENCE_GAP');
      expect(step.state).toBe(state);
    }
  });

  it('rámec cizí relace se odmítne dřív, než se porovná číslo', () => {
    const { events } = generation();
    const state = feed(events);

    const foreign: SessionEvent = { ...events[0], sessionId: 'ses-somebody-else', sequence: 900 };
    const step = reduceEvent(state, foreign);
    expect(step.ok).toBe(false);
    // Ne `SEQUENCE_GAP`: mezera by poslala čtečku pro snapshot relace,
    // které se ten rámec vůbec netýká.
    if (!step.ok) expect(step.fault).toBe('FOREIGN_SESSION');
  });

  it('`shape.refining` nesmaže hash, který přinesl `shape.coarse`', () => {
    const { events } = generation();
    const state = feed(events);

    expect(shape(state, 'hero').contentHash).toBe('hash-coarse');
    expect(shape(state, 'hero').triangles).toBe(4_000);
  });

  it('`session.failed` uloží veřejnou větu a fázi', () => {
    const { session } = generation();
    const failure = session.fail('the model could not be reached');
    expect(failure.ok).toBe(true);

    const state = feed(session.events.all());
    expect(state.phase).toBe('failed');
    expect(state.fault).toBe('the model could not be reached');
  });
});

/* ------------------------------------------------------------------ *
 * Snapshot.
 * ------------------------------------------------------------------ */

function snapshotOf(session: GenerationSession, overrides: Partial<ClientSnapshot> = {}): ClientSnapshot {
  const raw = session.snapshot();
  return {
    sessionId: raw.sessionId,
    phase: raw.phase,
    sequence: raw.sequence,
    representations: raw.representations as unknown as ClientSnapshot['representations'],
    ...overrides,
  };
}

describe('applySnapshot', () => {
  it('obnoví stav po reconnectu z autoritativního snapshotu', () => {
    const { session, events } = generation();
    const partial = feed(events.slice(0, 3));

    const restored = applySnapshot(partial, snapshotOf(session));
    expect(restored.phase).toBe('world');
    expect(restored.sequence).toBe(session.events.sequence);
    expect(restored.shapes.map((entry) => entry.stableId).sort()).toEqual(['hero', 'pillar']);
    expect(shape(restored, 'hero').rung).toBe('refining');
  });

  it('revizi nikdy nesníží, ani když ji snapshot má nižší', () => {
    const { session } = generation();
    // Druhá věta zvedla revizi hrdiny na 1 a klient to ví z proudu.
    expect(session.revise('hero')).toBe(1);
    const current = applySnapshot(initialClientState(), snapshotOf(session));
    expect(shape(current, 'hero').revision).toBe(1);

    // Opožděný snapshot ze staršího požadavku popisuje svět před druhou větou.
    const stale = snapshotOf(session, {
      representations: [{ stableId: 'hero', revision: 0, state: { kind: 'planned' } }],
    });
    const after = applySnapshot(current, stale);
    expect(shape(after, 'hero').revision).toBe(1);
  });

  it('snapshot s nižším číslem proudu se zahodí celý', () => {
    const { session, events } = generation();
    const state = feed(events);

    const stale = snapshotOf(session, { phase: 'intent', sequence: 1, representations: [] });
    expect(applySnapshot(state, stale)).toBe(state);
  });

  it('objekt, o kterém snapshot neví, se nezahodí', () => {
    const { session, events } = generation();
    const state = feed(events);

    const thin = snapshotOf(session, {
      representations: [{ stableId: 'pillar', revision: 0, state: { kind: 'planned' } }],
    });
    const after = applySnapshot(state, thin);
    expect(after.shapes.map((entry) => entry.stableId).sort()).toEqual(['hero', 'pillar']);
    expect(shape(after, 'hero').contentHash).toBe('hash-coarse');
  });
});

/* ------------------------------------------------------------------ *
 * Čtečka nad scriptovaným `fetch`.
 * ------------------------------------------------------------------ */

const HANDLE: SessionHandle = {
  sessionId: SESSION_ID,
  events: `/api/worldstream/sessions/${SESSION_ID}/events`,
  snapshot: `/api/worldstream/sessions/${SESSION_ID}`,
};

interface Call {
  readonly url: string;
  readonly method: string;
}

/** Tělo proudu z kusů. `open: true` znamená spojení, které samo neskončí. */
function body(chunks: readonly string[], open: boolean, signal?: AbortSignal | null): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener(
        'abort',
        () => {
          // Přesně to, co udělá opravdový `fetch`: zruší se **tělo**.
          try {
            controller.error(new DOMException('the read was aborted', 'AbortError'));
          } catch {
            /* proud už skončil */
          }
        },
        { once: true },
      );
    },
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index++]));
        return;
      }
      if (!open) {
        controller.close();
        return;
      }
      // Otevřené spojení, které mlčí. Nikdy se nevyřeší.
      return new Promise<void>(() => undefined);
    },
  });
}

function streamResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

describe('followSession', () => {
  it('přečte celou relaci a skončí na koncové fázi', async () => {
    const { session } = generation();
    session.advance('complete', {});
    const frames = session.events.all().map(sessionFrame);
    const calls: Call[] = [];

    const state = await followSession(HANDLE, {
      maxResumes: 0,
      fetch: async (input, init) => {
        calls.push({ url: String(input), method: init?.method ?? 'GET' });
        return streamResponse(body(frames, false));
      },
    });

    expect(state.phase).toBe('complete');
    expect(shape(state, 'hero').contentHash).toBe('hash-coarse');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${HANDLE.events}?since=0`);
  });

  it('rámec rozpadlý uprostřed `data:` řádku dojde celý', async () => {
    const { session } = generation();
    session.advance('complete', {});
    const wire = session.events.all().map(sessionFrame).join('');
    // Řez uprostřed, ne na hranici rámce — to je stav, který vyrobí síť.
    const cut = Math.floor(wire.length / 2);

    const state = await followSession(HANDLE, {
      maxResumes: 0,
      fetch: async () => streamResponse(body([wire.slice(0, cut), wire.slice(cut)], false)),
    });

    expect(state.phase).toBe('complete');
    expect(state.sequence).toBe(session.events.sequence);
  });

  it('po mezeře si dojde pro snapshot a naváže od jeho čísla', async () => {
    const { session } = generation();
    session.advance('complete', {});
    const all = session.events.all();
    const calls: Call[] = [];
    let stream = 0;

    const state = await followSession(HANDLE, {
      maxResumes: 2,
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, method: init?.method ?? 'GET' });

        if (url === HANDLE.snapshot)
          return Response.json({
            ...session.snapshot(),
            // Snapshot je autoritativní k číslu, na kterém proud utekl.
            sequence: all[3].sequence,
            phase: 'world',
          });

        stream += 1;
        // První proud vynechá rámec 3 — tedy přesně ta mezera, kterou reducer
        // odmítne zalepit.
        if (stream === 1)
          return streamResponse(body([all[0], all[1], all[3]].map(sessionFrame), false));
        return streamResponse(body(all.slice(4).map(sessionFrame), false));
      },
    });

    expect(state.phase).toBe('complete');
    expect(calls.map((call) => call.url)).toEqual([
      `${HANDLE.events}?since=0`,
      HANDLE.snapshot,
      `${HANDLE.events}?since=${all[3].sequence}`,
    ]);
  });

  it('zrušení zastaví čtení a **na server nepošle nic dalšího**', async () => {
    const { session } = generation();
    const frames = session.events.all().map(sessionFrame);
    const controller = new AbortController();
    const calls: Call[] = [];
    let seen = 0;

    const state = await followSession(HANDLE, {
      signal: controller.signal,
      maxResumes: 3,
      onState: () => {
        seen += 1;
        // Odchod porotce ze stránky uprostřed generace.
        if (seen === 3) controller.abort();
      },
      fetch: async (input, init) => {
        calls.push({ url: String(input), method: init?.method ?? 'GET' });
        return streamResponse(body(frames, true, init?.signal));
      },
    });

    // Relace na serveru běží dál: klient ji nezrušil, jen se přestal dívat.
    expect(session.phase).toBe('world');
    expect(calls).toHaveLength(1);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
    // Rozečtený svět je použitelnější než výjimka.
    expect(state.phase).toBe('blueprint');
  });

  it('zrušení uprostřed čekání na další rámec vrátí svět, ne výjimku', async () => {
    // **Tenhle test je ten, který v provozu platí.** Ten nad ním zruší čtení
    // v okamžiku, kdy čtečka zrovna zpracovává rámce, takže se zastaví na
    // kontrole na začátku smyčky a k `reader.read()` se vůbec nedostane.
    // Porotce ale odchází ze stránky ve chvíli, kdy se **čeká** — mezi
    // `session.accepted` a `intent.ready` je celé volání modelu. Tam zrušení
    // shodí tělo odpovědi a `read()` se odmítne; naměřeno mutací, která
    // odchycení té výjimky sundala a tenhle soubor bez tohohle testu zůstal
    // celý zelený.
    const { session } = generation();
    const frames = session.events.all().map(sessionFrame);
    const controller = new AbortController();
    let seen = 0;

    const state = await followSession(HANDLE, {
      signal: controller.signal,
      maxResumes: 3,
      onState: () => {
        seen += 1;
        // Až za posledním rámcem: čtečka se vrátí do smyčky, projde kontrolou
        // (ještě není zrušeno) a zablokuje se na `read()`. Teprve pak časovač.
        if (seen === frames.length) setTimeout(() => controller.abort(), 0);
      },
      fetch: async (_input, init) => streamResponse(body(frames, true, init?.signal)),
    });

    expect(session.phase).toBe('world');
    expect(state.phase).toBe('world');
    expect(state.sequence).toBe(session.events.sequence);
  });

  it('proud zavřený před koncem relace se dočte, ne zahodí', async () => {
    const { session } = generation();
    session.advance('complete', {});
    const all = session.events.all();
    let stream = 0;

    const state = await followSession(HANDLE, {
      maxResumes: 1,
      fetch: async () => {
        stream += 1;
        if (stream === 1) return streamResponse(body(all.slice(0, 3).map(sessionFrame), false));
        return streamResponse(body(all.slice(3).map(sessionFrame), false));
      },
    });

    expect(state.phase).toBe('complete');
    expect(state.sequence).toBe(session.events.sequence);
  });
});

/* ------------------------------------------------------------------ *
 * Otevření relace.
 * ------------------------------------------------------------------ */

describe('openWorldstreamSession', () => {
  it('pošle prompt a vrátí adresy z odpovědi 202', async () => {
    let sent: unknown = null;

    const handle = await openWorldstreamSession('a drowned cathedral', {
      fetch: async (_input, init) => {
        sent = JSON.parse(String(init?.body));
        return Response.json(
          { requestId: 'req-1', sessionId: SESSION_ID, events: HANDLE.events, snapshot: HANDLE.snapshot },
          { status: 202 },
        );
      },
    });

    expect(sent).toEqual({ prompt: 'a drowned cathedral' });
    expect(handle).toEqual(HANDLE);
  });

  it('odmítnutí je výjimka s kódem serveru, ne tichý prázdný svět', async () => {
    await expect(
      openWorldstreamSession('something the moderator refuses', {
        fetch: async () =>
          Response.json({ error: { code: 'PROMPT_REFUSED', message: 'no' } }, { status: 400 }),
      }),
    ).rejects.toThrow('PROMPT_REFUSED');
  });
});

/* ------------------------------------------------------------------ *
 * Dekodér: starý kontrakt se odstěhováním nezměnil.
 * ------------------------------------------------------------------ */

describe('SseDecoder', () => {
  it('drží zbytek mezi kusy a komentář zahodí', () => {
    const decoder = new SseDecoder();
    expect(decoder.push(': heartbeat\n\nevent: progress\ndata: {"pha')).toEqual([]);
    expect(decoder.push('se":"schema","step":2}\n\n')).toEqual([
      { event: 'progress', data: '{"phase":"schema","step":2}' },
    ]);
  });
});
