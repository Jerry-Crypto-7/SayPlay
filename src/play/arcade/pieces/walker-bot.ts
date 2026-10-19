import { z } from 'zod';
import { AXIS_MAX, BODY, BUTTON, FLAG, HEADER, ROLE, bodyBase, type ArcadeObservation, type BotPiece } from '../contract';
import { SHOOTER } from './shooter';
import { census } from './shots';
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

/**
 * Střelba v bludišti (P52 T6): střela letí směrem chůze (`blaster` s `aim: 'heading'`) a zeď ji zastaví. Robot vystřelí,
 * když je nejbližší tělo v ose chůze do `range` nepřítel, který patří střelbě (`owns`, R4) – ne do zdi a ne do nepřítele
 * druhé akce. Polohu a směr dopočítá z vlastních vstupů jako `walkerBot`; jedna střela naráz jako v aréně.
 */
export function walkerShot({ state, player, recent }: Pick<ArcadeObservation, 'state' | 'player' | 'recent'>, speed: number, range: number, owns?: (body: number) => boolean): boolean {
  if (census(state).projectiles > 0) return false;
  const p = bodyBase(player);
  let x = state[p + BODY.x]!, z0 = state[p + BODY.z]!;
  let velocity = { vx: state[p + BODY.vx]!, vz: state[p + BODY.vz]! };
  for (const input of recent) {
    velocity = walkerVelocity(input, speed);
    x += velocity.vx; z0 += velocity.vz;
  }
  // Stojící hrdina míří po ose z a šikmo bludištěm robot nechodí: v obou případech by střela šla jinam, než robot hledí.
  if ((velocity.vx === 0) === (velocity.vz === 0)) return false;
  const horizontal = velocity.vx !== 0;
  const sign = Math.sign(horizontal ? velocity.vx : velocity.vz);
  const [axis, cross, width] = horizontal ? [BODY.x, BODY.z, BODY.d] : [BODY.z, BODY.x, BODY.w];
  const [from, line] = horizontal ? [x, z0] : [z0, x];
  let nearest = -1, distance = range;
  for (let body = 0; body < state[HEADER.bodyCount]!; body++) {
    const b = bodyBase(body), flags = state[b + BODY.flags]!;
    if (body === player || (flags & FLAG.alive) === 0 || (state[b + BODY.role] !== ROLE.enemy && (flags & FLAG.solid) === 0)) continue;
    const ahead = (state[b + axis]! - from) * sign;
    if (ahead <= 0 || ahead >= distance || Math.abs(state[b + cross]! - line) * 2 >= state[b + width]! + SHOOTER.bulletSize) continue;
    nearest = body; distance = ahead;
  }
  return nearest >= 0 && state[bodyBase(nearest) + BODY.role] === ROLE.enemy && (owns === undefined || owns(nearest));
}
