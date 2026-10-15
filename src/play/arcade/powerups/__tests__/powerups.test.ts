/**
 * Power-upy (P46C T1): ruční trať běžce (150 jednotek za tik vpřed, pruh 0), power-up
 * na `z` 1500 – hrdina ho sebere kolem tiku 7. Co se děje potom, rozhoduje jen `z` těl.
 */

import { describe, expect, it } from 'vitest';

import { applyAbilities } from '../../abilities';
import type { ArcadeParts } from '../../addons';
import { canonicalHash } from '@/ir/worlddoc';
import type { GameSpecV1 } from '@/play/spec';
import {
  ABILITY_SLOTS,
  ARCADE_HZ,
  BODY,
  type BodyInit,
  COUNTER,
  FLAG,
  HEADER,
  HIT_GRACE,
  NO_INPUT,
  POWERUP_SLOTS,
  POWERUP_TICKS,
  type PowerupId,
  bodyBase,
  comboOf,
  powerupOf,
} from '../../contract';
import { buildWorld, instantiate, loadProgram, step } from '../../kernel';
import { ARCADE_LIBRARY } from '../../library';
import { RUNNER, SPEED } from '../../pieces/runner';
import { type PlacedPowerup, applyPowerups } from '..';

const player: BodyInit = { role: 'player', kind: 'player', x: 0, y: 0, z: 0, w: RUNNER.playerW, h: RUNNER.runH, d: RUNNER.playerD, solid: false };
const coin = (x: number, z: number): BodyInit => ({ role: 'collectible', kind: 'coin', x, y: 300, z, w: 500, h: 500, d: 500, solid: false });
const rock = (z: number): BodyInit => ({ role: 'obstacle', kind: 'rock', x: 0, y: 0, z, w: 1200, h: 1000, d: 400, solid: false });
const at = (id: PowerupId, z = 1500): PlacedPowerup => ({ id, x: 0, y: 0, z });

function parts(bodies: readonly BodyInit[], comboKeeper?: number): ArcadeParts {
  return {
    control: { id: 'runner', params: { speed: 'normal' } },
    bot: { id: 'runner_bot', params: {} },
    level: { bodies: [player, ...bodies], length: 60_000 },
    rules: [
      { id: 'hit', params: { role: 'obstacle', effect: 'damage', grace: HIT_GRACE } },
      { id: 'pickup', params: comboKeeper === undefined ? {} : { combo: comboKeeper } },
      { id: 'out_of_health', params: {} },
    ],
  };
}

function run(made: ArcadeParts, ticks: number, each?: (state: Int32Array, tick: number) => void): Int32Array {
  const built = buildWorld({ seed: 1, control: made.control, bot: made.bot, rules: made.rules, level: made.level, health: 3 }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  const program = loadProgram(built.world, ARCADE_LIBRARY);
  const state = instantiate(built.world);
  for (let tick = 0; tick < ticks; tick += 1) {
    step(state, NO_INPUT, program);
    each?.(state, tick);
  }
  return state;
}

const keeperOf = (made: ArcadeParts): number => (made.control.params as { powerups: { keeper: number } }).powerups.keeper;
const score = (state: Int32Array): number => state[HEADER.counters + COUNTER.score] as number;
const health = (state: Int32Array): number => state[HEADER.counters + COUNTER.health] as number;
const alive = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;
const playerZ = (state: Int32Array): number => state[bodyBase(0) + BODY.z] as number;

describe('power-up pickup and timer', () => {
  it('sets the timed state on pickup and clears it when the time runs out', () => {
    for (const id of ['magnet', 'speed', 'double'] as const) {
      const made = applyPowerups(parts([]), [at(id)]);
      const keeper = keeperOf(made);
      let picked = -1;
      let ended = -1;
      run(made, 60 + POWERUP_TICKS[id], (state, tick) => {
        if (picked < 0 && powerupOf(state, keeper) === id) picked = tick;
        if (picked >= 0 && ended < 0 && powerupOf(state, keeper) === undefined) ended = tick;
      });
      expect(picked, id).toBeGreaterThan(0);
      expect(ended - picked, id).toBe(POWERUP_TICKS[id]);
    }
  });

  it('keeps the power-up body out of the world when none is placed', () => {
    const plain = parts([coin(0, 3000)]);
    expect(applyPowerups(plain, [])).toBe(plain);
    const a = run(plain, 200);
    const b = run(applyPowerups(plain, []), 200);
    expect(canonicalHash([...b])).toBe(canonicalHash([...a]));
  });

  it('replaces the active power-up with the newer one', () => {
    const made = applyPowerups(parts([]), [at('magnet', 1500), at('double', 4500)]);
    const state = run(made, 40);
    expect(powerupOf(state, keeperOf(made))).toBe('double');
    expect(state[bodyBase(keeperOf(made)) + POWERUP_SLOTS.left]).toBeGreaterThan(POWERUP_TICKS.double - 20);
  });
});

describe('magnet', () => {
  it('pulls a coin from the next lane while active and leaves it after the time runs out', () => {
    // Mince v pruhu vedle na z 3000 (do okruhu se dostane během magnetu), druhá daleko za jeho koncem.
    const late = 1500 + 150 * (POWERUP_TICKS.magnet + 120);
    const bodies = [coin(RUNNER.laneWidth, 3000), coin(RUNNER.laneWidth, late)];
    const without = run(parts(bodies), POWERUP_TICKS.magnet + 260);
    expect(alive(without, 1)).toBe(true);
    const made = applyPowerups(parts(bodies), [at('magnet')]);
    const state = run(made, POWERUP_TICKS.magnet + 260);
    expect(alive(state, 1)).toBe(false);
    expect(score(state)).toBe(1);
    // Po vypršení magnet nic netáhne: druhá mince leží, kde ležela.
    expect(alive(state, 2)).toBe(true);
    expect(state[bodyBase(2) + BODY.x]).toBe(RUNNER.laneWidth);
  });
});

describe('shield', () => {
  it('absorbs one hit, then ends and the next hit takes a life', () => {
    // Druhý kámen až za milostí po prvním zásahu (tik ~97).
    const bodies = [rock(3000), rock(15_000)];
    expect(health(run(parts(bodies), 120))).toBe(1);
    const made = applyPowerups(parts(bodies), [at('shield')]);
    const keeper = keeperOf(made);
    const first = run(made, 12);
    expect(powerupOf(first, keeper)).toBe('shield');
    expect(first[bodyBase(keeper) + ABILITY_SLOTS.shield]).toBe(1);
    const state = run(made, 60);
    expect(health(state)).toBe(3);
    expect(alive(state, 1)).toBe(false);
    expect(powerupOf(state, keeper)).toBeUndefined();
    expect(state[bodyBase(keeper) + ABILITY_SLOTS.shield]).toBe(0);
    expect(health(run(made, 120))).toBe(2);
  });

  it('runs out after its time when nothing hits it', () => {
    const made = applyPowerups(parts([]), [at('shield')]);
    const keeper = keeperOf(made);
    const state = run(made, 20 + POWERUP_TICKS.shield);
    expect(powerupOf(state, keeper)).toBeUndefined();
    expect(state[bodyBase(keeper) + ABILITY_SLOTS.shield]).toBe(0);
  });

  it('shares the charge and the block with the shield ability without cutting it to the ability window', () => {
    const spec = { abilities: ['shield'] } as unknown as GameSpecV1;
    const armed = applyAbilities(parts([rock(1500 + 150 * 120)]), { spec, seed: 1, health: 3 });
    const made = applyPowerups(armed, [at('shield')]);
    expect(keeperOf(made)).toBe((armed.control.params as { abilities: { keeper: number } }).abilities.keeper);
    // Jedno pravidlo bloku na svět: power-up ho nepřidá podruhé.
    expect(made.rules.filter((rule) => rule.id === 'ability_shield')).toHaveLength(1);
    const state = run(made, 140);
    expect(health(state)).toBe(3);
    expect(powerupOf(state, keeperOf(made))).toBeUndefined();
  });
});

describe('speed', () => {
  it('raises the genre speed by its share and drops back after the time runs out', () => {
    const made = applyPowerups(parts([]), [at('speed')], { pct: 30 });
    const speeds: number[] = [];
    run(made, 40 + POWERUP_TICKS.speed, (state) => speeds.push(state[bodyBase(0) + BODY.vz] as number));
    expect(speeds[2]).toBe(SPEED.normal);
    expect(speeds[30]).toBe(SPEED.normal + Math.trunc((SPEED.normal * 30) / 100));
    expect(speeds.at(-1)).toBe(SPEED.normal);
    const plain = run(parts([]), 40 + POWERUP_TICKS.speed);
    const boosted = run(made, 40 + POWERUP_TICKS.speed);
    expect(playerZ(boosted) - playerZ(plain)).toBeGreaterThan(0.25 * SPEED.normal * POWERUP_TICKS.speed);
  });
});

describe('double', () => {
  it('doubles the points while active and pays single points after', () => {
    const late = 1500 + 150 * (POWERUP_TICKS.double + 60);
    const made = applyPowerups(parts([coin(0, 3000), coin(0, late)]), [at('double')]);
    const state = run(made, 60 + POWERUP_TICKS.double + 60);
    expect(score(state)).toBe(2 + 1);
  });

  it('doubles the combo score once and leaves the combo multiplier its own', () => {
    // Mince po 30 tikách (4500 jednotek) jsou v okně komba: násobič 1, 2, 3.
    const keeperIndex = 4;
    const combo: BodyInit = { role: 'thing', kind: 'player', x: 0, y: 0, z: 0, w: 1, h: 1, d: 1, solid: false, template: true };
    const made = applyPowerups(parts([coin(0, 3000), coin(0, 7500), coin(0, 12_000), combo], keeperIndex), [at('double')]);
    const state = run(made, 100);
    expect(score(state)).toBe(2 * (1 + 2 + 3));
    expect(comboOf(state, keeperIndex)).toBe(3);
  });
});
