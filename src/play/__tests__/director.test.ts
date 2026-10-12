import type { GenreSpec } from '../genre/contract';
import { liveCells, assemblyOfCell } from '../compose/allowed';
import { compileRecipe } from '../compose/compile';
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
import { actionEvidence, missingActions } from '../fidelity/action-evidence';
import { extractIntent } from '../intent/extract';

/** Věta, které je výchozí odpověď (`genreAnswer`: vlk a žaludy lesa) věrná – P39 soudí obsazení proti větě. */
const SENTENCE = 'Collect five acorns in a moonlit forest';

/** Hra, kterou z odpovědi (čtené proti větě, je-li dána) složí modul žánru – to, co režisér vrátí bez oprav. */
function compiled(answer = genreAnswer(), sentence?: string): GameSpecV1 {
  const counted = sentence === undefined && answer.spec.cast?.some(item => item.does === 'collect') ? { ...answer, spec: { ...answer.spec, counts: { ...answer.spec.counts, collectible: 5 } } } : answer;
  const read = readGenreAnswer(counted, undefined, sentence);
  if (!read.ok) throw new Error(`${read.reason}: ${read.detail}`);
  if (sentence !== undefined || !answer.spec.cast?.some(item => item.does === 'collect')) return read.spec;
  const composition = draftGameSpecWithMeta(SENTENCE).composition;
  // P42: věta se skládá z dílů (`assembled.<pohyb>`), ne z živé buňky žánru – režisér složení zkompiluje s obsahem odpovědi.
  if (composition?.recipe.preset === 'assembled') return compileRecipe({ ...composition.recipe, content: { ...read.genre, genre: composition.recipe.content.genre, mode: composition.recipe.content.mode } as GenreSpec });
  const cell = liveCells().find(cell => cell.id === composition?.cellId);
  if (cell === undefined) throw new Error('Expected a live legacy fixture');
  return compileRecipe(assemblyOfCell(cell, { ...read.genre, genre: cell.preset.genre, mode: cell.preset.mode } as GenreSpec));
}

const KEYPOINT: RepairIssue = { code: 'KEYPOINT_FAILED', path: '/verification/0', evidence: 'keypoint winnable failed: the robot never won', repairHint: 'fix the game or the claim' };

/** Robot, který neprojde hru přesně tak, jak ji z `answer` složil modul žánru; projde cokoli, co záplata změnila. */
const checkFor =
  (answer = genreAnswer()) =>
  (spec: GameSpecV1): RepairIssue[] =>
    (answer === SURVIVE ? spec.objective.seconds !== 30 : isDeepStrictEqual(spec, compiled(answer))) ? [KEYPOINT] : [];
const check = checkFor();

/**
 * Útěk bez věci ke sběru: přežít 40 s. Skutečná Aréna (T5b) dává útěku se sběrem
 * cíl bez času, takže záplata `CONTRADICT` má co rozporovat jen tady. Věrná je
 * jen větě bez věci ke sběru (`ESCAPE`) – větě se žaludy by kontrola obsazení žaludy doplnila.
 */
const SURVIVE = genreAnswer({ cast: [{ label: 'wolf', does: 'chase_me' }] });
const ESCAPE = 'A fox escapes a wolf in a dark forest';

const RETITLE = [{ op: 'replace', path: '/title', value: 'Fox Night Escape' }];
/** Záplata, která hře přežití (`SURVIVE`) přinese blokující nález: cíl 30 s proti časovači 40 s (CONTRADICTION). */
// P41 escape may be a native track without an existing timer. Create the actual
// contradiction explicitly; the check seam above only requests the initial repair.
const CONTRADICT = [
  { op: 'add', path: '/objective/seconds', value: 30 },
  { op: 'add', path: '/mechanics/-', value: { id: 'timer', params: { id: 'clock', seconds: 40, onEnd: 'lose' } } },
];
const UNCONTRADICT = [{ op: 'replace', path: '/objective/seconds', value: 40 }];

/** Režim → ovládání, na které ho dnes přeloží modul žánru. */
const CONTROL_OF_MODE: Readonly<Record<string, string>> = {
  'runner.default': 'runner',
  'platformer.default': 'platform',
  'arena.escape': 'move_free',
  'arena.collect': 'move_free',
  // Skutečné moduly (T5b): souboj hraje generátor na volném pohybu, přibyly přistání a oba režimy úkolu.
  'arena.fight': 'move_free',
  'voyage.race': 'steer',
  'voyage.land': 'steer',
  'quest.spatial': 'move_free',
  'quest.station': 'move_free',
  // P36A T10: střelba a hod jsou zase žánry na svých ovládáních.
  'shooter.default': 'shooter',
  'throw.default': 'throw',
  // P36A T11: načasování, rytmus, souboj a poletování taky.
  'timing.stack': 'timing',
  'timing.precision': 'timing',
  'timing.bridge': 'timing',
  'rhythm.default': 'rhythm',
  'duel.default': 'duel',
  'flap.default': 'flap',
};

/** Režim → věta, jejíž hlavní sloveso ho hraje (kontrola věrnosti, P32B T5); hrdina fox a nepřítel wolf jako v `genreAnswer`. */
const SENTENCE_OF_MODE: Readonly<Record<string, string>> = {
  'runner.default': 'A fox runs through a dark forest past a wolf',
  'platformer.default': 'A fox jumps across a dark forest past a wolf',
  'arena.escape': 'A fox escapes a wolf in a dark forest',
  'arena.collect': 'A fox collects acorns in a dark forest while a wolf prowls',
  'arena.fight': 'A fox fights a wolf in a dark forest',
  'voyage.race': 'A fox drives through a dark forest past a wolf',
  'voyage.land': 'A fox lands on a dark forest clearing past a wolf',
  'quest.spatial': 'A fox lights lanterns in a dark forest while a wolf prowls',
  'quest.station': 'A fox cooks soup in a dark forest kitchen while a wolf prowls',
  'shooter.default': 'A fox shoots wolves in a dark forest',
  'throw.default': 'A fox throws stones at a wolf in a dark forest',
  'timing.stack': 'A fox stacks logs in a dark forest while a wolf prowls',
  'timing.precision': 'A fox taps at the right time to stop the swinging log in a dark forest while a wolf prowls',
  'timing.bridge': 'A fox grows a bridge over a dark forest gorge while a wolf prowls',
  'rhythm.default': 'A fox dances in a dark forest while a wolf prowls',
  'duel.default': 'A fox duels a wolf in a dark forest',
  'flap.default': 'A fox flaps through a dark forest past a wolf',
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
    expect(game.spec).toMatchObject({ control: 'move_free', genre: { id: 'arena', mode: 'collect' } });
    expect(branch.calls).toHaveLength(1);
    const request = branch.calls[0]!.request;
    expect(request.user).toContain(SENTENCE);
    expect(request.user).toContain(`Starting point (a keyword guess, replace what it got wrong): ${JSON.stringify(draftGameSpecWithMeta(SENTENCE).genre)}`);
    expect(request.outputSchema).toBe(GENRE_ANSWER_SCHEMA);
    expect(game.ms).toBeGreaterThan(0);
  });

  it('every ready mode is authored on the control its genre module compiles, with the hero the answer named', async () => {
    expect(GENRE_ANSWERS.map(({ name }) => name).sort()).toEqual(Object.keys(CONTROL_OF_MODE).sort());
    expect(Object.keys(SENTENCE_OF_MODE).sort()).toEqual(Object.keys(CONTROL_OF_MODE).sort());
    for (const { name, answer } of GENRE_ANSWERS) {
      const game = await run(fakeBranch([answered(answer)]), {}, SENTENCE_OF_MODE[name]);
      expect(game.source, name).toBe('authored');
      // Věrná odpověď se nepřepíná: hra je přesně ta, kterou z odpovědi složí modul žánru.
      // Čtení proti větě doplní, co odpověď nenapsala – hod „throws stones“ hází kameny (P39 T14).
      expect(compiled(answer, SENTENCE_OF_MODE[name]).control, name).toBe(CONTROL_OF_MODE[name]);
      const unmet = missingActions(extractIntent(SENTENCE_OF_MODE[name]!), await actionEvidence(game.spec, 1));
      expect(game.unmet, name).toEqual(unmet);
      expect(game.fallbackReason, name).toBe(unmet.length > 0 ? 'VERB_UNPROVED' : null);
      expect(game.spec.roles.find((role) => role.kind === 'player')?.label, name).toBe('fox');
    }
    // Každý žánr ověří robot; s logikou P45B a průběhem P45C samotný test ~20 s.
  }, 90_000);

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
      answered(SURVIVE),
      answered(CONTRADICT),
      (call) => {
        // Nález, který přinesla záplata, jde modelu v dalším kole.
        expect(call.request.user).toContain('CONTRADICTION');
        return answered({ not: 'an array' });
      },
      // Čtvrté volání by spec spravilo – nesmí k němu dojít.
      answered(UNCONTRADICT),
    ]);
    const game = await run(branch, { check: checkFor(SURVIVE) }, ESCAPE);
    // Hláška „could not fix“ pro žánrový spec neexistuje (P32B T5): hraje se žánr draftu, bez důvodu zálohy.
    expect(game).toMatchObject({ source: 'draft', fallbackReason: 'UNREPAIRED', repairRounds: 2, calls: 3, failure: { stage: 'critic', reason: 'UNREPAIRED' } });
    expect(game.spec).toEqual(draftGameSpec(ESCAPE));
    expect(game.failure?.detail).toContain('CONTRADICTION');
    expect(branch.calls).toHaveLength(3);
  });

  it('a keypoint that keeps failing costs at most two rounds – 3 calls, never 4 – and the game is not cached', async () => {
    const writes: string[] = [];
    const cache = { id: 'spy', read: () => Promise.resolve(null), write: (key: string) => Promise.resolve(void writes.push(key)) };
    const branch = fakeBranch([answered(genreAnswer()), answered({ not: 'an array' }), answered([{ op: 'replace', path: '/schema', value: 'x' }]), answered(RETITLE)]);
    const game = await run(branch, { check, cache });
    // Hru, kterou kritik pustil, soudí až publikace (NOT_PLAYABLE); do cache nejde, příští pokus dostane novou šanci.
    expect(game).toMatchObject({ source: 'authored', fallbackReason: 'VERB_UNPROVED', repairRounds: 2, calls: 3 });
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
    const game = await run(fakeBranch([answered(SURVIVE), answered(CONTRADICT), failed('UPSTREAM_UNAVAILABLE')]), { check: checkFor(SURVIVE) }, ESCAPE);
    expect(game).toMatchObject({ source: 'draft', fallbackReason: 'MODEL_UNAVAILABLE', calls: 3, failure: { stage: 'model' } });
    // Nad hrou, kterou kritik pustil, výpadek o větě nic neříká: hra jde dál.
    const passed = await run(fakeBranch([answered(genreAnswer()), failed('UPSTREAM_UNAVAILABLE')]), { check });
    expect(passed).toMatchObject({ source: 'authored', fallbackReason: 'VERB_UNPROVED', calls: 2 });
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
    const stale: GameSpecV1 = { ...compiled(SURVIVE), objective: { ...compiled(SURVIVE).objective, seconds: 30 } };
    expect(blockingIssues(critique(stale)).map((issue) => issue.code)).toEqual(['CONTRADICTION']);
    const cache = { id: 'stale', read: () => Promise.resolve({ spec: stale, authoredBy: null }), write: () => Promise.resolve() };
    const branch = fakeBranch([answered(genreAnswer())]);
    const game = await run(branch, { cache });
    expect(game).toMatchObject({ source: 'authored', calls: 1 });
    expect(game.spec).toEqual(compiled());
  });

  it('an unrepaired game played as the draft genre is never written – the next direct calls the model again', async () => {
    const cache = directorCache(memoryAnswerStore(), () => undefined);
    const first = await run(fakeBranch([answered(SURVIVE), answered(CONTRADICT), answered({})]), { cache, check: checkFor(SURVIVE) }, ESCAPE);
    expect(first).toMatchObject({ source: 'draft', fallbackReason: 'UNREPAIRED', failure: { reason: 'UNREPAIRED' } });
    expect(first.spec).toEqual(draftGameSpec(ESCAPE));
    const branch = fakeBranch([answered(SURVIVE)]);
    const second = await run(branch, { cache }, ESCAPE);
    const unmet = missingActions(extractIntent(ESCAPE), await actionEvidence(second.spec, 1));
    expect(second.source).toBe('authored');
    expect(second.unmet).toEqual(unmet);
    expect(second.calls).toBe(unmet.length > 0 ? 2 : 1);
    expect(branch.calls).toHaveLength(second.calls);
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
