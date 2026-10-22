import { loadRapier } from '@/play/arcade/physics/world';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractIntent } from '@/play/intent/extract';
import { essentialTriples } from '@/play/intent/contract';
import { matchesWitness } from '@/play/arcade/witness';
import type { GameSpecV1 } from '@/play/spec';
import { draftGameSpecWithMeta } from '@/play/draft/draft';
import type { Reading } from '@/play/read/schema';
import { compileRecipe } from '../compile';
import { compose } from '../compose';

type Label = { id: string; sentence: string };
const groups = (JSON.parse(readFileSync('evals/play/p41/sentences.json', 'utf8')) as { groups: Record<string, Label[]> }).groups;
const tuning = ['multi-action', 'paraphrase', 'negation', 'unsupported', 'single'].flatMap(group => groups[group].map(item => ({ ...item, group })));

describe('compose a live recipe from the full intent', () => {
  for (const row of tuning) it(`${row.id}: proves or admits every essential triple`, () => {
    const intent = extractIntent(row.sentence);
    const made = compose(intent);
    if (['si-025', 'si-026'].includes(row.id)) {
      expect(made.recipe.move).toBe('ball');
      expect(made.witnesses.some(witness => witness.verb === (row.id === 'si-025' ? 'throw' : 'ball'))).toBe(true);
    }
    for (const triple of essentialTriples(intent)) {
      const proved = made.witnesses.some(w => matchesWitness(triple, w));
      const admitted = made.unmet.some(item => item.actor === triple.actor && item.verb === triple.verb && item.object === triple.object);
      expect(proved || admitted, JSON.stringify(triple)).toBe(true);
      if (admitted) expect(proved).toBe(false);
    }
  });

  it('escaping without a vehicle selects a real running chase with escape evidence', () => {
    const made = compose(extractIntent('escape from the prison'));
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

  // The content is the quick version's GenreSpec (the director's starting point, the fidelity check):
  // it names the part's thing, but only the part plays it – also when the director wrote the content.
  it('names a part’s thing in the content and plays it once, as the part', () => {
    const made = compose(extractIntent('a seal swims across a harbour dodging sharks'));
    expect(made.recipe.parts).toEqual([expect.objectContaining({ kind: 'hazard', label: 'shark' })]);
    expect(made.recipe.content.cast).toContainEqual({ label: 'shark', does: 'avoid' });
    const sharks = (spec: GameSpecV1) => spec.roles.filter(role => role.label.includes('shark')).map(role => role.id);
    expect(sharks(made.spec)).toEqual(['part_0']);
    const directed = compileRecipe({ ...made.recipe, content: { ...made.recipe.content, cast: [{ label: 'sharks', does: 'avoid' }, { label: 'shark', does: 'chase_me' }] } });
    expect(sharks(directed)).toEqual(['part_0']);
  });
});

// P56A T5: žánr hry se čtením gpt-oss-20b z `evals/play/p56a/readings/` (lokálně, tytéž váhy jako demo). Slovník rozhodne,
// když první slyší nový žánr, jinak čtení – pin nad otevřeným holdoutem P55 a nad dev P54C, kde slovník trefí 64/64.
// Pasti se prahem nehlídají (majitel 21. 10. přijal pokles), jen se vypíšou.
describe('the sentence reading decides the genre unless the keywords hear a new one (P56A T5)', () => {
  const fresh = new Set(['catch', 'whack', 'defense', 'slice', 'hop', 'crowd', 'merge', 'push']);
  const played = (set: string, reads: string) => {
    const sentences = (JSON.parse(readFileSync(set, 'utf8')) as { sentences: { id: string; family: string; genre?: string | null; expect?: string | null; text: string }[] }).sentences;
    const readings = new Map((JSON.parse(readFileSync(reads, 'utf8')) as { readings: { id: string; reading: Reading | null }[] }).readings.map(row => [row.id, row.reading]));
    expect(readings.size).toBe(sentences.length);
    const missed: string[] = [];
    const strayed: string[] = [];
    for (const row of sentences) {
      const genre = draftGameSpecWithMeta(row.text, 1, { reading: readings.get(row.id) ?? null }).genre;
      const got = genre === null ? 'none' : `${genre.genre}.${genre.mode}`;
      const wanted = row.expect ?? `${row.genre}.default`;
      if (row.family === 'target' && got !== wanted) missed.push(`${row.id}: ${wanted} -> ${got}`);
      if (row.family !== 'target' && fresh.has(got.split('.')[0]!)) strayed.push(`${row.id}: ${got}`);
    }
    const targets = sentences.filter(row => row.family === 'target').length;
    console.info(`${set}: targets ${targets - missed.length}/${targets}, traps kept ${sentences.length - targets - strayed.length}/${sentences.length - targets}\n${strayed.join('\n')}`);
    return { hit: targets - missed.length, missed };
  };

  it('plays the read genre on the opened P55 holdout: targets ≥ 40/60', () => {
    const { hit, missed } = played('evals/play/p55/holdout.json', 'evals/play/p56a/readings/p55-holdout.gpt-oss-20b.json');
    expect(hit, missed.join('\n')).toBeGreaterThanOrEqual(40);
  }, 300_000);

  it('keeps every P54C dev target the keywords hear: 64/64', () => {
    const { missed } = played('evals/play/p54c/dev.json', 'evals/play/p56a/readings/p54c-dev.gpt-oss-20b.json');
    expect(missed).toEqual([]);
  }, 300_000);
});

// Composition now executes physical ball witnesses even in synchronous draft tests.
beforeAll(async () => { await loadRapier(); });
