/**
 * Fakta listu „About this game“: věty čtené člověkem, ne JSON ani zpráva
 * kvality (P70C T3) – a kdo hru navrhl, bez vydávání návrhu za AI.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { GENRE_MODES, GENRES } from '@/play/genre/contract';
import { loseLineOf } from '@/play/lose-line';
import { MECHANICS, type MechanicId } from '@/play/registry';
import { readGameSpec } from '@/play/spec';

import { authorshipOf, howLinesOf, labFacts, readFacts } from '../lab';

const spec = (() => {
  const read = readGameSpec(JSON.parse(readFileSync('src/play/__fixtures__/collect_exit.json', 'utf8')));
  if (!read.ok) throw new Error(read.reason);
  return read.value;
})();

// P70C T3: list „About this game“ je pro hráče – cíl, prohra, ovládání a věty, jak hra běží. Tiky výhry,
// replay a parametry mechanik by vypadaly hotově a hráči neřekly nic.
const DEV_JARGON = /tick|replay|rules checked|winnable|not proven|[{}[\]"_]/i;

describe('labFacts', () => {
  it('says how to win, how to lose and the controls from the spec, with no developer facts', () => {
    const facts = labFacts(spec, null);
    expect(facts).toMatchObject({ goal: spec.tutorial.goalLine, lose: loseLineOf(spec, null), controls: spec.tutorial.controlsHint });
    expect(JSON.stringify(Object.values(facts).flat())).not.toMatch(/tick|replay|rules checked|winnable|not proven/i);
  });

  it('a game without a genre explains its rules in the registry sentences, three at most', () => {
    expect(howLinesOf(spec)).toEqual(spec.mechanics.slice(0, 3).map((mechanic) => MECHANICS[mechanic.id as MechanicId].explanation));
  });

  it('every genre has two plain sentences, and an older spec finds its genre by its controls', () => {
    for (const id of GENRES) {
      const lines = howLinesOf({ ...spec, genre: { id, mode: GENRE_MODES[id][0], compilerVersion: 'genre.v7' } });
      expect(lines, id).toHaveLength(2);
      for (const line of lines) {
        expect(line, id).toMatch(/^[A-Z].{8,88}\.$/);
        expect(line, id).not.toMatch(DEV_JARGON);
      }
    }
    expect(howLinesOf({ ...spec, control: 'duel' })[0]).toMatch(/rival/);
  });
});

// Panel „From your sentence“ tvrdí porotci, kdo hru navrhl. Návrh ze slov,
// který se hlásí jako „Designed by AI“, by vypadal správně a lhal.
describe('authorshipOf and readFacts', () => {
  it('a draft from keywords is never reported as AI, even with a sentence beside it', () => {
    expect(authorshipOf({ origin: { sentence: 'fox in a forest', seed: null } })).toBe('draft');
    expect(authorshipOf({ origin: { sentence: 'fox in a forest', seed: null }, sentence: 'fox in a forest' })).toBe('draft');
  });

  it('the model upgrade and a game the director published directly are AI; a remix is a remix', () => {
    expect(authorshipOf({ relation: 'upgrade' })).toBe('ai');
    expect(authorshipOf({ sentence: 'fox in a forest' })).toBe('ai');
    expect(authorshipOf({})).toBe('remix');
  });

  it('reads the game, world, player, opponents, goal and rules straight from the spec', () => {
    const arcade = readGameSpec(JSON.parse(readFileSync('src/play/arcade/__fixtures__/duel.json', 'utf8')));
    if (!arcade.ok) throw new Error(arcade.reason);
    const read = readFacts(arcade.value, 'ai', 'boxing match');
    expect(read).toMatchObject({ authorship: 'ai', sentence: 'boxing match', game: 'Duel', world: 'a rooftop at night · tense', you: 'fighter', against: ['ninja'] });
    // Mřížková hra nemá ovládání – jméno hry je její archetyp.
    expect(readFacts(spec, 'draft', null)).toMatchObject({ game: 'Collect exit', you: 'fox', against: [], sentence: null });
  });
});
