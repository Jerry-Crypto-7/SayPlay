/**
 * **Automat relace a proud bez mezer (P13 T15).**
 *
 * Vada, kterou tu hledáme, je **závod, po kterém nezůstane stopa**. Pozdní
 * výsledek staré revize se připojí a vypadá jako správný tvar; rámec, který
 * se cestou ztratil, vypadá jako rámec, co teprve přijde; sloučený stavový
 * přechod vypadá jako přechod, který se nestal. Ani jedna z těch tří nevyhodí
 * výjimku a ani jednu nevidí porotce — vidí jen svět, který neodpovídá tomu,
 * co napsal.
 *
 * Testy proto všude tvrdí **obě strany**: co se přijmout má i co se přijmout
 * nesmí, a u čísel proudu úplnou posloupnost, ne její délku. Délka sedí
 * i tehdy, když se jedno číslo přeskočí a jiné zopakuje.
 */

import { describe, expect, it } from 'vitest';

import { coveringProgram } from '@/shape/__fixtures__/programs';

import { shapeContentHash, type MeshArtifact } from '../cache';
import { COALESCABLE_EVENT_TYPES } from '../events';
import {
  createSession,
  restoreSession,
  type GenerationSession,
  type RepresentationState,
} from '../session';

const SESSION_ID = 'ws-1';
const SEED = 4021;

/** Pevné hodiny. `at` je observační, takže se testy nemají čeho chytat. */
const CLOCK = () => '2026-09-02T10:00:00.000Z';

function session(): GenerationSession {
  return createSession({ sessionId: SESSION_ID, sessionSeed: SEED, now: CLOCK });
}

function artifact(overrides: Partial<MeshArtifact> = {}): MeshArtifact {
  return {
    shapeId: 'hive',
    contentHash: 'deadbeef',
    resolution: 32,
    vertices: 5_003,
    triangles: 10_044,
    bounds: { min: [-1, 0, -1], max: [1, 2, 1] },
    buildMs: 249,
    ...overrides,
  };
}

function coarse(): RepresentationState {
  return { kind: 'coarse', artifact: artifact() };
}

function refined(): RepresentationState {
  return {
    kind: 'refined',
    artifact: artifact({ contentHash: 'feed0001', resolution: 48, triangles: 24_616 }),
  };
}

/** Relace dovedená k hrubému světu s jedním zaregistrovaným hrdinou. */
function live(): GenerationSession {
  const run = session();
  run.advance('intent', { title: 'a hillside terrace of beehives' });
  run.advance('blueprint', { objects: ['hive'] });
  run.register(['hive']);
  run.advance('world', { simHash: '1a2b3c4d' });
  return run;
}

function sequences(run: GenerationSession): number[] {
  return run.events.all().map((event) => event.sequence);
}

describe('session phases', () => {
  it('opens the stream with session.accepted', () => {
    const run = session();
    expect(run.phase).toBe('accepted');
    expect(run.events.all()).toEqual([
      {
        sessionId: SESSION_ID,
        sequence: 1,
        type: 'session.accepted',
        at: CLOCK(),
        payload: {},
      },
    ]);
  });

  it('walks from intent to the coarse world, one rung at a time', () => {
    const run = session();
    expect(run.advance('intent').ok).toBe(true);
    expect(run.advance('blueprint').ok).toBe(true);
    expect(run.advance('world').ok).toBe(true);
    expect(run.advance('complete').ok).toBe(true);

    expect(run.phase).toBe('complete');
    expect(run.events.all().map((event) => event.type)).toEqual([
      'session.accepted',
      'intent.ready',
      'blueprint.ready',
      'world.ready',
      'session.complete',
    ]);
  });

  it('refuses to skip a rung, and mints nothing when it refuses', () => {
    const run = session();
    expect(run.advance('world')).toEqual({ ok: false, reason: 'NOT_MONOTONE' });
    expect(run.phase).toBe('accepted');
    expect(run.events.sequence).toBe(1);
  });

  it('refuses to go back', () => {
    const run = session();
    run.advance('intent');
    run.advance('blueprint');
    expect(run.advance('intent')).toEqual({ ok: false, reason: 'NOT_MONOTONE' });
    expect(run.phase).toBe('blueprint');
  });

  it('reaches failed from anywhere and then stays closed', () => {
    const run = session();
    run.advance('intent');
    expect(run.fail('the compiler never produced a blueprint').ok).toBe(true);
    expect(run.phase).toBe('failed');

    expect(run.advance('blueprint')).toEqual({ ok: false, reason: 'SESSION_CLOSED' });
    expect(run.fail('again')).toEqual({ ok: false, reason: 'SESSION_CLOSED' });
    expect(run.events.all().at(-1)?.type).toBe('session.failed');
  });

  it('does not let advance impersonate a failure', () => {
    const run = session();
    expect(run.advance('failed', 'boom')).toEqual({ ok: false, reason: 'NOT_MONOTONE' });
    expect(run.phase).toBe('accepted');
  });
});

describe('sequence numbers', () => {
  it('runs 1..n with no gaps and no duplicates across a whole generation', () => {
    const run = live();
    run.queue('hive', 32);
    run.apply({
      sessionId: SESSION_ID,
      stableId: 'hive',
      representationRevision: 0,
      next: coarse(),
    });
    run.apply({
      sessionId: SESSION_ID,
      stableId: 'hive',
      representationRevision: 0,
      next: { kind: 'refining', from: artifact() },
    });
    run.apply({
      sessionId: SESSION_ID,
      stableId: 'hive',
      representationRevision: 0,
      next: refined(),
    });
    run.advance('complete');

    const numbers = sequences(run);
    expect(numbers).toEqual([...numbers.keys()].map((index) => index + 1));
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(run.events.sequence).toBe(numbers.at(-1));
  });

  it('serves a reconnecting client only the tail it is missing', () => {
    const run = live();
    expect(run.events.since(0)).toHaveLength(4);
    expect(run.events.since(2).map((event) => event.type)).toEqual([
      'blueprint.ready',
      'world.ready',
    ]);
    // Klient, který tvrdí vyšší číslo než proud vydal, nedostane nic —
    // vymyslet mu rámce je horší než nechat ho na snapshotu.
    expect(run.events.since(99)).toEqual([]);
  });
});

describe('backpressure', () => {
  it('merges consecutive progress frames for the same object', () => {
    const run = live();
    run.register(['hive', 'wall']);
    run.apply({
      sessionId: SESSION_ID,
      stableId: 'hive',
      representationRevision: 0,
      next: coarse(),
    });

    const before = run.events.sequence;
    run.apply({
      sessionId: SESSION_ID,
      stableId: 'hive',
      representationRevision: 0,
      next: { kind: 'refining', from: artifact() },
    });
    const merged = run.apply({
      sessionId: SESSION_ID,
      stableId: 'hive',
      representationRevision: 0,
      next: { kind: 'refining', from: artifact({ contentHash: 'aaaa0001' }) },
    });

    expect(run.events.sequence).toBe(before + 1);
    expect(merged.ok && merged.event?.sequence).toBe(before + 1);
    // Sloučený rámec nese **novější** obsah, ne starší.
    expect(run.events.all().at(-1)?.payload).toEqual({ stableId: 'hive', from: 'aaaa0001' });
  });

  it('never merges progress across two different objects', () => {
    const run = live();
    run.register(['hive', 'wall']);

    // Tvary se meshují za sebou, takže se jejich průběhy proplétají. Kdyby se
    // slučovalo podle typu a ne podle objektu, `wall` by zmizela mezi dvěma
    // rámci `hive` a klient by se o ní nedozvěděl vůbec.
    for (const stableId of ['hive', 'wall', 'hive']) {
      run.apply({
        sessionId: SESSION_ID,
        stableId,
        representationRevision: 0,
        next: { kind: 'refining', from: artifact({ shapeId: stableId }) },
      });
    }

    expect(
      run.events
        .all()
        .filter((event) => event.type === 'shape.refining')
        .map((event) => (event.payload as { stableId: string }).stableId),
    ).toEqual(['hive', 'wall', 'hive']);
  });

  it('never merges a state transition', () => {
    const run = live();
    run.register(['hive', 'wall']);
    run.apply({
      sessionId: SESSION_ID,
      stableId: 'hive',
      representationRevision: 0,
      next: coarse(),
    });
    run.apply({
      sessionId: SESSION_ID,
      stableId: 'wall',
      representationRevision: 0,
      next: coarse(),
    });

    const coarseFrames = run.events.all().filter((event) => event.type === 'shape.coarse');
    expect(coarseFrames).toHaveLength(2);

    // **Soudí se vlastnost, ne opsaný seznam — přepsáno 4. 9. 2026.** Do
    // `COALESCABLE_EVENT_TYPES` přibyl `patch.rejected` (`T22-rejectflood`),
    // což je typ mimo žebřík příček, takže se automatu relace nedotýká vůbec.
    // Rovnost na jediné jméno by ale tenhle test položila — a tvrdila by tím
    // o příčkách něco, co se nezměnilo. Měří se tedy to, co název slibuje:
    // z příček se smí slučovat jedině průběh.
    for (const rung of ['shape.coarse', 'shape.ready', 'shape.failed'] as const)
      expect(COALESCABLE_EVENT_TYPES, `${rung} se slučuje, takže příčka umí zmizet`).not.toContain(
        rung,
      );
    expect(COALESCABLE_EVENT_TYPES).toContain('shape.refining');
  });
});

describe('stale artifacts', () => {
  it('drops a result of revision N delivered after revision N+1 was committed', () => {
    const run = live();
    const stale = { sessionId: SESSION_ID, stableId: 'hive', representationRevision: 0 } as const;

    expect(run.revisionOf('hive')).toBe(0);
    expect(run.revise('hive')).toBe(1);

    const before = run.events.sequence;
    expect(run.apply({ ...stale, next: coarse() })).toEqual({
      ok: false,
      fault: 'STALE_ARTIFACT',
      reason: 'STALE_REVISION',
    });

    // Ani stav, ani proud se nehnuly: registry o něm nesmí vědět (§13.4).
    expect(run.stateOf('hive')).toEqual({ kind: 'planned' });
    expect(run.events.sequence).toBe(before);

    // A nová revize projde toutéž cestou, takže odmítnutí není slepá ulička.
    expect(run.apply({ ...stale, representationRevision: 1, next: coarse() }).ok).toBe(true);
  });

  it('names the four ways a delivery can arrive too late', () => {
    const run = live();
    const now = { stableId: 'hive', representationRevision: 0, next: coarse() } as const;

    expect(run.apply({ ...now, sessionId: 'ws-other' })).toMatchObject({
      reason: 'UNKNOWN_SESSION',
    });
    expect(run.apply({ ...now, sessionId: SESSION_ID, stableId: 'ghost' })).toMatchObject({
      reason: 'UNKNOWN_OBJECT',
    });

    run.apply({ ...now, sessionId: SESSION_ID });
    expect(run.apply({ ...now, sessionId: SESSION_ID })).toMatchObject({
      reason: 'NOT_MONOTONE',
    });

    run.advance('complete');
    expect(run.apply({ ...now, sessionId: SESSION_ID, next: refined() })).toMatchObject({
      reason: 'SESSION_CLOSED',
    });
  });

  it('refuses a coarse artifact that arrives after the refined one', () => {
    const run = live();
    const at = { sessionId: SESSION_ID, stableId: 'hive', representationRevision: 0 } as const;

    run.apply({ ...at, next: coarse() });
    run.apply({ ...at, next: refined() });

    expect(run.apply({ ...at, next: coarse() })).toMatchObject({ reason: 'NOT_MONOTONE' });
    expect(run.stateOf('hive')).toEqual(refined());
  });
});

describe('failure and retry', () => {
  it('falls to failed from any rung and reports whether a retry is worth it', () => {
    const run = live();
    const at = { sessionId: SESSION_ID, stableId: 'hive', representationRevision: 0 } as const;

    run.apply({ ...at, next: coarse() });
    const outcome = run.apply({
      ...at,
      next: { kind: 'failed', reason: 'BUDGET_EXCEEDED', retryable: false },
    });

    expect(outcome.ok).toBe(true);
    expect(run.events.all().at(-1)).toMatchObject({
      type: 'shape.failed',
      payload: { stableId: 'hive', reason: 'BUDGET_EXCEEDED', retryable: false },
    });

    // Z `failed` nevede cesta doručením — jen výslovným retry nebo revizí.
    expect(run.apply({ ...at, next: refined() })).toMatchObject({ reason: 'NOT_MONOTONE' });
    expect(run.retry('hive')).toBe(false);
  });

  it('lets an explicit retry restart the same revision', () => {
    const run = live();
    const at = { sessionId: SESSION_ID, stableId: 'hive', representationRevision: 0 } as const;

    run.apply({ ...at, next: { kind: 'failed', reason: 'WORKER_FAILED', retryable: true } });
    expect(run.retry('hive')).toBe(true);
    expect(run.stateOf('hive')).toEqual({ kind: 'planned' });
    // Program se nezměnil, takže se revize nezvedá — jinak by retry vypadal
    // jako druhá věta a zrušil by práci, kterou nikdo neodvolal.
    expect(run.revisionOf('hive')).toBe(0);
    expect(run.apply({ ...at, next: coarse() }).ok).toBe(true);
  });
});

describe('rungs without a frame', () => {
  it('moves through validating and revealing without touching the stream', () => {
    const run = live();
    const at = { sessionId: SESSION_ID, stableId: 'hive', representationRevision: 0 } as const;

    run.apply({ ...at, next: coarse() });
    const before = run.events.sequence;

    expect(run.apply({ ...at, next: { kind: 'validating' } })).toMatchObject({ ok: true });
    expect(run.apply({ ...at, next: { kind: 'revealing', artifact: artifact() } })).toMatchObject({
      ok: true,
    });

    expect(run.stateOf('hive')?.kind).toBe('revealing');
    expect(run.events.sequence).toBe(before);
  });
});

describe('snapshot and reconnect', () => {
  it('restores the state and keeps numbering where the stream stopped', () => {
    const run = live();
    const key = shapeContentHash(coveringProgram(), 32);
    run.cache.settle(key, artifact({ contentHash: key }));
    run.apply({
      sessionId: SESSION_ID,
      stableId: 'hive',
      representationRevision: 0,
      next: coarse(),
    });

    const snapshot = run.snapshot();
    const back = restoreSession(snapshot, { now: CLOCK });

    expect(back.phase).toBe('world');
    expect(back.representations).toEqual(run.representations);
    expect(back.cache.lookup(key).kind).toBe('hit');

    // Historii rámců snapshot nenese; nese číslo, na které se navazuje.
    expect(back.events.all()).toEqual([]);
    const next = back.advance('complete');
    expect(next.ok && next.event.sequence).toBe(snapshot.sequence + 1);
  });

  it('registers a repeated blueprint without resetting a live representation', () => {
    const run = live();
    run.apply({
      sessionId: SESSION_ID,
      stableId: 'hive',
      representationRevision: 0,
      next: coarse(),
    });

    run.register(['hive', 'wall']);

    expect(run.stateOf('hive')).toEqual(coarse());
    expect(run.stateOf('wall')).toEqual({ kind: 'planned' });
  });
});
