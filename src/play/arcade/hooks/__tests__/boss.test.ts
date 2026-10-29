/**
 * Moment bosse (P66 T3): boss finále přivede průběh (`pacing-parts`) a útočí `boss_beat`; háček jen ohlásí vstup jeho
 * kopie (`boss_enter` + hláška `boss`) – v souboji ze 3 kol v posledním kole, jednou za hru.
 */

import { describe, expect, it } from 'vitest';

import { BODY, FLAG, HEADER, bodyBase, nativeRule } from '../../contract';
import { ARCADE_LIBRARY } from '../../library';
import { runBot } from '../../verify';
import { hooksOf } from '../index';
import { bossTemplateOf } from '../boss';
import { fightSpec, item, ofKind, play, testWorld, TEST_LIBRARY, worldOf } from './harness';

describe('the boss moment reuses the finale boss', () => {
  it('the hooks know the boss template of boss_beat and nothing new is written', () => {
    const world = worldOf(fightSpec(), 1);
    const boss = nativeRule(world.rules, 'boss_beat')!.params.boss as number;
    expect(bossTemplateOf(world.rules)).toBe(boss);
    expect(hooksOf(world.rules)!.boss).toBe(boss);
    expect(world.rules.map((ref) => ref.id).filter((id) => id.includes('boss'))).toEqual(['boss_beat']);
  });

  it.each([1, 2, 3])('seed %i: boss_enter once, on a live copy of the boss, in the last round', (seed) => {
    const world = worldOf(fightSpec(), seed);
    const played = play(world, runBot(world).inputs, ARCADE_LIBRARY, { snapshots: true });
    const enters = ofKind(played, 'boss_enter');
    expect(enters).toHaveLength(1);
    const { body, tick } = enters[0]!;
    const state = played.states[tick]!;
    const boss = hooksOf(world.rules)!.boss!;
    expect(((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0).toBe(true);
    expect(state[bodyBase(body) + BODY.kind]).toBe(state[bodyBase(boss) + BODY.kind]);
    expect(body).toBeGreaterThanOrEqual(state[HEADER.spawnBase] as number);
    const lastStart = ofKind(played, 'round_start').at(-1)!;
    expect(lastStart.round).toBe(2);
    expect(tick).toBeGreaterThanOrEqual(lastStart.tick);
    expect(ofKind(played, 'callout').filter((callout) => callout.callout === 'boss').map((callout) => callout.tick)).toEqual([tick]);
  });

  it('a world without a finale boss has no boss in its hooks and never says boss_enter', () => {
    const world = testWorld(1, [item(1, true)], [{ id: 'spawn_at', params: { at: [[3, 1]] } }], { rounds: 1 });
    expect(hooksOf(world.rules)!.boss).toBeUndefined();
    expect(ofKind(play(world, [], TEST_LIBRARY, { horizon: 10 }), 'boss_enter')).toEqual([]);
  });

  it('with a boss template, its spawned copy is announced at the tick it enters', () => {
    const world = testWorld(1, [item(1, true)], [{ id: 'spawn_at', params: { at: [[3, 1]] } }], { rounds: 1 }, { boss: 1 });
    expect(ofKind(play(world, [], TEST_LIBRARY, { horizon: 10 }), 'boss_enter')).toEqual([{ kind: 'boss_enter', body: 3, tick: 3 }]);
  });
});
