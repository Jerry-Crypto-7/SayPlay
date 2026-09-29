/**
 * Počty a hustota z věty v arkádových generátorech (P26D T9). Dnešní vada byla
 * „počet rolí je zahozen“: spec nesl `count`, úroveň ho nečetla. Pin je počet
 * těles v hotové úrovni.
 */

import { describe, expect, it } from 'vitest';

// P32B T2: šablony ovládání staví jen remix uložených legacy her – zkouší se přes něj.
import { legacyDraft } from '../../__tests__/legacy-draft';
import { readGameSpec, type GameSpecV1 } from '../../spec';
import flap from '../__fixtures__/flap.json';
import platform from '../__fixtures__/platform.json';
import runner from '../__fixtures__/runner.json';
import shooter from '../__fixtures__/shooter.json';
import { arcadeWorldOf, compileArcade } from '../compile';
import { type ArcadeRole, BODY, HEADER, ROLE, bodyBase } from '../contract';

interface Body {
  readonly role: ArcadeRole;
  readonly kind: string;
  readonly z: number;
}

const ROLE_NAME = Object.fromEntries(Object.entries(ROLE).map(([name, code]) => [code, name])) as Record<number, ArcadeRole>;

/** Tělesa úrovně ze stavu světa (role, druh, poloha na trati). */
function bodies(spec: GameSpecV1, seed = 1): readonly Body[] {
  const built = arcadeWorldOf(spec, seed);
  if (!built.ok) throw new Error(built.issues.join('; '));
  const { initial, kinds } = built.world;
  return Array.from({ length: initial[HEADER.bodyCount] as number }, (_, i) => ({
    role: ROLE_NAME[initial[bodyBase(i) + BODY.role] as number] as ArcadeRole,
    kind: kinds[initial[bodyBase(i) + BODY.kind] as number] as string,
    z: initial[bodyBase(i) + BODY.z] as number,
  }));
}

const count = (list: readonly Body[], role: ArcadeRole, kind?: string): number => list.filter((b) => b.role === role && (kind === undefined || b.kind === kind)).length;

function withCounts(fixture: unknown, counts: Readonly<Record<string, number>>): GameSpecV1 {
  const read = readGameSpec(fixture);
  if (!read.ok) throw new Error(read.issues.join('; '));
  const spec = JSON.parse(JSON.stringify(read.value)) as GameSpecV1;
  spec.roles = spec.roles.map((role) => (counts[role.id] === undefined ? role : { ...role, count: counts[role.id] as number }));
  return spec;
}

describe('arcade role counts and sentence density', () => {
  it('a runner with a lot of obstacles has sharply more obstacles than a plain one', () => {
    const dense = legacyDraft('a runner with a lot of obstacles');
    const plain = legacyDraft('a runner in the city');
    expect(dense.control).toBe('runner');
    expect(plain.control).toBe('runner');
    const many = count(bodies(dense), 'obstacle');
    const few = count(bodies(plain), 'obstacle');
    expect(many, `${many} vs ${few}`).toBeGreaterThanOrEqual(few * 1.5);
  });

  it.each([
    ['a runner collecting five coins', 'runner'],
    ['a platformer with 5 coins', 'platform'],
    ['flappy bird with five coins', 'flap'],
  ] as const)('„%s“ builds exactly 5 coins', (sentence, control) => {
    const spec = legacyDraft(sentence);
    expect(spec.control).toBe(control);
    expect(spec.roles.find((role) => role.id === 'coin')?.count).toBe(5);
    expect(count(bodies(spec), 'collectible', 'coin')).toBe(5);
  });

  it('a runner with eight obstacles has eight obstacle rows spread over the track', () => {
    const list = bodies(withCounts(runner, { obstacle: 8 }));
    const rows = [...new Set(list.filter((b) => b.role === 'obstacle').map((b) => b.z))].sort((a, b) => a - b);
    expect(rows).toHaveLength(8);
    const finish = list.find((b) => b.role === 'goal')!.z;
    expect(rows[7]!).toBeGreaterThan(finish * 0.7);
  });

  it('the shooter reads target and enemy counts exactly', () => {
    const list = bodies(withCounts(shooter, { target: 2, enemy: 5 }));
    expect(count(list, 'target')).toBe(2);
    expect(count(list, 'enemy')).toBe(5);
  });

  it('a count of 1 is the schema default and leaves the generator default alone', () => {
    const read = readGameSpec(runner);
    if (!read.ok) throw new Error(read.issues.join('; '));
    expect(count(bodies(read.value), 'collectible', 'coin')).toBeGreaterThan(5);
  });

  it('a count over what the generator carries is capped within the body limit', () => {
    expect(count(bodies(withCounts(flap, { coin: 50 })), 'collectible', 'coin')).toBeLessThanOrEqual(40);
    expect(count(bodies(withCounts(shooter, { target: 50, enemy: 50 })), 'target')).toBe(8);
  });

  const COUNTED: readonly (readonly [string, GameSpecV1])[] = [
    ['runner 5 coins, 8 rows', withCounts(runner, { coin: 5, obstacle: 8 })],
    ['runner 30 rows', withCounts(runner, { obstacle: 30 })],
    ['platform 5 coins', withCounts(platform, { coin: 5 })],
    ['flap 5 coins', withCounts(flap, { coin: 5 })],
    ['shooter 2 targets, 5 enemies', withCounts(shooter, { target: 2, enemy: 5 })],
    ['shooter 8 targets, 20 enemies', withCounts(shooter, { target: 8, enemy: 20 })],
  ];

  it.each(COUNTED)('the bot still wins %s on 20 seeds', (_, spec) => {
    const lost = Array.from({ length: 20 }, (__, seed) => seed + 1).filter((seed) => !compileArcade(spec, seed).ok);
    expect(lost).toEqual([]);
  });
});
