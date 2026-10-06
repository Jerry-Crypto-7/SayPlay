import { loadRapier } from '@/play/arcade/physics/world';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { classifyGenre } from '@/play/genre/classify';
import { extractIntent } from '@/play/intent/extract';
import { essentialTriples } from '@/play/intent/contract';
import { matchesWitness } from '@/play/arcade/witness';
import { compose } from '../compose';
import { liveCells } from '../allowed';

type Label = { id: string; sentence: string };
const groups = (JSON.parse(readFileSync('evals/play/p41/sentences.json', 'utf8')) as { groups: Record<string, Label[]> }).groups;
const tuning = ['multi-action', 'paraphrase', 'negation', 'unsupported', 'single'].flatMap(group => groups[group].map(item => ({ ...item, group })));

describe('compose a live recipe from the full intent', () => {
  const selections = new Map<string, string>();
  for (const row of tuning) it(`${row.id}: proves or admits every essential triple`, () => {
    const intent = extractIntent(row.sentence);
    const made = compose(intent);
    if (['si-025', 'si-026'].includes(row.id)) {
      expect(made.cellId).toBe('ball.score');
      expect(made.witnesses.some(witness => witness.verb === (row.id === 'si-025' ? 'throw' : 'ball'))).toBe(true);
    }
    selections.set(row.id, made.recipe.content.genre ?? made.recipe.move);
    expect(liveCells().some(cell => cell.id === made.cellId)).toBe(true);
    for (const triple of essentialTriples(intent)) {
      const proved = made.witnesses.some(w => matchesWitness(triple, w));
      const admitted = made.unmet.some(item => item.actor === triple.actor && item.verb === triple.verb && item.object === triple.object);
      expect(proved || admitted, JSON.stringify(triple)).toBe(true);
      if (admitted) expect(proved).toBe(false);
    }
  });

  it('records single-action selection changes explicitly', () => {
    const changed = groups.single.filter(row => selections.get(row.id) !== classifyGenre(row.sentence, null).ranked[0].genre);
    // Record the legacy content genre, not the native movement id. Both sports
    // use the real ball.score cell (asserted above), whose content genre is throw.
    // Mail now physically rides to its destination in the delivery cell.
    expect(changed.map(row => [row.id, selections.get(row.id)])).toEqual([
      ['si-015', 'duel'], ['si-017', 'runner'], ['si-024', 'voyage'], ['si-025', 'throw'],
    ]);
  });

  it('escaping without a vehicle selects a real running chase with escape evidence', () => {
    const made = compose(extractIntent('escape from the prison'));
    expect(made.cellId).toBe('run.escape');
    expect(made.recipe.move).toBe('run');
    expect(made.unmet).not.toContainEqual(expect.objectContaining({ verb: 'escape' }));
    expect(made.witnesses).toContainEqual(expect.objectContaining({ verb: 'escape', run: 'winner' }));
  });

  it('plays driving, shooting and racing together', () => {
    const made = compose(extractIntent('game in a car with shooting and racing'));
    expect(made.recipe.move).toBe('drive');
    expect(made.unmet).toEqual([]);
    expect(made.witnesses).toEqual(expect.arrayContaining([
      expect.objectContaining({ verb: 'drive' }),
      expect.objectContaining({ verb: 'shoot', evidence: 'projectile-hit' }),
      expect.objectContaining({ verb: 'race', evidence: 'overtake' }),
    ]));
  });
});

// Composition now executes physical ball witnesses even in synchronous draft tests.
beforeAll(async () => { await loadRapier(); });
