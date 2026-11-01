/**
 * Důkaz hry závodu s triky (P68V T3): přehraje záznam od tiku 0 v Node a z polohy těles, vstupů a hlavičky stavu
 * spočítá, co se opravdu stalo – řízení, brzdění, vzduch a skoky, nárazy do mantinelu, rozbité hromady, posunuté
 * trosky a průjezd cílem. Efekt `win`, čítače hry (`STUNT_SLOTS`) ani parametry pravidel nečte: hra, která by se
 * kaskadérským závodem jen jmenovala (robot objede rampy i hromady), tu neprojde, i když vyhraje.
 *
 * Definice (zmrazené aserce P68-I `evals/play/p68/assertions.json`, 60 tiků = 1 s):
 * - **skok** = auto aspoň `jumpHeight` (0,5 m) nad povrchem pod sebou (země, nebo plocha rampy, nad kterou je) po aspoň
 *   `jumpTicks` (12) tiků za sebou;
 * - **náraz do hromady** = krabice hromady (fyzikální tělo živé od tiku 0) zmizí; **posunutá troska** = fyzikální tělo
 *   ze slotu spawnu, které od místa, kde se objevilo, ujede víc než `debrisMoved` (1 m);
 * - **průjezd cílem** = příď auta za přední hranou cíle v jeho šířce, do `P68_MAX_TICKS`.
 */

import { P68_MAX_TICKS } from '../../genre/p68-contract';
import { type ArcadeState, type ArcadeWorld, BODY, BUTTON, COUNTER, FLAG, HEADER, type InputEvent, NO_INPUT, ROLE, UNIT, bodyBase } from '../contract';
import { type ArcadeOutcome, hashArcade, instantiate, loadProgram, outcomeOf, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { releasePhysics } from '../physics/step';

export const STUNT_EVIDENCE = { jumpHeight: UNIT / 2, jumpTicks: 12, debrisMoved: UNIT, airSnap: 250, rampKind: 'gen3d-ramp' } as const;

export interface StuntEvidence {
  /** Tiky s řízením (osa nebo šipka) na zemi či rampě – ve vzduchu a v omráčení řízení nic nedělá. */
  readonly steerTicks: number;
  /** Tiky s brzdou na zemi, ve kterých rychlost vpřed opravdu klesla. */
  readonly brakeTicks: number;
  /** Tiky ve vzduchu (nad povrchem víc než `airSnap`). */
  readonly airTicks: number;
  /** Skoky podle aserce P68-I (`jumpHeight` po `jumpTicks` tiků za sebou). */
  readonly jumps: number;
  /** Nejdelší souvislý úsek aspoň `jumpHeight` nad povrchem (tiky). */
  readonly longestJump: number;
  /** Tiky, ve kterých ubyl život. */
  readonly crashes: number;
  /** Hromady, ze kterých zmizela aspoň jedna krabice. */
  readonly impacts: number;
  /** Krabice hromad, které zmizely. */
  readonly boxesGone: number;
  /** Trosky, které ujely víc než `debrisMoved` od místa, kde se objevily. */
  readonly debrisMoved: number;
  /** Nejvíc živých fyzikálních těl v jednom tiku (strop `STUNT_DEBRIS_MAX`). */
  readonly maxPhysics: number;
  readonly finished: boolean;
  readonly outcome: ArcadeOutcome;
  readonly ticks: number;
  readonly hash: string;
}

const at = (state: ArcadeState, body: number, slot: keyof typeof BODY): number => state[bodyBase(body) + BODY[slot]] as number;
const alive = (state: ArcadeState, body: number): boolean => (at(state, body, 'flags') & FLAG.alive) !== 0;
const physical = (state: ArcadeState, body: number): boolean => (at(state, body, 'flags') & (FLAG.alive | FLAG.physics)) === (FLAG.alive | FLAG.physics);

interface Box {
  readonly x: number;
  readonly z: number;
  readonly w: number;
  readonly d: number;
  readonly h: number;
}

const boxOf = (state: ArcadeState, body: number): Box => ({ x: at(state, body, 'x'), z: at(state, body, 'z'), w: at(state, body, 'w'), d: at(state, body, 'd'), h: at(state, body, 'h') });

/** Výška povrchu pod středem auta: plocha klínu rampy (stoupá od přední hrany), jinak země. */
function surfaceAt(ramps: readonly Box[], x: number, z: number): number {
  for (const ramp of ramps) {
    const z0 = ramp.z - ramp.d / 2;
    if (Math.abs(x - ramp.x) * 2 < ramp.w && z >= z0 && z < z0 + ramp.d) return Math.floor((ramp.h * (z - z0)) / ramp.d);
  }
  return 0;
}

/** Přehraje záznam `inputs` od tiku 0 (do konce běhu nebo `P68_MAX_TICKS`) a vrátí důkaz ze stavu. Rapier musí být načtený. */
export function stuntEvidence(world: ArcadeWorld, inputs: readonly InputEvent[]): StuntEvidence {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  const player = state[HEADER.player] as number;
  const spawnBase = state[HEADER.spawnBase] as number;
  const count = (): number => state[HEADER.bodyCount] as number;
  const ramps: Box[] = [];
  const piles = new Map<number, number[]>();
  let goal: Box | null = null;
  for (let body = 0; body < count(); body += 1) {
    if (!alive(state, body)) continue;
    const role = at(state, body, 'role');
    if (role === ROLE.platform && world.kinds[at(state, body, 'kind')] === STUNT_EVIDENCE.rampKind) ramps.push(boxOf(state, body));
    if (role === ROLE.goal && goal === null) goal = boxOf(state, body);
    // Krabice hromad: fyzikální těla úrovně, živá od tiku 0; hromada = krabice se stejným `z`.
    if (body < spawnBase && physical(state, body)) piles.set(at(state, body, 'z'), [...(piles.get(at(state, body, 'z')) ?? []), body]);
  }
  const lives = (): number => state[HEADER.counters + COUNTER.health] as number;
  /** Kde se troska ve slotu objevila; `null` = slot prázdný nebo troska už ujela. */
  const spawned = new Map<number, { x: number; y: number; z: number } | null>();
  const hit = new Set<number>();
  let steerTicks = 0;
  let brakeTicks = 0;
  let airTicks = 0;
  let jumps = 0;
  let streak = 0;
  let longestJump = 0;
  let crashes = 0;
  let boxesGone = 0;
  let debrisMoved = 0;
  let maxPhysics = 0;
  let finished = false;
  let next = 0;
  const clearance = (): number => at(state, player, 'y') - surfaceAt(ramps, at(state, player, 'x'), at(state, player, 'z'));
  try {
    for (let tick = 0; tick < P68_MAX_TICKS && outcomeOf(state) === 'running'; tick += 1) {
      while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
      const event = inputs[next];
      const input = event !== undefined && event.tick === tick ? event : NO_INPUT;
      const onSurface = clearance() <= STUNT_EVIDENCE.airSnap;
      const vz = at(state, player, 'vz');
      const health = lives();
      const before = new Set<number>();
      for (const boxes of piles.values()) for (const box of boxes) if (alive(state, box)) before.add(box);
      step(state, input, program);

      if (onSurface && (input.axis !== 0 || (input.buttons & (BUTTON.LEFT | BUTTON.RIGHT)) !== 0)) steerTicks += 1;
      if (onSurface && (input.buttons & BUTTON.DOWN) !== 0 && at(state, player, 'vz') < vz) brakeTicks += 1;
      const height = clearance();
      if (height > STUNT_EVIDENCE.airSnap) airTicks += 1;
      if (height >= STUNT_EVIDENCE.jumpHeight) {
        streak += 1;
        if (streak === STUNT_EVIDENCE.jumpTicks) jumps += 1;
        longestJump = Math.max(longestJump, streak);
      } else streak = 0;
      if (lives() < health) crashes += 1;
      for (const [z, boxes] of piles) {
        const gone = boxes.filter((box) => before.has(box) && !alive(state, box)).length;
        if (gone > 0) hit.add(z);
        boxesGone += gone;
      }
      let live = 0;
      for (let body = 0; body < count(); body += 1) {
        if (!physical(state, body)) {
          if (body >= spawnBase) spawned.delete(body);
          continue;
        }
        live += 1;
        if (body < spawnBase) continue;
        const where = { x: at(state, body, 'x'), y: at(state, body, 'y'), z: at(state, body, 'z') };
        if (!spawned.has(body)) {
          spawned.set(body, where);
          continue;
        }
        const from = spawned.get(body);
        if (from === null || from === undefined) continue;
        if (Math.hypot(where.x - from.x, where.y - from.y, where.z - from.z) > STUNT_EVIDENCE.debrisMoved) {
          debrisMoved += 1;
          spawned.set(body, null);
        }
      }
      maxPhysics = Math.max(maxPhysics, live);
      if (goal !== null && !finished) {
        finished = at(state, player, 'z') + at(state, player, 'd') / 2 > goal.z - goal.d / 2 && Math.abs(at(state, player, 'x') - goal.x) * 2 < goal.w + at(state, player, 'w');
      }
    }
    return {
      steerTicks,
      brakeTicks,
      airTicks,
      jumps,
      longestJump,
      crashes,
      impacts: hit.size,
      boxesGone,
      debrisMoved,
      maxPhysics,
      finished,
      outcome: outcomeOf(state),
      ticks: state[HEADER.tick] as number,
      hash: hashArcade(state),
    };
  } finally {
    releasePhysics(state);
  }
}
