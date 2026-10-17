/**
 * Fronta režiséra (P53 T2): při plných slotech dveří `play` volání čeká ve
 * frontě `AdmissionQueue` místo okamžitého `MODEL_UNAVAILABLE`. Odmítnutí
 * fronty (plná, termín, zavření) je dnešní výpadek modelu, slot se vrací na
 * každé cestě ven a čekající jdou v pořadí příchodu. Podvržený `fetch` na
 * primár, který odpoví až na pokyn – nikam se nevolá.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { genreAnswer } from '@/play/director/__fixtures__';
import { draftGameSpecWithMeta } from '@/play/draft';
import { __resetProcessVersionStore, memoryVersionStore } from '@/play/version';
import { type AnswerStore, memoryAnswerStore } from '@/server/answer-cache';
import { acquireSlot, DOOR_CEILING, resetConcurrency, slotsDetail } from '@/server/paid-slots';
import { resetRateWindows } from '@/server/rate-limit';
import { resetProcessSpendCap } from '@/server/spend-cap';

const answers = vi.hoisted(() => ({ store: null as AnswerStore | null }));
vi.mock('@/play/director', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/play/director')>();
  return { ...actual, directorCacheFromEnv: () => actual.directorCache(answers.store ?? memoryAnswerStore()) };
});

import {
  callDirectorModel,
  DEFAULT_PLAY_DIRECTOR_QUEUE,
  DIRECTOR_BUDGET_MS,
  directorCalls,
  directorQueueLength,
  directorQueueState,
  getDirector,
  OSS_MIN_CALL_MS,
  resetDirectorQueue,
} from '../_director';
import { derivedSeeds, publishReadSpec, seedFrom } from '../_publish';
import { __resetRemixes, remixStatus, startRemix } from '../_remix-jobs';
import { __resetUpgrades, knownUpgrade, upgradeOf } from '../_upgrade';

const OSS = {
  WORLDSMITH_BRANCH: 'live',
  WORLDSMITH_MODEL_ENDPOINT: 'openai:https://api.together.xyz',
  WORLDSMITH_MODEL: 'openai/gpt-oss-20b',
  WORLDSMITH_MODEL_PROFILE: 'metered',
  WORLDSMITH_MODEL_KEY: 'tg-test-key',
  WORLDSMITH_USD_PER_MTOK_IN: '0.05',
  WORLDSMITH_USD_PER_MTOK_OUT: '0.2',
  WORLDSMITH_SPEND_CAP_USD: '5',
} as const;

const COMPACT = genreAnswer({ genre: 'platformer', mode: 'default', hero: 'penguin', cast: undefined, setting: 'frozen iceberg field', palette: 'snow' });
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango'];
const sentence = (n: number) => `a penguin jumps ${WORDS[n]!}`;

const answer = () =>
  new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content: JSON.stringify(COMPACT) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2000, completion_tokens: 900 },
    }),
  );

/**
 * Primár, který odpoví až na pokyn. `first` = věty v pořadí, v jakém poprvé
 * šly ven (opravné kolo téže věty se nepočítá), `inFlight` = kolik volání
 * právě visí, `peak` = nejvíc naráz.
 */
function gatedUpstream() {
  const first: string[] = [];
  /** Každé volání v pořadí, i opravné kolo a druhý pokus téže věty. */
  const all: string[] = [];
  const held: Array<{ readonly said: string; readonly settle: (reply: Response | Error) => void }> = [];
  let open = false;
  let peak = 0;
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    const body = String(init.body);
    const said = WORDS.map((_, n) => sentence(n)).find((candidate) => body.includes(candidate)) ?? '?';
    all.push(said);
    if (!first.includes(said)) first.push(said);
    if (open) return Promise.resolve(answer());
    return new Promise<Response>((resolve, reject) => {
      held.push({ said, settle: (reply) => (reply instanceof Error ? reject(reply) : resolve(reply)) });
      peak = Math.max(peak, held.length);
    });
  });
  return {
    first,
    all,
    inFlight: () => held.length,
    peak: () => peak,
    /** Odpoví nejstaršímu visícímu volání. */
    answerNext: (reply: Response | Error = answer()) => held.shift()!.settle(reply),
    /** Odpoví všem visícím a každému dalšímu hned. */
    openAll: () => {
      open = true;
      for (const call of held.splice(0)) call.settle(answer());
    },
  };
}

function stubEnv(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  resetProcessSpendCap();
}

beforeEach(() => {
  answers.store = memoryAnswerStore();
  __resetProcessVersionStore();
  resetRateWindows();
  resetConcurrency();
  resetDirectorQueue();
  __resetUpgrades();
  __resetRemixes();
  stubEnv(OSS);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetProcessSpendCap();
  resetConcurrency();
  resetDirectorQueue();
});

/** `vi.waitFor` s rezervou: osmnáct režií naráz překládá a ověřuje déle než výchozí vteřinu. */
const until = (check: () => void) => vi.waitFor(check, { timeout: 30_000 });

/**
 * Totéž pod falešnými hodinami, ale bez posunu času: `vi.waitFor` by při každém
 * pokusu posunul hodiny o 50 ms a čekající by vypršel dřív, než se na něj podíváme.
 */
async function untilFrozen(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200_000 && !check(); turn += 1) await new Promise((next) => setImmediate(next));
  expect(check()).toBe(true);
}

/** Režie věty `n`, každá s vlastním volajícím (denní počet volajícího tu nerozhoduje). */
const directing = (n: number, startedAt = Date.now()) => getDirector(startedAt, `queue-caller-${String(n)}`)(sentence(n));

describe('the play director queue (P53 T2)', () => {
  it('(a) a third call at a ceiling of 2 waits and goes out once a slot frees', async () => {
    expect(DOOR_CEILING.play).toBe(2);
    const up = gatedUpstream();
    const games = [directing(0), directing(1), directing(2)];
    await until(() => expect(directorQueueState()).toEqual({ running: 2, queued: 1 }));
    expect(up.first).toEqual([sentence(0), sentence(1)]);
    expect(slotsDetail('play')).toContain('2 play');

    up.answerNext();
    await until(() => expect(up.first).toEqual([sentence(0), sentence(1), sentence(2)]));
    up.openAll();
    const done = await Promise.all(games);
    expect(done.map((game) => game.source)).toEqual(['authored', 'authored', 'authored']);
    expect(up.peak()).toBe(2);
    expect(directorQueueState()).toEqual({ running: 0, queued: 0 });
    expect(slotsDetail('play')).toContain('0 play');
  });

  it(`(b) the waiter past ${String(DEFAULT_PLAY_DIRECTOR_QUEUE)} gets QUEUE_FULL, which the player sees as MODEL_UNAVAILABLE`, async () => {
    const up = gatedUpstream();
    const games = Array.from({ length: 2 + DEFAULT_PLAY_DIRECTOR_QUEUE }, (_, n) => directing(n));
    await until(() => expect(directorQueueState()).toEqual({ running: 2, queued: DEFAULT_PLAY_DIRECTOR_QUEUE }));

    const refused = await directing(2 + DEFAULT_PLAY_DIRECTOR_QUEUE);
    expect(refused).toMatchObject({ source: 'draft', fallbackReason: 'MODEL_UNAVAILABLE', failure: { reason: 'UPSTREAM_REJECTED' } });
    expect(refused.failure?.detail).toContain('QUEUE_FULL');
    expect(up.first).not.toContain(sentence(2 + DEFAULT_PLAY_DIRECTOR_QUEUE));

    up.openAll();
    expect((await Promise.all(games)).every((game) => game.source === 'authored')).toBe(true);
    expect(up.peak()).toBe(2);
  });

  it('(c) a waiter whose wait would leave less than the call minimum is refused with DEADLINE_EXCEEDED', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const up = gatedUpstream();
    // Fronta vznikne prvním voláním; čas přijetí před jejím vznikem by se nebral.
    up.openAll();
    await directing(0);
    vi.setSystemTime(Date.now() + DIRECTOR_BUDGET_MS);

    const held = gatedUpstream();
    const running = [directing(1), directing(2)];
    await untilFrozen(() => held.inFlight() === 2);
    // Z rozpočtu zbývá minimum volání gpt-oss a o vteřinu víc.
    const late = directing(3, Date.now() - (DIRECTOR_BUDGET_MS - OSS_MIN_CALL_MS - 1_000));
    await untilFrozen(() => directorQueueState().queued === 1);

    await vi.advanceTimersByTimeAsync(990);
    expect(directorQueueState().queued, 'refused before its deadline').toBe(1);
    await vi.advanceTimersByTimeAsync(20);
    const game = await late;
    expect(game).toMatchObject({ source: 'draft', fallbackReason: 'MODEL_UNAVAILABLE' });
    expect(game.failure?.detail).toContain('DEADLINE_EXCEEDED');
    expect(held.first).not.toContain(sentence(3));

    held.openAll();
    expect((await Promise.all(running)).map((g) => g.source)).toEqual(['authored', 'authored']);
  });

  it('(d) a failing or throwing call gives its slot back to the next waiter', async () => {
    const up = gatedUpstream();
    const failing = [directing(0), directing(1)];
    const waiting = directing(2);
    await until(() => expect(directorQueueState()).toEqual({ running: 2, queued: 1 }));
    up.answerNext(new TypeError('fetch failed'));
    expect((await failing[0]!).source).toBe('draft');
    await until(() => expect(up.first).toContain(sentence(2)));

    // Výjimka uprostřed režie (kontrola hratelnosti spadne) slot vrátí taky.
    const thrown = getDirector(Date.now(), 'queue-caller-throws', () => {
      throw new Error('check exploded');
    })(sentence(3));
    await until(() => expect(directorQueueState().queued).toBe(1));
    up.openAll();
    await expect(thrown).rejects.toThrow('check exploded');
    await Promise.all([failing[1], waiting]);
    expect(directorQueueState()).toEqual({ running: 0, queued: 0 });
    expect(slotsDetail('play')).toContain('0 play');
    expect(acquireSlot('play')).toBe(true);
    expect(acquireSlot('play')).toBe(true);
  });

  it('(e) waiters get the freed slots in the order they arrived', async () => {
    const up = gatedUpstream();
    const games = [directing(0), directing(1)];
    for (const n of [2, 3, 4]) {
      games.push(directing(n));
      await until(() => expect(directorQueueState().queued).toBe(n - 1));
    }
    for (const n of [2, 3, 4]) {
      up.answerNext();
      await until(() => expect(up.first).toHaveLength(n + 1));
    }
    expect(up.first).toEqual([0, 1, 2, 3, 4].map(sentence));
    up.openAll();
    await Promise.all(games);
  });

  it('queues a remix call the same way, and maps its refusal to UPSTREAM_REJECTED', async () => {
    stubEnv({ PLAY_DIRECTOR_QUEUE: '0' });
    resetDirectorQueue();
    const up = gatedUpstream();
    const games = [directing(0), directing(1)];
    await until(() => expect(up.inFlight()).toBe(2));
    const request = { model: 'x', system: 's', user: sentence(5) };
    const refused = await callDirectorModel(Date.now(), 'remix-caller', request, sentence(5));
    expect(refused).toMatchObject({ ok: false, reason: 'UPSTREAM_REJECTED' });
    expect(refused.ok ? '' : refused.detail).toContain('QUEUE_FULL');
    up.openAll();
    await Promise.all(games);
  });

  // Revize fáze 1: vypínač čtený před frontou by čekajícího po až 240 s pustil k placenému volání.
  it('a waiter admitted after the upstream kill switch went on makes no paid call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'play-queue-kill-'));
    const control = join(dir, 'control.json');
    writeFileSync(control, JSON.stringify({ off: [] }));
    stubEnv({ WORLDSMITH_CONTROL_FILE: control });
    try {
      const up = gatedUpstream();
      const games = [directing(0), directing(1), directing(2)];
      await until(() => expect(directorQueueState()).toEqual({ running: 2, queued: 1 }));
      writeFileSync(control, JSON.stringify({ off: ['upstream'] }));
      up.answerNext();
      const late = await games[2]!;
      expect(late.fallbackReason).toBe('MODEL_UNAVAILABLE');
      expect(up.first).not.toContain(sentence(2));
      up.openAll();
      await Promise.all(games);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // P53 T3: stav, který klient polluje, nese pořadí, dokud práce čeká – a ztratí ho, jakmile slot má.
  it('(f) a waiting upgrade and remix carry their place in line until they get a slot', async () => {
    const up = gatedUpstream();
    const store = memoryVersionStore();
    const said = sentence(2);
    const quick = await publishReadSpec(store, draftGameSpecWithMeta(said, 1).spec, derivedSeeds(seedFrom(said)), null, { origin: { sentence: said, seed: null } });
    if (!quick.ok) throw new Error(`quick version did not publish: ${JSON.stringify(quick.issues)}`);
    const draft = quick.value.game;
    const draftId = draft.version.versionId;
    const busy = [directing(0), directing(1)];
    await until(() => expect(up.inFlight()).toBe(2));

    const upgraded = upgradeOf(store, draft, { sentence: said, seed: null, ackMs: null, draftReadyMs: null, startedAt: Date.now(), caller: 'queue-upgrade' });
    await until(() => expect(knownUpgrade(draftId)).toMatchObject({ status: 'pending', queued: 1 }));
    const remix = startRemix(store, draft, { sentence: sentence(3), startedAt: Date.now(), caller: 'queue-remix' });
    if (remix.status !== 'pending') throw new Error(`remix did not start: ${JSON.stringify(remix)}`);
    await until(() => expect(directorQueueState().queued).toBe(2));
    expect(await remixStatus(store, draftId, remix.job)).toMatchObject({ status: 'pending', queued: 2 });

    up.answerNext();
    await until(() => expect(up.first).toContain(said));
    expect(knownUpgrade(draftId)).toMatchObject({ status: 'pending' });
    expect(knownUpgrade(draftId)).not.toHaveProperty('queued');
    expect(await remixStatus(store, draftId, remix.job)).toMatchObject({ status: 'pending', queued: 1 });

    up.openAll();
    await Promise.all([...busy, upgraded]);
    await until(async () => expect((await remixStatus(store, draftId, remix.job))?.status).not.toBe('pending'));
    expect(await remixStatus(store, draftId, remix.job)).not.toHaveProperty('queued');
  });

  // Revize fáze 1, nález 2 (T3a): druhé volání téže práce nesmí znovu čekat na konci fronty za cizími větami.
  it('(g) an upgrade that adds nothing publishes its first version while strangers wait, without queueing again', async () => {
    const up = gatedUpstream();
    const store = memoryVersionStore();
    const said = sentence(2);
    const quick = await publishReadSpec(store, draftGameSpecWithMeta(said, 1).spec, derivedSeeds(seedFrom(said)), null, { origin: { sentence: said, seed: null } });
    if (!quick.ok) throw new Error(`quick version did not publish: ${JSON.stringify(quick.issues)}`);
    const draftId = quick.value.game.version.versionId;
    const busy = [directing(0), directing(1)];
    await until(() => expect(up.inFlight()).toBe(2));
    const upgraded = upgradeOf(store, quick.value.game, { sentence: said, seed: null, ackMs: null, draftReadyMs: null, startedAt: Date.now(), caller: 'queue-upgrade' });
    await until(() => expect(knownUpgrade(draftId)).toMatchObject({ status: 'pending', queued: 1 }));
    const strangers = [directing(3), directing(4)];
    await until(() => expect(directorQueueState().queued).toBe(3));

    up.answerNext();
    await until(() => expect(up.first).toContain(said));
    up.answerNext();
    await until(() => expect(up.first).toContain(sentence(3)));
    expect(directorQueueState().queued, 'a stranger still waits').toBe(1);
    // Odpověď upgradu: jeho slot hned vezme čekající cizí věta, takže pro druhý pokus volno není.
    up.answerNext();
    await until(() => expect(knownUpgrade(draftId)?.status).toBe('ready'));
    expect(knownUpgrade(draftId)).toMatchObject({ status: 'ready', adds: [] });
    expect(up.all.filter((call) => call === said)).toHaveLength(1);

    up.openAll();
    await Promise.all([...busy, ...strangers, upgraded]);
  });

  it('(h) the second paid call of one work rides the slot its first call took', async () => {
    const up = gatedUpstream();
    const request = (n: number) => ({ model: 'x', system: 's', user: sentence(n) });
    const calls = directorCalls(Date.now(), 'remix-caller', 'remix-work');
    const first = calls.call(request(5), sentence(5));
    await until(() => expect(up.inFlight()).toBe(1));
    const busy = directing(0);
    await until(() => expect(up.inFlight()).toBe(2));
    const stranger = directing(1);
    await until(() => expect(directorQueueState().queued).toBe(1));

    up.answerNext();
    expect(await first).toMatchObject({ ok: true });
    const second = calls.call(request(6), sentence(6));
    await until(() => expect(up.first).toContain(sentence(6)));
    expect(up.first, 'the stranger still waits behind the held slot').not.toContain(sentence(1));
    expect(directorQueueState()).toEqual({ running: 2, queued: 1 });

    up.openAll();
    expect(await second).toMatchObject({ ok: true });
    calls.close();
    await Promise.all([busy, stranger]);
    expect(directorQueueState()).toEqual({ running: 0, queued: 0 });
    expect(slotsDetail('play')).toContain('0 play');
  });
});

describe('PLAY_DIRECTOR_QUEUE', () => {
  it('defaults to 16 and takes any whole number from 0', () => {
    expect(DEFAULT_PLAY_DIRECTOR_QUEUE).toBe(16);
    expect(directorQueueLength({})).toBe(16);
    expect(directorQueueLength({ PLAY_DIRECTOR_QUEUE: '' })).toBe(16);
    expect(directorQueueLength({ PLAY_DIRECTOR_QUEUE: '0' })).toBe(0);
    expect(directorQueueLength({ PLAY_DIRECTOR_QUEUE: ' 40 ' })).toBe(40);
  });

  it.each(['-1', 'many', '2.5', '1e3', '9'.repeat(400)])('refuses %s with a log line and keeps 16', (raw) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(directorQueueLength({ PLAY_DIRECTOR_QUEUE: raw })).toBe(16);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('PLAY_DIRECTOR_QUEUE'));
  });
});
