/** Analytic aiming for actual Rapier shots; only ordinary player inputs are emitted. */
import { z } from 'zod';
import { AXIS_MAX, BODY, BUTTON, COUNTER, FLAG, HEADER, NO_INPUT, ROLE, bodyBase, type BotPiece } from '../contract';
import { BALL, BALL_GOALS, ballFlight, ballSpeed, type BallGoal } from './ball';

export interface BallTarget { x: number; y: number; z: number; w: number; h: number; d: number }
export interface BallPlan { aim: number; charge: number; flightTicks: number }
export function solveBall(target: BallTarget, goal: BallGoal): BallPlan | null {
  let best: BallPlan | null = null, error = Infinity;
  for (let charge = 1; charge <= BALL.maxCharge; charge++) {
    const aim = Math.round(AXIS_MAX * target.x / (target.z - BALL.launchZ));
    if (Math.abs(aim) > AXIS_MAX) continue;
    for (let tick = 1; tick < 100; tick++) {
      const point = ballFlight(goal, charge, tick);
      if (point.y < 0) break;
      const y = point.y + BALL.size / 2;
      if (goal === 'hoop' && point.vy >= 0) continue;
      const x = Math.trunc(ballSpeed(charge) * aim / AXIS_MAX) * tick;
      if (Math.abs(point.z - target.z) >= target.d / 2 - 100 || Math.abs(x - target.x) >= target.w / 2 - 100 || y < target.y + 80 || y > target.y + target.h - 80) continue;
      const distance = Math.abs(y - (target.y + target.h / 2)) + Math.abs(point.z - target.z) + Math.abs(x - target.x);
      if (distance < error) { error = distance; best = { aim, charge, flightTicks: tick }; }
    }
  }
  return best;
}
const paramsSchema = z.object({ goal: z.enum(BALL_GOALS) }).strict();
export const ballBot: BotPiece<z.infer<typeof paramsSchema>> = {
  id: 'ball_bot', params: paramsSchema, roles: ['player', 'target', 'enemy', 'thing'], reactionTicks: 8, cost: () => ({ bodies: 0, rules: 0 }),
  decide({ state, player, recent }, params) {
    if (state[HEADER.counters + COUNTER.cooldown]! > 0) return NO_INPUT;
    const p = bodyBase(player);
    let charge = Math.max(0, state[p + BODY.aux1]!);
    for (const input of recent) charge = input.buttons & BUTTON.TAP ? 0 : Math.min(BALL.maxCharge, charge + Number(Boolean(input.buttons & BUTTON.HOLD)));
    const targets: BallTarget[] = [];
    for (let i = 0; i < state[HEADER.bodyCount]!; i++) {
      const b = bodyBase(i);
      if ((state[b + BODY.flags]! & FLAG.alive) && state[b + BODY.role] === ROLE.target) targets.push({ x: state[b + BODY.x]!, y: state[b + BODY.y]!, z: state[b + BODY.z]!, w: state[b + BODY.w]!, h: state[b + BODY.h]!, d: state[b + BODY.d]! });
    }
    const target = targets[0];
    if (target === undefined) return NO_INPUT;
    const plan = solveBall(target, params.goal);
    if (plan === null) return NO_INPUT;
    if (charge < plan.charge) return { axis: plan.aim, buttons: BUTTON.HOLD };
    // A keeper is a physical obstacle. Wait with the stored charge until the
    // forecast crossing lane is clear; do not modify its position or collision.
    for (let i = 0; i < state[HEADER.bodyCount]!; i++) {
      const b = bodyBase(i);
      if (!(state[b + BODY.flags]! & FLAG.alive) || state[b + BODY.role] !== ROLE.enemy) continue;
      if (state[b + BODY.z]! > target.z + target.d / 2) continue;
      const time = Math.max(0, Math.round((state[b + BODY.z]! - BALL.launchZ) / ballSpeed(plan.charge)));
      const flight = ballFlight(params.goal, plan.charge, time);
      if (flight.y > state[b + BODY.y]! + state[b + BODY.h]! + BALL.size / 2) continue;
      let x = state[b + BODY.x]!, vx = state[b + BODY.vx]!, phase = state[b + BODY.aux0]!;
      const period = state[b + BODY.aux1]!;
      for (let t = 0; t < time + recent.length + 1; t++) {
        x += vx;
        phase++;
        if (period > 0 && phase >= period) { phase = 0; vx = -vx; }
      }
      const shotX = Math.trunc(ballSpeed(plan.charge) * plan.aim / AXIS_MAX) * time;
      if (Math.abs(shotX - x) < state[b + BODY.w]! / 2 + BALL.size + 250) return { axis: plan.aim, buttons: 0 };
    }
    return { axis: plan.aim, buttons: BUTTON.TAP };
  },
};
