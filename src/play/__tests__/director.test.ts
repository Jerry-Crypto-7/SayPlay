/**
 * Orchestrace režiséra (P23-B T7; od P32B T4 nad odpovědí `GenreSpec`) nad
 * dvojníkem větve. Model se nevolá; `fakeBranch` odpovídá ze scénáře a počítá
 * volání – strop kol, pořadí návrh → model a „do cache jen přijatý spec" jsou
 * tři vlastnosti, které zelené testy bez počítání volání nepoznají (mutanty
 * v outcome úlohy).
 *
 * Hru z první odpovědi skládá modul žánru a kritik ji pustí; do opravného kola
 * ji tak posílá neprošlé ověření robotem (`check`) a blokující nález do ní může
 * přinést až záplata. Tělo `GameSpec` je nečitelné a tabulkou se neopravuje.
 */

import { isDeepStrictEqual } from 'node:util';

import { describe, expect, it } from 'vitest';

import { memoryAnswerStore } from '@/server/answer-cache';

import { GENRE_ANSWERS, answerFixture, genreAnswer } from '../director/__fixtures__';
import { answered, failed, fakeBranch, type FakeBranch } from '../director/__fixtures__/branch';
import { GENRE_ANSWER_SCHEMA } from '../director/answer-schema';
import { directorCache, directorCacheFromEnv, directorKey } from '../director/cache';
import { blockingIssues, critique } from '../director/critic';
import { direct, type DirectedGame } from '../director/index';
import { DIRECTOR_PROMPT_VERSION } from '../director/prompt';
import { readGenreAnswer } from '../director/read';
import type { RepairIssue } from '../director/repair';
import { draftGameSpec, draftGameSpecWithMeta } from '../draft';
import { readGameSpec, type GameSpecV1 } from '../spec';

const SENTENCE = 'Collect five glowing mushrooms in a moonlit forest, then escape through the portal';

/** Hra, kterou z odpovědi složí modul žánru – to, co režisér vrátí bez oprav. */
function compiled(answer = genreAnswer()): GameSpecV1 {
  const read = readGenreAnswer(answer);
  if (!read.ok) throw new Error(`${read.reason}: ${read.detail}`);
  return read.spec;
}

const KEYPOINT: RepairIssue = { code: 'KEYPOINT_FAILED', path: '/verification/0', evidence: 'keypoint winnable failed: the robot never won', repairHint: 'fix the game or the claim' };

/** Robot, který neprojde hru přesně tak, jak ji složil modul žánru; projde cokoli, co záplata změnila. */
const check = (spec: GameSpecV1): RepairIssue[] => (isDeepStrictEqual(spec, compiled()) ? [KEYPOINT] : []);

const RETITLE = [{ op: 'replace', path: '/title', value: 'Fox Night Escape' }];
/** Záplata, která hře přinese blokující nález: cíl 30 s proti časovači 40 s (CONTRADICTION). */
const CONTRADICT = [{ op: 'replace', path: '/objective/seconds', value: 30 }];
const UNCONTRADICT = [{ op: 'replace', path: '/objective/seconds', value: 40 }];

/** Režim → ovládání, na které ho dnes přeloží modul žánru. */
const CONTROL_OF_MODE: Readonly<Record<string, string>> = {
  'runner.default': 'runner',
  'platformer.default': 'platform',
  'arena.escape': 'move_free',
  'arena.collect': 'move_free',
  'arena.fight': 'duel',
  'voyage.race': 'steer',
};

/** Režim → věta, jejíž hlavní sloveso ho hraje (kontrola věrnosti, P32B T5); hrdina fox a nepřítel wolf jako v `genreAnswer`. */
const SENTENCE_OF_MODE: Readonly<Record<string, string>> = {
  'runner.default': 'A fox runs through a dark forest past a wolf',
  'platformer.default': 'A fox jumps across a dark forest past a wolf',
  'arena.escape': 'A fox escapes a wolf in a dark forest',
  'arena.collect': 'A fox collects acorns in a dark forest while a wolf prowls',
  'arena.fight': 'A fox fights a wolf in a dark forest',
  'voyage.race': 'A fox drives through a dark forest past a wolf',
};

function clock(): () => number {
  let tick = 0;
  return () => {
    tick += 250;
    return tick;
  };
}

async function run(branch: FakeBranch, overrides: Partial<Parameters<typeof direct>[1]> = {}, sentence = SENTENCE): Promise<DirectedGame> {
  return direct(sentence, { branch, now: clock(), ...overrides });
}

describe('direct – the model answers', () => {
  it('a good GenreSpec answer is authored in one call: the genre module builds the game', async () => {
    const branch = fakeBranch([answered(genreAnswer())]);
    const game = await run(branch);
    expect(game).toMatchObject({ ok: true, source: 'authored', repairRounds: 0, fallbackReason: null, calls: 1 });
    expect(game.spec).toEqual(compiled());
    expect(game.spec).toMatchObject({ control: 'move_free', genre: { id: 'arena', mode: 'escape' } });
    expect(branch.calls).toHaveLength(1);
    const request = branch.calls[0]!.request;
    expect(request.user).toContain(SENTENCE);
    expect(request.user).toContain(`Starting point (keep or improve): ${JSON.stringify(draftGameSpecWithMeta(SENTENCE).genre)}`);
    expect(request.outputSchema).toBe(GENRE_ANSWER_SCHEMA);
    expect(game.ms).toBeGreaterThan(0);
  });

  it('every ready mode is authored on the control its genre module compiles, with the hero the answer named', async () => {
    expect(GENRE_ANSWERS.map(({ name }) => name).sort()).toEqual(Object.keys(CONTROL_OF_MODE).sort());
    expect(Object.keys(SENTENCE_OF_MODE).sort()).toEqual(Object.keys(CONTROL_OF_MODE).sort());
    for (const { name, answer } of GENRE_ANSWERS) {
      const game = await run(fakeBranch([answered(answer)]), {}, SENTENCE_OF_MODE[name]);
      expect(game, name).toMatchObject({ source: 'authored', fallbackReason: null, calls: 1 });
      // Věrná odpověď se nepřepíná: hra je přesně ta, kterou z odpovědi složí modul žánru.
      expect(game.spec, name).toEqual(compiled(answer));
      expect(game.spec.control, name).toBe(CONTROL_OF_MODE[name]);
      expect(game.spec.roles.find((role) => role.kind === 'player')?.label, name).toBe('fox');
    }
  });

  it('a GameSpec body is unreadable – draft + MALFORMED after one call, the table no longer repairs it', async () => {
    const good = answerFixture('good-collect_exit');
    for (const body of [good, { plan: 'a whole game', spec: good }, answerFixture('bad-unknown-mechanic')]) {
      const game = await run(fakeBranch([answered(body)]));
      expect(game).toMatchObject({ source: 'draft', fallbackReason: 'MALFORMED', repairRounds: 0, calls: 1, failure: { stage: 'read', reason: 'MALFORMED_SPEC' } });
    }
  });

  it('a failed keypoint costs one RFC 6902 round and the patched game is accepted', async () => {
    const branch = fakeBranch([
      answered(genreAnswer()),
      (call) => {
        expect(call.request.user).toContain('KEYPOINT_FAILED');
        return answered(RETITLE);
      },
    ]);
    const game = await run(branch, { check });
    expect(game).toMatchObject({ source: 'authored', repairRounds: 1, fallbackReason: null, calls: 2 });
    expect(game.spec).toEqual({ ...compiled(), title: 'Fox Night Escape' });
    expect(branch.calls).toHaveLength(2);
  });

  it('carries the critic warnings of the accepted spec, not of the first one', async () => {
    const echo = [{ op: 'replace', path: '/tutorial/goalLine', value: compiled().title }];
    const game = await run(fakeBranch([answered(genreAnswer()), answered(echo)]), { check });
    expect(game).toMatchObject({ source: 'authored', repairRounds: 1 });
    expect(game.warnings.every((issue) => issue.severity === 'warn')).toBe(true);
    expect(critique(compiled()).map((issue) => issue.code)).not.toContain('GOAL_UNCLEAR');
    expect(game.warnings.map((issue) => issue.code)).toContain('GOAL_UNCLEAR');
  });
});

describe('direct – failure paths fall back to the draft, never throw', () => {
  it('UPSTREAM_UNAVAILABLE → draft + MODEL_UNAVAILABLE, and the draft came out before generate', async () => {
    const order: string[] = [];
    const branch = fakeBranch([
      () => {
        order.push('generate');
        return failed('UPSTREAM_UNAVAILABLE');
      },
    ]);
    const game = await run(branch, {
      onDraft: (spec) => {
        order.push(`draft:${spec.archetype}`);
      },
    });
    expect(game).toMatchObject({ ok: true, source: 'draft', fallbackReason: 'MODEL_UNAVAILABLE', repairRounds: 0, calls: 1 });
    // Draft nové hry je od P32B T2 žánr; archetyp mu dává modul žánru, ne mřížka.
    expect(order).toEqual([`draft:${draftGameSpec(SENTENCE).archetype}`, 'generate']);
    expect(readGameSpec(game.spec).ok).toBe(true);
  });

  it('onDraft fires synchronously, before the first await', () => {
    let seen: GameSpecV1 | null = null;
    const pending = run(fakeBranch([]), { onDraft: (spec) => (seen = spec) });
    expect(seen).not.toBeNull();
    return pending;
  });

  it('an empty object → draft + MALFORMED after one call', async () => {
    const game = await run(fakeBranch([answered({})]));
    expect(game).toMatchObject({ source: 'draft', fallbackReason: 'MALFORMED', calls: 1 });
  });

  it('a WorldDoc instead of a GenreSpec → draft + MALFORMED', async () => {
    const game = await run(fakeBranch([answered(answerFixture('bad-worlddoc'))]));
    expect(game).toMatchObject({ source: 'draft', fallbackReason: 'MALFORMED', calls: 1 });
  });

  it('a blocking issue that survives the last round → the draft genre, authored, failure UNREPAIRED after exactly 3 calls, never 4', async () => {
    const branch = fakeBranch([
      answered(genreAnswer()),
      answered(CONTRADICT),
      (call) => {
        // Nález, který přinesla záplata, jde modelu v dalším kole.
        expect(call.request.user).toContain('CONTRADICTION');
        return answered({ not: 'an array' });
      },
      // Čtvrté volání by spec spravilo – nesmí k němu dojít.
      answered(UNCONTRADICT),
    ]);
    const game = await run(branch, { check });
    // Hláška „could not fix“ pro žánrový spec neexistuje (P32B T5): hraje se žánr draftu, bez důvodu zálohy.
    expect(game).toMatchObject({ source: 'authored', fallbackReason: null, repairRounds: 2, calls: 3, failure: { stage: 'critic', reason: 'UNREPAIRED' } });
    expect(game.spec).toEqual(draftGameSpec(SENTENCE));
    expect(game.failure?.detail).toContain('CONTRADICTION');
    expect(branch.calls).toHaveLength(3);
  });

  it('a keypoint that keeps failing costs at most two rounds – 3 calls, never 4 – and the game is not cached', async () => {
    const writes: string[] = [];
    const cache = { id: 'spy', read: () => Promise.resolve(null), write: (key: string) => Promise.resolve(void writes.push(key)) };
    const branch = fakeBranch([answered(genreAnswer()), answered({ not: 'an array' }), answered([{ op: 'replace', path: '/schema', value: 'x' }]), answered(RETITLE)]);
    const game = await run(branch, { check, cache });
    // Hru, kterou kritik pustil, soudí až publikace (NOT_PLAYABLE); do cache nejde, příští pokus dostane novou šanci.
    expect(game).toMatchObject({ source: 'authored', fallbackReason: null, repairRounds: 2, calls: 3 });
    expect(game.spec).toEqual(compiled());
    expect(branch.calls).toHaveLength(3);
    expect(writes).toEqual([]);
  });

  it('maxRepairRounds: 0 means no repair call at all', async () => {
    const branch = fakeBranch([answered(genreAnswer()), answered(RETITLE)]);
    const game = await run(branch, { check, maxRepairRounds: 0 });
    expect(game).toMatchObject({ source: 'authored', repairRounds: 0, calls: 1 });
    expect(branch.calls).toHaveLength(1);
  });

  it('a branch that dies during a repair round over a blocking issue → draft + MODEL_UNAVAILABLE', async () => {
    const game = await run(fakeBranch([answered(genreAnswer()), answered(CONTRADICT), failed('UPSTREAM_UNAVAILABLE')]), { check });
    expect(game).toMatchObject({ source: 'draft', fallbackReason: 'MODEL_UNAVAILABLE', calls: 3, failure: { stage: 'model' } });
    // Nad hrou, kterou kritik pustil, výpadek o větě nic neříká: hra jde dál.
    const passed = await run(fakeBranch([answered(genreAnswer()), failed('UPSTREAM_UNAVAILABLE')]), { check });
    expect(passed).toMatchObject({ source: 'authored', fallbackReason: null, calls: 2 });
  });
});

describe('direct – cache', () => {
  it('the second direct of the same sentence is cached with zero calls, whitespace and case aside', async () => {
    const cache = directorCache(memoryAnswerStore(), () => undefined);
    const first = await run(fakeBranch([answered(genreAnswer())]), { cache });
    expect(first.source).toBe('authored');

    const branch = fakeBranch([answered(genreAnswer({ genre: 'runner', mode: 'default' }))]);
    const second = await run(branch, { cache }, `  ${SENTENCE.toUpperCase()}   `);
    expect(second).toMatchObject({ source: 'cached', repairRounds: 0, fallbackReason: null, calls: 0 });
    expect(second.spec).toEqual(first.spec);
    expect(branch.calls).toHaveLength(0);
  });

  it('a broken record in the store is a miss', async () => {
    const store = memoryAnswerStore();
    const cache = directorCache(store, () => undefined);
    const key = directorKey({ sentence: SENTENCE, promptVersion: DIRECTOR_PROMPT_VERSION, model: 'x', endpoint: 'fake' });
    await store.set(key, '{"schema":"gamespec.v1"', 60);
    await store.set(directorKey({ sentence: SENTENCE, promptVersion: DIRECTOR_PROMPT_VERSION, model: 'x', endpoint: 'other' }), '{"title":"not a spec"}', 60);
    expect(await cache.read(key)).toBeNull();
    const branch = fakeBranch([answered(genreAnswer())]);
    const game = await run(branch, { cache });
    expect(game).toMatchObject({ source: 'authored', calls: 1 });
  });

  it('a cached spec the critic blocks today is a miss – the model is called again', async () => {
    const stale: GameSpecV1 = { ...compiled(), objective: { ...compiled().objective, seconds: 30 } };
    expect(blockingIssues(critique(stale)).map((issue) => issue.code)).toEqual(['CONTRADICTION']);
    const cache = { id: 'stale', read: () => Promise.resolve({ spec: stale, authoredBy: null }), write: () => Promise.resolve() };
    const branch = fakeBranch([answered(genreAnswer())]);
    const game = await run(branch, { cache });
    expect(game).toMatchObject({ source: 'authored', calls: 1 });
    expect(game.spec).toEqual(compiled());
  });

  it('an unrepaired game played as the draft genre is never written – the next direct calls the model again', async () => {
    const cache = directorCache(memoryAnswerStore(), () => undefined);
    const first = await run(fakeBranch([answered(genreAnswer()), answered(CONTRADICT), answered({})]), { cache, check });
    expect(first).toMatchObject({ source: 'authored', fallbackReason: null, failure: { reason: 'UNREPAIRED' } });
    expect(first.spec).toEqual(draftGameSpec(SENTENCE));
    const branch = fakeBranch([answered(genreAnswer())]);
    const second = await run(branch, { cache });
    expect(second).toMatchObject({ source: 'authored', calls: 1 });
    expect(branch.calls).toHaveLength(1);
  });

  it('a store that throws is a miss on read and silent on write', async () => {
    const cache = directorCache({ id: 'broken', get: () => Promise.reject(new Error('down')), set: () => Promise.reject(new Error('down')) }, () => undefined);
    const game = await run(fakeBranch([answered(genreAnswer())]), { cache });
    expect(game).toMatchObject({ source: 'authored', calls: 1 });
  });

  it('directorKey: sentence normalised, every other field distinguishes', () => {
    const base = { sentence: SENTENCE, promptVersion: DIRECTOR_PROMPT_VERSION, model: 'm', endpoint: 'e' };
    expect(directorKey(base)).toBe(directorKey({ ...base, sentence: `  ${SENTENCE.toUpperCase()} ` }));
    expect(directorKey(base)).not.toBe(directorKey({ ...base, promptVersion: 'other' }));
    expect(directorKey(base)).not.toBe(directorKey({ ...base, model: 'other' }));
    expect(directorKey(base)).not.toBe(directorKey({ ...base, endpoint: 'other' }));
    expect(directorKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('directorCacheFromEnv: memory without a shared store, http with one', () => {
    expect(directorCacheFromEnv({}).id).toBe('memory');
    expect(directorCacheFromEnv({ KV_REST_API_URL: 'https://kv.example', KV_REST_API_TOKEN: 't' }, () => Promise.reject(new Error('no network'))).id).toBe('http');
  });
});
