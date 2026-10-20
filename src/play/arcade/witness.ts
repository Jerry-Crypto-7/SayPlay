import { baseControlOf, underlyingRule } from './addons';
/** P41: důkazy měřené při hraní, nikdy odvozené jen z názvu slovesa či výhry. */
import { singular } from '@/play/draft/lexicon';
import type { IntentTriple } from '@/play/intent/contract';
import type { GameRole, GameSpecV1 } from '@/play/spec';

import { type ArcadeEffect, type ArcadeInput, type ArcadeObservation, type ArcadeState, type ArcadeWorld, AXIS_MAX, BODY, BUTTON, COUNTER, FLAG, HEADER, NO_INPUT, ROLE, RUN_STATE, UNIT, bodyBase, bodyHp } from './contract';
import { axisOfLane, laneOfX } from './pieces/lanes';
import { CATCH } from './pieces/catch-fall';
import { WHACK, holeOpen } from './pieces/whack';
import { SLICE, heightAt } from './pieces/slice';
import { type HopBotParams, hopProbeInput } from './pieces/hop-bot';
import { crowdProbeInput } from './pieces/crowd-bot';
import { nearestRival } from './pieces/push-ring';
import type { ArcadeLibrary, ArcadeOutcome } from './kernel';
import { axisOfDirection, directionToward, graceLeft } from './pieces/arena';
import { ballKeeperProbeInput } from './pieces/ball-probe';
import { walkerVisible, walkerCell, walkerWaypoint, walkerVelocity, type WalkerMap } from './pieces/walker';
import { ballLaunchEvidence, ballScoreEvidence, ballPinImpact, keeperBlockEvidence, opponentBallEvidence, type BallLaunchEvidence } from './ball-evidence';
import type { PieceRef } from './contract';
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

// Sloty jednou za modul: import pod vitestem čte každý přístup getterem a svědek prochází všechna těla každý tik.
const FIRST_BODY = bodyBase(0);
const STRIDE = bodyBase(1) - FIRST_BODY;
const { role: ROLE_SLOT, flags: FLAGS_SLOT, kind: KIND_SLOT, x: X_SLOT, y: Y_SLOT, z: Z_SLOT } = BODY;
const BODY_COUNT = HEADER.bodyCount;
const ALIVE = FLAG.alive;
const MOVED_SQUARED = UNIT * UNIT;
const roleAt = (state: ArrayLike<number>, body: number): number => state[FIRST_BODY + body * STRIDE + ROLE_SLOT]!;
const live = (state: ArrayLike<number>, body: number): boolean => (state[FIRST_BODY + body * STRIDE + FLAGS_SLOT]! & ALIVE) !== 0;
const kindAt = (world: ArcadeWorld, state: ArrayLike<number>, body: number): string => world.kinds[state[FIRST_BODY + body * STRIDE + KIND_SLOT]!] ?? '';

/**
 * Bez hádání mezi více kandidáty. Neobsazené tělo nemůže dokazovat jméno z věty. Kandidáti stejného druhu
 * a popisku hádání nejsou (P54C T14r1): role pravidel odpovědi „bomb“ vedle `hazard` bomby žánru pruhů je
 * totéž jméno, vazba bere první – roli modulu, která v `spec.roles` stojí před rolemi pravidel.
 */
export function bindRoles(spec: GameSpecV1, world: ArcadeWorld): readonly RoleBinding[] {
  const out: RoleBinding[] = [];
  const unique = (roles: readonly GameRole[]): GameRole | undefined => roles.length === 1 || (roles.length > 1 && roles.every(role => role.kind === roles[0]!.kind && role.label === roles[0]!.label)) ? roles[0] : undefined;
  for (let body = 0; body < world.initial[HEADER.bodyCount]!; body += 1) {
    const code = roleAt(world.initial, body);
    const kind = kindAt(world, world.initial, body);
    const player = body === world.initial[HEADER.player];
    const named = kind.startsWith('thing:') ? kind.slice(6) : kind === 'opponent-forward' ? 'goalkeeper' : kind === 'opponent-ball' ? 'physics_ball' : kind === 'rival-car' || kind === 'foe' ? 'rival' : kind === 'tire-barrier' ? 'barrier' : kind;
    let role = player ? unique(spec.roles.filter(r => r.kind === 'player')) : spec.roles.find(r => r.id === named && r.kind !== 'player');
    if (!player && code === ROLE.projectile && kind === 'bullet') role = spec.roles.find(r => r.id === 'ammunition' && r.kind === 'item') ?? role;
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
/** Může vazba `binding` být aktérem trojice? Bez toho svědek s tímto aktérem trojici nepotvrdí (`matchesWitness`). */
export const namesActor = (triple: IntentTriple, binding: RoleBinding): boolean => names(triple.actor, binding);
export function matchesWitness(triple: IntentTriple, witness: ActionWitness): boolean {
  // Zachycení v sondě nesmí potvrdit cíl catch/escape/survive.
  if (witness.run === 'probe' && !['chaser', 'guard', 'hazard', 'obstacle', 'rival'].includes(triple.verb)) return false;
  return triple.verb === witness.verb && namesActor(triple, witness.actor) && (triple.object === null || (witness.object !== null && names(triple.object, witness.object)));
}

/** Sonda mění jen vstup hráče; svět, rychlosti i pravidla zůstávají stejné. */
export function threatProbeInput(world: ArcadeWorld, target: number, observation: ArcadeObservation, normal: ArcadeInput): ArcadeInput {
  world = { ...world, rules: world.rules.map(underlyingRule) };
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
  const attached = world.rules.find(ref => ref.id === 'assembly_part' && (ref.params.part as { body: number }).body === target)?.params.part as { kind: string; motion: string; startY: number } | undefined;
  if (attached !== undefined) {
    if (attached.kind === 'rival' || attached.kind === 'chaser') {
      if (attached.kind === 'rival' && (control === 'runner' || control === 'flap')) return { ...normal, buttons: normal.buttons | BUTTON.DOWN };
      if (attached.kind === 'rival' && control === 'platform') return NO_INPUT;
      if (control === 'steer') return { buttons: BUTTON.DOWN, axis: 0 };
      if (control === 'glide') return { buttons: BUTTON.HOLD, axis: 0 };
      if (control === 'walker' || control === 'move_free' || control === 'ball') return NO_INPUT;
    }
    if (control === 'walker' && baseControl.params.size !== undefined) {
      const map = baseControl.params as unknown as WalkerMap;
      const speed = Number(baseControl.params.speed ?? 110);
      let x = state[p + BODY.x]!, z = state[p + BODY.z]!;
      for (const input of observation.recent) { const v = walkerVelocity(input, speed); x += v.vx; z += v.vz; }
      const waypoint = walkerWaypoint(map, x, z, walkerCell(map, state[t + BODY.x]!, state[t + BODY.z]!));
      if (waypoint) {
        const mx = waypoint.x - x, mz = waypoint.z - z;
        return Math.abs(mx) > 80 ? { axis: Math.round(Math.max(-1, Math.min(1, mx / speed)) * AXIS_MAX), buttons: 0 }
          : { axis: 0, buttons: Math.abs(mz) > 80 ? mz > 0 ? BUTTON.UP : BUTTON.DOWN : 0 };
      }
    }
    if (control === 'ball') return { axis: 0, buttons: (Math.abs(dx) > 200 ? dx > 0 ? BUTTON.RIGHT : BUTTON.LEFT : 0) | (Math.abs(dz) > 200 ? dz > 0 ? BUTTON.UP : BUTTON.DOWN : 0) };
    if (Math.abs(dz) > 6500) return normal;
    if (control === 'platform') {
      // Keep the native jumps across earlier gaps. Only walk into the threat
      // once both bodies are over the same supporting slab; stopping jumps
      // several metres early can fall into an unrelated pit instead.
      const px = state[p + BODY.x]!, pz = state[p + BODY.z]!;
      for (let body = 0; body < state[HEADER.bodyCount]!; body++) {
        const slab = bodyBase(body);
        if (!live(state, body) || roleAt(state, body) !== ROLE.platform) continue;
        const near = state[slab + BODY.z]! - state[slab + BODY.d]! / 2;
        const far = state[slab + BODY.z]! + state[slab + BODY.d]! / 2;
        const top = state[slab + BODY.y]! + state[slab + BODY.h]!;
        if (Math.abs(px - state[slab + BODY.x]!) < state[slab + BODY.w]! / 2 && pz >= near && pz <= far
          && state[t + BODY.z]! - state[t + BODY.d]! / 2 >= near && state[t + BODY.z]! + state[t + BODY.d]! / 2 <= far
          && Math.abs(state[p + BODY.y]! - top) < 100) return { buttons: 0, axis: Math.abs(dz) < 200 ? 0 : dz > 0 ? AXIS_MAX : -AXIS_MAX };
      }
      return normal;
    }
    if (control === 'runner') return { buttons: Math.abs(dx) < 500 ? 0 : dx > 0 ? BUTTON.RIGHT : BUTTON.LEFT, axis: 0 };
    if (control === 'steer') return { buttons: state[p + BODY.vz]! > 60 || dz < 500 ? BUTTON.DOWN : 0, axis: Math.round(Math.max(-AXIS_MAX, Math.min(AXIS_MAX, dx * 2 - state[p + BODY.vx]! * 4))) };
    if (control === 'walker') return { buttons: dz >= 0 ? BUTTON.UP : BUTTON.DOWN, axis: Math.abs(dx) < 200 ? 0 : Math.sign(dx) * AXIS_MAX };
    if (control === 'glide') {
      const desiredY = attached.motion === 'fall' ? attached.startY - 7000 : state[t + BODY.y]!;
      const dy = desiredY - state[p + BODY.y]! - state[p + BODY.vy]! * 6;
      return { buttons: (state[p + BODY.vz]! > 60 || dz < 500 ? BUTTON.HOLD : 0) | (dy > 100 ? BUTTON.UP : dy < -100 ? BUTTON.DOWN : 0),
        axis: Math.round(Math.max(-AXIS_MAX, Math.min(AXIS_MAX, dx * 2 - state[p + BODY.vx]! * 4))) };
    }
    if (control === 'flap') {
      if (Math.abs(dz) > 1800) return normal;
      const desired = state[t + BODY.y]! + state[t + BODY.h]! / 2 - state[p + BODY.h]! / 2;
      return { axis: 0, buttons: state[p + BODY.y]! < desired && state[p + BODY.vy]! < 50 ? BUTTON.TAP : 0 };
    }
  }
  // Přeskákání (P54C T9): sonda hraje jako robot, dokud by ji skok vpřed neposlal pod viděné vozidlo; pak skočí.
  if (control === 'hop' && roleAt(state, target) === ROLE.obstacle) return hopProbeInput(observation, world.bot.params as HopBotParams, normal);
  // Dav a brány (P54C T10): sonda hraje jako robot, dokud překážka není těsně před ní; pak zahne do jejího pruhu.
  if (control === 'crowd' && roleAt(state, target) === ROLE.obstacle) return crowdProbeInput(observation, target, normal);
  // Obrana pruhů (P54C T7): sonda nestřílí ani nestaví – nepřítel dojde k hradbě a vezme život.
  if (control === 'lanes' && roleAt(state, target) === ROLE.chaser && world.rules.some((ref) => ref.id === 'defense_hit')) return NO_INPUT;
  // Krájení (P54C T8): sonda hraje jako robot, dokud bomba nevyletí do výšky řezu; pak švihne do jejího pruhu.
  if (control === 'lanes' && roleAt(state, target) === ROLE.hazard && world.rules.some((ref) => ref.id === 'slice_cut')) {
    const now = observation.tick + observation.recent.length;
    return heightAt(state[t + BODY.y]!, state[t + BODY.vy]!, observation.tick, now) >= SLICE.cutY && (state[t + BODY.flags]! & FLAG.grounded) === 0 ? { buttons: BUTTON.TAP, axis: axisOfLane(laneOfX(state[t + BODY.x]!)) } : normal;
  }
  // Bouchání (P54C T6): sonda hraje jako robot, dokud hodný cíl nevykoukne z díry; pak do ní bouchne.
  if (control === 'lanes' && roleAt(state, target) === ROLE.hazard && world.rules.some((ref) => ref.id === 'whack_hit')) return holeOpen(state, target) ? { buttons: BUTTON.TAP, axis: axisOfLane(laneOfX(state[t + BODY.x]!)) } : normal;
  // Chytání (P54C T5): sonda hraje jako robot, dokud bomba visí nad obrazem; pak stojí v jejím pruhu, ať do koše spadne právě ona.
  if (control === 'lanes' && roleAt(state, target) === ROLE.hazard) return state[t + BODY.y]! > CATCH.viewTop ? normal : { buttons: 0, axis: axisOfLane(laneOfX(state[t + BODY.x]!)) };
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

type Origin = { readonly other: number; readonly source: number; readonly held: number; readonly ballBefore?: ArcadeState; readonly ballEffects?: readonly ArcadeEffect[]; readonly projectileBefore?: ArcadeState };

/** Pozorovatel pravidel: kopie efektů nesou kontext kontaktu, jádro stále rozhoduje, co se skutečně provedlo. */
export class WitnessRecorder {
  private readonly world: ArcadeWorld;
  private readonly run: 'winner' | 'probe';
  private readonly runId: string;
  private readonly origins = new WeakMap<ArcadeEffect, Origin>();
  private readonly found = new Map<string, ActionWitness>();
  private readonly bindings: ReadonlyMap<number, RoleBinding>;
  private readonly templates = new Map<number, Map<string, RoleBinding | null>>();
  private readonly resolved = new Map<number, { code: number; kind: string; binding: RoleBinding | undefined }>();
  private readonly control: string;
  // Index the same (role, body) pairs without allocating string keys each tick.
  // A recycled body can retain movement history for more than one role.
  private readonly moved = new Map<string, Set<number>>();
  private readonly knockdown: boolean;
  private readonly team: boolean;
  private readonly race: boolean;
  private readonly stack: boolean;
  private readonly movementVerb: string | undefined;
  private readonly positions = new Map<number, { roleId: string; x: number; y: number; z: number }>();
  private readonly hurt = new Set<string>();
  /** Pronásledovatelé, které pravidlo `pacing` odvolalo živé (finále P45C T12: s bossem odejdou), poté co se hnuli. */
  private readonly departed: RoleBinding[] = [];
  /** Keepers of a composed game: `assembly_gate_*` latches a native win there as `stateChange` 1 until the parts are done. */
  private readonly latches: ReadonlySet<number>;
  private readonly start: readonly number[];
  private readonly thrown: { body: number; x: number; y: number; z: number; tick: number }[] = [];
  private readonly pendingLosses: { body: number; evidence: string }[] = [];
  private readonly ballLaunches = new Map<number, BallLaunchEvidence>();
  private readonly struckPins = new Set<number>();
  private readonly teamShots = new Set<string>();
  private readonly namedAmmunition: boolean;
  private readonly launched = new Map<number, { x: number; y: number; z: number; tick: number }>();
  /** Hodné cíle bouchání (P54C T6) zasažené v tomhle tiku; zranily, jen když tik opravdu ubral život. */
  private readonly struckGood: number[] = [];
  /** Nepřátelé obrany pruhů (P54C T7), kteří v tomhle tiku prošli hradbou; zranili, jen když tik opravdu ubral život. */
  private readonly breached: number[] = [];
  /** Bomby krájení (P54C T8) rozseknuté v tomhle tiku; zranily, jen když tik opravdu ubral život. */
  private readonly slicedBombs: number[] = [];

  constructor(world: ArcadeWorld, bindings: readonly RoleBinding[], run: 'winner' | 'probe', runId: string) {
    this.world = { ...world, rules: world.rules.map(underlyingRule) };
    this.latches = new Set(world.rules.filter(rule => rule.id.startsWith('assembly_gate_')).map(rule => rule.params.keeper as number));
    this.run = run;
    this.runId = runId;
    this.bindings = new Map(bindings.map(b => [b.body, b]));
    this.namedAmmunition = bindings.some(binding => binding.roleId === 'ammunition' && binding.roleKind === 'item');
    this.control = baseControlOf(world.control).id;
    this.knockdown = this.world.rules.some(rule => rule.id === 'ball_knockdown');
    this.team = this.world.rules.some(rule => rule.params.team !== undefined);
    this.race = this.control === 'steer' && this.world.rules.some(rule => rule.id === 'rival_finish' && !('land' in rule.params)) ||
      this.control === 'glide' && this.world.rules.some(rule => rule.id === 'glide_finish' && rule.params.race === true);
    this.stack = this.control === 'timing' && baseControlOf(this.world.control).params.mode === 'stack';
    const movement: Record<string, string> = { runner: 'run', platform: 'jump', flap: 'flap', steer: 'drive', move_free: 'roam', fight: 'roam', glide: 'glide', walker: 'walk', lanes: 'lanes', hop: 'hop', crowd: 'crowd', push: 'roam' };
    this.movementVerb = this.control === 'steer' && baseControlOf(this.world.control).params.land !== undefined ? 'glide' : movement[this.control];
    this.start = world.initial;
    for (const binding of this.bindings.values()) {
      const code = roleAt(this.start, binding.body);
      const kind = kindAt(this.world, this.start, binding.body);
      this.resolved.set(binding.body, { code, kind, binding });
      let kinds = this.templates.get(code);
      if (kinds === undefined) this.templates.set(code, kinds = new Map());
      const known = kinds.get(kind);
      // Matching templates with different role identities remain ambiguous.
      if (known === undefined) kinds.set(kind, binding);
      else if (known === null || known.roleId !== binding.roleId) kinds.set(kind, null);
    }
    for (const binding of bindings) {
      const base = bodyBase(binding.body);
      this.positions.set(binding.body, { roleId: binding.roleId, x: this.start[base + BODY.x]!, y: this.start[base + BODY.y]!, z: this.start[base + BODY.z]! });
    }
  }

  observe(library: ArcadeLibrary): ArcadeLibrary {
    return { ...library, rules: Object.fromEntries(Object.entries(library.rules).map(([id, piece]) => [id, {
      ...piece,
      fire: (ctx: Parameters<typeof piece.fire>[0], params: unknown) => {
        const effective = underlyingRule({ id, params: params as Record<string, unknown> });
        const ballBefore = effective.id === 'ball_launch' || effective.id === 'ball_score' || effective.id === 'launch' ? ctx.state.slice() : undefined;
        const effects = piece.fire(ctx, params);
        const projectileBefore = this.namedAmmunition && (effective.id === 'blaster' || effective.id === 'gun') && effects.some(effect => effect.kind === 'spawn') ? ctx.state.slice() : undefined;
        return effects.map(effect => {
          const copy = { ...effect };
          this.origins.set(copy, { other: ctx.other, source: ctx.source, held: ctx.state[HEADER.held]! - 1,
            ...(projectileBefore === undefined ? {} : { projectileBefore }),
            ...(ballBefore === undefined ? {} : { ballBefore, ballEffects: effects }) });
          return copy;
        });
      },
    }])) };
  }

  private binding(body: number, state: ArcadeState): RoleBinding | undefined {
    if (body < 0 || body >= state[BODY_COUNT]!) return undefined;
    const code = roleAt(state, body);
    const kind = kindAt(this.world, state, body);
    const cached = this.resolved.get(body);
    if (cached !== undefined && cached.code === code && cached.kind === kind) return cached.binding;
    const direct = this.bindings.get(body);
    if (direct !== undefined && code === roleAt(this.start, body) && kind === kindAt(this.world, this.start, body)) {
      this.resolved.set(body, { code, kind, binding: direct });
      return direct;
    }
    // Nová kopie předlohy: totožnost jen když všechny shodné předlohy patří téže roli.
    const template = this.templates.get(code)?.get(kind);
    const binding = template == null ? undefined : { ...template, body };
    this.resolved.set(body, { code, kind, binding });
    return binding;
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
    // Lovce, kterého finále průběhu odvolá živého, hráč přečkal: únik z něj dokáže i výhra, při které už na ploše není.
    if (ref.id === 'pacing' && effect.kind === 'despawn' && roleAt(state, effect.body) === ROLE.chaser) {
      const binding = this.binding(effect.body, state);
      if (binding !== undefined && this.hasMoved(binding, state)) this.departed.push(binding);
    }
    const launchBefore = origin.projectileBefore;
    if (launchBefore !== undefined && effect.kind === 'spawn' && effect.template === ref.params.template &&
        roleAt(launchBefore, effect.template) === ROLE.projectile && kindAt(this.world, launchBefore, effect.template) === 'bullet' &&
        this.binding(effect.template, launchBefore)?.roleId === 'ammunition' &&
        state[HEADER.counters + COUNTER.ammo]! < launchBefore[HEADER.counters + COUNTER.ammo]! &&
        effect.vx * effect.vx + effect.vy * effect.vy + effect.vz * effect.vz > 0) {
      for (let body = state[HEADER.spawnBase]!; body < state[HEADER.bodyCount]!; body++) {
        const b = bodyBase(body);
        if (!live(launchBefore, body) && live(state, body) && roleAt(state, body) === ROLE.projectile && kindAt(this.world, state, body) === 'bullet' &&
            state[b + BODY.x] === effect.x && state[b + BODY.y] === effect.y && state[b + BODY.z] === effect.z &&
            state[b + BODY.vx] === effect.vx && state[b + BODY.vy] === effect.vy && state[b + BODY.vz] === effect.vz) {
          this.launched.set(body, { x: effect.x, y: effect.y, z: effect.z, tick });
        }
      }
    }
    if (ref.id === 'ball_knockdown' && effect.kind === 'despawn' && this.struckPins.has(effect.body) && pinFallen(state, effect.body)) {
      this.add('ball', player, null, tick, 'physical-ball-knockdown', state);
      this.add('defeat', player, effect.body, tick, 'physical-pin-knocked-down', state);
    }
    if (origin.ballBefore !== undefined && origin.ballEffects !== undefined) {
      const observation = { world: this.world, rule, before: origin.ballBefore, after: state, effects: origin.ballEffects };
      for (const shot of opponentBallEvidence(observation)) {
        const team = this.binding(shot.opponent, state);
        if (team !== undefined) this.teamShots.add(team.roleId);
        if (shot.event === 'goal' && this.run === 'probe') this.add('rival', shot.opponent, player, tick, 'opponent-physical-goal', state);
      }
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
        // The goal course launches a ground-level shot. Require the same real
        // launch, travel and goal evidence as scoring; a label cannot prove a kick.
        if (scored.goal === 'goal') this.add('kick', player, scored.ball, tick, 'physical-ball-kicked-into-goal', state);
      }
    }
    if (ref.id === 'assembly_part') {
      const part = ref.params.part as { body: number; kind: string; startX: number; startY: number; startZ: number; goalX: number; goalZ: number };
      const binding = this.binding(part.body, state);
      const b = bodyBase(part.body), p = bodyBase(player);
      const travelled = Math.hypot(state[b + BODY.x]! - part.startX, state[b + BODY.y]! - part.startY, state[b + BODY.z]! - part.startZ) >= UNIT;
      if (effect.kind === 'stateChange' && effect.body === part.body && effect.state === 2) {
        if (part.kind === 'catch' && travelled && binding !== undefined && this.binding(player, state) !== undefined && this.hasMoved(this.binding(player, state)!, state)) this.add('catch', player, part.body, tick, 'moving-prey-contact', state);
        if ((part.kind === 'duel' || part.kind === 'fight') && bodyHp(state, part.body) === 0) this.add(part.kind, player, part.body, tick, 'opponent-knocked-out', state);
        if ((part.kind === 'deliver' || part.kind === 'interact') && origin.held === part.body && Math.hypot(state[p + BODY.x]! - part.goalX, state[p + BODY.z]! - part.goalZ) < 1800) this.add(part.kind, player, part.body, tick, 'carried-to-destination', state);
        if (part.kind === 'rival' && travelled) this.add('race', player, part.body, tick, 'finished-before-moving-rival', state);
        if (part.kind === 'escape' && state[p + BODY.z]! >= (ref.params.length as number) - 1200 && this.binding(player, state) !== undefined && this.hasMoved(this.binding(player, state)!, state)) this.add('escape', player, part.body, tick, 'left-location-after-phase', state);
      }
      if ((effect.kind === 'damage' || effect.kind === 'lose') && this.run === 'probe' && travelled && ['hazard', 'chaser', 'rival'].includes(part.kind)) {
        this.add(part.kind, part.body, player, tick, part.kind === 'rival' ? 'rival-finished-first' : 'moving-threat-contact', state);
        if (binding !== undefined) this.hurt.add(binding.roleId);
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
    // Akce Grab (P46A) bere věc v dosahu bez dotyku: věc hry je sebraná stejně jako dotykem.
    if (ref.id === 'ability_grab' && effect.kind === 'despawn' && (roleAt(state, effect.body) === ROLE.collectible || this.binding(effect.body, state)?.roleKind === 'collectible')) this.add('collect', player, effect.body, tick, 'grabbed-ability', state);
    // Chytání (P54C T5): věc, kterou pravidlo dopadu odebere nad zemí, padla hrdinovi do koše – ovoce je chycené,
    // bomba ho zranila. Co propadlo, zmizí až na zemi a nedokazuje nic.
    if (ref.id === 'catch_fall' && effect.kind === 'despawn' && state[bodyBase(effect.body) + BODY.y]! > 0) {
      const code = roleAt(state, effect.body);
      // Záměr čte „catches falling apples“ jako `catch` (P54C T13) – chycená věc ho dokazuje stejně jako sběr.
      if (code === ROLE.collectible) for (const verb of ['collect', 'catch']) this.add(verb, player, effect.body, tick, 'caught-in-lane', state);
      else if (code === ROLE.hazard) this.harm(effect.body, player, tick, 'falling-bomb-caught', state);
    }
    // Bouchání (P54C T6): cíl, který pravidlo úderu odebere ještě v okně, dostal ránu – krtek je rozbitý; hodný
    // cíl hráče zranil, ubral-li tik život (`afterTick`). Co se po okně schovalo samo, nedokazuje nic.
    if (ref.id === 'whack_hit' && effect.kind === 'despawn' && state[bodyBase(effect.body) + BODY.y]! < WHACK.band) {
      const code = roleAt(state, effect.body);
      if (code === ROLE.target) {
        this.add('whack', player, effect.body, tick, 'whacked-in-hole', state);
        this.add('defeat', player, effect.body, tick, 'target-whacked', state);
        // Záměr čte hit, pop a smash jako `interact` (úder do věci, P54C T13) – rána do cíle v díře ho dokazuje.
        this.add('interact', player, effect.body, tick, 'whacked-in-hole', state);
      } else if (code === ROLE.hazard) this.struckGood.push(effect.body);
    }
    // Krájení (P54C T8): věc, kterou pravidlo švihu odebere ve výšce řezu (ne na zemi), byla rozseknutá – ovoce je
    // dokázané krájení, bomba hráče zranila, ubral-li tik život (`afterTick`). Co dopadlo na zem, nedokazuje nic.
    if (ref.id === 'slice_cut' && effect.kind === 'despawn' && state[bodyBase(effect.body) + BODY.y]! >= SLICE.cutY && (state[bodyBase(effect.body) + BODY.flags]! & FLAG.grounded) === 0) {
      const code = roleAt(state, effect.body);
      if (code === ROLE.collectible) this.add('slice', player, effect.body, tick, 'sliced-at-cut-height', state);
      else if (code === ROLE.hazard) this.slicedBombs.push(effect.body);
    }
    // Obrana pruhů (P54C T7): zásah, jehož útočník je šíp z luku hrdiny (druh `bolt`), dokazuje střelbu; nepřítel, kterého
    // pravidlo zásahu odebere na nule HP, padl. Kdo odejde s HP, prošel hradbou – zranil, ubral-li tik život (`afterTick`).
    if (ref.id === 'defense_hit') {
      if (effect.kind === 'hit' && kindAt(this.world, state, effect.by) === 'bolt') this.add('shoot', player, effect.body, tick, 'bolt-hit-in-lane', state);
      if (effect.kind === 'despawn' && roleAt(state, effect.body) === ROLE.chaser) {
        if (bodyHp(state, effect.body) === 0) this.add('defeat', player, effect.body, tick, 'enemy-stopped-in-lane', state);
        else this.breached.push(effect.body);
      }
    }
    // Slučování (P54C T11): předmět, který vypustil pust hráče, je puštěný (kámen po trpělivosti nedokazuje nic);
    // předmět, který vytvořilo pravidlo sloučení ze dvou stejných předmětů v kontaktu, dokazuje sloučení.
    if (ref.id === 'merge_drop' && effect.kind === 'spawn' && roleAt(state, effect.template) === ROLE.collectible) this.add('drop', player, effect.template, tick, 'item-dropped', state);
    if (ref.id === 'merge_join' && effect.kind === 'spawn') this.add('merge', player, effect.template, tick, 'equal-items-merged', state);
    // Vytlačování (P54C T12): soupeř, kterému pravidlo pádu vzalo HP, je za okrajem ringu po výpadu hrdiny – vystrčený.
    // Pád hrdiny z ringu (ztracený život) způsobil soupeř, který u něj stojí nejblíž – ten hrdinu vystrčil (sonda hrozby).
    if (ref.id === 'push_out' && effect.kind === 'hit' && roleAt(state, effect.body) === ROLE.enemy) this.add('push', player, effect.body, tick, 'pushed-out-of-ring', state);
    if (ref.id === 'push_out' && effect.kind === 'damage') {
      const shover = nearestRival(state);
      if (shover >= 0) this.harm(shover, player, tick, 'pushed-hero-out-of-ring', state);
    }
    // Výhra obrany: žádný nepřítel už nejde a hradba drží – hrdina ji ubránil.
    if (ref.id === 'defense_goal' && effect.kind === 'win') {
      const keep = [...this.bindings.values()].find((binding) => binding.roleId === 'castle');
      // „protect the tower from monsters“ (P54C T13): záměr čte „protect“ jako vlastní sloveso, ubráněná hradba ho dokazuje stejně.
      for (const verb of ['defend', 'protect']) this.add(verb, player, keep?.body ?? null, tick, 'held-every-wave', state);
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
        // Mód čte základní ovládání: nad průběhem (P45C T14) je ovládání světa `pacing_control`.
        const verb = this.control === 'rhythm' ? 'beat' : this.control === 'duel' ? 'duel' : this.stack ? 'stack' : 'time';
        const target = [...this.bindings.values()].find(b => !b.player && (roleAt(state, b.body) === ROLE.enemy || roleAt(state, b.body) === ROLE.target));
        this.add(verb, player, target?.body ?? null, tick, 'successful-timing', state);
      }
    }
    // The gate's latch is the native win (the exit was touched); the later `assembly_finish` win has no contact.
    if (effect.kind === 'win' || effect.kind === 'stateChange' && effect.state === 1 && this.latches.has(effect.body)) {
      if ((ref.id === 'finish' || ref.id === 'finish_collected' || ref.id === 'rule_contact') && (code === ROLE.goal || ['exit', 'destination'].includes(this.binding(other, state)?.roleKind ?? ''))) this.add('reach', player, other, tick, 'finish-contact', state);
      if (ref.id === 'survive_time') this.add('survive', player, null, tick, 'survival-timer', state);
      if (ref.id === 'judge' && this.stack && [...this.found.values()].some(w => w.verb === 'stack')) this.add('build', player, null, tick, 'stack-completed', state);
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
      // Tělo chování (P45C) udeří z pravidla `pacing` (spouštěč `tick`, bez `other`): sonda úder připíše nejbližšímu sondovanému tělu.
      if (ref.id === 'pacing' && this.run === 'probe') {
        const striker = this.nearestPaced(state, player);
        if (striker >= 0) this.harm(striker, player, tick, 'behaviour-strike', state);
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

  /** Nejbližší živé tělo s vazbou sondy průběhu (`pacing:*`) k hráči, nebo −1. */
  private nearestPaced(state: ArcadeState, player: number): number {
    const p = bodyBase(player);
    let nearest = -1;
    let distance = Number.POSITIVE_INFINITY;
    for (let body = 0; body < state[HEADER.bodyCount]!; body += 1) {
      if (!live(state, body) || this.binding(body, state)?.roleId.startsWith('pacing:') !== true) continue;
      const b = bodyBase(body);
      const squared = (state[b + BODY.x]! - state[p + BODY.x]!) ** 2 + (state[b + BODY.z]! - state[p + BODY.z]!) ** 2;
      if (squared < distance) { nearest = body; distance = squared; }
    }
    return nearest;
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
    if (this.moved.get(binding.roleId)?.has(binding.body)) return true;
    const start = this.positions.get(binding.body);
    if (start === undefined || start.roleId !== binding.roleId) return false;
    const base = FIRST_BODY + binding.body * STRIDE;
    return (state[base + X_SLOT]! - start.x) ** 2 + (state[base + Y_SLOT]! - start.y) ** 2 + (state[base + Z_SLOT]! - start.z) ** 2 >= MOVED_SQUARED;
  }

  afterTick(before: ArcadeState, state: ArcadeState, tick: number): void {
    const player = state[HEADER.player]!;
    if (this.stack &&
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
        if (this.knockdown && ballPinImpact(before, state, launch, binding.body)) this.struckPins.add(binding.body);
        const blocked = keeperBlockEvidence(this.world, before, state, launch, binding.body, this.run);
        if (blocked !== null && (!this.team || this.teamShots.has(binding.roleId))) this.add('rival', blocked.keeper, player, tick, 'keeper-deflected-physical-ball', state);
      }
      if (!live(state, launch.ball)) this.ballLaunches.delete(launch.ball);
    }
    if (state[HEADER.runState] === RUN_STATE.lost) for (const loss of this.pendingLosses) this.harm(loss.body, player, tick, loss.evidence, state);
    this.pendingLosses.length = 0;
    if (this.struckGood.length > 0 && state[HEADER.counters + COUNTER.health]! < before[HEADER.counters + COUNTER.health]!) {
      for (const body of this.struckGood) this.harm(body, player, tick, 'good-target-whacked', state);
    }
    this.struckGood.length = 0;
    if (this.breached.length > 0 && state[HEADER.counters + COUNTER.health]! < before[HEADER.counters + COUNTER.health]!) {
      for (const body of this.breached) this.harm(body, player, tick, 'enemy-broke-through', state);
    }
    this.breached.length = 0;
    if (this.slicedBombs.length > 0 && state[HEADER.counters + COUNTER.health]! < before[HEADER.counters + COUNTER.health]!) {
      for (const body of this.slicedBombs) this.harm(body, player, tick, 'bomb-sliced', state);
    }
    this.slicedBombs.length = 0;
    const p = bodyBase(player);
    for (let body = 0; body < state[BODY_COUNT]!; body += 1) {
      const binding = this.binding(body, state);
      if (binding === undefined) continue;
      if (!live(state, body)) {
        this.positions.delete(body);
        this.moved.get(binding.roleId)?.delete(body);
        continue;
      }
      let moved = this.moved.get(binding.roleId);
      if (!moved?.has(body) && this.hasMoved(binding, state)) {
        if (moved === undefined) this.moved.set(binding.roleId, moved = new Set());
        moved.add(body);
      }
      if (this.positions.get(body)?.roleId !== binding.roleId) {
        const base = bodyBase(body);
        this.positions.set(body, { roleId: binding.roleId, x: state[base + BODY.x]!, y: state[base + BODY.y]!, z: state[base + BODY.z]! });
      }
    }
    if (this.run !== 'winner') return;
    for (const [body, launch] of this.launched) {
      const b = bodyBase(body);
      const active = live(state, body) && tick - launch.tick <= 20 && roleAt(state, body) === ROLE.projectile && kindAt(this.world, state, body) === 'bullet' && this.binding(body, state)?.roleId === 'ammunition';
      const travelled = active && (state[b + BODY.x]! - launch.x) ** 2 + (state[b + BODY.y]! - launch.y) ** 2 + (state[b + BODY.z]! - launch.z) ** 2 >= UNIT * UNIT;
      if (travelled) this.add('shoot', player, body, tick, 'launched-projectile-moved', state);
      if (!active || travelled) this.launched.delete(body);
    }
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
    // The legacy lander shares the steer control id, but actually flies under
    // gravity and thrust. Its airborne translation is not driving on a road.
    const verb = this.movementVerb;
    const hero = this.binding(player, state);
    if (verb !== undefined && hero !== undefined && this.hasMoved(hero, state) && (verb !== 'jump' || (state[p + BODY.y]! > before[p + BODY.y]! && (state[p + BODY.flags]! & FLAG.grounded) === 0))) this.add(verb, player, null, tick, 'player-moved', state);
    if (this.race) {
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
      for (const left of this.departed) {
        if (left.roleId !== threat.actor.roleId) continue;
        if (threat.verb === 'chaser' || threat.verb === 'guard') this.addLeft('escape', left, tick, `survived-threat:${threat.runId}`, state);
        this.addLeft('survive', left, tick, `survived-threat:${threat.runId}`, state);
      }
    }
    return this.finish('won');
  }

  /** Jako `add` s hráčem jako aktérem, ale předmět je vazba odvolaného těla (jeho slot mohl mezitím připadnout jinému). */
  private addLeft(verb: string, what: RoleBinding, tick: number, evidence: string, state: ArcadeState): void {
    const who = this.binding(state[HEADER.player]!, state);
    if (who === undefined) return;
    const key = `${verb}:${who.roleId}:${what.roleId}:${evidence}`;
    if (!this.found.has(key)) this.found.set(key, { actor: who, verb, object: what, tick, evidence, run: this.run, runId: this.runId });
  }
}
