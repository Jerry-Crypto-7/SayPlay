/** P41: a kicked/thrown sphere simulated by PhysicsSession, never a projectile shortcut. */
import { z } from 'zod';
import { createCompileRng } from '@/play/compile/rng';
import { AXIS_MAX, BODY, BUTTON, COUNTER, FLAG, HEADER, PHYSICS_SUBSTEPS, ROLE, bodyBase, type ArcadeEffect, type ArcadeLevel, type BodyInit, type ControlPiece, type ModeGeneratorPiece, type RulePiece } from '../contract';
import { GRAVITY } from '../kernel';

export const BALL_GOALS = ['goal', 'hoop', 'hole'] as const;
export type BallGoal = typeof BALL_GOALS[number];
export const BALL = { size: 400, launchY: 1000, launchZ: 500, maxCharge: 60, minSpeed: 100, chargeSpeed: 4, timeout: 3600, flightTicks: 160, keeperSpeed: 60, keeperPeriod: 80 } as const;
export const ballParams = z.object({ goal: z.enum(BALL_GOALS).default('goal'), keeper: z.boolean().default(false), difficulty: z.enum(['easy', 'normal', 'hard']).default('normal'), targets: z.int().min(1).max(5).default(1) }).strict();
export type BallPitchParams = z.infer<typeof ballParams>;
export const ballControlParams = z.object({}).strict();
export const ballLoft = (goal: BallGoal): number => goal === 'hoop' ? 300 : goal === 'hole' ? 150 : 80;
export const ballSpeed = (charge: number): number => BALL.minSpeed + BALL.chargeSpeed * Math.max(1, Math.min(BALL.maxCharge, charge));
export function ballVelocity(goal: BallGoal, aim: number, charge: number): { vx: number; vy: number; vz: number } {
  const vz = ballSpeed(charge);
  return { vx: Math.trunc(vz * aim / AXIS_MAX), vy: ballLoft(goal), vz };
}
/** Free-flight prediction uses the same substep gravity lag as PhysicsSession. */
export function ballFlight(goal: BallGoal, charge: number, tick: number): { y: number; z: number; vy: number } {
  const gravityLag = GRAVITY * (PHYSICS_SUBSTEPS - 1) / (2 * PHYSICS_SUBSTEPS);
  return { y: BALL.launchY + tick * ballLoft(goal) - GRAVITY * tick * (tick + 1) / 2 + tick * gravityLag, z: BALL.launchZ + tick * ballSpeed(charge), vy: ballLoft(goal) - tick * GRAVITY };
}
export const ballControl: ControlPiece<z.infer<typeof ballControlParams>> = {
  id: 'ball', params: ballControlParams, roles: ['player'], cost: () => ({ bodies: 1, rules: 0 }),
  step(state, player, input) {
    const p = bodyBase(player);
    state[p + BODY.vx] = 0; state[p + BODY.vz] = 0;
    state[p + BODY.aux0] = Math.max(-AXIS_MAX, Math.min(AXIS_MAX, input.axis));
    let charge = input.buttons & BUTTON.DOWN ? 0 : Math.max(0, state[p + BODY.aux1]!);
    if (!(input.buttons & BUTTON.DOWN) && (input.buttons & BUTTON.HOLD)) charge = Math.min(BALL.maxCharge, charge + 1);
    state[p + BODY.aux1] = input.buttons & BUTTON.TAP ? -Math.max(1, charge) : charge;
  },
};
const launchParams = z.object({ template: z.int().min(1), goal: z.enum(BALL_GOALS) }).strict();
export const ballLaunch: RulePiece<z.infer<typeof launchParams>> = {
  id: 'ball_launch', params: launchParams, roles: ['player', 'thing'], trigger: 'tick', cost: () => ({ bodies: 0, rules: 1 }),
  fire({ state, player }, params) {
    const cooldown = state[HEADER.counters + COUNTER.cooldown]!;
    if (cooldown > 0) return [{ kind: 'count', counter: 'cooldown', amount: -1 }];
    const p = bodyBase(player), charge = -state[p + BODY.aux1]!;
    if (charge <= 0 || state[HEADER.counters + COUNTER.ammo]! <= 0) return [];
    for (let i = 0; i < state[HEADER.bodyCount]!; i++) {
      const b = bodyBase(i);
      if ((state[b + BODY.flags]! & (FLAG.alive | FLAG.physics | FLAG.ball)) === (FLAG.alive | FLAG.physics | FLAG.ball)) return [];
    }
    return [{ kind: 'count', counter: 'ammo', amount: -1 }, { kind: 'count', counter: 'cooldown', amount: BALL.flightTicks }, { kind: 'spawn', template: params.template, x: 0, y: BALL.launchY, z: BALL.launchZ, ...ballVelocity(params.goal, state[p + BODY.aux0]!, charge) }];
  },
};

const scoreParams = z.object({ goal: z.enum(BALL_GOALS), timeout: z.int().min(100).default(BALL.timeout) }).strict();
export const ballScore: RulePiece<z.infer<typeof scoreParams>> = {
  id: 'ball_score', params: scoreParams, roles: ['thing', 'target'], trigger: 'tick', cost: () => ({ bodies: 0, rules: 1 }),
  fire({ state }, params) {
    const targets: number[] = [], balls: number[] = [];
    for (let i = 0; i < state[HEADER.bodyCount]!; i++) {
      const b = bodyBase(i), flags = state[b + BODY.flags]!;
      if (!(flags & FLAG.alive)) continue;
      if (state[b + BODY.role] === ROLE.target) targets.push(i);
      if ((flags & (FLAG.physics | FLAG.ball)) === (FLAG.physics | FLAG.ball)) balls.push(i);
    }
    for (const ball of balls) {
      const b = bodyBase(ball);
      for (const target of targets) {
        const t = bodyBase(target);
        const inside = Math.abs(state[b + BODY.x]! - state[t + BODY.x]!) < state[t + BODY.w]! / 2 && Math.abs(state[b + BODY.z]! - state[t + BODY.z]!) < state[t + BODY.d]! / 2 && state[b + BODY.y]! + BALL.size / 2 >= state[t + BODY.y]! && state[b + BODY.y]! + BALL.size / 2 <= state[t + BODY.y]! + state[t + BODY.h]!;
        if (!inside || (params.goal === 'hoop' && state[b + BODY.vy]! >= 0)) continue;
        const effects: ArcadeEffect[] = [{ kind: 'score', amount: 1 }, { kind: 'despawn', body: ball }, { kind: 'despawn', body: target }];
        if (targets.length === 1) effects.push({ kind: 'win' });
        return effects;
      }
      if (state[HEADER.counters + COUNTER.cooldown]! <= 1 || Math.abs(state[b + BODY.x]!) > 20000 || state[b + BODY.z]! > 30000) return [{ kind: 'despawn', body: ball }];
    }
    if (state[HEADER.tick]! >= params.timeout || (state[HEADER.counters + COUNTER.ammo]! <= 0 && balls.length === 0)) return [{ kind: 'lose' }];
    return [];
  },
};

function generate(seed: number, params: BallPitchParams): ArcadeLevel {
  const rng = createCompileRng(seed);
  const bodies: BodyInit[] = [
    { role: 'player', kind: 'ball-player', x: 0, y: 0, z: 0, w: 600, h: 1700, d: 600, solid: false },
    { role: 'thing', kind: 'physics-ball', x: 0, y: BALL.launchY, z: BALL.launchZ, w: BALL.size, h: BALL.size, d: BALL.size, solid: true, physics: true, ball: true, restitution: 150, template: true },
  ];
  const aperture = params.difficulty === 'hard' ? 1000 : params.difficulty === 'easy' ? 1800 : 1400;
  for (let index = 0; index < params.targets; index++) {
    const charge = rng.int(20, 40);
    const tick = params.goal === 'hoop' ? 67 : params.goal === 'hole' ? 42 : 20;
    const flight = ballFlight(params.goal, charge, tick);
    const x = (index - (params.targets - 1) / 2) * 1400 + rng.int(-300, 300);
    const centerY = Math.max(BALL.size / 2, Math.round(flight.y + BALL.size / 2));
    bodies.push({ role: 'target', kind: params.goal, x, y: params.goal === 'hole' ? 0 : Math.max(0, centerY - 500), z: flight.z, w: aperture, h: params.goal === 'hole' ? 600 : 1000, d: aperture, solid: false });
  }
  if (params.keeper) {
    const target = bodies[2]!;
    bodies.push({ role: 'enemy', kind: 'goalkeeper', x: -2400, y: 0, z: Math.floor(target.z * 0.6), w: 1000, h: 2300, d: 600, solid: true, kinematic: true, vx: BALL.keeperSpeed, period: BALL.keeperPeriod });
  }
  return { bodies, length: 0, spawnSlots: 1, counters: { ammo: params.targets * 3 } };
}
export const ballPitch: ModeGeneratorPiece<BallPitchParams> = {
  id: 'ball_pitch', params: ballParams, roles: ['player', 'thing', 'target', 'enemy'], cost: params => ({ bodies: 3 + params.targets + Number(params.keeper), rules: 2 }), generate,
  parts(seed, params, health) {
    return { level: generate(seed, params), control: { id: 'ball', params: {} }, bot: { id: 'ball_bot', params: { goal: params.goal } }, rules: [{ id: 'ball_launch', params: { template: 1, goal: params.goal } }, { id: 'ball_score', params: { goal: params.goal, timeout: BALL.timeout } }], health };
  },
};
