import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
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
    selections.set(row.id, made.recipe.content.genre);
    expect(liveCells().some(cell => cell.id === made.cellId)).toBe(true);
    for (const triple of essentialTriples(intent)) {
      const proved = made.witnesses.some(w => matchesWitness(triple, w));
      const admitted = made.unmet.some(item => item.actor === triple.actor && item.verb === triple.verb && item.object === triple.object);
      expect(proved || admitted, JSON.stringify(triple)).toBe(true);
      if (admitted) expect(proved).toBe(false);
    }
  });

  it('preserves single-action choices except the two explicit semantic corrections', () => {
    const changed = groups.single.filter(row => selections.get(row.id) !== classifyGenre(row.sentence, null).ranked[0].genre);
    // Raw retention is 28/30, below T9's 95% target; report that discrepancy.
    // Basketball throws a ball instead of firing a gun; a named argument is a
    // duel rather than a physical arena fight. Do not restore either old choice
    // merely to raise the retention metric.
    expect(changed.map(row => [row.id, selections.get(row.id)])).toEqual([
      ['si-015', 'duel'], ['si-025', 'throw'],
    ]);
  });

  it('prioritizes movement and admits unsupported racing instead of calling arrival a race', () => {
    const made = compose(extractIntent('game in a car with shooting and racing'));
    expect(made.recipe.move).toBe('drive');
    expect(made.unmet.some(item => item.verb === 'race')).toBe(true);
    expect(made.unmet.some(item => item.verb === 'shoot')).toBe(true);
    expect(made.unmet.some(item => item.verb === 'drive')).toBe(false);
  });
});
