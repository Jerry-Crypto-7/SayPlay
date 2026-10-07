import { z } from 'zod';
import { AXIS_MAX, BODY, BUTTON, bodyBase, type BotPiece } from '../contract';
import { walkerMapSchema, walkerVelocity, walkerWaypoint } from './walker';

const paramsSchema = walkerMapSchema.extend({ speed: z.int().min(80).max(160), goal: z.int().min(0).max(224) }).strict();

/** Plans on the maze, compensates delayed observation using its own recent input. */
export const walkerBot: BotPiece<z.infer<typeof paramsSchema>> = {
  id: 'walker_bot', params: paramsSchema, roles: ['player', 'goal'], reactionTicks: 8, cost: () => ({ bodies: 0, rules: 0 }),
  decide({ state, player, recent }, params) {
    const p = bodyBase(player);
    let x = state[p + BODY.x]!, z0 = state[p + BODY.z]!;
    for (const input of recent) {
      const velocity = walkerVelocity(input, params.speed);
      x += velocity.vx; z0 += velocity.vz;
    }
    const target = walkerWaypoint(params, x, z0, params.goal);
    if (target === null) return { axis: 0, buttons: 0 };
    const dx = target.x - x, dz = target.z - z0;
    if (Math.abs(dx) > 80) return { axis: Math.round(Math.max(-1, Math.min(1, dx / params.speed)) * AXIS_MAX), buttons: 0 };
    return { axis: 0, buttons: Math.abs(dz) > 80 ? dz > 0 ? BUTTON.UP : BUTTON.DOWN : 0 };
  },
};
