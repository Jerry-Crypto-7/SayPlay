/**
 * Remix čipy na běžci (P25A T8): každý čip na fixtuře běžce dá spec, který
 * projde `verifyArcade`, a `harder` mění právě jeden parametr tratě.
 */

import { describe, expect, it } from 'vitest';

import { applyRemix, REMIX_CHIPS, remixPatch } from '../../director/remix';
import { readGameSpec, type GameSpecV1, type RunnerParams } from '../../spec';
import flapFixture from '../__fixtures__/flap.json';
import platformFixture from '../__fixtures__/platform.json';
import fixture from '../__fixtures__/runner.json';
import arenaFixture from '../__fixtures__/arena.json';
import steerFixture from '../__fixtures__/steer.json';
import { arcadeWorldOf } from '../compile';
import { verifyArcade } from '../verify';

const parent = (() => {
  const read = readGameSpec(fixture);
  if (!read.ok) throw new Error(read.issues.join('; '));
  return read.value;
})();

function publishable(spec: GameSpecV1): boolean {
  const built = arcadeWorldOf(spec, 1);
  return built.ok && verifyArcade(built.world).publishEligible;
}

function remix(chip: (typeof REMIX_CHIPS)[number], from: GameSpecV1, seed = 1): GameSpecV1 {
  const applied = applyRemix(from, remixPatch(chip, from, seed, publishable));
  if (!applied.ok) throw new Error(`${chip}: ${applied.detail}`);
  return applied.spec;
}

describe('runner remix chips', () => {
  it.each(REMIX_CHIPS)('%s changes the runner and the child still passes the arcade verifier', (chip) => {
    const child = remix(chip, parent);
    expect(child.control).toBe('runner');
    expect(child).not.toEqual(parent);
    expect(publishable(child)).toBe(true);
  });

  it('harder changes exactly one track parameter, up to the ceiling', () => {
    let spec = parent;
    for (let round = 0; round < 8; round += 1) {
      const ops = remixPatch('harder', spec);
      if (ops.length === 0) break;
      expect(ops.map((op) => op.path.split('/').slice(0, 3).join('/'))).toHaveLength(1);
      expect(ops[0].path).toMatch(/^\/controlParams\/(speed|density|lengthM)$/);
      spec = remix('harder', spec);
    }
    expect(spec.controlParams).toMatchObject({ speed: 'fast', density: 'high', lengthM: 500 });
  });

  it('twist adds a rule the arcade reads and swap_enemy picks another obstacle set', () => {
    const added = new Set<string>();
    for (let seed = 1; seed <= 6; seed += 1) {
      const twisted = remix('twist', parent, seed);
      const rules = twisted.mechanics.map((m) => m.id).filter((id) => id === 'health' || id === 'timer');
      expect(rules).toHaveLength(1);
      expect(publishable(twisted), `seed ${seed}`).toBe(true);
      added.add(rules[0]);
    }
    expect([...added].sort()).toEqual(['health', 'timer']);
    const swapped = remix('swap_enemy', parent);
    const obstacles = (spec: GameSpecV1) => (spec.controlParams as RunnerParams | undefined)?.obstacles;
    expect(obstacles(swapped)).toBeDefined();
    expect(obstacles(swapped)).not.toEqual(obstacles(parent));
  });
});

describe('platform and flap remix chips (P25C)', () => {
  const read = (raw: unknown): GameSpecV1 => {
    const result = readGameSpec(raw);
    if (!result.ok) throw new Error(result.issues.join('; '));
    return result.value;
  };
  const PARENTS = [
    ['platform', read(platformFixture)],
    ['flap', read(flapFixture)],
  ] as const;

  for (const [control, base] of PARENTS) {
    it.each(REMIX_CHIPS)(`%s changes the ${control} game and the child still passes the arcade verifier`, (chip) => {
      const child = remix(chip, base);
      expect(child.control).toBe(control);
      expect(child).not.toEqual(base);
      expect(publishable(child)).toBe(true);
    });

    it(`${control}: harder changes exactly one parameter, difficulty first, up to the ceiling`, () => {
      let spec = base;
      const paths: string[] = [];
      for (let round = 0; round < 8; round += 1) {
        const ops = remixPatch('harder', spec);
        if (ops.length === 0) break;
        expect(ops).toHaveLength(1);
        paths.push(ops[0]!.path);
        spec = remix('harder', spec);
        expect(publishable(spec), `round ${round}`).toBe(true);
      }
      expect(paths[0]).toBe('/controlParams/difficulty');
      expect(spec.controlParams).toMatchObject({ difficulty: 'hard', lengthM: 250 });
    });
  }

  it('swap_enemy renames the hazard, and the platformer toggles moving platforms', () => {
    for (const [control, base] of PARENTS) {
      const swapped = remix('swap_enemy', base);
      const label = (spec: GameSpecV1) => spec.roles.find((role) => role.kind === 'hazard')?.label;
      expect(label(swapped), control).not.toBe(label(base));
      if (control === 'platform') expect(swapped.controlParams).toMatchObject({ movingPlatforms: true });
    }
  });
});

describe('race and arena remix chips (P25F)', () => {
  const read = (raw: unknown): GameSpecV1 => {
    const result = readGameSpec(raw);
    if (!result.ok) throw new Error(result.issues.join('; '));
    return result.value;
  };
  const PARENTS = [
    ['steer', read(steerFixture)],
    ['move_free', read(arenaFixture)],
  ] as const;

  for (const [control, base] of PARENTS) {
    it.each(REMIX_CHIPS)(`%s changes the ${control} game and the child still passes the arcade verifier`, (chip) => {
      const child = remix(chip, base);
      expect(child.control).toBe(control);
      expect(child).not.toEqual(base);
      expect(publishable(child)).toBe(true);
    });
  }

  it('harder: the race goes to hard, the arena to dense, one parameter at a time', () => {
    const race = remix('harder', PARENTS[0][1]);
    expect(remixPatch('harder', PARENTS[0][1])).toHaveLength(1);
    expect(race.controlParams).toMatchObject({ difficulty: 'hard' });
    const arena = remix('harder', PARENTS[1][1]);
    expect(arena.controlParams).toMatchObject({ density: 'dense' });
    expect(remixPatch('harder', arena)).toEqual([]);
  });

  // Závod životy nečte; aréna (archetyp přežití) už `timer` má, zbydou jí životy.
  it('twist gives the race a time limit and the arena three lives', () => {
    for (let seed = 1; seed <= 6; seed += 1) {
      const race = remix('twist', PARENTS[0][1], seed);
      expect(race.mechanics.map((m) => m.id), `race seed ${seed}`).toContain('timer');
      expect(race.mechanics.map((m) => m.id), `race seed ${seed}`).not.toContain('health');
      const arena = remix('twist', PARENTS[1][1], seed);
      expect(arena.mechanics.map((m) => m.id), `arena seed ${seed}`).toContain('health');
      expect(arena.objective.description).toMatch(/you have 3/);
    }
  });

  it('swap_enemy renames the rivals and the hunters', () => {
    const race = remix('swap_enemy', PARENTS[0][1]);
    expect(race.roles.find((role) => role.id === 'rival')?.label).not.toBe('rival car');
    const arena = remix('swap_enemy', PARENTS[1][1]);
    expect(arena.roles.find((role) => role.id === 'hunter')?.label).not.toBe('big fish');
  });
});
