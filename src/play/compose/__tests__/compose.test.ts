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

// P58B T5: žánr hry se čtením astry z T3 (`evals/play/p58b/compare-dev.json`). Rozhoduje čtení, slovník jen u nejistého
// (`sure: false`). Do P58B tu bylo čtení gpt-oss-20b a slovník rozhodl, kdykoli první slyšel nový žánr – astra čte nové
// žánry líp než slovník (T3), takže pin nad P54C dev se čtením odpadl; P54C dev bez čtení (rychlá hra) hlídá
// `genre/__tests__/classify.test.ts`. Pasti se prahem nehlídají, jen se vypíšou.
describe('the sentence reading decides the genre (P58B T5)', () => {
  const compare = JSON.parse(readFileSync('evals/play/p58b/compare-dev.json', 'utf8')) as { rows: { set: string; id: string; models: Record<string, { reading: Reading | null }> }[] };
  const played = (set: string) => {
    const sentences = (JSON.parse(readFileSync(`evals/play/${set}.json`, 'utf8')) as { sentences: { id: string; family: string; genre?: string | null; text: string }[] }).sentences;
    const readings = new Map(compare.rows.filter(row => row.set === set).map(row => [row.id, row.models['astra@openai']!.reading]));
    expect(readings.size).toBe(sentences.length);
    const missed: string[] = [];
    const traps: string[] = [];
    for (const row of sentences) {
      const genre = draftGameSpecWithMeta(row.text, 1, { reading: readings.get(row.id) ?? null }).genre;
      const got = genre === null ? 'none' : `${genre.genre}.${genre.mode}`;
      if (row.family !== 'target') traps.push(`${row.id}: ${got}`);
      else if (got !== (row.genre!.includes('.') ? row.genre : `${row.genre}.default`)) missed.push(`${row.id}: ${row.genre} -> ${got}`);
    }
    const targets = sentences.length - traps.length;
    console.info(`${set}: targets ${targets - missed.length}/${targets}\n${traps.join('\n')}`);
    return { hit: targets - missed.length, missed };
  };

  it('plays the read genre on the opened P55 holdout: targets 60/60', () => {
    const { missed } = played('p55/holdout');
    expect(missed).toEqual([]);
  }, 300_000);

  // `classifyGenre` dá se stejnými čteními 59/60; skládání (`sources` řazené podle `missing`) 9 z nich přehodí jinam
  // (s03, s06, s09, s12, s23, s26, s32, s41, s54) – úkol P58B T5a. Před T5 49/60, s02 tehdy přebil slovník.
  it('plays the read genre on the opened P56A holdout: targets ≥ 50/60, s02 among them', () => {
    const { hit, missed } = played('p56a/holdout');
    expect(hit, missed.join('\n')).toBeGreaterThanOrEqual(50);
    expect(missed.filter(line => line.startsWith('s02:'))).toEqual([]);
  }, 300_000);
});

// Composition now executes physical ball witnesses even in synchronous draft tests.
beforeAll(async () => { await loadRapier(); });
