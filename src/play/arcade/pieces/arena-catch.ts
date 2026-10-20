import { z } from 'zod';
import { createCompileRng } from '@/play/compile/rng';
import { BODY, FLAG, ROLE, UNIT, bodyBase, bodyHp, type ArcadeLevel, type BodyInit, type ModeGeneratorPiece, type RulePiece } from '../contract';
import { ARENA } from './arena';

/**
 * Finále chytání (P51 T4, jen nová hra se značkou `segments`): kořist je boss, který vydrží `hp` chycení – každé jí
 * ubere HP (zásah, který telemetrie počítá), první dvě ji nechají utéct a hráče vrátí na start (`respawn`), teprve
 * poslední ji chytí. Hodiny = `clockPct` % `catchSeconds` (nejvýš strop `time_limit` 90 s). Změřeno na buňce
 * `roam.catch` (11 s, 12 semínek): intermediate vyhraje za 22–35 s, začátečník za 34–60 s; hodiny 3 × 11 = 33 s daly
 * intermediate 6/12, 47 s (430 %) intermediate 12/12 a začátečníka 5/12 (44 s → 4/12, 48 s → 8/12).
 */
export const CATCH_FINALE = { hp: 3, clockPct: 430 } as const;

export const arenaCatchParams = z.object({
  half: z.int().min(5 * UNIT).max(40 * UNIT).default(ARENA.half),
  preySpeed: z.int().min(20).max(300).default(125),
  catchSeconds: z.int().min(10).max(80).default(30),
  /** Nová hra s průběhem a kořistí-bossem (P51 T4, `CATCH_FINALE`); uložený spec bez pole hraje jako dřív. */
  segments: z.literal(true).optional(),
}).strict();
export type ArenaCatchParams = z.infer<typeof arenaCatchParams>;
/**
 * Včely chytání se střelbou (P52 T7b, „spits water at the bees“): kořist střela nesebere (`shot_hit` `spare`), takže
 * akce střelby potřebuje jiný cíl. Včely stojí na přímce start → kořist: první `near` od startu (nejvýš `at[0]` ‰
 * cesty), kde ji robot vidí hned – kořist utíká rychleji než hrdina a cestu jinam stočí –, druhá v `at[1]` ‰.
 * Dotyk hrdinu vrátí na start (`stings`). Velikost je nad hrdinou i po zásahu všech (bod za zásah = `ARENA.grow`),
 * takže je robot bez střely jako větší buňku obchází.
 */
export const CATCH_BEES = { near: 6 * UNIT, at: [350, 650], size: 2000 } as const;

/** Včely na cestě ke kořisti, která začíná na `x`, `z` (hrdina na středu). Vzdálenost po větší ose, jako hledá robot. */
export function catchBees(x: number, z: number): BodyInit[] {
  const far = Math.max(Math.abs(x), Math.abs(z));
  const [first, second] = CATCH_BEES.at;
  return [Math.min(CATCH_BEES.near, Math.trunc((far * first) / 1000)), Math.trunc((far * second) / 1000)].map((reach) => ({
    role: 'enemy', kind: 'enemy', x: Math.trunc((x * reach) / far), y: 0, z: Math.trunc((z * reach) / far),
    w: CATCH_BEES.size, h: ARENA.height, d: CATCH_BEES.size, solid: false,
  }));
}

const contactParams = z.object({ prey: z.int().min(1), startX: z.int(), startZ: z.int(), tough: z.literal(true).optional(), stings: z.literal(true).optional() }).strict();
/** Motion is a physical precondition: standing beside a static prop is not pursuit. `stings`: any other enemy (a bee) sends the hero back to the start. */
export const arenaCatchContact: RulePiece<z.infer<typeof contactParams>> = {
  id: 'arena_catch_contact', params: contactParams, trigger: 'contact', roles: ['player', 'enemy'], cost: () => ({ bodies: 0, rules: 1 }),
  fire({ state, player, other }, params) {
    const p = bodyBase(player), q = bodyBase(other);
    if (other !== params.prey) {
      const bee = params.stings === true && (state[q + BODY.flags]! & FLAG.alive) !== 0 && state[q + BODY.role] === ROLE.enemy;
      return bee && state[p + BODY.x]! ** 2 + state[p + BODY.z]! ** 2 >= UNIT * UNIT ? [{ kind: 'respawn' }] : [];
    }
    if (!(state[q + BODY.flags]! & FLAG.alive) || !(state[q + BODY.flags]! & FLAG.kinematic) || state[q + BODY.role] !== ROLE.enemy) return [];
    if ((state[q + BODY.x]! - params.startX) ** 2 + (state[q + BODY.z]! - params.startZ) ** 2 < UNIT * UNIT) return [];
    if (state[p + BODY.x]! ** 2 + state[p + BODY.z]! ** 2 < UNIT * UNIT) return [];
    if (Math.abs(state[p + BODY.x]! - state[q + BODY.x]!) * 2 >= state[p + BODY.w]! + state[q + BODY.w]! ||
        Math.abs(state[p + BODY.z]! - state[q + BODY.z]!) * 2 >= state[p + BODY.d]! + state[q + BODY.d]!) return [];
    if (params.tough !== true) return [{ kind: 'despawn', body: other }, { kind: 'win' }];
    // Kořist-boss: chycení jí ubere HP; dokud nějaké zbývá, uteče a hráč jde zpět na start (odtud chycení neplatí).
    const hit = { kind: 'hit' as const, body: other, by: player, amount: 1 };
    return bodyHp(state, other) > 1 ? [hit, { kind: 'respawn' }] : [hit, { kind: 'despawn', body: other }, { kind: 'win' }];
  },
};
function generate(seed: number, params: ArenaCatchParams): ArcadeLevel {
  const rng = createCompileRng(seed);
  const edge = params.half - 1000;
  const x = rng.pick([-1, 1]) * rng.int(Math.floor(edge / 2), edge);
  const zz = rng.int(-edge, edge);
  return { length: 0, bodies: [
    { role: 'player', kind: 'player', x: 0, y: 0, z: 0, w: ARENA.startSize, h: ARENA.height, d: ARENA.startSize, solid: false },
    { role: 'enemy', kind: 'prey', x, y: 0, z: zz, w: 600, h: ARENA.height, d: 600, solid: false, kinematic: true, ...(params.segments === true ? { hp: CATCH_FINALE.hp } : {}) },
  ] };
}
export const arenaCatch: ModeGeneratorPiece<ArenaCatchParams> = {
  id: 'arena_catch', params: arenaCatchParams, roles: ['player', 'enemy'], cost: () => ({ bodies: 2, rules: 2 }), generate,
  parts(seed, params) {
    const level = generate(seed, params), prey = level.bodies[1]!;
    const tough = params.segments === true;
    return { level, control: { id: 'move_free', params: { half: params.half, size: ARENA.startSize, preySpeed: params.preySpeed } },
      bot: { id: 'arena_bot', params: { half: params.half } }, rules: [
        { id: 'arena_catch_contact', params: { prey: 1, startX: prey.x, startZ: prey.z, ...(tough ? { tough: true } : {}) } },
        { id: 'time_limit', params: { seconds: tough ? Math.min(90, Math.floor((params.catchSeconds * CATCH_FINALE.clockPct) / 100)) : params.catchSeconds } },
      ] };
  },
};
