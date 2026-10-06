/** P41: důkazy měřené při hraní, nikdy odvozené jen z názvu slovesa či výhry. */
import { singular } from '@/play/draft/lexicon';
import type { IntentTriple } from '@/play/intent/contract';
import type { GameRole, GameSpecV1 } from '@/play/spec';

import { type ArcadeEffect, type ArcadeInput, type ArcadeObservation, type ArcadeState, type ArcadeWorld, BODY, BUTTON, FLAG, HEADER, NO_INPUT, ROLE, RUN_STATE, UNIT, bodyBase, bodyHp } from './contract';
import type { ArcadeLibrary, ArcadeOutcome } from './kernel';
import { axisOfDirection, directionToward, graceLeft } from './pieces/arena';
import { ballKeeperProbeInput } from './pieces/ball-probe';
import { walkerVisible, type WalkerMap } from './pieces/walker';
import { ballLaunchEvidence, ballScoreEvidence, keeperBlockEvidence, type BallLaunchEvidence } from './ball-evidence';

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
const names = (name: string, binding: RoleBinding): boolean => name === 'hero' ? binding.player : noun(name) === noun(binding.label);
export function matchesWitness(triple: IntentTriple, witness: ActionWitness): boolean {
  // Zachycení v sondě nesmí potvrdit cíl catch/escape/survive.
  if (witness.run === 'probe' && !['chaser', 'guard', 'hazard', 'obstacle', 'rival'].includes(triple.verb)) return false;
  return triple.verb === witness.verb && names(triple.actor, witness.actor) && (triple.object === null || (witness.object !== null && names(triple.object, witness.object)));
}

/** Sonda mění jen vstup hráče; svět, rychlosti i pravidla zůstávají stejné. */
export function threatProbeInput(world: ArcadeWorld, target: number, observation: ArcadeObservation, normal: ArcadeInput): ArcadeInput {
  const { state, player } = observation;
  const baseControl = world.control.id === 'addon_control' ? world.control.params.base as ArcadeWorld['control'] : world.control;
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

  constructor(world: ArcadeWorld, bindings: readonly RoleBinding[], run: 'winner' | 'probe', runId: string) {
    this.world = world;
    this.run = run;
    this.runId = runId;
    this.bindings = new Map(bindings.map(b => [b.body, b]));
    this.control = world.control.id === 'addon_control' ? (world.control.params.base as { id: string }).id : world.control.id;
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
        const ballBefore = id === 'ball_launch' || id === 'ball_score' ? ctx.state.slice() : undefined;
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
    if (origin.ballBefore !== undefined && origin.ballEffects !== undefined) {
      const observation = { world: this.world, rule, before: origin.ballBefore, after: state, effects: origin.ballEffects };
      for (const launch of ballLaunchEvidence(observation)) this.ballLaunches.set(launch.ball, launch);
      for (const scored of ballScoreEvidence(observation, [...this.ballLaunches.values()])) {
        this.add('ball', player, null, tick, 'physical-ball-scored', state);
        this.add('score', player, scored.target, tick, 'physical-ball-in-goal', state);
      }
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
    // Hlídka arény používá skutečný dohled; pouhý popisek „guard“ nestačí.
    const control = this.world.control.id === 'addon_control' ? this.world.control.params.base as ArcadeWorld['control'] : this.world.control;
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
    for (const launch of this.ballLaunches.values()) {
      for (const binding of this.bindings.values()) {
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
    const movement: Record<string, string> = { runner: 'run', platform: 'jump', flap: 'flap', steer: 'drive', move_free: 'roam', fight: 'roam', glide: 'glide', walker: 'walk' };
    const verb = movement[this.control];
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
