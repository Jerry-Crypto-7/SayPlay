/**
 * Kdo hru napsal (P29B R2). Od zálohy režiséra (T8) může první odpověď psát
 * primár i lokální model a opravné kolo ten druhý; `authoredBy` to musí říct
 * a přežít cache – jinak opakovaná věta tvrdí `cached` bez stopy po autorovi.
 */

import { describe, expect, it } from 'vitest';

import { memoryAnswerStore } from '@/server/answer-cache';

import { answerFixture } from '../director/__fixtures__';
import { answered } from '../director/__fixtures__/branch';
import { fakeBranch } from '../director/__fixtures__/branch';
import { directorCache } from '../director/cache';
import { blockingIssues, critique } from '../director/critic';
import { direct } from '../director/index';
import { readGameSpec, type GameSpecV1 } from '../spec';

const SENTENCE = 'Collect five glowing mushrooms in a moonlit forest, then escape through the portal';

const by = (body: unknown, model: string) => ({ ...answered(body), provenance: { branch: 'fake', model } });

function unrepairableByTable(): GameSpecV1 {
  const read = readGameSpec(answerFixture('good-survival_timer'));
  if (!read.ok) throw new Error(read.reason);
  const spec = JSON.parse(JSON.stringify(read.value)) as GameSpecV1;
  (spec.mechanics[0].params as { onEnd: string }).onEnd = 'signal';
  expect(blockingIssues(critique(spec))).not.toEqual([]);
  return spec;
}

const now = () => 0;

describe('authoredBy', () => {
  it('names the model of the answer and survives the cache', async () => {
    const cache = directorCache(memoryAnswerStore());
    const first = await direct(SENTENCE, { branch: fakeBranch([by(answerFixture('good-collect_exit'), 'gpt-oss-20b')]), cache, now });
    expect(first).toMatchObject({ source: 'authored', authoredBy: 'gpt-oss-20b' });
    const again = await direct(SENTENCE, { branch: fakeBranch([]), cache, now });
    expect(again).toMatchObject({ source: 'cached', authoredBy: 'gpt-oss-20b' });
  });

  // Revize P29B na hranici fáze: klíč cache patří primáru – hra od zálohy by ho navždy zastoupila.
  it('does not cache a game the local fallback wrote, in the answer or in a repair round', async () => {
    // Roli zálohy dává šev režiséra (`_director.ts`); transport o ní od P30A nerozhoduje.
    const local = (body: unknown) => ({ ...answered(body), provenance: { branch: 'fake', model: 'gpt-oss-20b', source: 'hosted-http', fallback: true } });
    const cache = directorCache(memoryAnswerStore());
    expect(await direct(SENTENCE, { branch: fakeBranch([local(answerFixture('good-collect_exit'))]), cache, now })).toMatchObject({ source: 'authored', authoredBy: 'gpt-oss-20b' });
    expect((await direct(SENTENCE, { branch: fakeBranch([]), cache, now })).source).not.toBe('cached');
    const patch = [{ op: 'replace', path: '/mechanics/0/params/onEnd', value: 'win' }];
    const repaired = directorCache(memoryAnswerStore());
    expect(await direct(SENTENCE, { branch: fakeBranch([by(unrepairableByTable(), 'gpt-6-astra'), local(patch)]), cache: repaired, now })).toMatchObject({ source: 'authored', repairRounds: 1 });
    expect((await direct(SENTENCE, { branch: fakeBranch([]), cache: repaired, now })).source).not.toBe('cached');
  });

  it('adds the model that wrote the repair round', async () => {
    const patch = [{ op: 'replace', path: '/mechanics/0/params/onEnd', value: 'win' }];
    const game = await direct(SENTENCE, { branch: fakeBranch([by(unrepairableByTable(), 'gpt-6-astra'), by(patch, 'gpt-oss-20b')]), now });
    expect(game).toMatchObject({ source: 'authored', repairRounds: 1, authoredBy: 'gpt-6-astra + gpt-oss-20b' });
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
    const game = await direct(SENTENCE, { branch: fakeBranch([answered(answerFixture('good-collect_exit'))]), now });
    expect(game.source).toBe('authored');
    expect(game).not.toHaveProperty('authoredBy');
  });
});
