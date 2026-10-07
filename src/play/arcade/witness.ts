import { baseControlOf } from './addons';
/** P41: důkazy měřené při hraní, nikdy odvozené jen z názvu slovesa či výhry. */
import { singular } from '@/play/draft/lexicon';
import type { IntentTriple } from '@/play/intent/contract';
import type { GameRole, GameSpecV1 } from '@/play/spec';

import { type ArcadeEffect, type ArcadeInput, type ArcadeObservation, type ArcadeState, type ArcadeWorld, AXIS_MAX, BODY, BUTTON, COUNTER, FLAG, HEADER, NO_INPUT, ROLE, RUN_STATE, UNIT, bodyBase, bodyHp } from './contract';
import type { ArcadeLibrary, ArcadeOutcome } from './kernel';
import { axisOfDirection, directionToward, graceLeft } from './pieces/arena';
import { ballKeeperProbeInput } from './pieces/ball-probe';
import { walkerVisible, type WalkerMap } from './pieces/walker';
import { ballLaunchEvidence, ballScoreEvidence, ballPinImpact, keeperBlockEvidence, type BallLaunchEvidence } from './ball-evidence';
import { pinFallen } from './pieces/ball';
import { TIMING_SLOTS } from './pieces/timing';

export interface RoleBinding {
  readonly body: number;
  readonly roleId: string;
  readonly label: string;
  readonly roleKind: GameRole['kind'];
  readonly player: boolean;
}

export interface ActionWitness {
  readonly actor: RoleBinding;
  readonly verb: string;
  readonly object: RoleBinding | null;
  readonly tick: number;
  readonly run: 'winner' | 'probe';
  /** Konkrétní běh (sondy mají vlastní id); výsledek běhu sám není důkaz akce. */
  readonly runId: string;
  readonly evidence: string;
}

const roleAt = (state: ArrayLike<number>, body: number): number => state[bodyBase(body) + BODY.role]!;
const live = (state: ArrayLike<number>, body: number): boolean => (state[bodyBase(body) + BODY.flags]! & FLAG.alive) !== 0;
const kindAt = (world: ArcadeWorld, state: ArrayLike<number>, body: number): string => world.kinds[state[bodyBase(body) + BODY.kind]!] ?? '';

/** Bez hádání mezi více kandidáty. Neobsazené tělo nemůže dokazovat jméno z věty. */
export function bindRoles(spec: GameSpecV1, world: ArcadeWorld): readonly RoleBinding[] {
  const out: RoleBinding[] = [];
  const unique = (roles: readonly GameRole[]): GameRole | undefined => roles.length === 1 ? roles[0] : undefined;
  for (let body = 0; body < world.initial[HEADER.bodyCount]!; body += 1) {
    const code = roleAt(world.initial, body);
    const kind = kindAt(world, world.initial, body);
    const player = body === world.initial[HEADER.player];
    const named = kind.startsWith('thing:') ? kind.slice(6) : kind === 'rival-car' || kind === 'foe' ? 'rival' : kind === 'tire-barrier' ? 'barrier' : kind;
    let role = player ? unique(spec.roles.filter(r => r.kind === 'player')) : spec.roles.find(r => r.id === named && r.kind !== 'player');
    // Native body kinds are kebab-case; stored role IDs are schema-safe names.
    if (role === undefined && /^(?:glide-|physics-ball$)/.test(kind)) role = spec.roles.find(r => r.id === kind.replaceAll('-', '_') && r.kind !== 'player');
    if (role === undefined && !kind.startsWith('thing:')) {
      const kinds = code === ROLE.collectible ? ['collectible'] : code === ROLE.goal ? ['exit', 'destination'] : code === ROLE.chaser ? ['chaser'] : code === ROLE.target ? ['target'] : code === ROLE.enemy ? ['patrol', 'hazard'] : code === ROLE.obstacle || code === ROLE.hazard ? ['hazard'] : code === ROLE.checkpoint ? ['checkpoint'] : [];
      role = unique(spec.roles.filter(r => kinds.includes(r.kind)));
    }
    if (role !== undefined) out.push({ body, roleId: role.id, label: role.label, roleKind: role.kind, player });
  }
  return out;
}

/** Stejná normalizace hlavy podstatného jména jako extraktor záměru. */
const noun = (label: string): string => singular(label.toLowerCase().trim()).split(' ').at(-1) ?? label;
const names = (name: string, binding: RoleBinding): boolean => name === 'hero' ? binding.player : noun(name) === noun(binding.label) ||
  // Generic ball denotes the actual bound sports ammunition, never an arbitrary
  // target/actor renamed basketball. Specific ball identities remain distinct.
  noun(name) === 'ball' && binding.roleKind === 'item' && ['ball', 'physics_ball'].includes(binding.roleId) &&
  /^(?:basketball|football|soccer ball|golf ball)$/.test(binding.label.toLowerCase());
export function matchesWitness(triple: IntentTriple, witness: ActionWitness): boolean {
  // Zachycení v sondě nesmí potvrdit cíl catch/escape/survive.
  if (witness.run === 'probe' && !['chaser', 'guard', 'hazard', 'obstacle', 'rival'].includes(triple.verb)) return false;
  return triple.verb === witness.verb && names(triple.actor, witness.actor) && (triple.object === null || (witness.object !== null && names(triple.object, witness.object)));
}

/** Sonda mění jen vstup hráče; svět, rychlosti i pravidla zůstávají stejné. */
export function threatProbeInput(world: ArcadeWorld, target: number, observation: ArcadeObservation, normal: ArcadeInput): ArcadeInput {
  const { state, player } = observation;
  const baseControl = baseControlOf(world.control);
  const control = baseControl.id;
  // Nestoupnout na spící předlohu: sonda má změřit pohyb i chycení hlídkou po probuzení.
  if (baseControl.params.chase !== undefined && graceLeft(state) > 0) return normal;
  const p = bodyBase(player);
  if (!live(state, target)) {
    const code = roleAt(world.initial, target);
    const kind = kindAt(world, world.initial, target);
    let nearest = -1;
    let distance = Number.POSITIVE_INFINITY;
    for (let body = 0; body < state[HEADER.bodyCount]!; body += 1) {
      if (!live(state, body) || roleAt(state, body) !== code || kindAt(world, state, body) !== kind) continue;
      const base = bodyBase(body);
      const squared = (state[base + BODY.x]! - state[p + BODY.x]!) ** 2 + (state[base + BODY.z]! - state[p + BODY.z]!) ** 2;
      if (squared < distance) { nearest = body; distance = squared; }
    }
    if (nearest < 0) return normal;
    target = nearest;
  }
  const t = bodyBase(target);
  const dx = state[t + BODY.x]! - state[p + BODY.x]!;
  const dz = state[t + BODY.z]! - state[p + BODY.z]!;
  if (control === 'move_free' || control === 'fight') return { buttons: 0, axis: axisOfDirection(directionToward(dx, dz)) };
  if (control === 'steer' && roleAt(state, target) === ROLE.chaser) return { buttons: BUTTON.DOWN, axis: 0 };
  if (control === 'glide' && roleAt(state, target) === ROLE.chaser) return { buttons: BUTTON.HOLD, axis: 0 };
  if (control === 'glide' && roleAt(state, target) === ROLE.enemy) return { ...normal, buttons: normal.buttons | BUTTON.HOLD };
  if (control === 'ball' && roleAt(state, target) === ROLE.enemy) return ballKeeperProbeInput(world, state, target, observation.recent);
  if (control === 'steer' && roleAt(state, target) === ROLE.enemy && world.rules.some(rule => rule.id === 'rival_finish' && !('land' in rule.params))) {
    // Brake at the safe start: coasting into a wall would only prove a crash.
    // The opponent must still traverse the real course and finish first.
    return { buttons: BUTTON.DOWN, axis: 0 };
  }
  if (control === 'platform' && roleAt(state, target) === ROLE.hazard) {
    // Traverse prior gaps with the native bot. Once grounded on the target's
    // actual supporting slab, walk into it rather than jumping over it.
    // Coordinates are read-only; the normal collision rule must cause harm.
    if ((state[p + BODY.flags]! & FLAG.grounded) !== 0) {
      const py = state[p + BODY.y]!, pz = state[p + BODY.z]!;
      for (let body = 0; body < state[HEADER.bodyCount]!; body++) {
        const slab = bodyBase(body);
        if (!live(state, body) || roleAt(state, body) !== ROLE.platform) continue;
        const top = state[slab + BODY.y]! + state[slab + BODY.h]!;
        const near = state[slab + BODY.z]! - state[slab + BODY.d]! / 2;
        const far = state[slab + BODY.z]! + state[slab + BODY.d]! / 2;
        if (py === top && state[t + BODY.y] === top && pz >= near && pz <= far && state[t + BODY.z]! - state[t + BODY.d]! / 2 >= near && state[t + BODY.z]! + state[t + BODY.d]! / 2 <= far) {
          return { buttons: 0, axis: dz < 0 ? -AXIS_MAX : AXIS_MAX };
        }
      }
    }
    return normal;
  }

  if (control === 'flap' && roleAt(state, target) === ROLE.obstacle) {
    // Reach the pipe with the ordinary bot first. Idle from spawn hits the
    // floor before any pipe and cannot establish that the pipe is harmful.
    if (dz > 8 * UNIT || dz < -state[t + BODY.d]!) return normal;
    const targetY = Math.max(600, state[t + BODY.y]! + state[t + BODY.h]! / 2 - state[p + BODY.h]! / 2);
    return { buttons: state[p + BODY.y]! + state[p + BODY.vy]! * 4 < targetY ? BUTTON.TAP : 0, axis: 0 };
  }

  if (control === 'runner') {
    // Po zbytek trati normální robot; u cílové hrozby záměrně neuhne ani neskočí.
    // Settle a jump from the preceding obstacle before the encounter. Starting
    // only 12 m away can leave the probe airborne over an otherwise lethal chaser.
    if (Math.abs(dz) > 24 * UNIT) return normal;
    if (roleAt(state, target) === ROLE.chaser) return NO_INPUT;
    return { buttons: Math.abs(dx) < UNIT / 2 ? 0 : dx > 0 ? BUTTON.RIGHT : BUTTON.LEFT, axis: 0 };
  }
  return NO_INPUT;
}

type Origin = { readonly other: number; readonly source: number; readonly held: number; readonly ballBefore?: ArcadeState; readonly ballEffects?: readonly ArcadeEffect[] };

/** Pozorovatel pravidel: kopie efektů nesou kontext kontaktu, jádro stále rozhoduje, co se skutečně provedlo. */
export class WitnessRecorder {
  private readonly world: ArcadeWorld;
  private readonly run: 'winner' | 'probe';
  private readonly runId: string;
  private readonly origins = new WeakMap<ArcadeEffect, Origin>();
  private readonly found = new Map<string, ActionWitness>();
  private readonly bindings: ReadonlyMap<number, RoleBinding>;
  private readonly control: string;
  private readonly moved = new Set<string>();
  private readonly positions = new Map<number, { roleId: string; x: number; y: number; z: number }>();
  private readonly hurt = new Set<string>();
  private readonly start: readonly number[];
  private readonly thrown: { body: number; x: number; y: number; z: number; tick: number }[] = [];
  private readonly pendingLosses: { body: number; evidence: string }[] = [];
  private readonly ballLaunches = new Map<number, BallLaunchEvidence>();
  private readonly struckPins = new Set<number>();

  constructor(world: ArcadeWorld, bindings: readonly RoleBinding[], run: 'winner' | 'probe', runId: string) {
    this.world = world;
    this.run = run;
    this.runId = runId;
    this.bindings = new Map(bindings.map(b => [b.body, b]));
    this.control = baseControlOf(world.control).id;
    this.start = world.initial;
    for (const binding of bindings) {
      const base = bodyBase(binding.body);
      this.positions.set(binding.body, { roleId: binding.roleId, x: this.start[base + BODY.x]!, y: this.start[base + BODY.y]!, z: this.start[base + BODY.z]! });
    }
  }

  observe(library: ArcadeLibrary): ArcadeLibrary {
    return { ...library, rules: Object.fromEntries(Object.entries(library.rules).map(([id, piece]) => [id, {
      ...piece,
      fire: (ctx: Parameters<typeof piece.fire>[0], params: unknown) => {
        const ballBefore = id === 'ball_launch' || id === 'ball_score' || id === 'launch' ? ctx.state.slice() : undefined;
        const effects = piece.fire(ctx, params);
        return effects.map(effect => {
          const copy = { ...effect };
          this.origins.set(copy, { other: ctx.other, source: ctx.source, held: ctx.state[HEADER.held]! - 1,
            ...(ballBefore === undefined ? {} : { ballBefore, ballEffects: effects }) });
          return copy;
        });
      },
    }])) };
  }

  private binding(body: number, state: ArcadeState): RoleBinding | undefined {
    if (body < 0 || body >= state[HEADER.bodyCount]!) return undefined;
    const code = roleAt(state, body);
    const kind = kindAt(this.world, state, body);
    const direct = this.bindings.get(body);
    if (direct !== undefined && code === roleAt(this.start, body) && kind === kindAt(this.world, this.start, body)) return direct;
    // Nová kopie předlohy: totožnost jen když všechny shodné předlohy patří téže roli.
    const candidates = [...this.bindings.values()].filter(b => roleAt(this.start, b.body) === code && kindAt(this.world, this.start, b.body) === kind);
    if (candidates.length === 0 || candidates.some(b => b.roleId !== candidates[0]!.roleId)) return undefined;
    return { ...candidates[0]!, body };
  }

  private add(verb: string, actor: number, object: number | null, tick: number, evidence: string, state: ArcadeState): void {
    const who = this.binding(actor, state);
    const what = object === null ? null : this.binding(object, state);
    if (who === undefined || what === undefined) return;
    const key = `${verb}:${who.roleId}:${what?.roleId ?? ''}:${evidence}`;
    if (!this.found.has(key)) this.found.set(key, { actor: who, verb, object: what, tick, evidence, run: this.run, runId: this.runId });
  }

  effect(rule: number, effect: ArcadeEffect, state: ArcadeState, tick: number): void {
    const ref = this.world.rules[rule];
    const origin = this.origins.get(effect);
    if (ref === undefined || origin === undefined) return;
    const player = state[HEADER.player]!;
    if (ref.id === 'ball_knockdown' && effect.kind === 'despawn' && this.struckPins.has(effect.body) && pinFallen(state, effect.body)) {
      this.add('ball', player, null, tick, 'physical-ball-knockdown', state);
      this.add('defeat', player, effect.body, tick, 'physical-pin-knocked-down', state);
    }
    if (origin.ballBefore !== undefined && origin.ballEffects !== undefined) {
      const observation = { world: this.world, rule, before: origin.ballBefore, after: state, effects: origin.ballEffects };
      for (const launch of ballLaunchEvidence(observation)) {
        this.ballLaunches.set(launch.ball, launch);
        // A hoop shot launches a real sphere upward. Require its subsequent
        // travel before certifying throw; score or the word basketball is insufficient.
        if (ref.params.goal === 'hoop' && launch.velocity.y > 0 && !this.thrown.some(item => item.body === launch.ball)) this.thrown.push({ body: launch.ball, ...launch.from, tick });
      }
      if (ref.id === 'launch' && effect.kind === 'spawn' && effect.template === ref.params.template &&
          kindAt(this.world, origin.ballBefore, effect.template) === 'ball' && roleAt(origin.ballBefore, effect.template) === ROLE.projectile &&
          state[HEADER.counters + COUNTER.ammo]! < origin.ballBefore[HEADER.counters + COUNTER.ammo]! && effect.vy > 0 && effect.vz !== 0) {
        for (let body = 0; body < state[HEADER.bodyCount]!; body++) {
          const b = bodyBase(body);
          if (!live(origin.ballBefore, body) && live(state, body) && roleAt(state, body) === ROLE.projectile &&
              kindAt(this.world, state, body) === 'ball' && state[b + BODY.x] === effect.x && state[b + BODY.y] === effect.y && state[b + BODY.z] === effect.z &&
              state[b + BODY.vx] === effect.vx && state[b + BODY.vy] === effect.vy && state[b + BODY.vz] === effect.vz) this.thrown.push({ body, x: effect.x, y: effect.y, z: effect.z, tick });
        }
      }
      for (const scored of ballScoreEvidence(observation, [...this.ballLaunches.values()])) {
        this.add('ball', player, null, tick, 'physical-ball-scored', state);
        this.add('score', player, scored.target, tick, 'physical-ball-in-goal', state);
      }
    }
    if (ref.id === 'objective_order' && effect.kind === 'stateChange' && effect.state === 1) {
      const node = (ref.params.nodes as { body: number; action: string }[]).find(node => node.body === effect.body);
      if (node?.action === 'collect') this.add('collect', player, effect.body, tick, 'ordered-pickup', state);
      if (node?.action === 'open') { this.add('interact', player, effect.body, tick, 'ordered-gate-opened', state); this.add('open', player, effect.body, tick, 'ordered-gate-opened', state); }
      if (node?.action === 'reach') this.add('reach', player, effect.body, tick, 'ordered-goal-contact', state);
    }
    const other = origin.other;
    const code = other < 0 ? -1 : roleAt(state, other);
    if (effect.kind === 'despawn' && effect.body === other) {
      if ((ref.id === 'shot_hit' || ref.id === 'glide_shot_hit' || ref.id === 'rule_hit') && origin.source >= 0) {
        const projectile = kindAt(this.world, state, origin.source);
        if (projectile === 'bullet' || projectile === 'ball') {
          this.add(projectile === 'bullet' ? 'shoot' : 'throw', player, other, tick, 'projectile-hit', state);
          this.add('defeat', player, other, tick, 'target-destroyed', state);
        }
      }
      if ((ref.id === 'pickup' || ref.id === 'arena_eat' || ref.id === 'rule_contact') && (code === ROLE.collectible || this.binding(other, state)?.roleKind === 'collectible')) this.add('collect', player, other, tick, 'pickup', state);
      if (ref.id === 'arena_catch_contact' && code === ROLE.enemy && this.binding(other, state) !== undefined && this.binding(player, state) !== undefined && this.hasMoved(this.binding(other, state)!, state) && this.hasMoved(this.binding(player, state)!, state)) this.add('catch', player, other, tick, 'moving-prey-contact', state);
      if (ref.id === 'arena_eat' && code === ROLE.enemy) this.add('catch', player, other, tick, 'contact-consumed', state);
    }
    if (effect.kind === 'despawn' && effect.body === origin.held && other >= 0 && other !== origin.held && ref.id === 'rule_contact') this.add('deliver', player, origin.held, tick, 'carried-to-destination', state);
    if (effect.kind === 'hit' && effect.amount > 0) {
      if (effect.by === player) {
        this.add('fight', player, effect.body, tick, 'hit-points', state);
        if (bodyHp(state, effect.body) === 0) this.add('defeat', player, effect.body, tick, 'target-knocked-out', state);
      } else if (effect.body === player) this.harm(effect.by, player, tick, 'hit-points', state);
    }
    // Reset cíle mezi vlnami není hráčova interakce.
    if (effect.kind === 'stateChange' && ref.id === 'interact') this.add('interact', player, effect.body, tick, 'target-state', state);
    if (effect.kind === 'grab' && state[HEADER.held] === effect.body + 1) this.add('collect', player, effect.body, tick, 'grabbed', state);
    if (effect.kind === 'throwHeld' && origin.held >= 0) {
      const base = bodyBase(origin.held);
      this.thrown.push({ body: origin.held, x: state[base + BODY.x]!, y: state[base + BODY.y]!, z: state[base + BODY.z]!, tick });
    }
    if (effect.kind === 'toggle') {
      for (const b of this.bindings.values()) if (roleAt(state, b.body) === effect.role && (state[bodyBase(b.body) + BODY.flags]! & FLAG.switched) !== 0) this.add('interact', player, b.body, tick, 'toggled', state);
    }
    if (effect.kind === 'score' && effect.amount > 0) {
      this.add('score', player, null, tick, 'score-increased', state);
      if (ref.id === 'judge') {
        const verb = this.control === 'rhythm' ? 'beat' : this.control === 'duel' ? 'duel' : this.world.control.params.mode === 'stack' ? 'stack' : 'time';
        const target = [...this.bindings.values()].find(b => !b.player && (roleAt(state, b.body) === ROLE.enemy || roleAt(state, b.body) === ROLE.target));
        this.add(verb, player, target?.body ?? null, tick, 'successful-timing', state);
      }
    }
    if (effect.kind === 'win') {
      if ((ref.id === 'finish' || ref.id === 'finish_collected' || ref.id === 'rule_contact') && (code === ROLE.goal || ['exit', 'destination'].includes(this.binding(other, state)?.roleKind ?? ''))) this.add('reach', player, other, tick, 'finish-contact', state);
      if (ref.id === 'survive_time') this.add('survive', player, null, tick, 'survival-timer', state);
      if (ref.id === 'judge' && this.control === 'timing' && this.world.control.params.mode === 'stack' && [...this.found.values()].some(w => w.verb === 'stack')) this.add('build', player, null, tick, 'stack-completed', state);
      if (ref.id === 'rival_finish' && 'land' in ref.params) {
        const goal = [...this.bindings.values()].find(b => roleAt(state, b.body) === ROLE.goal);
        if (goal !== undefined) this.add('land', player, goal.body, tick, 'safe-landing', state);
      }
      if (origin.held >= 0 && other >= 0 && ref.id === 'rule_contact') this.add('deliver', player, origin.held, tick, 'carried-to-destination', state);
    }
    if (effect.kind === 'lose' || (effect.kind === 'damage' && effect.amount > 0)) {
      if (ref.id === 'walker_caught' && typeof ref.params.body === 'number') {
        const guard = ref.params.body;
        const binding = this.binding(guard, state);
        if (binding !== undefined && this.hasMoved(binding, state) && walkerVisible(state, player, guard, ref.params as unknown as WalkerMap, ref.params.range as number)) {
          this.hurt.add(binding.roleId);
          if (this.run === 'probe') this.add('guard', guard, player, tick, 'caught-in-patrol-sight', state);
        }
      }
      if (other >= 0) {
        if (effect.kind === 'lose') this.pendingLosses.push({ body: other, evidence: 'harmful-contact' });
        else this.harm(other, player, tick, 'harmful-contact', state);
      }
      if (ref.id === 'rival_finish' && typeof ref.params.atZ === 'number') {
        for (const b of this.bindings.values()) {
          const base = bodyBase(b.body);
          if (roleAt(state, b.body) === ROLE.enemy && live(state, b.body) && state[base + BODY.z]! + state[base + BODY.d]! / 2 >= ref.params.atZ) this.pendingLosses.push({ body: b.body, evidence: 'rival-finished-first' });
        }
      }
      if (ref.id === 'glide_finish' && typeof ref.params.rivalIndex === 'number' && typeof ref.params.atZ === 'number') {
        const rival = ref.params.rivalIndex;
        if (live(state, rival) && state[bodyBase(rival) + BODY.z]! >= ref.params.atZ) this.pendingLosses.push({ body: rival, evidence: 'rival-finished-first' });
      }
    }
  }

  private harm(body: number, player: number, tick: number, evidence: string, state: ArcadeState): void {
    const binding = this.binding(body, state);
    if (binding === undefined) return;
    const code = roleAt(state, body);
    const threat = code === ROLE.chaser ? 'chaser' : code === ROLE.obstacle ? 'obstacle' : code === ROLE.hazard || binding.roleKind === 'hazard' && code !== ROLE.enemy ? 'hazard' : code === ROLE.enemy ? 'rival' : null;
    this.hurt.add(binding.roleId);
    if (threat === null || this.run !== 'probe' || threat === 'chaser' && !this.hasMoved(binding, state)) return;
    this.add(threat, body, player, tick, evidence, state);
    // Native reef frames are authored hazards as well as passage obstacles.
    // This runs only after their own contact causes actual damage/loss; a
    // decorative frame or a renamed role without a hit rule proves nothing.
    if (this.control === 'glide' && code === ROLE.obstacle && binding.roleKind === 'hazard' &&
        kindAt(this.world, state, body) === 'glide-reef' && evidence === 'harmful-contact') this.add('hazard', body, player, tick, evidence, state);
    // A stationary platform spike is also a jumpable obstacle, but only after
    // this probe's real contact has caused harm. A label alone proves nothing.
    const spike = bodyBase(body);
    if (this.control === 'platform' && code === ROLE.hazard && kindAt(this.world, state, body) === 'spikes' &&
        (state[spike + BODY.flags]! & FLAG.kinematic) === 0 && state[spike + BODY.vx] === 0 && state[spike + BODY.vy] === 0 && state[spike + BODY.vz] === 0) this.add('obstacle', body, player, tick, evidence, state);
    // Hlídka arény používá skutečný dohled; pouhý popisek „guard“ nestačí.
    const control = baseControlOf(this.world.control);
    const sight = (control.params.chase as { patrol?: number } | undefined)?.patrol;
    const b = bodyBase(body);
    const p = bodyBase(player);
    if (threat === 'chaser' && sight !== undefined && (state[b + BODY.x]! - state[p + BODY.x]!) ** 2 + (state[b + BODY.z]! - state[p + BODY.z]!) ** 2 <= sight * sight) this.add('guard', body, player, tick, 'caught-in-sight', state);
  }

  private hasMoved(binding: RoleBinding, state: ArcadeState): boolean {
    const key = `${binding.roleId}:${binding.body}`;
    if (this.moved.has(key)) return true;
    const start = this.positions.get(binding.body);
    if (start === undefined || start.roleId !== binding.roleId) return false;
    const base = bodyBase(binding.body);
    return (state[base + BODY.x]! - start.x) ** 2 + (state[base + BODY.y]! - start.y) ** 2 + (state[base + BODY.z]! - start.z) ** 2 >= UNIT * UNIT;
  }

  afterTick(before: ArcadeState, state: ArcadeState, tick: number): void {
    const player = state[HEADER.player]!;
    if (this.control === 'timing' && baseControlOf(this.world.control).params.mode === 'stack' &&
        state[bodyBase(player) + BODY.z]! > before[bodyBase(player) + BODY.z]!) {
      // The control actually activates a placed block; bind that object, not
      // the abstract timing target or an arbitrary collectible role.
      for (let body = TIMING_SLOTS.marks; body < state[HEADER.bodyCount]!; body++) {
        const b = bodyBase(body);
        if (!live(before, body) && live(state, body) && roleAt(state, body) === ROLE.platform &&
            state[b + BODY.vx] === 0 && state[b + BODY.w]! > 0) this.add('stack', player, body, tick, 'block-placed', state);
      }
    }
    for (const launch of this.ballLaunches.values()) {
      for (const binding of this.bindings.values()) {
        if (this.world.rules.some(rule => rule.id === 'ball_knockdown') && ballPinImpact(before, state, launch, binding.body)) this.struckPins.add(binding.body);
        const blocked = keeperBlockEvidence(this.world, before, state, launch, binding.body, this.run);
        if (blocked !== null) this.add('rival', blocked.keeper, player, tick, 'keeper-deflected-physical-ball', state);
      }
      if (!live(state, launch.ball)) this.ballLaunches.delete(launch.ball);
    }
    if (state[HEADER.runState] === RUN_STATE.lost) for (const loss of this.pendingLosses) this.harm(loss.body, player, tick, loss.evidence, state);
    this.pendingLosses.length = 0;
    const p = bodyBase(player);
    for (let body = 0; body < state[HEADER.bodyCount]!; body += 1) {
      const binding = this.binding(body, state);
      if (binding === undefined) continue;
      const key = `${binding.roleId}:${body}`;
      if (!live(state, body)) {
        this.positions.delete(body);
        this.moved.delete(key);
        continue;
      }
      if (this.hasMoved(binding, state)) this.moved.add(key);
      if (this.positions.get(body)?.roleId !== binding.roleId) {
        const base = bodyBase(body);
        this.positions.set(body, { roleId: binding.roleId, x: state[base + BODY.x]!, y: state[base + BODY.y]!, z: state[base + BODY.z]! });
      }
    }
    if (this.run !== 'winner') return;
    for (let i = this.thrown.length - 1; i >= 0; i -= 1) {
      const motion = this.thrown[i]!;
      const base = bodyBase(motion.body);
      const active = tick - motion.tick <= 20 && live(state, motion.body) && state[HEADER.held] !== motion.body + 1;
      const moved = active && (state[base + BODY.x]! - motion.x) ** 2 + (state[base + BODY.y]! - motion.y) ** 2 + (state[base + BODY.z]! - motion.z) ** 2 >= UNIT * UNIT;
      if (moved) this.add('throw', player, motion.body, tick, 'thrown-body-moved', state);
      if (!active || moved) this.thrown.splice(i, 1);
    }
    if (this.control === 'runner' && (before[p + BODY.flags]! & FLAG.grounded) !== 0 &&
        (state[p + BODY.flags]! & FLAG.grounded) === 0 && state[p + BODY.y]! > before[p + BODY.y]! && state[p + BODY.vy]! > 0) this.add('jump', player, null, tick, 'runner-takeoff', state);
    const movement: Record<string, string> = { runner: 'run', platform: 'jump', flap: 'flap', steer: 'drive', move_free: 'roam', fight: 'roam', glide: 'glide', walker: 'walk' };
    // The legacy lander shares the steer control id, but actually flies under
    // gravity and thrust. Its airborne translation is not driving on a road.
    const verb = this.control === 'steer' && this.world.control.params.land !== undefined ? 'glide' : movement[this.control];
    const hero = this.binding(player, state);
    if (verb !== undefined && hero !== undefined && this.hasMoved(hero, state) && (verb !== 'jump' || (state[p + BODY.y]! > before[p + BODY.y]! && (state[p + BODY.flags]! & FLAG.grounded) === 0))) this.add(verb, player, null, tick, 'player-moved', state);
    if (this.control === 'steer' && this.world.rules.some(r => r.id === 'rival_finish' && !('land' in r.params)) || this.control === 'glide' && this.world.rules.some(r => r.id === 'glide_finish' && r.params.race === true)) {
      for (const b of this.bindings.values()) {
        if (roleAt(state, b.body) !== ROLE.enemy || !live(state, b.body)) continue;
        const z = bodyBase(b.body) + BODY.z;
        if (before[p + BODY.z]! <= before[z]! && state[p + BODY.z]! > state[z]! && state[z]! > this.start[z]!) this.add('race', player, b.body, tick, 'overtake', state);
      }
    }
  }

  finish(outcome: ArcadeOutcome): readonly ActionWitness[] {
    return this.run === 'winner' && outcome !== 'won' ? [] : [...this.found.values()];
  }

  /** Jen unikl živé, pohybující se hrozbě, která ho v tomhle běhu nezranila. */
  escaped(probes: readonly ActionWitness[], state: ArcadeState, tick: number): readonly ActionWitness[] {
    for (const threat of probes) {
      if (this.hurt.has(threat.actor.roleId)) continue;
      // Index v sondě není indexem ve vítězném běhu: vlny a spawn mají jiný průběh.
      for (let body = 0; body < state[HEADER.bodyCount]!; body += 1) {
        const own = this.binding(body, state);
        if (!live(state, body) || own?.roleId !== threat.actor.roleId) continue;
        if ((threat.verb === 'chaser' || threat.verb === 'guard') && this.hasMoved(own, state)) this.add('escape', state[HEADER.player]!, body, tick, `survived-threat:${threat.runId}`, state);
        this.add('survive', state[HEADER.player]!, body, tick, `survived-threat:${threat.runId}`, state);
      }
    }
    return this.finish('won');
  }
}
