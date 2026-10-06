/**
 * Kdo hru napsal (P29B R2). Od zálohy režiséra (T8) může první odpověď psát
 * primár i lokální model a opravné kolo ten druhý; `authoredBy` to musí říct
 * a přežít cache – jinak opakovaná věta tvrdí `cached` bez stopy po autorovi.
 * První odpověď je od P32B T4 `GenreSpec`; opravné kolo spustí neprošlý
 * keypoint (`check`), protože hru ze žánru kritik pustí.
 */

import { isDeepStrictEqual } from 'node:util';

import { describe, expect, it } from 'vitest';

import { memoryAnswerStore } from '@/server/answer-cache';

import { answerFixture, genreAnswer } from '../director/__fixtures__';
import { answered } from '../director/__fixtures__/branch';
import { fakeBranch } from '../director/__fixtures__/branch';
import { directorCache } from '../director/cache';
import { direct } from '../director/index';
import { readGenreAnswer } from '../director/read';
import type { RepairIssue } from '../director/repair';
import { readGameSpec, type GameSpecV1 } from '../spec';

/** Věta, které je výchozí odpověď (`genreAnswer`: vlk a žaludy lesa) věrná – P39 soudí obsazení proti větě. */
const SENTENCE = 'Collect five acorns in a moonlit forest, then escape through the portal';

const by = (body: unknown, model: string) => ({ ...answered(body), provenance: { branch: 'fake', model } });

function compiled(): GameSpecV1 {
  const read = readGenreAnswer(genreAnswer());
  if (!read.ok) throw new Error(read.detail);
  return read.spec;
}

/** Robot, který neprojde hru ze žánru, dokud ji záplata nezmění – jediná cesta do opravného kola. */
const check = (spec: GameSpecV1): RepairIssue[] =>
  isDeepStrictEqual(spec, compiled()) ? [{ code: 'KEYPOINT_FAILED', path: '/verification/0', evidence: 'keypoint winnable failed', repairHint: 'fix the game or the claim' }] : [];

const patch = [{ op: 'replace', path: '/title', value: 'Fox Night Escape' }];

const now = () => 0;

describe('authoredBy', () => {
  it('names the model of the answer and survives the cache', async () => {
    const cache = directorCache(memoryAnswerStore());
    const answer = await direct(SENTENCE, { branch: fakeBranch([by(genreAnswer(), 'gpt-oss-20b')]), cache, now });
    expect(answer).toMatchObject({ source: 'authored', authoredBy: 'gpt-oss-20b' });
    const again = await direct(SENTENCE, { branch: fakeBranch([]), cache, now });
    expect(again).toMatchObject({ source: 'cached', authoredBy: 'gpt-oss-20b' });
  });

  // Revize P29B na hranici fáze: klíč cache patří primáru – hra od zálohy by ho navždy zastoupila.
  it('does not cache a game the local fallback wrote, in the answer or in a repair round', async () => {
    // Roli zálohy dává šev režiséra (`_director.ts`); transport o ní od P30A nerozhoduje.
    const local = (body: unknown) => ({ ...answered(body), provenance: { branch: 'fake', model: 'gpt-oss-20b', source: 'hosted-http', fallback: true } });
    const cache = directorCache(memoryAnswerStore());
    expect(await direct(SENTENCE, { branch: fakeBranch([local(genreAnswer())]), cache, now })).toMatchObject({ source: 'authored', authoredBy: 'gpt-oss-20b' });
    expect((await direct(SENTENCE, { branch: fakeBranch([]), cache, now })).source).not.toBe('cached');
    const repaired = directorCache(memoryAnswerStore());
    expect(await direct(SENTENCE, { branch: fakeBranch([by(genreAnswer(), 'gpt-6-astra'), local(patch)]), cache: repaired, check, now })).toMatchObject({ source: 'authored', repairRounds: 1 });
    expect((await direct(SENTENCE, { branch: fakeBranch([]), cache: repaired, now })).source).not.toBe('cached');
  });

  it('adds the model that wrote the repair round, and both survive the cache', async () => {
    const cache = directorCache(memoryAnswerStore());
    const game = await direct(SENTENCE, { branch: fakeBranch([by(genreAnswer(), 'gpt-6-astra'), by(patch, 'gpt-oss-20b')]), cache, check, now });
    expect(game).toMatchObject({ source: 'authored', repairRounds: 1, authoredBy: 'gpt-6-astra + gpt-oss-20b' });
    const again = await direct(SENTENCE, { branch: fakeBranch([]), cache, now });
    expect(again).toMatchObject({ source: 'cached', authoredBy: 'gpt-6-astra + gpt-oss-20b' });
  });

  it('reads a record written before attribution as unknown author', async () => {
    const store = memoryAnswerStore();
    const cache = directorCache(store);
    const spec = readGameSpec(answerFixture('good-collect_exit'));
    if (!spec.ok) throw new Error(spec.reason);
    await store.set('old', JSON.stringify(spec.value), 60);
    await expect(cache.read('old')).resolves.toEqual({ spec: spec.value, authoredBy: null });
  });

  it('has no authoredBy when the branch does not name a model', async () => {
    const game = await direct(SENTENCE, { branch: fakeBranch([answered(genreAnswer())]), now });
    expect(game.source).toBe('authored');
    expect(game).not.toHaveProperty('authoredBy');
  });
});
