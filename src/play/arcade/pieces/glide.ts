/** Native 3D swimming/flying. Geometry and forces are integer, seed-only data. */
import { z } from 'zod';
import { createCompileRng } from '@/play/compile/rng';
import { AXIS_MAX, BODY, BUTTON, FLAG, HEADER, ROLE, UNIT, bodyBase, type ArcadeInput, type ArcadeLevel, type BodyInit, type ControlPiece, type ModeGeneratorPiece, type RulePiece } from '../contract';
import { GRAVITY } from '../kernel';

export const GLIDE = { size: 700, speed: 180, lateral: 120, acceleration: 10, drag: 8, reactionTicks: 8, halfGap: 1800, spacing: 20 * UNIT, ceiling: 14 * UNIT, bound: 12 * UNIT, current: 12, currentDepth: 4000 } as const;
export const GLIDE_MODES = ['reach', 'collect', 'race', 'escape'] as const;
export const glideNodeSchema = z.object({ x: z.int(), y: z.int(), z: z.int(), currentX: z.int().min(-12).max(12), currentY: z.int().min(-12).max(12) }).strict();
export const glidePathSchema = z.array(glideNodeSchema).min(1).max(20);
export type GlideNode = z.infer<typeof glideNodeSchema>;
export const glideControlParams = z.object({ topSpeed: z.int().min(120).max(240).default(GLIDE.speed), path: glidePathSchema, rivalIndex: z.int().min(1).optional() }).strict();
export type GlideControlParams = z.infer<typeof glideControlParams>;
export const glideCourseParams = z.object({ mode: z.enum(GLIDE_MODES).default('reach'), difficulty: z.enum(['easy', 'normal', 'hard']).default('normal'), clearancePermille: z.int().min(250).max(1000).optional(), clearanceRisePermille: z.int().min(0).max(250).optional(), lengthM: z.int().min(80).max(400).default(160), topSpeed: z.int().min(120).max(240).default(GLIDE.speed) }).strict();
export type GlideCourseParams = z.infer<typeof glideCourseParams>;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const toward = (n: number, goal: number, rate: number): number => n < goal ? Math.min(goal, n + rate) : Math.max(goal, n - rate);
export interface GlideMotion { x: number; y: number; z: number; vx: number; vy: number; vz: number }

/** Post-gravity velocity, shared with the delayed bot's input-only prediction. */
export function glideVelocity(motion: GlideMotion, input: ArcadeInput, params: GlideControlParams): Pick<GlideMotion, 'vx' | 'vy' | 'vz'> {
  const axis = input.axis || ((input.buttons & BUTTON.RIGHT ? 1 : 0) - (input.buttons & BUTTON.LEFT ? 1 : 0)) * AXIS_MAX;
  const vertical = (input.buttons & BUTTON.UP ? 1 : 0) - (input.buttons & BUTTON.DOWN ? 1 : 0);
  const current = params.path.find(node => Math.abs(node.z - motion.z) <= GLIDE.currentDepth / 2);
  const tx = Math.trunc(axis * GLIDE.lateral / AXIS_MAX) + (current?.currentX ?? 0);
  const ty = vertical * GLIDE.lateral + (current?.currentY ?? 0);
  return { vx: toward(motion.vx, tx, axis === 0 ? GLIDE.drag : GLIDE.acceleration), vy: toward(motion.vy, ty, vertical === 0 ? GLIDE.drag : GLIDE.acceleration), vz: input.buttons & BUTTON.HOLD ? toward(motion.vz, 0, 12) : toward(motion.vz, params.topSpeed, 4) };
}

export const glideControl: ControlPiece<GlideControlParams> = {
  id: 'glide', params: glideControlParams, roles: ['player', 'enemy', 'chaser'], cost: () => ({ bodies: 1, rules: 0 }),
  step(state, player, input, params) {
    const p = bodyBase(player);
    const motion = { x: state[p + BODY.x]!, y: state[p + BODY.y]!, z: state[p + BODY.z]!, vx: state[p + BODY.vx]!, vy: state[p + BODY.vy]!, vz: state[p + BODY.vz]! };
    const velocity = glideVelocity(motion, input, params);
    state[p + BODY.vx] = velocity.vx;
    // The kernel applies gravity next; cancel it without teleporting position.
    state[p + BODY.vy] = velocity.vy + GRAVITY;
    state[p + BODY.vz] = velocity.vz;
    for (let i = 0; i < state[HEADER.bodyCount]!; i++) {
      const b = bodyBase(i);
      if (!(state[b + BODY.flags]! & FLAG.alive)) continue;
      if (state[b + BODY.role] === ROLE.chaser) {
        state[b + BODY.vx] = clamp(motion.x - state[b + BODY.x]!, -100, 100);
        state[b + BODY.vy] = clamp(motion.y - state[b + BODY.y]!, -100, 100);
        state[b + BODY.vz] = clamp(motion.z - state[b + BODY.z]!, -params.topSpeed + 25, params.topSpeed - 25);
      } else if (i === params.rivalIndex && state[b + BODY.role] === ROLE.enemy && (state[b + BODY.flags]! & FLAG.kinematic)) {
        const next = params.path.find(node => node.z > state[b + BODY.z]!) ?? params.path.at(-1)!;
        state[b + BODY.vx] = clamp(next.x - 2400 - state[b + BODY.x]!, -80, 80);
        state[b + BODY.vy] = clamp(next.y - GLIDE.size / 2 - state[b + BODY.y]!, -80, 80);
      }
    }
  },
};

export function glidePathOf(level: ArcadeLevel): GlideNode[] {
  return level.bodies.filter(body => body.kind === 'glide-ring').map((body, index) => ({ x: body.x, y: body.y + body.h / 2, z: body.z, currentX: index % 2 === 0 ? GLIDE.current : -GLIDE.current, currentY: index % 2 === 0 ? -GLIDE.current : GLIDE.current }));
}

function generate(seed: number, params: GlideCourseParams): ArcadeLevel {
  const rng = createCompileRng(seed);
  const length = params.lengthM * UNIT;
  const bodies: BodyInit[] = [{ role: 'player', kind: 'glider', x: 0, y: 4000, z: 0, w: GLIDE.size, h: GLIDE.size, d: GLIDE.size, solid: false }];
  let x = rng.pick([-1, 1]) * 3000;
  let y = 7500;
  const shift = params.difficulty === 'easy' ? 1600 : params.difficulty === 'hard' ? 2600 : 2100;
  for (let at = GLIDE.spacing; at <= length - 8000; at += GLIDE.spacing) {
    const section = Math.min(2, Math.floor(at * 3 / length));
    const baseClearance = params.clearancePermille ?? 1000;
    const clearance = Math.min(1000, baseClearance + Math.round((params.clearanceRisePermille ?? 0) * (2 - section) / 2));
    const gap = Math.round(GLIDE.halfGap * clearance / 1000);
    bodies.push({ role: 'collectible', kind: 'glide-ring', x, y: y - gap, z: at, w: gap * 2, h: gap * 2, d: 600, solid: false });
    // Four frames cover the cross-section: going around a ring cannot win.
    const frame = (bx: number, by: number, w: number, h: number): BodyInit => ({ role: 'obstacle', kind: 'glide-reef', x: Math.trunc(bx), y: by, z: at, w, h, d: 800, solid: false });
    const left = x - gap, right = x + gap;
    bodies.push(frame((-GLIDE.bound + left) / 2, 0, left + GLIDE.bound, GLIDE.ceiling), frame((right + GLIDE.bound) / 2, 0, GLIDE.bound - right, GLIDE.ceiling), frame(x, 0, 2 * gap, y - gap), frame(x, y + gap, 2 * gap, GLIDE.ceiling - y - gap));
    bodies.push({ role: 'platform', kind: 'glide-current', x, y: y - gap, z: at - 1000, w: 2 * gap, h: 2 * gap, d: GLIDE.currentDepth, solid: false });
    x = clamp(x + rng.int(-shift, shift), -5500, 5500);
    y = clamp(y + rng.int(-1500, 1500), 3500, 10500);
  }
  if (params.mode === 'race') bodies.push({ role: 'enemy', kind: 'glide-rival', x: 0, y: 6000, z: 10000, w: GLIDE.size, h: GLIDE.size, d: GLIDE.size, solid: false, kinematic: true, vz: Math.floor(params.topSpeed * 0.65) });
  if (params.mode === 'escape') bodies.push({ role: 'chaser', kind: 'glide-pursuer', x: 0, y: 4000, z: -12000, w: 1100, h: 1100, d: 1100, solid: false, kinematic: true, vz: params.topSpeed - 25 });
  bodies.push({ role: 'goal', kind: 'finish', x: 0, y: 0, z: length, w: 2 * GLIDE.bound, h: GLIDE.ceiling, d: 1000, solid: false });
  return { bodies, length };
}

const finishParams = z.object({ atZ: z.int().positive(), race: z.boolean(), rivalIndex: z.int().min(1).optional() }).strict();
export const glideFinish: RulePiece<z.infer<typeof finishParams>> = {
  id: 'glide_finish', params: finishParams, trigger: 'tick', roles: ['player', 'enemy'], cost: () => ({ bodies: 0, rules: 1 }),
  fire({ state, player }, params) {
    const p = bodyBase(player);
    if (Math.abs(state[p + BODY.x]!) > GLIDE.bound || state[p + BODY.y]! < 1 || state[p + BODY.y]! + GLIDE.size > GLIDE.ceiling || state[p + BODY.z]! > params.atZ + 1000) return [{ kind: 'lose' }];
    if (params.race) for (let i = 0; i < state[HEADER.bodyCount]!; i++) {
      const b = bodyBase(i);
      if (i === params.rivalIndex && (state[b + BODY.flags]! & FLAG.alive) && state[b + BODY.role] === ROLE.enemy && state[b + BODY.z]! >= params.atZ) return [{ kind: 'lose' }];
    }
    return [];
  },
};

/** Conservative reach with reaction, acceleration and current reserve removed. */
export function checkGlideLevel(level: ArcadeLevel, topSpeed: number = GLIDE.speed): string[] {
  const issues: string[] = [];
  let previous = { x: 0, y: 4000 + GLIDE.size / 2, z: 0 };
  const rings = level.bodies.filter(body => body.kind === 'glide-ring');
  for (const [index, node] of glidePathOf(level).entries()) {
    const ticks = Math.floor((node.z - previous.z) / topSpeed) - GLIDE.reactionTicks - 2 * Math.ceil(GLIDE.lateral / GLIDE.acceleration);
    const reach = Math.max(0, ticks) * (GLIDE.lateral - GLIDE.current);
    if (Math.abs(node.x - previous.x) + 600 > reach || Math.abs(node.y - previous.y) + 600 > reach) issues.push(`ring at ${node.z} exceeds delayed steering reach`);
    const halfGap = rings[index]!.h / 2;
    if (rings[index]!.w < GLIDE.size || rings[index]!.h < GLIDE.size) issues.push(`ring at ${node.z} cannot fit the player`);
    if (node.y - halfGap < 0 || node.y + halfGap > GLIDE.ceiling) issues.push(`ring at ${node.z} exceeds height bounds`);
    previous = node;
  }
  if (level.bodies.length > 256) issues.push('body budget exceeded');
  return issues;
}

export const glideCourse: ModeGeneratorPiece<GlideCourseParams> = {
  id: 'glide_course', params: glideCourseParams, roles: ['player', 'obstacle', 'collectible', 'platform', 'enemy', 'chaser', 'goal'],
  cost: params => ({ bodies: 3 + 6 * Math.ceil(params.lengthM * UNIT / GLIDE.spacing), rules: 6 }), generate,
  parts(seed, params, health) {
    const level = generate(seed, params);
    const rivalIndex = level.bodies.findIndex(body => body.kind === 'glide-rival');
    const rival = rivalIndex < 0 ? {} : { rivalIndex };
    const control = { topSpeed: params.topSpeed, path: glidePathOf(level), ...rival };
    return { level, control: { id: 'glide', params: control }, bot: { id: 'glide_bot', params: control }, health,
      rules: [{ id: 'pickup', params: {} }, { id: 'hit', params: { role: 'obstacle', effect: 'lose' } }, { id: 'hit', params: { role: 'enemy', effect: 'lose' } }, { id: 'hit', params: { role: 'chaser', effect: 'lose' } }, { id: 'finish', params: { allItems: true } }, { id: 'glide_finish', params: { atZ: level.length, race: params.mode === 'race', ...rival } }],
      issues: checkGlideLevel(level, params.topSpeed) };
  },
};
