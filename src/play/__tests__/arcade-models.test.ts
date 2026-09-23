/**
 * Výběr modelu z popisku role (P26 T12): celý katalog, hlava fráze, synonyma,
 * záložní kategorie postavy – a žádná kategorie u věci, kterou katalog nemá.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import runner from '../arcade/__fixtures__/runner.json';
import shooter from '../arcade/__fixtures__/shooter.json';
import throwGame from '../arcade/__fixtures__/throw.json';
import { enemyModel, heroModel, modelOf, modelPath, propModels } from '../arcade/models';
import { draftGameSpec } from '../draft';
import type { GameSpecV1 } from '../spec';

const withLabel = (fixture: unknown, id: string, label: string): GameSpecV1 => {
  const spec = structuredClone(fixture) as GameSpecV1;
  spec.roles = spec.roles.map((role) => (role.id === id ? { ...role, label } : role));
  return spec;
};

describe('arcade model choice from role labels', () => {
  it.each([
    ['dog', 'dog'], // mimo složku her – dřív kovboj
    ['cardboard robot', 'robot'], // hlava fráze, ne první slovo
    ['brave little puppies', 'dog'], // synonymum v množném čísle
    ['kitten', 'cat'], // tag katalogu
    ['zombies', 'goblin'], // příšera
    ['space bunny', 'hamster'],
    ['grizzly bear', 'fox'], // kategorie zvíře
    ['mall security guard', 'explorer'], // kategorie člověk
    ['battle tank', 'robot'], // kategorie stroj
  ])('%s → %s', (label, model) => {
    expect(modelOf(label, true)).toBe(model);
  });

  it('a thing the catalog lacks gets no category and keeps the role default', () => {
    expect(modelOf('sock', true)).toBeUndefined();
    expect(heroModel(withLabel(runner, 'player', 'sock'))).toBe('explorer');
    expect(enemyModel(withLabel(shooter, 'enemy', 'angry socks'))).toBe('robot');
  });

  it('a flappy bird is the bird, not the nest', () => {
    expect(modelOf('little bird', true)).toBe('bird');
  });

  it('props take only a direct catalog match, never a category or the core kind', () => {
    expect(propModels(withLabel(runner, 'coin', 'gems'))).toEqual({ coin: 'crystal' });
    expect(propModels(withLabel(runner, 'obstacle', 'traffic cones'))).toEqual({});
    expect(propModels(withLabel(runner, 'obstacle', 'grizzly bears'))).toEqual({});
    expect(propModels(withLabel(throwGame, 'target', 'rubber ducks'))).toEqual({ target: 'rubber-duck' });
    // Střelnice popisek terče nekreslí (tabulka schopností), takže ho nečte ani výběr.
    expect(propModels(withLabel(shooter, 'target', 'rubber ducks'))).toEqual({});
  });

  // Návrh ze slov musí jméno z věty do role zapsat, jinak scéna nemá co vybrat.
  it.each([
    ['shoot the zombies in the mall', (spec: GameSpecV1) => enemyModel(spec), 'goblin'],
    ['space shooter against asteroids', (spec: GameSpecV1) => spec.roles.find((role) => role.id === 'enemy')?.label, 'asteroid'],
    ['throw balls at rubber ducks', (spec: GameSpecV1) => propModels(spec).target, 'rubber-duck'],
    ['a runner dodging traffic cones and collecting gems', (spec: GameSpecV1) => propModels(spec).coin, 'crystal'],
    ['a cat running and dodging dogs', (spec: GameSpecV1) => `${heroModel(spec)}|${propModels(spec).obstacle}`, 'cat|dog'],
  ])('sentence %s reaches the scene', (sentence, read, expected) => {
    expect(read(draftGameSpec(sentence))).toBe(expected);
  });

  it('every model a label can pick has a GLB on disk', () => {
    for (const id of ['dog', 'robot', 'goblin', 'crystal', 'rubber-duck', 'aquarium', 'hurdle']) {
      expect(existsSync(join(process.cwd(), 'public', modelPath(id))), id).toBe(true);
    }
  });
});
