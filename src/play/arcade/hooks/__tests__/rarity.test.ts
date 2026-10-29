/**
 * Vzácnost a zprávy skóre (P66 T3): losy ze streamu `rarity` (týž seed = tytéž, váhy 70/25/5), věc dostane vzácnost
 * při vzniku, takže pořadí sebrání ji nezmění; body × násobič, `rare_found` u vzácné a epické, nálezy podle vzácnosti
 * ve stavu; létající skóre u každého přírůstku a hlášky komba na ×2, ×3 a stropu.
 */

import { describe, expect, it } from 'vitest';

import { BODY, COMBO, COUNTER, FLAG, HEADER, RESTITUTION_SHIFT, ROLE, bodyBase } from '../../contract';
import { RARITY, RARITY_SCORE, type Rarity } from '../contract';
import { foundOf, hooksOf, rarityOf } from '../index';
import { RARITY_DRAWS, assignRarities, drawRarities } from '../rarity';
import { TEST_LIBRARY, fightSpec, fightTuned, item, ofKind, play, testWorld, worldOf } from './harness';

const rarityAt = (draws: string, k: number): Rarity => RARITY[Number(draws[k])] as Rarity;

/**
 * První seed, jehož první a třetí los se liší a mezi prvními třemi je `want`: věc 1 a věc 3 pak mají jinou vzácnost,
 * takže sebrání v obráceném pořadí by s losem při sebrání dalo jiné body.
 */
function seedWith(want: Rarity): number {
  for (let seed = 1; seed < 500; seed += 1) {
    const first = [0, 1, 2].map((k) => rarityAt(drawRarities(seed), k));
    if (first[0] !== first[2] && first.includes(want)) return seed;
  }
  throw new Error(`no seed with ${want}`);
}

describe('rarity draws from the rarity stream', () => {
  it('the same seed gives the same rarities, other seeds other ones', () => {
    expect(drawRarities(11)).toEqual(drawRarities(11));
    expect(drawRarities(11)).toHaveLength(RARITY_DRAWS);
    expect(new Set([1, 2, 3, 4, 5, 6].map(drawRarities)).size).toBe(6);
  });

  it('weights 70 / 25 / 5 over many games', () => {
    const all = Array.from({ length: 40 }, (_, k) => drawRarities(k + 1)).join('');
    const share = (code: string): number => all.split('').filter((digit) => digit === code).length / all.length;
    expect(share('0')).toBeGreaterThan(0.66);
    expect(share('0')).toBeLessThan(0.74);
    expect(share('1')).toBeGreaterThan(0.21);
    expect(share('1')).toBeLessThan(0.29);
    expect(share('2')).toBeGreaterThan(0.03);
    expect(share('2')).toBeLessThan(0.07);
  });
});

describe('a thing gets its rarity when it comes into being, not when it is collected', () => {
  const seed = seedWith('rare');
  const draws = drawRarities(seed);

  it('level things carry their draws in body order from the first tick, a spawned copy the next draw at its spawn tick', () => {
    const world = testWorld(seed, [item(1), item(2), item(3), item(4, true)], [{ id: 'spawn_at', params: { at: [[5, 4]] } }], { rounds: 1, rarity: true });
    const first = play(world, [], TEST_LIBRARY, { horizon: 1 });
    expect([1, 2, 3].map((body) => rarityOf(first.state, body))).toEqual([0, 1, 2].map((k) => rarityAt(draws, k)));
    // Předloha je mrtvá: los nedostane, dostane ho až její kopie.
    expect(rarityOf(first.state, 4)).toBeUndefined();
    const spawned = play(world, [], TEST_LIBRARY, { horizon: 6 });
    const copy = (spawned.state[HEADER.bodyCount] as number) - 1;
    expect(copy).toBeGreaterThan(5);
    expect(rarityOf(spawned.state, copy)).toBe(rarityAt(draws, 3));
  });

  it('collected in either order, every thing keeps its rarity, score and the found counts', () => {
    const run = (order: readonly number[]) => {
      const at = order.map((body, k) => [10 * (k + 1), body] as const);
      const world = testWorld(seed, [item(1), item(2), item(3)], [{ id: 'collect_at', params: { at } }], { rounds: 1, rarity: true });
      const played = play(world, [], TEST_LIBRARY, { horizon: 40 });
      const pops = new Map(ofKind(played, 'score_pop').map((pop) => [pop.body, pop.amount]));
      return { pops, score: played.state[HEADER.counters + COUNTER.score], found: foundOf(played.state, hooksOf(world.rules)!.keeper as number) };
    };
    const forward = run([1, 2, 3]);
    const backward = run([3, 2, 1]);
    for (const body of [1, 2, 3]) expect(forward.pops.get(body)).toBe(10 * RARITY_SCORE[rarityAt(draws, body - 1)]);
    expect(backward.pops).toEqual(forward.pops);
    expect(backward.score).toBe(forward.score);
    expect(backward.found).toEqual(forward.found);
    const counted = [0, 1, 2].map((k) => rarityAt(draws, k));
    expect(forward.found).toEqual({ common: counted.filter((r) => r === 'common').length, rare: counted.filter((r) => r === 'rare').length, epic: counted.filter((r) => r === 'epic').length });
  });

  it('rare and epic finds send rare_found, an epic one the Epic find callout', () => {
    const epic = seedWith('epic');
    const world = testWorld(epic, [item(1), item(2), item(3)], [{ id: 'collect_at', params: { at: [[10, 1], [11, 2], [12, 3]] } }], { rounds: 1, rarity: true });
    const played = play(world, [], TEST_LIBRARY, { horizon: 20 });
    const rarities = [0, 1, 2].map((k) => rarityAt(drawRarities(epic), k));
    expect(ofKind(played, 'rare_found').map((found) => [found.rarity, found.body])).toEqual(
      rarities.flatMap((rarity, k) => (rarity === 'common' ? [] : [[rarity, k + 1]])),
    );
    expect(ofKind(played, 'callout').filter((callout) => callout.callout === 'epic_find')).toHaveLength(rarities.filter((r) => r === 'epic').length);
  });

  it('without rarity a collection scores as before and no thing carries a draw', () => {
    const world = testWorld(seed, [item(1)], [{ id: 'collect_at', params: { at: [[10, 1]] } }], { rounds: 1 });
    const played = play(world, [], TEST_LIBRARY, { horizon: 20 });
    expect(played.state[HEADER.counters + COUNTER.score]).toBe(10);
    expect(rarityOf(play(world, [], TEST_LIBRARY, { horizon: 1 }).state, 1)).toBeUndefined();
  });

  it('a physics thing keeps its restitution bits and gets no rarity', () => {
    const state = new Int32Array(bodyBase(3));
    state[HEADER.bodyCount] = 3;
    state[bodyBase(1) + BODY.role] = ROLE.collectible;
    state[bodyBase(1) + BODY.flags] = FLAG.alive | FLAG.physics | (500 << RESTITUTION_SHIFT);
    assignRarities(state, 2, '2');
    expect(rarityOf(state, 1)).toBeUndefined();
    expect(((state[bodyBase(1) + BODY.flags] as number) >> RESTITUTION_SHIFT) & 0x3ff).toBe(500);
    expect(state[bodyBase(2) + BODY.aux0]).toBe(0);
  });
});

describe('score pops and combo callouts', () => {
  it('a score pop over the thing that scored, or over the hero when no thing did', () => {
    const world = testWorld(3, [item(1)], [{ id: 'collect_at', params: { at: [[10, 1]] } }], { rounds: 1 });
    expect(ofKind(play(world, [], TEST_LIBRARY, { horizon: 20 }), 'score_pop')).toEqual([{ kind: 'score_pop', amount: 10, body: 1, tick: 10 }]);
  });

  it('combo callouts on x2, x3 and the top, once per streak', () => {
    const multipliers = [1, 2, 3, 4, COMBO.max, COMBO.max, 1, 2];
    const at = multipliers.map((multiplier, k) => [10 + k, multiplier] as const);
    // Počítadlo komba = mrtvá předloha těla 2.
    const world = testWorld(3, [item(1), item(2, true)], [{ id: 'combo_at', params: { keeper: 2, at } }], { rounds: 1 }, { combo: 2 });
    const callouts = ofKind(play(world, [], TEST_LIBRARY, { horizon: 30 }), 'callout');
    expect(callouts.map((callout) => [callout.callout, callout.tick])).toEqual([
      ['combo_2', 11],
      ['combo_3', 12],
      ['combo_max', 14],
      ['combo_2', 17],
    ]);
  });
});

describe('hookRarity in tuning', () => {
  it('a genre.v6 game with hookRarity draws rarities, one without does not', () => {
    expect(hooksOf(worldOf(fightTuned((tuning) => ({ ...tuning, hookRarity: true })), 1).rules)?.rarity).toBeDefined();
    expect(hooksOf(worldOf(fightSpec(), 1).rules)?.rarity).toBeUndefined();
  });
});
