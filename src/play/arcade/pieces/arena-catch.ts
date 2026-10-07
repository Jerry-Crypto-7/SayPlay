import { z } from 'zod';
import { createCompileRng } from '@/play/compile/rng';
import { BODY, FLAG, ROLE, UNIT, bodyBase, type ArcadeLevel, type ModeGeneratorPiece, type RulePiece } from '../contract';
import { ARENA } from './arena';

export const arenaCatchParams = z.object({
  half: z.int().min(5 * UNIT).max(40 * UNIT).default(ARENA.half),
  preySpeed: z.int().min(20).max(300).default(125),
  catchSeconds: z.int().min(10).max(80).default(30),
}).strict();
export type ArenaCatchParams = z.infer<typeof arenaCatchParams>;
const contactParams = z.object({ prey: z.int().min(1), startX: z.int(), startZ: z.int() }).strict();
/** Motion is a physical precondition: standing beside a static prop is not pursuit. */
export const arenaCatchContact: RulePiece<z.infer<typeof contactParams>> = {
  id: 'arena_catch_contact', params: contactParams, trigger: 'contact', roles: ['player', 'enemy'], cost: () => ({ bodies: 0, rules: 1 }),
  fire({ state, player, other }, params) {
    if (other !== params.prey) return [];
    const p = bodyBase(player), q = bodyBase(other);
    if (!(state[q + BODY.flags]! & FLAG.alive) || !(state[q + BODY.flags]! & FLAG.kinematic) || state[q + BODY.role] !== ROLE.enemy) return [];
    if ((state[q + BODY.x]! - params.startX) ** 2 + (state[q + BODY.z]! - params.startZ) ** 2 < UNIT * UNIT) return [];
    if (state[p + BODY.x]! ** 2 + state[p + BODY.z]! ** 2 < UNIT * UNIT) return [];
    if (Math.abs(state[p + BODY.x]! - state[q + BODY.x]!) * 2 >= state[p + BODY.w]! + state[q + BODY.w]! ||
        Math.abs(state[p + BODY.z]! - state[q + BODY.z]!) * 2 >= state[p + BODY.d]! + state[q + BODY.d]!) return [];
    return [{ kind: 'despawn', body: other }, { kind: 'win' }];
  },
};
function generate(seed: number, params: ArenaCatchParams): ArcadeLevel {
  const rng = createCompileRng(seed);
  const edge = params.half - 1000;
  const x = rng.pick([-1, 1]) * rng.int(Math.floor(edge / 2), edge);
  const zz = rng.int(-edge, edge);
  return { length: 0, bodies: [
    { role: 'player', kind: 'player', x: 0, y: 0, z: 0, w: ARENA.startSize, h: ARENA.height, d: ARENA.startSize, solid: false },
    { role: 'enemy', kind: 'prey', x, y: 0, z: zz, w: 600, h: ARENA.height, d: 600, solid: false, kinematic: true },
  ] };
}
export const arenaCatch: ModeGeneratorPiece<ArenaCatchParams> = {
  id: 'arena_catch', params: arenaCatchParams, roles: ['player', 'enemy'], cost: () => ({ bodies: 2, rules: 2 }), generate,
  parts(seed, params) {
    const level = generate(seed, params), prey = level.bodies[1]!;
    return { level, control: { id: 'move_free', params: { half: params.half, size: ARENA.startSize, preySpeed: params.preySpeed } },
      bot: { id: 'arena_bot', params: { half: params.half } }, rules: [
        { id: 'arena_catch_contact', params: { prey: 1, startX: prey.x, startZ: prey.z } },
        { id: 'time_limit', params: { seconds: params.catchSeconds } },
      ] };
  },
};
