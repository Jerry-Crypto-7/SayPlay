/**
 * Výběr vylepšení (P66 T3): nabídky ze streamu `upgrades` (týž seed = tytéž, jiný seed jiné), tři různé karty pod
 * stropem, volba je vstup v záznamu (karta 1–3), bez volby po `pickTicks` karta 0, vylepšení se promítne do hrdiny
 * a robot bere karty pevným pořadím.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { BODY, BUTTON, type BotPiece, COUNTER, HEADER, type InputEvent, NO_INPUT, bodyBase } from '../../contract';
import { ARCADE_LIBRARY } from '../../library';
import { runBot } from '../../verify';
import { HOOK_SLOTS, LEVEL_BITS, UPGRADE_OFFER, UPGRADE_PICK_BUTTONS, UPGRADE_STEP, UPGRADES, type UpgradeId } from '../contract';
import { hooksOf, offerOf, upgradeLevel } from '../index';
import { PICK_MASK, UPGRADE_PRIORITY, boostHero, drawOffers, makeHooksBot, openOffer, priorityCard, shortenSwing } from '../upgrades';
import { fightSpec, ofKind, play, worldOf } from './harness';

const POOL: readonly UpgradeId[] = ['speed', 'fire_rate', 'extra_life'];

/** Prázdný stav o `bodies` tělech (hlavička + těla), pro testy jednotlivých funkcí. */
const blank = (bodies: number): Int32Array => new Int32Array(bodyBase(bodies));

/** Záznam robota do první nabídky (bez jeho volby) – dál vstupy podle `then`. */
function untilOffer(seed: number): { world: ReturnType<typeof worldOf>; offerTick: number; before: InputEvent[] } {
  const world = worldOf(fightSpec(), seed);
  const bot = runBot(world);
  const offerTick = ofKind(play(world, bot.inputs), 'upgrade_offer')[0]!.tick;
  return { world, offerTick, before: bot.inputs.filter((input) => input.tick <= offerTick) };
}

describe('offers drawn from the upgrades stream', () => {
  it('the same seed gives the same offers, other seeds other ones', () => {
    expect(drawOffers(4, UPGRADES, 4)).toEqual(drawOffers(4, UPGRADES, 4));
    const orders = [1, 2, 3, 4, 5, 6].map((seed) => JSON.stringify(drawOffers(seed, UPGRADES, 4)));
    expect(new Set(orders).size).toBe(6);
    // Svět nese totéž, co losuje stream jeho semínka.
    expect(hooksOf(worldOf(fightSpec(), 4).rules)!.upgrades!.offers).toEqual(drawOffers(4, POOL, 2));
  });

  it('every offer is the whole pool in some order, so three different cards', () => {
    for (const order of drawOffers(9, UPGRADES, 4)) expect([...order].sort()).toEqual([...UPGRADES].sort());
  });

  it('an upgrade at the top level is not offered while three others are open', () => {
    const state = blank(3);
    state[bodyBase(2) + HOOK_SLOTS.levels] = UPGRADE_OFFER.maxLevel << (UPGRADES.indexOf('speed') * LEVEL_BITS);
    expect(openOffer(state, 2, ['speed', 'magnet', 'extra_life', 'carry'])).toEqual(['magnet', 'extra_life', 'carry']);
    expect(offerOf(state, 2)).toEqual(['magnet', 'extra_life', 'carry']);
    expect(state[bodyBase(2) + HOOK_SLOTS.pickLeft]).toBe(UPGRADE_OFFER.pickTicks);
  });
});


describe('the pick is an input in the record', () => {
  it.each([0, 1, 2])('card %i pressed in the break takes that card, levels it up and replays the same', (card) => {
    const { world, offerTick, before } = untilOffer(1);
    const pick: InputEvent = { tick: offerTick + 4, buttons: UPGRADE_PICK_BUTTONS[card]!, axis: 0 };
    const played = play(world, [...before, pick], ARCADE_LIBRARY, { horizon: offerTick + 20 });
    const offer = ofKind(played, 'upgrade_offer')[0]!.offer;
    expect(ofKind(played, 'upgrade_pick')).toEqual([{ kind: 'upgrade_pick', card, upgrade: offer[card], tick: offerTick + 4 }]);
    const keeper = hooksOf(world.rules)!.keeper;
    for (const id of offer) expect(upgradeLevel(played.state, keeper, id)).toBe(id === offer[card] ? 1 : 0);
    const again = play(world, [...before, pick], ARCADE_LIBRARY, { horizon: offerTick + 20 });
    expect(Array.from(again.state)).toEqual(Array.from(played.state));
  });

  it('nobody picks: card 0 is taken exactly pickTicks after the offer, and the round starts', () => {
    const { world, offerTick, before } = untilOffer(2);
    const played = play(world, before, ARCADE_LIBRARY, { horizon: offerTick + UPGRADE_OFFER.pickTicks + 5 });
    const offer = ofKind(played, 'upgrade_offer')[0]!.offer;
    expect(ofKind(played, 'upgrade_pick')).toEqual([{ kind: 'upgrade_pick', card: UPGRADE_OFFER.defaultCard, upgrade: offer[0], tick: offerTick + UPGRADE_OFFER.pickTicks }]);
    expect(ofKind(played, 'round_start').at(-1)).toMatchObject({ round: 1, tick: offerTick + UPGRADE_OFFER.pickTicks });
  });

  it('pick buttons outside a break change nothing', () => {
    const world = worldOf(fightSpec(), 3);
    const stray: InputEvent[] = [5, 6, 7].map((tick) => ({ tick, buttons: BUTTON.PICK_2, axis: 0 }));
    expect(Array.from(play(world, stray, ARCADE_LIBRARY, { horizon: 40 }).state)).toEqual(Array.from(play(world, [], ARCADE_LIBRARY, { horizon: 40 }).state));
  });

  it('extra_life adds a life the moment it is picked', () => {
    const { world, offerTick, before } = untilOffer(1);
    const offer = ofKind(play(world, before, ARCADE_LIBRARY, { horizon: offerTick + 2 }), 'upgrade_offer')[0]!.offer;
    const card = offer.indexOf('extra_life');
    const lives = (inputs: InputEvent[]): number => play(world, inputs, ARCADE_LIBRARY, { horizon: offerTick + 3 }).state[HEADER.counters + COUNTER.health] as number;
    const other = card === 0 ? 1 : 0;
    const pick = (k: number): InputEvent => ({ tick: offerTick + 2, buttons: UPGRADE_PICK_BUTTONS[k]!, axis: 0 });
    expect(lives([...before, pick(card)])).toBe(lives([...before, pick(other)]) + UPGRADE_STEP.extra_life);
  });
});

describe('upgrades on the hero', () => {
  const hero = (vx: number, vz: number): { state: Int32Array; keeper: number } => {
    const state = blank(4);
    state[HEADER.bodyCount] = 4;
    state[bodyBase(0) + BODY.vx] = vx;
    state[bodyBase(0) + BODY.vz] = vz;
    return { state, keeper: 3 };
  };
  const level = (state: Int32Array, keeper: number, id: UpgradeId, value: number): void => {
    state[bodyBase(keeper) + HOOK_SLOTS.levels] |= value << (UPGRADES.indexOf(id) * LEVEL_BITS);
  };

  it('speed moves the hero 15 % of its velocity further per level, without touching the velocity', () => {
    const { state, keeper } = hero(150, -100);
    boostHero(state, 0, keeper);
    expect([state[bodyBase(0) + BODY.x], state[bodyBase(0) + BODY.z]]).toEqual([0, 0]);
    level(state, keeper, 'speed', 2);
    boostHero(state, 0, keeper);
    expect([state[bodyBase(0) + BODY.x], state[bodyBase(0) + BODY.z], state[bodyBase(0) + BODY.vx]]).toEqual([45, -30, 150]);
  });

  it('magnet pulls things within 1.5 m per level, nothing farther', () => {
    const { state, keeper } = hero(0, 0);
    const thing = (body: number, x: number): void => {
      state[bodyBase(body) + BODY.role] = 3;
      state[bodyBase(body) + BODY.flags] = 1;
      state[bodyBase(body) + BODY.x] = x;
    };
    thing(1, 1400);
    thing(2, 1600);
    level(state, keeper, 'magnet', 1);
    boostHero(state, 0, keeper);
    expect([state[bodyBase(1) + BODY.x], state[bodyBase(2) + BODY.x]]).toEqual([1100, 1600]);
  });

  it('fire_rate shortens a strike cooldown the control has just set, by 20 % per level', () => {
    const { state, keeper } = hero(0, 0);
    const swing = { slot: BODY.aux1, ticks: 24 };
    state[bodyBase(0) + BODY.aux1] = 24;
    shortenSwing(state, 0, keeper, swing);
    expect(state[bodyBase(0) + BODY.aux1]).toBe(24);
    level(state, keeper, 'fire_rate', 1);
    shortenSwing(state, 0, keeper, swing);
    expect(state[bodyBase(0) + BODY.aux1]).toBe(20);
    // Rozestup, který už běží, se nezkracuje znovu.
    state[bodyBase(0) + BODY.aux1] = 15;
    shortenSwing(state, 0, keeper, swing);
    expect(state[bodyBase(0) + BODY.aux1]).toBe(15);
  });
});

describe('the robot picks by a fixed priority', () => {
  it('the priority card is the first of UPGRADE_PRIORITY in the offer', () => {
    expect(UPGRADE_PRIORITY).toHaveLength(UPGRADES.length);
    expect(priorityCard(['speed', 'magnet', 'extra_life'])).toBe(2);
    expect(priorityCard(['carry', 'range', 'magnet'])).toBe(1);
  });

  it('the hooks bot presses that card once in a break, nothing else in it, and hands over outside it', () => {
    const base: BotPiece = { id: 'test_bot', params: z.object({}).strict(), roles: ['player'], reactionTicks: 8, cost: () => ({ bodies: 0, rules: 0 }), decide: () => ({ buttons: BUTTON.ATTACK, axis: 300 }) };
    const bot = makeHooksBot({ test_bot: base });
    const state = blank(3);
    const params = { base: { id: 'test_bot', params: {} }, keeper: 2 };
    const seen = (recent: readonly { buttons: number; axis: number }[]) => bot.decide({ state, player: 0, tick: 0, recent }, params);
    expect(seen([])).toEqual({ buttons: BUTTON.ATTACK, axis: 300 });
    openOffer(state, 2, ['speed', 'magnet', 'extra_life']);
    state[bodyBase(2) + HOOK_SLOTS.breakLeft] = UPGRADE_OFFER.pickTicks;
    expect(seen([])).toEqual({ buttons: BUTTON.PICK_3, axis: 0 });
    expect(seen([{ buttons: BUTTON.PICK_3, axis: 0 }, NO_INPUT])).toEqual(NO_INPUT);
    expect((BUTTON.PICK_1 | BUTTON.PICK_2 | BUTTON.PICK_3) === PICK_MASK).toBe(true);
  });

  it('the robot of the hand-written fight takes extra_life first and wins', () => {
    const world = worldOf(fightSpec(), 1);
    const bot = runBot(world);
    expect(bot.outcome).toBe('won');
    const played = play(world, bot.inputs);
    const picks = ofKind(played, 'upgrade_pick');
    const offers = ofKind(played, 'upgrade_offer');
    expect(picks).toHaveLength(2);
    picks.forEach((pick, k) => expect(pick.card).toBe(priorityCard(offers[k]!.offer)));
    // Robot vidí stav starý 8 tiků: kartu stiskne 9 tiků po nabídce.
    picks.forEach((pick, k) => expect(pick.tick - offers[k]!.tick).toBe(9));
  });
});
