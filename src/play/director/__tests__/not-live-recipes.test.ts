/**
 * Recepty mimo tabulku živých kombinací (P54C T14br2). Čtyři odpovědi gpt-oss-20b z T14b
 * (`__fixtures__/not-live-recipes.json`: P46E d01, o01, o04 z `a035e5ad` a dev p06) spadly
 * na rychlou verzi jako `MALFORMED`. Model skládal kusy z různých řádků tabulky, takže
 * čtení recept převede na živou buňku se stejným pohybem a cílem, nebo ho odmítne s nápovědou.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { loadRapier } from '../../arcade/physics/world';
import { answered, fakeBranch } from '../__fixtures__/branch';
import { direct } from '../index';
import { readRecipeAnswer } from '../read';

interface Recorded { readonly id: string; readonly model: string; readonly sentence: string; readonly answer: Readonly<Record<string, unknown>> }

const recorded = JSON.parse(readFileSync(join(process.cwd(), 'src/play/director/__fixtures__/not-live-recipes.json'), 'utf8')) as readonly Recorded[];
const byId = (id: string): Recorded => recorded.find((item) => item.id === id)!;
const play = (id: string) => direct(byId(id).sentence, { branch: fakeBranch([answered(byId(id).answer)]), now: () => 0, maxRepairRounds: 0 });

describe('a director recipe outside the live table (P54C T14br2)', () => {
  beforeAll(async () => {
    await loadRapier();
  });

  it('replays four answers a model wrote', () => {
    expect(recorded.map((item) => item.id)).toEqual(['d01', 'o01', 'o04', 'p06']);
    for (const item of recorded) expect(item.model).toBe('gpt-oss-20b');
  });

  it.each([
    ['o01', 'run//escape/chaser', [{ actor: 'rabbit', verb: 'collect', object: null }]],
    ['o04', 'drive/shoot/escape/chaser', [{ actor: 'car', verb: 'push', object: null }]],
  ] as const)('%s keeps its move and objective and lists the dropped pieces as unmet', (id, recipe, dropped) => {
    const read = readRecipeAnswer(byId(id).answer);
    if (!read.ok) throw new Error(read.detail);
    const { move, actions, objective, threats } = read.value.recipe;
    expect([move, actions.join('+'), objective, threats.join('+')].join('/')).toBe(recipe);
    expect(read.value.unmet).toEqual(dropped);
  });

  it('o01 becomes the director game', async () => {
    expect((await play('o01')).source).toBe('authored');
  });

  it('o04 gets past the recipe – its own params of other genres are a separate rejection', async () => {
    const game = await play('o04');
    expect(game.failure?.detail).not.toContain('not a live combination');
    expect(game.failure?.detail).toContain('params');
  });

  it.each([
    ['d01', 'live with move run: -/escape/chaser'],
    ['p06', 'roam: push/defeat/rival'],
  ] as const)('%s has no live cell with its move and objective: the quick version, with a hint, not MALFORMED', async (id, hint) => {
    const game = await play(id);
    expect(game.source).toBe('draft');
    expect(game.fallbackReason).toBe('UNREPAIRED');
    expect(game.failure).toMatchObject({ stage: 'read', reason: 'RECIPE_NOT_LIVE' });
    expect(game.failure?.detail).toContain(hint);
  });
});
