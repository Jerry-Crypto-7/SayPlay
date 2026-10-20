/**
 * Žánr Úkol (P32G T4): hasič hasí hořící stromy, čaroděj zapaluje pět svíček,
 * než ho chytí duchové, kuchař obrací palačinky. Co by vypadalo dobře a přitom
 * bylo špatně: věta dojde ke hře, která se hraje (sběr v aréně), ale sloveso
 * nemá druh vizuálu, předmět má jiný počet stavů, než kolik jich scéna umí
 * nakreslit, nebo robot vyhraje hru, ve které se sloveso vůbec nedokázalo.
 */

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf, generatorOf } from '@/play/arcade/compile';
import { BODY, FLAG, HEADER, ROLE, bodyBase } from '@/play/arcade/contract';
import { instantiate } from '@/play/arcade/kernel';
import { verifyArcade } from '@/play/arcade/verify';
import { type GameSpecV1, readGameSpec } from '@/play/spec';

import { type GenreSpecOf, castFor } from '../contract';
import { GENRE_MODULES, compileGenre, readGenreSpec } from '../index';
import { KIND_STATES, VERB_KIND, verbKindOf } from '../quest';

const HEROES = {
  hasič: 'A firefighter puts out burning trees in a forest',
  čaroděj: 'A tiny wizard lights five candles before the ghosts catch him',
  kuchař: 'A chef flips pancakes in a restaurant kitchen',
} as const;

/** Věta → úplný `GenreSpec`: co věta neřekne (hrdina, prostředí), doplní test. */
function draft(sentence: string): GenreSpecOf<'quest'> {
  const read = readGenreSpec({ hero: 'hero', setting: 'somewhere', ...GENRE_MODULES.quest.draftFill(sentence, null) });
  if (!read.ok) throw new Error(read.issues.join('; '));
  return read.value as GenreSpecOf<'quest'>;
}

function gameOf(spec: GenreSpecOf<'quest'>): GameSpecV1 {
  const read = readGameSpec(compileGenre(spec));
  if (!read.ok) throw new Error(`${read.reason}: ${read.issues.join('; ')}`);
  return read.value;
}

/** Počty těl podle role jádra na semínku 1. */
function rolesOf(game: GameSpecV1): Map<number, number> {
  const made = arcadeWorldOf(game, 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  const state = instantiate(made.world);
  const counts = new Map<number, number>();
  for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) {
    // Mrtvé předlohy dalších kol (P36A T4) na startu nehrají.
    if (((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) === 0) continue;
    const role = state[bodyBase(body) + BODY.role] as number;
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  return counts;
}

/** Jako dveře publikace: první z osmi semínek, na kterém robot vyhraje a sloveso dokáže. */
function firstProvenSeed(game: GameSpecV1): { readonly seed: number; readonly failures: readonly string[]; readonly evidence: string | null } {
  let last = { seed: 0, failures: ['no seed tried'] as readonly string[], evidence: null as string | null };
  for (let seed = 1; seed <= 8; seed += 1) {
    const made = arcadeWorldOf(game, seed);
    if (!made.ok) return { seed, failures: made.issues, evidence: null };
    const verdict = verifyArcade(made.world);
    last = { seed, failures: verdict.failures, evidence: verdict.verbs[0]?.evidence ?? null };
    if (verdict.failures.length === 0) return last;
  }
  return last;
}

describe('quest genre – the sentence picks the mode, the verb kind and the target', () => {
  it('hasič: spatial, fire with three states, burning trees, one default chaser (P36A T3)', () => {
    const spec = draft(HEROES.hasič);
    const goal = castFor(spec, 'reach');
    expect(spec.mode).toBe('spatial');
    expect(goal?.label).toMatch(/trees$/);
    expect(verbKindOf(goal?.verb ?? '')).toBe('fire');
    expect(goal?.states).toBe(3);
    // Věta honičku neříká: jeden výchozí pronásledovatel, ne dva jako u „before the ghosts catch“.
    expect(spec.params?.chasers).toBe(1);
  });

  it('čaroděj: spatial, flame with two states, five candles, ghosts chasing', () => {
    const spec = draft(HEROES.čaroděj);
    expect(spec.mode).toBe('spatial');
    expect(castFor(spec, 'reach')).toEqual({ label: 'candles', does: 'reach', verb: 'light', states: 2 });
    expect(verbKindOf('light')).toBe('flame');
    expect(spec.params?.count).toBe(5);
    expect(castFor(spec, 'chase_me')?.label).toBe('ghosts');
    expect(spec.params?.chasers).toBeGreaterThan(0);
    const roles = rolesOf(gameOf(spec));
    expect(roles.get(ROLE.target)).toBe(5);
    expect(roles.get(ROLE.chaser)).toBe(spec.params?.chasers);
  });

  it('kuchař: station, cook with three states, pancakes', () => {
    const spec = draft(HEROES.kuchař);
    expect(spec.mode).toBe('station');
    expect(castFor(spec, 'reach')).toEqual({ label: 'pancakes', does: 'reach', verb: 'flip', states: 3 });
    expect(verbKindOf('flip')).toBe('cook');
  });

  it.each(Object.entries(HEROES))('%s compiles to its quest generator, the bot wins and proves the verb', (_hero, sentence) => {
    const spec = draft(sentence);
    const game = gameOf(spec);
    expect(generatorOf(game)).toBe(spec.mode === 'station' ? 'quest_station' : 'quest_spatial');
    const proof = firstProvenSeed(game);
    expect(proof.failures).toEqual([]);
    expect(proof.evidence).toMatch(/now in state/);
  });

  it('the rule carries the verb as one word, so "put out" still reads as fire', () => {
    const made = arcadeWorldOf(gameOf(draft(HEROES.hasič)), 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    const verb = made.world.rules.find((rule) => rule.id === 'interact')?.params.verb;
    expect(verb).toBe('put-out');
    expect(verbKindOf(verb as string)).toBe('fire');
  });

  it('the clock follows the work: eight burning trees with three chasers stay one long round, five candles get three rounds', () => {
    const timerOf = (game: GameSpecV1) => (game.mechanics.find((mechanic) => mechanic.id === 'timer')?.params as { seconds: number }).seconds;
    const roundsOf = (game: GameSpecV1) => (game.controlParams as { tuning?: { rounds?: number } }).tuning?.rounds;
    const fire = draft(HEROES.hasič);
    const hard = { ...fire, cast: [{ label: 'ghosts', does: 'chase_me' as const }, ...(fire.cast ?? [])], params: { count: 8, chasers: 3 } };
    // Hodiny = odhad robota × 1,5 + 15 s, nejvýš 88 s (P36A T4); dlouhá práce zůstane v jednom kole.
    expect(roundsOf(gameOf(hard))).toBeUndefined();
    expect(timerOf(gameOf(hard))).toBe(87);
    expect(roundsOf(gameOf(draft(HEROES.čaroděj)))).toBe(3);
    expect(timerOf(gameOf(draft(HEROES.čaroděj)))).toBe(88);
    expect(timerOf(gameOf({ ...hard, params: { ...hard.params, seconds: 30 } }))).toBe(30);
  });

  it('a spec whose target states disagree with the verb kind plays the states the scene can draw', () => {
    const wizard = draft(HEROES.čaroděj);
    const spec = { ...wizard, cast: (wizard.cast ?? []).map((item) => (item.does === 'reach' ? { ...item, states: 3 as const } : item)) };
    const made = arcadeWorldOf(gameOf(spec), 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    const interact = made.world.rules.find((rule) => rule.id === 'interact')?.params as { when: { interact: { states: number } } };
    expect(interact.when.interact.states).toBe(KIND_STATES.flame);
  });
});

describe('quest genre – module shape', () => {
  it('has every quest verb as a cue and both modes ready', () => {
    expect([...GENRE_MODULES.quest.cues].sort()).toEqual(
      ['light', 'ignite', 'extinguish', 'spray', 'put out', 'cook', 'bake', 'flip', 'fry', 'repair', 'fix', 'free', 'rescue', 'unlock', 'water', 'plant', 'paint'].sort(),
    );
    expect(GENRE_MODULES.quest.availability('spatial')).toBe('ready');
    expect(GENRE_MODULES.quest.availability('station')).toBe('ready');
  });

  it('maps every verb to its kind and every kind to its visible states', () => {
    expect(VERB_KIND).toEqual({
      extinguish: 'fire',
      spray: 'fire',
      'put out': 'fire',
      light: 'flame',
      ignite: 'flame',
      cook: 'cook',
      bake: 'cook',
      fry: 'cook',
      flip: 'cook',
      brew: 'cook',
      grill: 'cook',
      stir: 'cook',
      whisk: 'cook',
      knead: 'cook',
      frost: 'cook',
      simmer: 'cook',
      roast: 'cook',
      pour: 'cook',
      'meal prep': 'cook',
      repair: 'repair',
      fix: 'repair',
      free: 'free',
      rescue: 'free',
      unlock: 'free',
      water: 'grow',
      plant: 'grow',
    });
    expect(KIND_STATES).toEqual({ fire: 3, flame: 2, cook: 3, repair: 2, free: 2, grow: 3 });
    expect(verbKindOf('constructor')).toBeNull();
    expect(verbKindOf('paint')).toBeNull();
  });

  it('paramBounds refuse a value outside the generator bounds', () => {
    const base = draft(HEROES.čaroděj);
    for (const [key, value] of [['count', 9], ['count', 0], ['chasers', 4], ['seconds', 90]] as const) {
      expect(readGenreSpec({ ...base, params: { [key]: value } }).ok, `${key} ${value}`).toBe(false);
    }
  });

  it('draftFill keeps a station within the three places of the counter', () => {
    const spec = draft('A chef fries eight eggs in a kitchen');
    expect(spec.mode).toBe('station');
    expect(spec.params?.count).toBe(3);
  });

  it('draftFill caps the chasers a sentence names at three instead of refusing the quest', () => {
    const spec = draft('A tiny wizard lights five candles before six ghosts catch him');
    expect(castFor(spec, 'chase_me')?.label).toBe('ghosts');
    expect(spec.params?.chasers).toBe(3);
  });
});

// P39 T7: cíl úkolu je věc, ke které se jde, pronásledovatel věc, která honí – ne první věc v obsazení.
describe('quest genre reads the cast', () => {
  const base = { genre: 'quest', mode: 'spatial', hero: 'wizard', setting: 'castle' } as const;
  const roleOf = (game: GameSpecV1, id: string) => game.roles.find((role) => role.id === id)?.label;

  it('takes the thing it reaches as the target and the thing that chases as the hunter', () => {
    const game = gameOf({ ...base, cast: [{ label: 'coin', does: 'collect' }, { label: 'ghost', does: 'chase_me' }, { label: 'candle', does: 'reach', verb: 'light', states: 2 }] });
    expect(roleOf(game, 'target')).toBe('candle');
    expect(roleOf(game, 'hunter')).toBe('ghost');
    expect(game.objective.description).toMatch(/^Light all \d+ candle/);
  });

  it('a thing to dodge is a hunter too: a named thing never drops out', () => {
    expect(roleOf(gameOf({ ...base, cast: [{ label: 'bat', does: 'avoid' }, { label: 'candle', does: 'reach', verb: 'light', states: 2 }] }), 'hunter')).toBe('bat');
  });

  it('a hunter that patrols reaches the generator', () => {
    const game = gameOf({ ...base, cast: [{ label: 'guard', does: 'chase_me', patrol: true }, { label: 'vault', does: 'reach', verb: 'open', states: 2 }] });
    expect((game.controlParams as { readonly tuning: { readonly patrol?: number } }).tuning.patrol).toBeGreaterThan(0);
  });
});

// P54C T14r2: „Cook all 2 potion“ hráč na telefonu četl jako chybu. Víc kusů = množné číslo, jeden kus = „the key“, ne „all 1 key“.
describe('quest genre – the goal counts in plain English', () => {
  const goalOf = (verb: string, label: string, count: number) => {
    const game = gameOf({ genre: 'quest', mode: 'spatial', hero: 'wizard', setting: 'castle', cast: [{ label, does: 'reach', verb, states: 2 }], params: { count } });
    return { line: game.tutorial.goalLine, description: game.objective.description };
  };

  it('two targets read plural in the goal line and the objective', () => {
    const { line, description } = goalOf('cook', 'potion', 2);
    expect(line).toMatch(/^Cook all 2 potions[,.]/);
    expect(description).toMatch(/^Cook all 2 potions /);
  });

  it('one target reads singular, without "all 1"', () => {
    const { line, description } = goalOf('find', 'key', 1);
    expect(line).toMatch(/^Find the key[,.]/);
    expect(description).toMatch(/^Find the key /);
    expect(`${line} ${description}`).not.toMatch(/\ball 1\b|\bkeys\b/);
  });

  it('irregular labels and a label already plural from the sentence', () => {
    expect(goalOf('open', 'box', 3).line).toMatch(/^Open all 3 boxes[,.]/);
    expect(goalOf('pick', 'berry', 4).line).toMatch(/^Pick all 4 berries[,.]/);
    expect(goalOf('light', 'candles', 5).line).toMatch(/^Light all 5 candles[,.]/);
    expect(goalOf('pick', 'berries', 1).line).toMatch(/^Pick the berry[,.]/);
  });
});
