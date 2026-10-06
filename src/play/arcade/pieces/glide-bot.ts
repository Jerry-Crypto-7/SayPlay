/** Delayed, input-predicting 3D pilot. No state writes or position shortcuts. */
import { AXIS_MAX, BODY, BUTTON, bodyBase, type ArcadeInput, type BotPiece } from '../contract';
import { GLIDE, glideControlParams, glideVelocity, type GlideControlParams } from './glide';

export const glideBot: BotPiece<GlideControlParams> = {
  id: 'glide_bot', params: glideControlParams, roles: ['player', 'collectible', 'obstacle', 'enemy', 'chaser'], reactionTicks: GLIDE.reactionTicks, cost: () => ({ bodies: 0, rules: 0 }),
  decide({ state, player, recent }, params): ArcadeInput {
    const p = bodyBase(player);
    let now = { x: state[p + BODY.x]!, y: state[p + BODY.y]!, z: state[p + BODY.z]!, vx: state[p + BODY.vx]!, vy: state[p + BODY.vy]!, vz: state[p + BODY.vz]! };
    for (const input of recent) {
      const velocity = glideVelocity(now, input, params);
      now = { ...velocity, x: now.x + velocity.vx, y: now.y + velocity.vy, z: now.z + velocity.vz };
    }
    const next = params.path.find(node => node.z + 900 > now.z) ?? params.path.at(-1)!;
    const dx = next.x - now.x;
    const dy = next.y - GLIDE.size / 2 - now.y;
    const axis = Math.trunc(Math.max(-AXIS_MAX, Math.min(AXIS_MAX, (dx / 8 - now.vx / 2) * AXIS_MAX / GLIDE.lateral)));
    // Release before arrival: inertia continues while the controller damps it.
    const stopping = Math.sign(now.vy) * now.vy * now.vy / (2 * GLIDE.drag);
    const error = dy - stopping;
    const buttons = error > 90 ? BUTTON.UP : error < -90 ? BUTTON.DOWN : 0;
    return { axis, buttons };
  },
};
