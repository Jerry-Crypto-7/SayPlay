/** P41 physics-ball evidence. Pure observations; no names, genres or score shortcuts. */
import { BODY, COUNTER, FLAG, HEADER, ROLE, bodyBase, type ArcadeEffect, type ArcadeWorld } from './contract';

type State = ArrayLike<number>;
export interface BallEffectObservation {
  readonly world: ArcadeWorld;
  readonly rule: number;
  /** Snapshot at rule.fire, after physics but before this rule's effects. */
  readonly before: State;
  /** After the relevant effects have actually been applied. */
  readonly after: State;
  readonly effects: readonly ArcadeEffect[];
}
export interface BallLaunchEvidence {
  readonly player: number;
  readonly ball: number;
  readonly template: number;
  readonly tick: number;
  readonly kind: number;
  readonly from: { readonly x: number; readonly y: number; readonly z: number };
  readonly velocity: { readonly x: number; readonly y: number; readonly z: number };
}
export interface BallScoreEvidence {
  readonly player: number;
  readonly ball: number;
  readonly target: number;
  readonly tick: number;
  readonly launchTick: number;
  readonly goal: 'goal' | 'hoop' | 'hole';
}
export interface KeeperBlockEvidence {
  readonly keeper: number;
  readonly ball: number;
  readonly player: number;
  readonly tick: number;
  readonly launchTick: number;
  readonly beforeForward: number;
  readonly afterForward: number;
}
const at = (state: State, body: number, slot: number): number => state[bodyBase(body) + slot] ?? 0;
const alive = (state: State, body: number): boolean => (at(state, body, BODY.flags) & FLAG.alive) !== 0;
const physicsBall = (state: State, body: number): boolean => (at(state, body, BODY.flags) & (FLAG.physics | FLAG.ball)) === (FLAG.physics | FLAG.ball) && at(state, body, BODY.role) !== ROLE.projectile;
const position = (state: State, body: number) => ({ x: at(state, body, BODY.x), y: at(state, body, BODY.y), z: at(state, body, BODY.z) });

/** An actual ball_launch spawn that consumed ammunition and created a sphere. */
export function ballLaunchEvidence(observation: BallEffectObservation): readonly BallLaunchEvidence[] {
  const { world, rule, before, after, effects } = observation;
  if (world.rules[rule]?.id !== 'ball_launch' || after[HEADER.counters + COUNTER.ammo]! >= before[HEADER.counters + COUNTER.ammo]!) return [];
  const player = before[HEADER.player]!;
  const found: BallLaunchEvidence[] = [];
  for (const effect of effects) {
    if (effect.kind !== 'spawn' || effect.template !== world.rules[rule]!.params.template || !physicsBall(before, effect.template)) continue;
    if (effect.vx === 0 && effect.vy === 0 && effect.vz === 0) continue;
    for (let body = 0; body < after[HEADER.bodyCount]!; body++) {
      if (alive(before, body) || !alive(after, body) || !physicsBall(after, body) || at(after, body, BODY.kind) !== at(before, effect.template, BODY.kind)) continue;
      if (at(after, body, BODY.x) !== effect.x || at(after, body, BODY.y) !== effect.y || at(after, body, BODY.z) !== effect.z || at(after, body, BODY.vx) !== effect.vx || at(after, body, BODY.vy) !== effect.vy || at(after, body, BODY.vz) !== effect.vz) continue;
      found.push({ player, ball: body, template: effect.template, tick: before[HEADER.tick]!, kind: at(after, body, BODY.kind), from: { x: effect.x, y: effect.y, z: effect.z }, velocity: { x: effect.vx, y: effect.vy, z: effect.vz } });
    }
  }
  return found;
}

/** The scored sphere must still be inside the target in the pre-effect snapshot. */
export function ballScoreEvidence(observation: BallEffectObservation, launches: readonly BallLaunchEvidence[]): readonly BallScoreEvidence[] {
  const { world, rule, before, after, effects } = observation;
  const ref = world.rules[rule];
  if (ref?.id !== 'ball_score') return [];
  const goal = ref.params.goal;
  if (goal !== 'goal' && goal !== 'hoop' && goal !== 'hole') return [];
  const points = effects.reduce((sum, effect) => sum + (effect.kind === 'score' ? effect.amount : 0), 0);
  if (points !== 1 || after[HEADER.counters + COUNTER.score]! - before[HEADER.counters + COUNTER.score]! !== points) return [];
  const gone = effects.flatMap(effect => effect.kind === 'despawn' && alive(before, effect.body) && !alive(after, effect.body) ? [effect.body] : []);
  const targets = gone.filter(body => at(before, body, BODY.role) === ROLE.target);
  const found: BallScoreEvidence[] = [];
  for (const ball of gone.filter(body => physicsBall(before, body))) {
    const launch = launches.find(item => item.ball === ball && item.kind === at(before, ball, BODY.kind) && item.player === before[HEADER.player] && item.tick < before[HEADER.tick]!);
    if (launch === undefined) continue;
    const b = position(before, ball);
    if (Math.hypot(b.x - launch.from.x, b.y - launch.from.y, b.z - launch.from.z) < at(before, ball, BODY.w)) continue;
    if (goal === 'hoop' && at(before, ball, BODY.vy) >= 0) continue;
    for (const target of targets) {
      const t = position(before, target), centerY = b.y + at(before, ball, BODY.h) / 2;
      if (Math.abs(b.x - t.x) >= at(before, target, BODY.w) / 2 || Math.abs(b.z - t.z) >= at(before, target, BODY.d) / 2 || centerY < t.y || centerY > t.y + at(before, target, BODY.h)) continue;
      found.push({ player: launch.player, ball, target, tick: before[HEADER.tick]!, launchTick: launch.tick, goal });
    }
  }
  return found;
}

/** Conservative swept sphere/box overlap, including the box's own movement. */
function nearSweep(before: State, after: State, ball: number, box: number): boolean {
  const radius = Math.min(at(before, ball, BODY.w), at(before, ball, BODY.h), at(before, ball, BODY.d)) / 2;
  const ranges: readonly [number, number, number][] = [[BODY.x, BODY.w, 0], [BODY.y, BODY.h, 1], [BODY.z, BODY.d, 0]];
  return ranges.every(([axis, extent, vertical]) => {
    const b0 = at(before, ball, axis) + (vertical ? radius : 0), b1 = at(after, ball, axis) + (vertical ? radius : 0);
    const c0 = at(before, box, axis), c1 = at(after, box, axis), width = at(before, box, extent);
    const lo = Math.min(c0, c1) - (vertical ? 0 : width / 2), hi = Math.max(c0, c1) + (vertical ? width : width / 2);
    return Math.max(b0, b1) + radius + 40 >= lo && Math.min(b0, b1) - radius - 40 <= hi;
  });
}

/** A launched sphere transferred horizontal momentum to a unique dynamic pin. */
export function ballPinImpact(before: State, after: State, launch: BallLaunchEvidence, target: number): boolean {
  const ball = launch.ball;
  if (!alive(before, ball) || !alive(after, ball) || !physicsBall(before, ball) || before[HEADER.tick]! <= launch.tick) return false;
  if (!alive(before, target) || at(before, target, BODY.role) !== ROLE.target || !(at(before, target, BODY.flags) & FLAG.physics)) return false;
  if (!nearSweep(before, after, ball, target)) return false;
  const impulse = Math.hypot(at(after, target, BODY.vx) - at(before, target, BODY.vx), at(after, target, BODY.vz) - at(before, target, BODY.vz));
  if (impulse < 5) return false;
  for (let other = 0; other < before[HEADER.bodyCount]!; other++) {
    if (other === ball || other === target || other === launch.player || !alive(before, other)) continue;
    if ((at(before, other, BODY.flags) & FLAG.solid) && nearSweep(before, after, ball, other)) return false;
  }
  return true;
}

/** No label-based opponent proof: a probe must observe a unique physical block. */
export function keeperBlockEvidence(world: ArcadeWorld, before: State, after: State, launch: BallLaunchEvidence, keeper: number, run: 'winner' | 'probe'): KeeperBlockEvidence | null {
  if (run !== 'probe' || !world.rules.some(rule => rule.id === 'ball_launch') || !world.rules.some(rule => rule.id === 'ball_score')) return null;
  const ball = launch.ball;
  const flags = at(before, keeper, BODY.flags);
  if ((flags & (FLAG.alive | FLAG.solid | FLAG.kinematic)) !== (FLAG.alive | FLAG.solid | FLAG.kinematic) || at(before, keeper, BODY.role) !== ROLE.enemy || !alive(after, keeper)) return null;
  if (!alive(before, ball) || !alive(after, ball) || !physicsBall(before, ball) || !physicsBall(after, ball) || at(before, ball, BODY.kind) !== launch.kind || before[HEADER.tick]! <= launch.tick) return null;
  // Forward speed cannot be reduced by gravity in free flight. Require a large
  // observed reduction at the unique colliding solid body; exclude floor drag.
  const vz = at(before, ball, BODY.vz), nextVz = at(after, ball, BODY.vz);
  if (vz < 40 || nextVz > vz - 20 || at(before, ball, BODY.y) <= 80 || at(after, ball, BODY.y) <= 80 || !nearSweep(before, after, ball, keeper)) return null;
  if (at(before, keeper, BODY.z) < at(before, ball, BODY.z) - at(before, keeper, BODY.d) / 2) return null;
  for (let other = 0; other < before[HEADER.bodyCount]!; other++) {
    if (other === ball || other === keeper || other === launch.player || !alive(before, other)) continue;
    if ((at(before, other, BODY.flags) & FLAG.solid) && nearSweep(before, after, ball, other)) return null;
  }
  return { keeper, ball, player: launch.player, tick: after[HEADER.tick]!, launchTick: launch.tick, beforeForward: vz, afterForward: nextVz };
}
