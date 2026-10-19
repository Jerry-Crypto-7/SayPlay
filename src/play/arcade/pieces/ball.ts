/** P41: a kicked/thrown sphere simulated by PhysicsSession, never a projectile shortcut. */
import { z } from 'zod';
import { createCompileRng } from '@/play/compile/rng';
import { ARCADE_HZ, AXIS_MAX, BODY, BUTTON, COUNTER, FLAG, HEADER, PHYSICS_SUBSTEPS, ROLE, bodyBase, bodyHp, unpackRotation, type ArcadeEffect, type ArcadeLevel, type BodyInit, type ControlPiece, type ModeGeneratorPiece, type RulePiece } from '../contract';
import { GRAVITY } from '../kernel';

export const BALL_GOALS = ['goal', 'hoop', 'hole'] as const;
export type BallGoal = typeof BALL_GOALS[number];
export const BALL = { size: 400, launchY: 1000, launchZ: 500, maxCharge: 60, minSpeed: 100, chargeSpeed: 4, timeout: 3600, flightTicks: 160, keeperSpeed: 60, keeperPeriod: 80 } as const;
/**
 * Finále míče (P51 T4, jen nová hra se značkou `segments`): za terči hlídkuje soupeř-boss se `hp` HP – role nepřítele,
 * kyvadlo brankáře kolem x = 0, míč jím projde. Hra vyhraje, až padnou všechny terče a soupeř dostane `hp` zásahů
 * míčem. Stojí `behind` za nejvzdálenějším terčem, takže střela, která terč trefí, k němu nedoletí. Náboje navíc
 * `ammo`; hodiny navíc na `hp` + `spare` střel, každá = zotavení po střele + perioda kyvadla (čekání na průchod středem).
 * Změřeno (12 semínek, intermediate / finále): `ball.defeat`, `ball.score`, `ball.score+rival` 12/12 / 12/12, běh 26–31 s.
 * Bez rezervy (`spare` 0) `+rival` 0/12 (brankář prodlouží čekání). Začátečník 12/12 ve všech třech: liší se od
 * intermediate jen reakcí (≤ 1,5 s za běh), takže pásmo by držely jen hodiny pár desetin nad během intermediate.
 */
export const BALL_FINALE = { hp: 3, spare: 1, behind: 2000, ammo: 6, w: 1400, h: 2600, d: 800 } as const;
/** Sekundy navíc na finále: střely na soupeře podle zotavení hry (`ball_launch`, nejvyšší přírůstek po čtyřech gólech). */
export const ballFinaleSeconds = (params: BallPitchParams): number =>
  Math.ceil(((BALL_FINALE.hp + BALL_FINALE.spare) * ((params.shotRecoveryTicks ?? BALL.flightTicks) + 4 * (params.shotRecoveryRiseTicks ?? 0) + BALL.keeperPeriod)) / ARCADE_HZ);
export const ballParams = z.object({ goal: z.enum(BALL_GOALS).default('goal'), keeper: z.boolean().default(false), team: z.boolean().optional(), knockdown: z.boolean().optional(), difficulty: z.enum(['easy', 'normal', 'hard']).default('normal'), targets: z.int().min(1).max(5).default(1), shotRecoveryTicks: z.int().min(120).max(240).optional(), shotRecoveryRiseTicks: z.int().min(0).max(12).optional(), paceSeconds: z.int().min(10).max(90).optional(), segments: z.literal(true).optional() }).strict();
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
const teamSchema = z.object({ template: z.int().min(1), forward: z.int().min(1), goal: z.int().min(1), goalsToLose: z.int().min(2) }).strict();
const launchParams = z.object({ team: teamSchema.optional(), template: z.int().min(1), goal: z.enum(BALL_GOALS), shotRecoveryTicks: z.int().min(120).max(240).optional(), shotRecoveryRiseTicks: z.int().min(0).max(12).optional() }).strict();
export const ballLaunch: RulePiece<z.infer<typeof launchParams>> = {
  id: 'ball_launch', params: launchParams, roles: ['player', 'thing'], trigger: 'tick', cost: () => ({ bodies: 0, rules: 1 }),
  fire({ state, player }, params) {
    // Opposing forwards launch the same dynamic sphere as the player. A missed
    // shot cannot score; only the opposing goal's volume ends a possession.
    // The kickoff no longer swallows a shot released on the same tick; it still
    // holds the cooldown for that tick, as recorded replays expect.
    const kickoff: ArcadeEffect[] = [];
    if (params.team && state[HEADER.tick]! % 240 === 1) {
      const t = bodyBase(params.team.template), f = bodyBase(params.team.forward);
      const active = Array.from({ length: state[HEADER.bodyCount]! }, (_, i) => bodyBase(i)).some(b => (state[b + BODY.flags]! & FLAG.alive) && state[b + BODY.kind] === state[t + BODY.kind]);
      if (!active) kickoff.push({ kind: 'spawn', template: params.team.template, x: state[f + BODY.x]!, y: BALL.launchY, z: state[f + BODY.z]!, vx: 0, vy: 300, vz: -200 });
    }
    const cooldown = state[HEADER.counters + COUNTER.cooldown]!;
    if (cooldown > 0) return kickoff.length > 0 ? kickoff : [{ kind: 'count', counter: 'cooldown', amount: -1 }];
    const p = bodyBase(player), charge = -state[p + BODY.aux1]!;
    if (charge <= 0 || state[HEADER.counters + COUNTER.ammo]! <= 0) return kickoff;
    for (let i = 0; i < state[HEADER.bodyCount]!; i++) {
      const b = bodyBase(i);
      if ((state[b + BODY.flags]! & (FLAG.alive | FLAG.physics | FLAG.ball)) === (FLAG.alive | FLAG.physics | FLAG.ball) && state[b + BODY.kind] === state[bodyBase(params.template) + BODY.kind]) return kickoff;
    }
    const recovery = (params.shotRecoveryTicks ?? BALL.flightTicks) + Math.min(4, state[HEADER.counters + COUNTER.score]!) * (params.shotRecoveryRiseTicks ?? 0);
    return [...kickoff, { kind: 'count', counter: 'ammo', amount: -1 }, { kind: 'count', counter: 'cooldown', amount: recovery }, { kind: 'spawn', template: params.template, x: 0, y: BALL.launchY, z: BALL.launchZ, ...ballVelocity(params.goal, state[p + BODY.aux0]!, charge) }];
  },
};

const scoreParams = z.object({ team: teamSchema.optional(), goal: z.enum(BALL_GOALS), timeout: z.int().min(100).default(BALL.timeout), rival: z.int().min(1).optional() }).strict();
const aliveAt = (state: ArrayLike<number>, body: number | undefined): boolean => body !== undefined && (state[bodyBase(body) + BODY.flags]! & FLAG.alive) !== 0;
/** Míč v těle soupeře-bosse (`BALL_FINALE`): zásah a míč pryč; poslední HP = soupeř padne a bez terčů je to výhra. */
function rivalHit(state: Int32Array, ball: number, rival: number, targetsLeft: number): ArcadeEffect[] | null {
  const b = bodyBase(ball), r = bodyBase(rival);
  if (!aliveAt(state, rival) || Math.abs(state[b + BODY.x]! - state[r + BODY.x]!) * 2 >= state[r + BODY.w]! + BALL.size ||
      Math.abs(state[b + BODY.z]! - state[r + BODY.z]!) * 2 >= state[r + BODY.d]! + BALL.size || state[b + BODY.y]! >= state[r + BODY.y]! + state[r + BODY.h]!) return null;
  const effects: ArcadeEffect[] = [{ kind: 'hit', body: rival, by: ball, amount: 1 }, { kind: 'despawn', body: ball }];
  if (bodyHp(state, rival) <= 1) effects.push({ kind: 'despawn', body: rival }, ...(targetsLeft === 0 ? [{ kind: 'win' as const }] : []));
  return effects;
}
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
      if (params.team && state[b + BODY.kind] === state[bodyBase(params.team.template) + BODY.kind]) {
        const g = bodyBase(params.team.goal);
        const inside = Math.abs(state[b + BODY.x]! - state[g + BODY.x]!) < state[g + BODY.w]! / 2 && Math.abs(state[b + BODY.z]! - state[g + BODY.z]!) < state[g + BODY.d]! / 2 && state[b + BODY.y]! + BALL.size / 2 >= state[g + BODY.y]! && state[b + BODY.y]! + BALL.size / 2 <= state[g + BODY.y]! + state[g + BODY.h]!;
        if (inside) return [{ kind: 'count', counter: 'reserve', amount: 1 }, { kind: 'despawn', body: ball }, ...(state[HEADER.counters + COUNTER.reserve]! + 1 >= params.team.goalsToLose ? [{ kind: 'lose' as const }] : [])];
        // A missed shot that stops or rolls off the pitch ends the possession too;
        // a resting ball would otherwise hold an empty quiver open until the timeout.
        const resting = Math.abs(state[b + BODY.vx]!) + Math.abs(state[b + BODY.vy]!) + Math.abs(state[b + BODY.vz]!) <= 2;
        if (state[b + BODY.z]! < -2000 || resting || Math.abs(state[b + BODY.x]!) > 20000 || state[b + BODY.z]! > 30000) return [{ kind: 'despawn', body: ball }];
        continue;
      }
      for (const target of targets) {
        const t = bodyBase(target);
        const inside = Math.abs(state[b + BODY.x]! - state[t + BODY.x]!) < state[t + BODY.w]! / 2 && Math.abs(state[b + BODY.z]! - state[t + BODY.z]!) < state[t + BODY.d]! / 2 && state[b + BODY.y]! + BALL.size / 2 >= state[t + BODY.y]! && state[b + BODY.y]! + BALL.size / 2 <= state[t + BODY.y]! + state[t + BODY.h]!;
        if (!inside || (params.goal === 'hoop' && state[b + BODY.vy]! >= 0)) continue;
        const effects: ArcadeEffect[] = [{ kind: 'score', amount: 1 }, { kind: 'despawn', body: ball }, { kind: 'despawn', body: target }];
        if (targets.length === 1 && !aliveAt(state, params.rival)) effects.push({ kind: 'win' });
        return effects;
      }
      const rival = params.rival === undefined ? null : rivalHit(state, ball, params.rival, targets.length);
      if (rival !== null) return rival;
      if (state[HEADER.counters + COUNTER.cooldown]! <= 1 || Math.abs(state[b + BODY.x]!) > 20000 || state[b + BODY.z]! > 30000) return [{ kind: 'despawn', body: ball }];
    }
    if (state[HEADER.tick]! >= params.timeout || (state[HEADER.counters + COUNTER.ammo]! <= 0 && balls.length === 0)) return [{ kind: 'lose' }];
    return [];
  },
};

/** A pin must physically tip: a score counter or the sphere entering a sensor is insufficient. */
export const pinFallen = (state: ArrayLike<number>, body: number): boolean => {
  const b = bodyBase(body), q = unpackRotation(state[b + BODY.aux0]!, state[b + BODY.aux1]!);
  return Math.abs(1 - 2 * (q[0]! * q[0]! + q[2]! * q[2]!)) < 0.65;
};
export const ballKnockdown: RulePiece<z.infer<typeof scoreParams>> = {
  id: 'ball_knockdown', params: scoreParams, roles: ['thing', 'target'], trigger: 'tick', cost: () => ({ bodies: 0, rules: 1 }),
  fire({ state }, params) {
    const targets: number[] = [], balls: number[] = [];
    for (let i = 0; i < state[HEADER.bodyCount]!; i++) {
      const b = bodyBase(i), flags = state[b + BODY.flags]!;
      if (!(flags & FLAG.alive)) continue;
      if (state[b + BODY.role] === ROLE.target && (flags & FLAG.physics)) targets.push(i);
      if ((flags & (FLAG.physics | FLAG.ball)) === (FLAG.physics | FLAG.ball)) balls.push(i);
    }
    for (const target of targets) if (pinFallen(state, target)) {
      return [{ kind: 'score', amount: 1 }, { kind: 'despawn', body: target }, ...(targets.length === 1 && !aliveAt(state, params.rival) ? [{ kind: 'win' as const }] : [])];
    }
    if (params.rival !== undefined) for (const ball of balls) {
      const rival = rivalHit(state, ball, params.rival, targets.length);
      if (rival !== null) return rival;
    }
    if (balls.length > 0 && state[HEADER.counters + COUNTER.cooldown]! <= 1) return balls.map(body => ({ kind: 'despawn', body }));
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
    if (params.knockdown) { bodies.push({ role: 'target', kind: 'pin', x, y: 0, z: 5000, w: 350, h: 2000, d: 350, solid: true, physics: true }); continue; }
    bodies.push({ role: 'target', kind: params.goal, x, y: params.goal === 'hole' ? 0 : Math.max(0, centerY - 500), z: flight.z, w: aperture, h: params.goal === 'hole' ? 600 : 1000, d: aperture, solid: false });
  }
  if (params.keeper || params.team) {
    const target = bodies[2]!;
    bodies.push({ role: 'enemy', kind: 'goalkeeper', x: -2400, y: 0, z: Math.floor(target.z * 0.6), w: 1000, h: 2300, d: 600, solid: true, kinematic: true, vx: BALL.keeperSpeed, period: BALL.keeperPeriod });
  }
  if (params.segments === true) {
    const far = Math.max(...bodies.filter(body => body.role === 'target').map(body => body.z));
    const { w, h, d, hp, behind } = BALL_FINALE;
    bodies.push({ role: 'enemy', kind: 'goalkeeper', x: -(BALL.keeperSpeed * BALL.keeperPeriod) / 2, y: 0, z: far + behind, w, h, d, solid: false, kinematic: true, vx: BALL.keeperSpeed, period: BALL.keeperPeriod, hp });
  }
  if (params.team) {
    bodies.push({ role: 'enemy', kind: 'opponent-forward', x: 3500, y: 0, z: 15000, w: 600, h: 1700, d: 600, solid: true });
    bodies.push({ role: 'thing', kind: 'opponent-ball', x: 3500, y: BALL.launchY, z: 15000, w: BALL.size, h: BALL.size, d: BALL.size, solid: true, physics: true, ball: true, restitution: 150, template: true });
    bodies.push({ role: 'goal', kind: 'home-goal', x: 3500, y: 0, z: 1600, w: 1600, h: 5000, d: 1600, solid: false });
  }
  return { bodies, length: 0, spawnSlots: params.team ? 2 : 1, counters: { ammo: params.targets * 3 + (params.segments === true ? BALL_FINALE.ammo : 0) } };
}
/**
 * Do kterého tiku hra míče jistě běží (P52 T7): první gól padne nejdřív za vteřinu a každý další terč i zásah soupeře
 * finále chce vlastní střelu, mezi střelami je zotavení nejméně 120 tiků (`ball_launch`).
 */
export function ballOpenUntil(level: ArcadeLevel): number {
  const shots = level.bodies.reduce((sum, body) => sum + (body.role === 'target' ? 1 : body.role === 'enemy' && body.hp === BALL_FINALE.hp ? BALL_FINALE.hp : 0), 0);
  return ARCADE_HZ + Math.max(0, shots - 1) * 120;
}
/** Soupeř-boss finále (`BALL_FINALE`) v úrovni, nebo `undefined`. */
const rivalOf = (level: ArcadeLevel, params: BallPitchParams): number | undefined => (params.segments === true ? level.bodies.findIndex(body => body.hp === BALL_FINALE.hp && body.role === 'enemy') : undefined);
export const ballPitch: ModeGeneratorPiece<BallPitchParams> = {
  id: 'ball_pitch', params: ballParams, roles: ['player', 'thing', 'target', 'enemy'], cost: params => ({ bodies: 3 + params.targets + Number(params.keeper || params.team) + (params.team ? 4 : 0), rules: 2 }), generate,
  parts(seed, params, health) {
    const level = generate(seed, params);
    const index = rivalOf(level, params);
    // The finale rival's shots (`hp` + `spare`) give the opposing team as many goals more before the game is lost.
    const finaleGoals = index === undefined ? 0 : BALL_FINALE.hp + BALL_FINALE.spare;
    const team = params.team ? { team: { forward: level.bodies.findIndex(b => b.kind === 'opponent-forward'), template: level.bodies.findIndex(b => b.kind === 'opponent-ball'), goal: level.bodies.findIndex(b => b.kind === 'home-goal'), goalsToLose: params.targets + 1 + finaleGoals } } : {};
    const recovery = { ...(params.shotRecoveryTicks === undefined ? {} : { shotRecoveryTicks: params.shotRecoveryTicks }), ...(params.shotRecoveryRiseTicks === undefined ? {} : { shotRecoveryRiseTicks: params.shotRecoveryRiseTicks }) };
    const rival = index === undefined ? {} : { rival: index };
    const seconds = params.paceSeconds === undefined ? undefined : index === undefined ? params.paceSeconds : Math.min(90, params.paceSeconds + ballFinaleSeconds(params));
    return { level, control: { id: 'ball', params: {} }, bot: { id: 'ball_bot', params: { goal: params.goal, ...rival } }, rules: [{ id: 'ball_launch', params: { template: 1, goal: params.goal, ...recovery, ...team } }, { id: params.knockdown ? 'ball_knockdown' : 'ball_score', params: { goal: params.goal, timeout: BALL.timeout, ...team, ...rival } }, ...(seconds === undefined ? [] : [{ id: 'time_limit', params: { seconds } }])], health };
  },
};
