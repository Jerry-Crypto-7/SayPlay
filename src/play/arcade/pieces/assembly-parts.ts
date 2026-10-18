/** Independent named gameplay pieces, layered over the original movement. */
import { z } from 'zod';
import type { GameSpecV1 } from '../../spec';
import { assemblyPartSchema } from '../../compose/parts';
import { baseControlOf, type ArcadeParts } from '../addons';
import { guardParts } from '../abilities';
import { abilityButton, abilityIdsOf, guardParams, guardedHit } from '../abilities/state';
import { AXIS_MAX, BODY, BUTTON, COUNTER, FLAG, HEADER, ROLE, UNIT, bodyBase, bodyHp, graceOf, targetStateOf,
  type ArcadeEffect, type ArcadeInput, type BodyInit, type BotPiece, type ControlPiece, type PieceRef, type RulePiece, type RuleTrigger } from '../contract';
import { DIRECTIONS, arenaAxis, directionOfAxis } from './arena';
import { RUNNER, RUNNER_STRUCTURE_D } from './runner';
import { centerAt, courseSchema } from './steer';
import { GLIDE } from './glide';
import { WALKER_CELL, walkerCell, walkerMapSchema, walkerPath, walkerVelocity, walkerWaypoint } from './walker';

const refSchema = z.object({ id: z.string(), params: z.record(z.string(), z.unknown()) });
const pointSchema = z.object({ x: z.int(), y: z.int(), z: z.int() });
export const runtimePartSchema = assemblyPartSchema.extend({
  body: z.int().nonnegative(), startX: z.int(), startY: z.int(), startZ: z.int(),
  goalX: z.int(), goalY: z.int(), goalZ: z.int(), speed: z.int().positive(),
});
// `strike`: tlačítko akce úderu (P46A T8) – díl souboje ho bere jako ATTACK, protože J ve hře s akcemi patří akci.
const sharedSchema = z.object({ parts: z.array(runtimePartSchema), keeper: z.int(), length: z.int(), control: z.string(), path: z.array(pointSchema), maze: walkerMapSchema.optional(), strike: z.int().optional() });
const wrappedSchema = sharedSchema.extend({ base: refSchema });
// `guard`: ochrana dashem či štítem (P47B T4) jako u `hit` – dostane ji jen díl, který zraní, ve hře s akcemi (`guardParts`).
const partParams = sharedSchema.extend({ part: runtimePartSchema, guard: guardParams.optional() });
type Shared = z.infer<typeof sharedSchema>;
type Part = z.infer<typeof runtimePartSchema>;
const alive = (state: Int32Array, body: number) => Boolean(state[bodyBase(body) + BODY.flags]! & FLAG.alive);
const done = (state: Int32Array, part: Part) => targetStateOf(state, part.body) === 2;
const phaseReady = (state: Int32Array, part: Part, parts: readonly Part[]) => part.phase === 0 || parts.filter(p => p.phase === 0).every(p => done(state, p));
const required = (part: Part) => !['hazard', 'chaser'].includes(part.kind);
const close = (state: Int32Array, a: number, b: number, extra = 0): boolean => {
  const p = bodyBase(a), q = bodyBase(b);
  return Math.abs(state[p + BODY.x]! - state[q + BODY.x]!) < (state[p + BODY.w]! + state[q + BODY.w]!) / 2 + extra
    && Math.abs(state[p + BODY.z]! - state[q + BODY.z]!) < (state[p + BODY.d]! + state[q + BODY.d]!) / 2 + extra
    && state[p + BODY.y]! < state[q + BODY.y]! + state[q + BODY.h]! + extra
    && state[q + BODY.y]! < state[p + BODY.y]! + state[p + BODY.h]! + extra;
};
/**
 * Délka vektoru na hashované cestě: `Math.sqrt` je podle IEEE 754 přesně zaokrouhlená
 * v každém enginu, `Math.hypot` ne (tvar jako `length` v `arena.ts`, bez `floor`, ať se rychlosti nepohnou).
 */
const distance = (dx: number, dz: number, dy = 0): number => Math.sqrt(dx * dx + dy * dy + dz * dz);
const moved = (state: Int32Array, part: Part) => {
  const b = bodyBase(part.body);
  return distance(state[b + BODY.x]! - part.startX, state[b + BODY.z]! - part.startZ, state[b + BODY.y]! - part.startY) >= UNIT;
};
const pointAt = (path: Shared['path'], z: number) => {
  const after = path.find(p => p.z >= z) ?? path.at(-1)!;
  const before = [...path].reverse().find(p => p.z <= z) ?? path[0]!;
  const ratio = before.z === after.z ? 0 : Math.max(0, Math.min(1, (z - before.z) / (after.z - before.z)));
  return { x: Math.round(before.x + (after.x - before.x) * ratio), y: Math.round(before.y + (after.y - before.y) * ratio) };
};
const parsed = new WeakMap<object, unknown>();
function paramsOf(piece: { params: { parse(raw: unknown): unknown } }, ref: PieceRef): unknown {
  if (!parsed.has(ref.params)) parsed.set(ref.params, piece.params.parse(ref.params));
  return parsed.get(ref.params);
}

/** Native input integration remains authoritative; only NPC velocities are added. */
export function makeAssemblyControl(controls: Readonly<Record<string, ControlPiece>>): ControlPiece<z.infer<typeof wrappedSchema>> {
  return { id: 'assembly_control', params: wrappedSchema, roles: ['player', 'thing'], cost: () => ({ bodies: 0, rules: 0 }),
    step(state, player, input, params) {
      const native = controls[params.base.id]!;
      // DOWN dribbles back on a composed pitch, so the native ball control must
      // not read it as "drop the charge"; the input layer signals that reset as DOWN+UP.
      const resetCharge = (input.buttons & (BUTTON.DOWN | BUTTON.UP)) === (BUTTON.DOWN | BUTTON.UP);
      const nativeInput = params.control === 'ball' && !resetCharge ? { ...input, buttons: input.buttons & ~BUTTON.DOWN } : input;
      native.step(state, player, nativeInput, paramsOf(native, params.base));
      const p = bodyBase(player);
      if (['runner', 'flap'].includes(params.control) && params.parts.some(part => part.kind === 'rival') && (input.buttons & BUTTON.DOWN)) state[p + BODY.vz] = Math.round(state[p + BODY.vz]! * 0.15);
      if (params.control === 'ball') {
        // The composed pitch permits dribbling with arrow keys; aiming remains
        // on axis. Native ball launches resume from the marked shooting spot.
        state[p + BODY.vx] = ((input.buttons & BUTTON.RIGHT ? 1 : 0) - (input.buttons & BUTTON.LEFT ? 1 : 0)) * 150;
        state[p + BODY.vz] = ((input.buttons & BUTTON.UP ? 1 : 0) - (input.buttons & BUTTON.DOWN ? 1 : 0)) * 150;
      }
      for (const part of params.parts) {
        const b = bodyBase(part.body);
        if (!alive(state, part.body) || !phaseReady(state, part, params.parts) || state[HEADER.held] === part.body + 1) continue;
        if (done(state, part) && required(part)) continue;
        let vx = 0, vy = 0, vz = 0;
        if (part.kind === 'catch' || part.kind === 'rival') {
          if (params.maze) {
            const goal = walkerCell(params.maze, part.goalX, part.goalZ);
            const waypoint = walkerWaypoint(params.maze, state[b + BODY.x]!, state[b + BODY.z]!, goal);
            if (waypoint) {
              const dx = waypoint.x - state[b + BODY.x]!, dz = waypoint.z - state[b + BODY.z]!;
              if (Math.abs(dx) > 80) vx = Math.sign(dx) * Math.min(part.speed, Math.abs(dx));
              else if (Math.abs(dz) > 80) vz = Math.sign(dz) * Math.min(part.speed, Math.abs(dz));
            }
          } else if (part.kind === 'rival' && params.length === 0) {
            const dx = part.goalX - state[b + BODY.x]!, dz = part.goalZ - state[b + BODY.z]!;
            const span = Math.max(1, distance(dx, dz));
            vx = Math.round(dx / span * part.speed); vz = Math.round(dz / span * part.speed);
          } else if (params.length > 0) {
            vz = part.speed;
            const at = pointAt(params.path, state[b + BODY.z]! + vz);
            vx = Math.max(-180, Math.min(180, at.x - state[b + BODY.x]!));
            vy = Math.max(-100, Math.min(100, at.y - state[b + BODY.y]!));
          } else {
            // Prey flees in the arena; at the boundary it turns back into play.
            const dx = state[b + BODY.x]! - state[p + BODY.x]!, dz = state[b + BODY.z]! - state[p + BODY.z]!;
            const span = Math.max(1, distance(dx, dz));
            vx = Math.round(dx / span * part.speed); vz = Math.round(dz / span * part.speed);
            if (Math.abs(state[b + BODY.x]!) > 7000) vx = -Math.sign(state[b + BODY.x]!) * part.speed;
            if (Math.abs(state[b + BODY.z]!) > 7000) vz = -Math.sign(state[b + BODY.z]!) * part.speed;
          }
        } else if (part.kind === 'chaser') {
          const dx = state[p + BODY.x]! - state[b + BODY.x]!, dz = state[p + BODY.z]! - state[b + BODY.z]!;
          const span = Math.max(1, distance(dx, dz));
          vx = Math.round(dx / span * part.speed); vz = Math.round(dz / span * part.speed);
          vy = Math.max(-80, Math.min(80, state[p + BODY.y]! - state[b + BODY.y]!));
        } else if (part.kind === 'hazard') {
          // Release when the player approaches, so the encounter is with a
          // falling/flying object rather than a prop that landed at startup.
          const approaching = Math.abs(state[p + BODY.z]! - state[b + BODY.z]!) < 6500 || moved(state, part);
          const floor = part.startY - 7000;
          vy = approaching && part.motion === 'fall' && state[b + BODY.y]! > floor ? -Math.min(part.speed, state[b + BODY.y]! - floor) : 0;
          vz = approaching && part.motion === 'fly' ? -part.speed : 0;
        } else if (part.kind === 'duel' || part.kind === 'fight') {
          const dx = state[p + BODY.x]! - state[b + BODY.x]!, dz = state[p + BODY.z]! - state[b + BODY.z]!;
          if (Math.abs(dz) < 2600 && Math.abs(dx) < 7000) {
            vx = Math.abs(dx) > 500 ? Math.sign(dx) * 65 : 0;
            vz = Math.abs(dz) > 1200 ? Math.sign(dz) * 65 : 0;
            // A duel is fought before continuing along the same native course.
            state[p + BODY.vx] = 0; state[p + BODY.vz] = 0;
          }
        }
        state[b + BODY.vx] = vx; state[b + BODY.vy] = vy; state[b + BODY.vz] = vz;
      }
    } };
}

/** A single named body owns each rule, keeping effect attribution unambiguous. */
export const assemblyPart: RulePiece<z.infer<typeof partParams>> = {
  id: 'assembly_part', params: partParams, roles: ['player', 'thing'], trigger: 'tick', cost: () => ({ bodies: 0, rules: 1 }),
  fire({ state, player, input }, { part, parts, length, maze, strike, guard }) {
    if (!alive(state, part.body) || !phaseReady(state, part, parts) || (done(state, part) && required(part))) return [];
    const tick = state[HEADER.tick]!, p = bodyBase(player), b = bodyBase(part.body);
    const finish: ArcadeEffect[] = [{ kind: 'stateChange', body: part.body, state: 2 }];
    if (part.kind === 'catch') return moved(state, part) && close(state, player, part.body) ? [...finish, { kind: 'despawn', body: part.body }] : [];
    if (part.kind === 'duel' || part.kind === 'fight') {
      if (bodyHp(state, part.body) === 0) return [...finish, { kind: 'despawn', body: part.body }];
      if (!close(state, player, part.body, 1400)) return [];
      // ATTACK is an edge input: a human press must work on every frame.
      // Held fire/primary controls retain their regular attack cadence.
      if ((input.buttons & (BUTTON.ATTACK | (strike ?? 0))) || (tick % 20 === 0 && (input.buttons & (BUTTON.FIRE | BUTTON.TAP | BUTTON.HOLD)))) return [{ kind: 'hit', body: part.body, by: player, amount: 1 }];
      if (tick % 90 === 0 && graceOf(state, player) === 0) return [{ kind: 'damage', amount: 1, grace: 60 }, ...(state[HEADER.counters + COUNTER.health]! <= 1 ? [{ kind: 'lose' as const }] : [])];
      return [];
    }
    if (part.kind === 'deliver' || part.kind === 'interact') {
      if (state[HEADER.held] === part.body + 1) {
        const reached = distance(state[p + BODY.x]! - part.goalX, state[p + BODY.z]! - part.goalZ) < 1800;
        return reached ? [...finish, { kind: 'release' }, { kind: 'despawn', body: part.body }] : [];
      }
      return close(state, player, part.body, 300) && state[HEADER.held] === 0 ? [{ kind: 'grab', body: part.body }, { kind: 'stateChange', body: part.body, state: 1 }] : [];
    }
    if (part.kind === 'rival') {
      if (maze || length === 0) {
        const arrived = (body: number) => distance(state[bodyBase(body) + BODY.x]! - part.goalX, state[bodyBase(body) + BODY.z]! - part.goalZ) < 1000;
        if (arrived(part.body) && !arrived(player)) return [{ kind: 'lose' }];
        return arrived(player) && !arrived(part.body) ? finish : [];
      }
      if (length > 0 && state[b + BODY.z]! >= length && state[p + BODY.z]! < length) return [{ kind: 'lose' }];
      return length > 0 && state[p + BODY.z]! >= length && state[b + BODY.z]! < length ? finish : [];
    }
    if (part.kind === 'escape') return length > 0 && state[p + BODY.z]! >= length - 500 && state[p + BODY.z]! - part.startZ >= 5000 ? finish : [];
    const effects: ArcadeEffect[] = !done(state, part) && moved(state, part) ? finish : [];
    if (close(state, player, part.body) && graceOf(state, player) === 0) effects.push(...guardedHit(state, guard, part.body, [{ kind: 'damage', amount: 1, grace: 60 }, ...(state[HEADER.counters + COUNTER.health]! <= 1 ? [{ kind: 'lose' as const }] : [])]));
    return effects;
  },
};

export const assemblyFinish: RulePiece<Shared> = {
  id: 'assembly_finish', params: sharedSchema, roles: ['player', 'thing'], trigger: 'counter', cost: () => ({ bodies: 0, rules: 1 }),
  fire({ state }, params) {
    return targetStateOf(state, params.keeper) === 1 && params.parts.every(p => done(state, p)) ? [{ kind: 'win' }] : [];
  },
};

/** Wrap one native rule in `assembly_gate_<trigger>`: it still plays, its win waits in the keeper. */
const gateRule = (ref: PieceRef, shared: Readonly<Record<string, unknown>>, ruleLibrary: Readonly<Record<string, RulePiece>>): PieceRef =>
  ({ id: `assembly_gate_${ruleLibrary[ref.id]!.trigger}`, params: { ...shared, base: ref } });

/**
 * Gate for rules added after assembly (spec rules, `score_bonus`): a composed
 * game wraps them like its native rules; a game without parts keeps them as is.
 */
export function assemblyGate(rules: readonly PieceRef[], ruleLibrary: Readonly<Record<string, RulePiece>>): (ref: PieceRef) => PieceRef {
  const shared = rules.find(ref => ref.id === 'assembly_finish')?.params;
  return shared === undefined ? ref => ref : ref => gateRule(ref, shared, ruleLibrary);
}

/** Preserve native goals; latch a premature win until the composed work is done. */
export function assemblyGateRules(rules: Readonly<Record<string, RulePiece>>): Record<string, RulePiece> {
  return Object.fromEntries((['contact', 'tick', 'counter', 'hit', 'press'] as RuleTrigger[]).map(trigger => {
    const id = `assembly_gate_${trigger}`;
    const piece: RulePiece<z.infer<typeof wrappedSchema>> = { id, params: wrappedSchema, trigger, roles: ['player', 'thing'], cost: () => ({ bodies: 0, rules: 1 }),
      fire(ctx, params) {
        const native = rules[params.base.id]!;
        return native.fire(ctx, paramsOf(native, params.base)).map(effect => effect.kind === 'win' ? { kind: 'stateChange', body: params.keeper, state: 1 } : effect);
      } };
    return [id, piece];
  }));
}

/** Odstup od překážky dílu, pod kterým robot arény s průběhem jde podél ní místo k ní (P51 T5). */
export const HAZARD_SKIRT = 2500;

/**
 * Aréna s průběhem (P51 T5): překážka dílu (`hazard`) po dopadu leží na zemi a zraní při dotyku; robot průběhu ji
 * nevidí. Bez průběhu se jí cesta k věcem vyhnula, s bossem a chováními ne (věta „chytá vejce“, semínko 2: tři životy
 * u ní). Míří-li osa k překážce blíž než `HAZARD_SKIRT`, robot jde kolmo podél ní na stranu, která směr zachová nejlíp.
 */
function skirtHazards(state: Int32Array, player: number, parts: readonly Part[], input: ArcadeInput): ArcadeInput {
  const heading = DIRECTIONS[directionOfAxis(input.axis)];
  if (heading === undefined) return input;
  const p = bodyBase(player);
  for (const part of parts) {
    if (part.kind !== 'hazard' || !alive(state, part.body)) continue;
    const q = bodyBase(part.body), hx = state[q + BODY.x]! - state[p + BODY.x]!, hz = state[q + BODY.z]! - state[p + BODY.z]!;
    if (distance(hx, hz) >= HAZARD_SKIRT || hx * heading.dx + hz * heading.dz <= 0) continue;
    return { ...input, axis: -hz * heading.dx + hx * heading.dz >= 0 ? arenaAxis(-hz, hx) : arenaAxis(hz, -hx) };
  }
  return input;
}

export function makeAssemblyBot(bots: Readonly<Record<string, BotPiece>>): BotPiece<z.infer<typeof wrappedSchema>> {
  return { id: 'assembly_bot', params: wrappedSchema, roles: ['player', 'thing'], reactionTicks: 8, cost: () => ({ bodies: 0, rules: 0 }),
    decide(observation, params) {
      const native = bots[params.base.id]!;
      let input = native.decide(observation, paramsOf(native, params.base));
      const { state, player } = observation, p = bodyBase(player);
      // Aréna s průběhem (P51 T5, `genre.v5`): bez průběhu robot jede jako dřív.
      const paced = params.control === 'move_free' && params.base.id === 'pacing_bot';
      const ballPosition = { x: state[p + BODY.x]!, z: state[p + BODY.z]! };
      if (params.control === 'ball') for (const recent of observation.recent) {
        ballPosition.x += ((recent.buttons & BUTTON.RIGHT ? 1 : 0) - (recent.buttons & BUTTON.LEFT ? 1 : 0)) * 150;
        ballPosition.z += ((recent.buttons & BUTTON.UP ? 1 : 0) - (recent.buttons & BUTTON.DOWN ? 1 : 0)) * 150;
      }
      const pursuer = params.parts.find(part => part.kind === 'chaser' && alive(state, part.body) && phaseReady(state, part, params.parts)
        && distance(state[bodyBase(part.body) + BODY.x]! - state[p + BODY.x]!, state[bodyBase(part.body) + BODY.z]! - state[p + BODY.z]!) < 4500);
      if (pursuer) {
        const q = bodyBase(pursuer.body), dx = state[q + BODY.x]! - state[p + BODY.x]!, dz = state[q + BODY.z]! - state[p + BODY.z]!;
        if (params.control === 'ball') return { ...input, buttons: input.buttons | (dx > 0 ? BUTTON.LEFT : BUTTON.RIGHT) };
        if (params.control === 'runner' && Math.abs(dx) < 1400 && dz > -1200) return { ...input, buttons: input.buttons | (dx > 0 ? BUTTON.LEFT : BUTTON.RIGHT) };
        if (params.control === 'flap' && dz > -1200 && Math.abs(state[q + BODY.y]! - state[p + BODY.y]!) < 1800) return { ...input, buttons: input.buttons | BUTTON.TAP };
      }
      const target = params.parts.find(part => required(part) && !done(state, part) && phaseReady(state, part, params.parts));
      if (!target) {
        if (params.control === 'ball') {
          const dx = -ballPosition.x, dz = -ballPosition.z;
          if (Math.abs(dx) > 150 || Math.abs(dz) > 150) return { axis: 0, buttons: (Math.abs(dx) > 150 ? dx > 0 ? BUTTON.RIGHT : BUTTON.LEFT : 0) | (Math.abs(dz) > 150 ? dz > 0 ? BUTTON.UP : BUTTON.DOWN : 0) };
        }
        return paced ? skirtHazards(state, player, params.parts, input) : input;
      }
      const b = bodyBase(target.body), held = state[HEADER.held] === target.body + 1;
      const destination = held || target.kind === 'rival';
      const x = destination ? target.goalX : state[b + BODY.x]!, z = destination ? target.goalZ : state[b + BODY.z]!;
      const dx = x - state[p + BODY.x]!, dz = z - state[p + BODY.z]!;
      if (params.control === 'move_free') input = { ...input, axis: arenaAxis(dx, dz) };
      if (params.control === 'walker' && params.maze) {
        let px = state[p + BODY.x]!, pz = state[p + BODY.z]!;
        for (const recent of observation.recent) { const velocity = walkerVelocity(recent, 110); px += velocity.vx; pz += velocity.vz; }
        const waypoint = walkerWaypoint(params.maze, px, pz, walkerCell(params.maze, x, z));
        if (waypoint) {
          const mx = waypoint.x - px, mz = waypoint.z - pz;
          input = Math.abs(mx) > 80 ? { axis: Math.round(Math.max(-1, Math.min(1, mx / 110)) * AXIS_MAX), buttons: 0 }
            : { axis: 0, buttons: Math.abs(mz) > 80 ? mz > 0 ? BUTTON.UP : BUTTON.DOWN : 0 };
        }
      }
      if (params.control === 'ball') {
        const bx = x - ballPosition.x, bz = z - ballPosition.z;
        input = { axis: 0, buttons: (Math.abs(bx) > 300 ? bx > 0 ? BUTTON.RIGHT : BUTTON.LEFT : 0) | (Math.abs(bz) > 300 ? bz > 0 ? BUTTON.UP : BUTTON.DOWN : 0) };
      }
      // Cargo sits on the authored flight route. Keep the native pilot through
      // its narrow gates; aiming at the cargo's bottom raises the player above
      // the safe opening, even though normal route contact can pick it up.
      if (params.control === 'glide' && ['catch', 'duel', 'fight'].includes(target.kind) && dz > -1000 && dz < 5000) {
        const vx = state[p + BODY.vx]!, vy = state[p + BODY.vy]!;
        const predictedDx = dx + (state[b + BODY.vx]! - vx) * observation.recent.length;
        const dy = (held ? target.goalY : state[b + BODY.y]!) - state[p + BODY.y]! + (held ? -vy : state[b + BODY.vy]! - vy) * observation.recent.length;
        const stop = Math.sign(vy) * vy * vy / (2 * GLIDE.drag);
        input = { axis: Math.round(Math.max(-AXIS_MAX, Math.min(AXIS_MAX, (predictedDx / 8 - vx / 2) * AXIS_MAX / GLIDE.lateral))),
          buttons: (dy - stop > 90 ? BUTTON.UP : dy - stop < -90 ? BUTTON.DOWN : 0) | (target.kind !== 'catch' && !held && dz < 1200 && !close(state, player, target.body, 300) ? BUTTON.HOLD : 0) };
      }
      if (params.control === 'runner' && dz > 0 && dz < 4500) {
        let danger = false;
        for (let i = 0; i < state[HEADER.bodyCount]!; i++) {
          const q = bodyBase(i), ahead = state[q + BODY.z]! - state[p + BODY.z]!;
          // Stavba trati ze vzorů (P46D T2) je dlouhá desítky metrů: blízko je její kraj, ne střed; strop tunelu nad hlavou nehrozí.
          const long = state[q + BODY.d]! >= RUNNER_STRUCTURE_D;
          if (long && state[q + BODY.y]! >= RUNNER.runH) continue;
          const reach = long ? state[q + BODY.d]! / 2 : 0;
          if (state[q + BODY.role] === ROLE.obstacle && alive(state, i) && ahead + reach > -800 && ahead - reach < 3000) danger = true;
        }
        if (!danger && Math.abs(dx) > 600) input = { ...input, buttons: (input.buttons & ~(BUTTON.LEFT | BUTTON.RIGHT)) | (dx > 0 ? BUTTON.RIGHT : BUTTON.LEFT) };
      }
      if ((target.kind === 'fight' || target.kind === 'duel') && close(state, player, target.body, 1800) && (state[HEADER.tick]! + observation.recent.length) % 20 === 0) input = { ...input, buttons: input.buttons | BUTTON.ATTACK };
      if (target.kind === 'interact' || target.kind === 'deliver') input = { ...input, buttons: input.buttons | BUTTON.INTERACT };
      return paced ? skirtHazards(state, player, params.parts, input) : input;
    } };
}

/** Střed volné mezery trati běžce, ve které `z` leží; uvnitř překážky střed mezery za ní. */
function runnerGapZ(bodies: readonly BodyInit[], z: number, length: number): number {
  let from = 0;
  for (const body of bodies.filter(b => b.role === 'obstacle').sort((a, b) => a.z - a.d / 2 - (b.z - b.d / 2))) {
    const near = body.z - body.d / 2;
    if (near > z) return Math.round((from + near) / 2);
    from = Math.max(from, body.z + body.d / 2);
  }
  return Math.round((from + length) / 2);
}

/** Compilation is deterministic and leaves games without parts byte-for-byte alone. */
export function assemblyParts(parts: ArcadeParts, spec: GameSpecV1, ruleLibrary: Readonly<Record<string, RulePiece>>): ArcadeParts {
  if (!spec.assemblyParts?.length) return parts;
  const base = baseControlOf(parts.control), player = parts.level.bodies[0]!;
  const length = parts.level.length;
  const control = base.id;
  const course = courseSchema.safeParse(base.params.course);
  const explicitPath = z.array(pointSchema).safeParse(base.params.path);
  const mazeResult = control === 'walker' ? walkerMapSchema.safeParse({ size: base.params.size, open: base.params.open }) : null;
  const maze = mazeResult?.success ? mazeResult.data : undefined;
  const exit = parts.level.bodies.find(body => body.role === 'goal');
  const mazeRoute = maze && exit ? walkerPath(maze, walkerCell(maze, player.x, player.z), walkerCell(maze, exit.x, exit.z)) : [];
  const flapPath = control === 'flap' ? parts.level.bodies.filter(body => body.role === 'collectible' && body.kind === 'gate').map(body => ({ x: body.x, y: Math.round(body.y + body.h / 2 - 600), z: body.z })) : [];
  // Úroveň skákačky ze vzorů (P46D T5) stoupá po schodech: kořist a soupeř jdou po vršcích desek, ne ve výšce startu,
  // kde je hráč na koruně přeběhne nad hlavou. Uložené hry bez `chunks` staví tentýž svět.
  const chunked = control === 'platform' && (spec.controlParams as { tuning?: { chunks?: number } } | undefined)?.tuning?.chunks === 1;
  const slabPath = chunked ? parts.level.bodies.filter(body => body.role === 'platform' && body.solid && !body.kinematic).sort((a, b) => a.z - b.z)
    .flatMap(body => [-1, 1].map(side => ({ x: Math.round(body.x), y: Math.round(body.y + body.h), z: Math.round(body.z + side * body.d / 2) }))) : [];
  const path = explicitPath.success ? explicitPath.data : flapPath.length ? [{ x: player.x, y: player.y, z: player.z }, ...flapPath] : slabPath.length ? slabPath : Array.from({ length: 21 }, (_, i) => {
    const z = Math.round(length * i / 20);
    return { x: course.success ? centerAt(course.data, z) : player.x, y: player.y, z };
  });
  // Jen nová trať běžce: uložené hry bez `patterns` staví tentýž svět.
  const patterned = control === 'runner' && (spec.controlParams as { patterns?: number } | undefined)?.patterns === 1;
  const speed = control === 'runner' ? 60 : control === 'platform' ? 45 : control === 'flap' ? 35 : control === 'glide' ? 65 : control === 'steer' ? 100 : 45;
  const bodies: BodyInit[] = [...parts.level.bodies];
  const runtime: Part[] = spec.assemblyParts.map((part, i) => {
    let z = part.kind === 'rival' ? player.z : part.kind === 'chaser' ? player.z + (['runner', 'flap', 'platform'].includes(control) ? 8000 : -4000) : Math.max(player.z + 2400, Math.round(length * (0.12 + 0.035 * i + part.phase * 0.35)));
    if (control === 'glide' && part.kind === 'hazard') z = Math.round((player.z + path[0]!.z) / 2);
    // Trať ze vzorů (P46D T2) má stavby přes desítky metrů: věc jde doprostřed volné mezery, ne do zdi ani těsně za řadu.
    if (patterned && part.kind !== 'rival' && part.kind !== 'chaser') z = runnerGapZ(parts.level.bodies, z, length);
    let point = pointAt(path, z);
    if (maze && mazeRoute.length) {
      const cell = mazeRoute[Math.min(mazeRoute.length - 1, Math.max(2, Math.round(mazeRoute.length * (0.12 + i * 0.06))))]!;
      z = Math.floor(cell / maze.size) * WALKER_CELL;
      point = { x: cell % maze.size * WALKER_CELL, y: player.y };
    }
    if (control === 'platform' && ['hazard', 'duel', 'fight', 'deliver', 'interact'].includes(part.kind)) {
      const support = parts.level.bodies.filter(body => body.role === 'platform' && body.solid && !body.kinematic && body.d > 2400 && body.z > 2000)
        .sort((a, b) => Math.abs(a.z - z) - Math.abs(b.z - z))[0];
      if (support) { z = Math.round(support.z); point = { x: Math.round(support.x), y: Math.round(support.y + support.h) }; }
    }
    const y = point.y + (part.kind === 'hazard' && part.motion === 'fall' ? 7000 : 0);
    const hazardOffset = control === 'runner' ? 2000 : ['platform', 'walker', 'flap', 'steer'].includes(control) ? 0 : 1400;
    const x = point.x + (part.kind === 'hazard' ? hazardOffset : part.kind === 'rival' && !maze ? 2000 : 0);
    const body = bodies.length;
    bodies.push({ role: 'thing', roleCode: 128 + i, kind: `thing:${part.role}`, x, y, z, w: 1000, h: 1300, d: 1000, solid: false,
      kinematic: !['deliver', 'interact'].includes(part.kind), ...(part.kind === 'duel' || part.kind === 'fight' ? { hp: part.kind === 'duel' ? 3 : 2 } : {}) });
    const carrying = part.kind === 'deliver' || part.kind === 'interact';
    const goalZ = exit && (maze || carrying) ? exit.z : part.kind === 'escape' || part.kind === 'rival' ? length || player.z + 6000 : length > 0 ? Math.min(length - 1200, z + 6000) : player.z - 2400;
    // A flight finish spans the whole corridor; its body's x=0 is not the
    // authored exit lane. Deliver to the path endpoint inside that finish.
    const goal = control === 'glide' && carrying ? pointAt(path, goalZ) : exit && (maze || carrying) ? exit : pointAt(path, goalZ);
    if ((carrying || part.kind === 'rival') && !exit) bodies.push({ role: 'thing', roleCode: 180 + i, kind: 'checkpoint', x: goal.x, y: goal.y, z: goalZ, w: 1800, h: 200, d: 1800, solid: false });
    return { ...part, body, startX: x, startY: y, startZ: z, goalX: goal.x, goalY: goal.y, goalZ, speed: part.kind === 'hazard' ? 120 : part.kind === 'rival' ? Math.max(speed, Math.ceil(length / 4500)) : speed };
  });
  const keeper = bodies.length;
  bodies.push({ role: 'thing', roleCode: 150, kind: 'assembly-state', x: 0, y: -10000, z: 0, w: 1, h: 1, d: 1, solid: false });
  const strike = abilityButton(abilityIdsOf(parts.control), 'strike');
  const shared: Shared = { parts: runtime, keeper, length, control, path, ...(maze ? { maze } : {}), ...(strike === 0 ? {} : { strike }) };
  // Dash a štít (P47B T4) chrání i před díly, které zraní; hra bez akcí projde beze změny.
  return guardParts({ ...parts, level: { ...parts.level, bodies },
    control: { id: 'assembly_control', params: { ...shared, base: parts.control } },
    bot: { id: 'assembly_bot', params: { ...shared, base: parts.bot } },
    rules: [
      ...parts.rules.map(ref => gateRule(ref.id === 'time_limit' ? { ...ref, params: { ...ref.params, seconds: Math.max(35, Number(ref.params.seconds)) } } : ref, shared, ruleLibrary)),
      ...runtime.map(part => ({ id: 'assembly_part', params: { ...shared, part } })),
      { id: 'assembly_finish', params: shared },
    ],
  });
}
