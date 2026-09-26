/**
 * Orchestrace režiséra (P23-B T7) nad dvojníkem větve. Model se nevolá;
 * `fakeBranch` odpovídá ze scénáře a počítá volání – strop kol, pořadí
 * návrh → model a „do cache jen přijatý spec" jsou tři vlastnosti, které
 * zelené testy bez počítání volání nepoznají (mutanty v outcome úlohy).
 */

import { describe, expect, it } from 'vitest';

import { memoryAnswerStore } from '@/server/answer-cache';

import { GOOD_ANSWERS, answerFixture } from '../director/__fixtures__';
import { answered, failed, fakeBranch, type FakeBranch } from '../director/__fixtures__/branch';
import { directorCache, directorCacheFromEnv, directorKey } from '../director/cache';
import { blockingIssues, critique } from '../director/critic';
import { direct, type DirectedGame } from '../director/index';
import { DIRECTOR_PROMPT_VERSION } from '../director/prompt';
import { readGameSpec, type GameSpecV1 } from '../spec';

const SENTENCE = 'Collect five glowing mushrooms in a moonlit forest, then escape through the portal';

function good(name: (typeof GOOD_ANSWERS)[number]): GameSpecV1 {
  const result = readGameSpec(answerFixture(name));
  if (!result.ok) throw new Error(`${name}: ${result.reason}`);
  return result.value;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Přečtený spec, který deterministická oprava nespraví: survival_timer nesmí zone_trigger, takže timer bez výhry zůstane bez výhry. */
function unrepairableByTable(): GameSpecV1 {
  const spec = clone(good('good-survival_timer'));
  (spec.mechanics[0].params as { onEnd: string }).onEnd = 'signal';
  expect(blockingIssues(critique(spec)).map((issue) => issue.code)).toEqual(['NO_TERMINATION']);
  return spec;
}

const WIN_PATCH = [{ op: 'replace', path: '/mechanics/0/params/onEnd', value: 'win' }];

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
  it('a good answer is authored in one call with no repair round', async () => {
    const branch = fakeBranch([answered(answerFixture('good-collect_exit'))]);
    const game = await run(branch);
    expect(game).toMatchObject({ ok: true, source: 'authored', repairRounds: 0, fallbackReason: null, calls: 1 });
    expect(game.spec).toEqual(good('good-collect_exit'));
    expect(branch.calls).toHaveLength(1);
    expect(branch.calls[0].request.user).toContain(SENTENCE);
    expect(game.ms).toBeGreaterThan(0);
  });

  it('an unknown mechanic is repaired from the table – still authored, still one call', async () => {
    const branch = fakeBranch([answered(answerFixture('bad-unknown-mechanic'))]);
    const game = await run(branch);
    expect(game).toMatchObject({ source: 'authored', repairRounds: 0, calls: 1 });
    expect(game.spec.mechanics.map((m) => m.id)).toEqual(['defeat', 'health']);
    expect(blockingIssues(critique(game.spec))).toEqual([]);
  });

  it('a blocking issue the table cannot fix costs one RFC 6902 round', async () => {
    const branch = fakeBranch([
      answered(unrepairableByTable()),
      (call) => {
        expect(call.request.user).toContain('NO_TERMINATION');
        return answered(WIN_PATCH);
      },
    ]);
    const game = await run(branch);
    expect(game).toMatchObject({ source: 'authored', repairRounds: 1, fallbackReason: null, calls: 2 });
    expect(game.spec.mechanics[0].params).toMatchObject({ onEnd: 'win' });
    expect(branch.calls).toHaveLength(2);
  });

  it('carries the critic warnings of the accepted spec', async () => {
    const spec = clone(good('good-collect_exit'));
    spec.targetDurationSec = 170;
    spec.mechanics = spec.mechanics.filter((m) => m.id !== 'chaser');
    const game = await run(fakeBranch([answered(spec)]));
    expect(game.source).toBe('authored');
    expect(game.warnings.every((issue) => issue.severity === 'warn')).toBe(true);
    expect(game.warnings.map((issue) => issue.code)).toContain('DEAD_TIME');
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
    expect(order).toEqual(['draft:collect_exit', 'generate']);
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

  it('a WorldDoc instead of a GameSpec → draft + MALFORMED', async () => {
    const game = await run(fakeBranch([answered(answerFixture('bad-worlddoc'))]));
    expect(game).toMatchObject({ source: 'draft', fallbackReason: 'MALFORMED', calls: 1 });
  });

  it('three broken repairs in a row → draft + UNREPAIRED after exactly 3 calls, never 4', async () => {
    const branch = fakeBranch([
      answered(unrepairableByTable()),
      answered({ not: 'an array' }),
      answered([{ op: 'replace', path: '/schema', value: 'x' }]),
      // Čtvrté volání by spec spravilo – nesmí k němu dojít.
      answered(WIN_PATCH),
    ]);
    const game = await run(branch);
    expect(game).toMatchObject({ source: 'draft', fallbackReason: 'UNREPAIRED', repairRounds: 0, calls: 3 });
    expect(branch.calls).toHaveLength(3);
  });

  it('maxRepairRounds: 0 means no repair call at all', async () => {
    const branch = fakeBranch([answered(unrepairableByTable()), answered(WIN_PATCH)]);
    const game = await run(branch, { maxRepairRounds: 0 });
    expect(game).toMatchObject({ source: 'draft', fallbackReason: 'UNREPAIRED', calls: 1 });
  });

  it('a branch that dies during a repair round → draft + MODEL_UNAVAILABLE', async () => {
    const game = await run(fakeBranch([answered(unrepairableByTable()), failed('UPSTREAM_UNAVAILABLE')]));
    expect(game).toMatchObject({ source: 'draft', fallbackReason: 'MODEL_UNAVAILABLE', calls: 2 });
  });
});

describe('direct – cache', () => {
  it('the second direct of the same sentence is cached with zero calls, whitespace and case aside', async () => {
    const cache = directorCache(memoryAnswerStore(), () => undefined);
    const first = await run(fakeBranch([answered(answerFixture('good-collect_exit'))]), { cache });
    expect(first.source).toBe('authored');

    const branch = fakeBranch([answered(answerFixture('good-chase_escape'))]);
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
    const branch = fakeBranch([answered(answerFixture('good-collect_exit'))]);
    const game = await run(branch, { cache });
    expect(game).toMatchObject({ source: 'authored', calls: 1 });
  });

  it('a cached spec the critic blocks today is a miss – the model is called again', async () => {
    const stale = unrepairableByTable();
    const cache = { id: 'stale', read: () => Promise.resolve({ spec: stale, authoredBy: null }), write: () => Promise.resolve() };
    const branch = fakeBranch([answered(answerFixture('good-collect_exit'))]);
    const game = await run(branch, { cache });
    expect(game).toMatchObject({ source: 'authored', calls: 1 });
    expect(game.spec).toEqual(good('good-collect_exit'));
  });

  it('a draft fallback is never written – the next direct calls the model again', async () => {
    const cache = directorCache(memoryAnswerStore(), () => undefined);
    const first = await run(fakeBranch([answered(unrepairableByTable()), answered({}), answered({})]), { cache });
    expect(first.fallbackReason).toBe('UNREPAIRED');
    const branch = fakeBranch([answered(answerFixture('good-collect_exit'))]);
    const second = await run(branch, { cache });
    expect(second).toMatchObject({ source: 'authored', calls: 1 });
    expect(branch.calls).toHaveLength(1);
  });

  it('a store that throws is a miss on read and silent on write', async () => {
    const cache = directorCache({ id: 'broken', get: () => Promise.reject(new Error('down')), set: () => Promise.reject(new Error('down')) }, () => undefined);
    const game = await run(fakeBranch([answered(answerFixture('good-collect_exit'))]), { cache });
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
