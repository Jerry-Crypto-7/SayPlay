/**
 * Mizející podlaha (P56C T15, mutátor řetězu): dlaždice pod hrdinou, který stojí, se drolí a po
 * `period` × 3 tikách zmizí – hrdina spadne a ztratí život. Pohyb (rychlost, směrová klávesa, osa)
 * nebo skok drolení vrátí na začátek: další krok je nová dlaždice.
 *
 * Pravidlo stav nepíše a vlastní paměť nemá, drolení proto nese stav cíle hrdiny (`stateChange`,
 * 0..`TARGET_STATE_MAX`), který u hráče nic jiného nečte – je v hashi, takže replay sedí.
 * simplified: „stojí“ = nulová vodorovná rychlost a žádný směrový vstup, ne poloha dlaždice; hrdina, který
 * se uvnitř jedné dlaždice hýbe, ji nedrolí. Upgrade až s mřížkou dlaždic ve světě.
 */

import { z } from 'zod';

import { BODY, BUTTON, type ArcadeEffect, type BotPiece, FLAG, HEADER, type RulePiece, TARGET_STATE_MAX, bodyBase, targetStateOf } from '../contract';

const MOVES = BUTTON.LEFT | BUTTON.RIGHT | BUTTON.UP | BUTTON.DOWN;

const params = z.object({ period: z.int().min(10).max(120) }).strict();

const wrapped = z.object({ base: z.object({ id: z.string(), params: z.record(z.string(), z.unknown()) }).strict() }).strict();

/**
 * Robot, který pravidlo zná jako hráč, co vidí drolení: rozhoduje robot pod ním, a když je drolení na
 * maximu a robot stojí, uhne o krok ke středu (dlaždice vedle je nová).
 */
export function makeVanishingFloorBot(bots: Readonly<Record<string, BotPiece>>): BotPiece<z.infer<typeof wrapped>> {
  const parsed = new WeakMap<object, unknown>();
  return {
    id: 'vanishing_floor_bot',
    params: wrapped,
    roles: ['player'],
    // Všichni základní roboti reagují s 8 tiky (`makeAddonBot`).
    reactionTicks: 8,
    cost: () => ({ bodies: 0, rules: 0 }),
    decide: (observation, params) => {
      const base = bots[params.base.id];
      if (base === undefined) throw new Error(`arcade: unknown bot ${params.base.id}`);
      if (!parsed.has(params.base.params)) parsed.set(params.base.params, base.params.parse(params.base.params));
      const decided = base.decide(observation, parsed.get(params.base.params));
      const moving = (decided.buttons & MOVES) !== 0 || decided.axis !== 0 || observation.recent.some((input) => (input.buttons & MOVES) !== 0 || input.axis !== 0);
      if (moving || targetStateOf(observation.state, observation.player) < TARGET_STATE_MAX) return decided;
      const x = observation.state[bodyBase(observation.player) + BODY.x] as number;
      return { ...decided, buttons: decided.buttons | (x > 0 ? BUTTON.LEFT : BUTTON.RIGHT) };
    },
  };
}

export const vanishingFloor: RulePiece<z.infer<typeof params>> = {
  id: 'vanishing_floor',
  params,
  roles: ['player'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player, input }, { period }): readonly ArcadeEffect[] => {
    const p = bodyBase(player);
    const grounded = ((state[p + BODY.flags] as number) & FLAG.grounded) !== 0;
    const still = grounded && state[p + BODY.vx] === 0 && state[p + BODY.vz] === 0 && (input.buttons & MOVES) === 0 && input.axis === 0;
    const crumble = targetStateOf(state, player);
    if (!still) return crumble === 0 ? [] : [{ kind: 'stateChange', body: player, state: 0 }];
    if ((state[HEADER.tick] as number) % period !== 0) return [];
    if (crumble < TARGET_STATE_MAX) return [{ kind: 'stateChange', body: player, state: crumble + 1 }];
    return [{ kind: 'stateChange', body: player, state: 0 }, { kind: 'damage', amount: 1 }];
  },
};
