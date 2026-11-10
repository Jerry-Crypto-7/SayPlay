/**
 * Obchod se součtem (P83E T2): součet se po každém tiku rovná součtu cenovek položených věcí (200 semínek, robot
 * i ťukal bez plánu), robot vyhraje, „nic nedělat“ prohraje na hodiny, přehrání dá týž hash a trefa má vždy řešení.
 */
import { describe, expect, it } from 'vitest';

import { BUTTON, COUNTER, HEADER, type InputEvent, RUN_STATE, bodyHp, targetStateOf } from '../../contract';
import { buildWorld, instantiate, loadProgram, replay, step } from '../../kernel';
import { ARCADE_LIBRARY } from '../../library';
import { runBot } from '../../verify';
import { axisOfCell } from '../lanes';
import { shopParts } from '../shop';
import { SHOP, SHOP_STATE, type ShopGame, type ShopParams, type ShopUnit, generateShop, placedOf, reachable, receiptOf, shopParams, tagMax, tagScale, totalOf } from '../shop-level';

const UNITS: readonly ShopUnit[] = ['price', 'weight', 'plain'];

/** Semínko → parametry: liché trefa do součtu, sudé „polož N“, jednotky a počty dokola. */
function paramsOf(seed: number): ShopParams {
  const unit = UNITS[seed % UNITS.length] as ShopUnit;
  const items = SHOP.items.min + (seed % (SHOP.items.max - SHOP.items.min + 1));
  return shopParams.parse(seed % 2 === 1 ? { items, unit, target: SHOP.target.min + (seed % 29) } : { items, unit });
}

function worldOf(seed: number, params: ShopParams = paramsOf(seed)) {
  const parts = shopParts(seed, params);
  const built = buildWorld({ seed, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level, ...(parts.health === undefined ? {} : { health: parts.health }) }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return { world: built.world, game: parts.control.params as unknown as ShopGame };
}

/** Součet cenovek věcí na pultu – to, co musí ukázat HUD. */
function placedSum(state: Int32Array, game: ShopGame): number {
  let sum = 0;
  for (let item = game.first; item < game.first + game.count; item += 1) if (targetStateOf(state, item) === SHOP_STATE.placed) sum += bodyHp(state, item);
  return sum;
}

/** Přehraje vstupy tik po tiku a po každém tiku ověří součet; vrátí konečný stav. */
function playChecked(seed: number, inputs: readonly InputEvent[]): { state: Int32Array; game: ShopGame; broken: number } {
  const { world, game } = worldOf(seed);
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  let next = 0;
  let broken = 0;
  for (let tick = 0; tick < 90 * 60 && state[HEADER.runState] === RUN_STATE.running; tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    const event = inputs[next];
    step(state, event !== undefined && event.tick === tick ? event : { buttons: 0, axis: 0 }, program);
    if (totalOf(state, game) !== placedSum(state, game) || state[HEADER.counters + COUNTER.items] !== placedOf(state, game)) broken += 1;
  }
  return { state, game, broken };
}

describe('P83E shop kernel', () => {
  it('200 seeds: tags stay in range and every target level has a set of shelf items that hits it', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const params = paramsOf(seed);
      const shop = generateShop(seed, params);
      expect(shopParts(seed, params).issues, `seed ${seed}`).toEqual([]);
      const values = shop.level.bodies.slice(shop.game.first, shop.game.first + shop.game.count).map((body) => body.hp ?? 0);
      expect(values.every((value) => value >= 1 && value <= tagMax(params.unit))).toBe(true);
      if (params.target === undefined) expect(shop.game.count).toBe(params.items);
      else {
        expect(shop.game.target).toBe(params.target * tagScale(params.unit));
        expect(reachable(values, shop.game.target)).toBe(true);
      }
    }
  });

  it('200 seeds: the total equals the sum of placed tags after every tick, and the robot wins', () => {
    const failed: number[] = [];
    for (let seed = 1; seed <= 200; seed += 1) {
      const { world } = worldOf(seed);
      const run = runBot(world, ARCADE_LIBRARY, { planner: false });
      const { state, game, broken } = playChecked(seed, run.inputs);
      if (run.outcome !== 'won' || broken > 0 || state[HEADER.runState] !== RUN_STATE.won) failed.push(seed);
      if (game.target > 0) expect(totalOf(state, game), `seed ${seed}`).toBe(game.target);
      else expect(placedOf(state, game), `seed ${seed}`).toBe(game.count);
      expect(receiptOf(state, game).reduce((sum, line) => sum + line.value, 0)).toBe(totalOf(state, game));
    }
    expect(failed).toEqual([]);
  });

  it('a player tapping without a plan never breaks the total, and refusals cost lives', () => {
    let refused = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const { game } = worldOf(seed);
      // Ťuk každých 23 tiků na místo podle semínka: věci se řadí do fronty, opakované ťuky na tutéž věc nic nepřidají.
      const inputs: InputEvent[] = Array.from({ length: 120 }, (_, k) => ({ tick: 5 + k * 23, buttons: BUTTON.TAP, axis: axisOfCell((seed * 7 + k * 5) % game.count) }));
      const run = playChecked(seed, inputs);
      expect(run.broken, `seed ${seed}`).toBe(0);
      if (game.target > 0) refused += SHOP.lives - (run.state[HEADER.counters + COUNTER.health] as number);
    }
    expect(refused).toBeGreaterThan(0);
  });

  it('doing nothing loses on the clock', () => {
    for (const seed of [1, 2, 3, 4]) expect(replay(worldOf(seed).world, [], ARCADE_LIBRARY).outcome, `seed ${seed}`).toBe('lost');
  });

  it('the replay of a robot run gives the same hash', () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      const { world } = worldOf(seed);
      const run = runBot(world, ARCADE_LIBRARY, { planner: false });
      expect(replay(world, run.inputs, ARCADE_LIBRARY).hash).toBe(run.hash);
    }
  });

  it('an item that would overshoot the target goes back to the shelf and costs a life; three such lose', () => {
    // Trefa 2 z věcí 1–9: jediná věc s cenovkou nad 2 přeteče.
    const params = shopParams.parse({ items: 2, unit: 'plain', target: 2 });
    let seed = 1;
    while (generateShop(seed, params).level.bodies.every((body) => body.role !== 'collectible' || (body.hp ?? 0) <= 2)) seed += 1;
    const shop = generateShop(seed, params);
    const big = shop.level.bodies.findIndex((body) => body.role === 'collectible' && (body.hp ?? 0) > 2) - shop.game.first;
    const parts = shopParts(seed, params);
    const built = buildWorld({ seed, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level, health: parts.health ?? 0 }, ARCADE_LIBRARY);
    if (!built.ok) throw new Error(built.issues.join('; '));
    const taps: InputEvent[] = [0, 1, 2].map((k) => ({ tick: 5 + k * 400, buttons: BUTTON.TAP, axis: axisOfCell(big) }));
    expect(replay(built.world, taps.slice(0, 2), ARCADE_LIBRARY, 900).outcome).toBe('running');
    expect(replay(built.world, taps, ARCADE_LIBRARY).outcome).toBe('lost');
  });
});
