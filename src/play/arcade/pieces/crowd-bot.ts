/**
 * Robot davu (P54C T10): na příští dvojici bran, kterou v pozorovaném stavu ještě neprošel, chce stranu s větším
 * výsledkem pro dav, který vidí (`betterSide`). Pozorovaný stav je o reakci starší: bránu, kterou právě prošel,
 * vidí až po reakci, a teprve pak ví, kolik davu má a kam běžet dál – začátečník (delší reakce) přeběh mezi
 * hustými dvojicemi nestihne a projde horší branou. Překážku v chtěném pruhu před bránou oběhne druhým pruhem.
 * Pruh volí znaménkem osy jen v tiku, kdy chce jiný než ten, kam už míří (pozorovaný pruh + vlastní nedávné vstupy).
 */

import { z } from 'zod';

import { AXIS_MAX, type ArcadeInput, type ArcadeObservation, BODY, type BotPiece, FLAG, HEADER, NO_INPUT, ROLE, bodyBase } from '../contract';
import { CROWD, type GateRef, betterSide, crowdOf, laneAfter } from './crowd';

const op = z.int().min(0).max(3);
const gateN = z.int().min(1).max(99);

const botParams = z
  .object({
    gates: z.array(z.tuple([z.int().min(0), op, gateN, op, gateN])).max(50),
    stop: z.int().min(0),
  })
  .strict();
export type CrowdBotParams = z.infer<typeof botParams>;

/** Pruh, kam hrdina míří: pozorovaný pruh a vstupy, které robot vydal a stav je ještě neukazuje. */
export function intendedLane(observation: ArcadeObservation): number {
  let lane = observation.state[bodyBase(observation.player) + BODY.aux0] as number;
  for (const input of observation.recent) lane = laneAfter(lane, input);
  return lane;
}

/** Pruh překážky `body`, která v pozorovaném stavu stojí před hrdinou v `z` a před bránou `gateZ`; jinak 0. */
function obstacleLane(state: Int32Array, body: number, z: number, gateZ: number): number {
  const base = bodyBase(body);
  if (state[base + BODY.role] !== ROLE.obstacle || ((state[base + BODY.flags] as number) & FLAG.alive) === 0) return 0;
  const oz = state[base + BODY.z] as number;
  if (oz + (state[base + BODY.d] as number) / 2 + CROWD.hero.d / 2 <= z || oz >= gateZ) return 0;
  return Math.sign(state[base + BODY.x] as number);
}

/** Pruh, který robot chce (−1 / +1), nebo 0 = nic (souboj, za poslední bránou). */
export function wantedLane(observation: ArcadeObservation, params: CrowdBotParams): number {
  const { state, player } = observation;
  const base = bodyBase(player);
  const z = state[base + BODY.z] as number;
  if (z >= params.stop) return 0;
  const gate = params.gates.find((candidate) => candidate[0] > z) as GateRef | undefined;
  if (gate === undefined) return 0;
  const lane = intendedLane(observation);
  let want = betterSide(gate, crowdOf(state), lane);
  const blocked = new Set<number>();
  for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) {
    const at = body === player ? 0 : obstacleLane(state, body, z, gate[0]);
    if (at !== 0) blocked.add(at);
  }
  if (blocked.has(want) && !blocked.has(-want)) want = -want;
  return want;
}

export function crowdDecide(observation: ArcadeObservation, params: CrowdBotParams): ArcadeInput {
  const want = wantedLane(observation, params);
  return want === 0 || want === intendedLane(observation) ? NO_INPUT : { buttons: 0, axis: want * AXIS_MAX };
}

/** Jak daleko před překážkou (tiky běhu) do ní sonda zahne. */
const PROBE_TICKS = 40;

/** Sonda hrozby: hraje jako robot, dokud překážka `target` není blízko před hrdinou; pak zahne do jejího pruhu. */
export function crowdProbeInput(observation: ArcadeObservation, target: number, normal: ArcadeInput): ArcadeInput {
  const { state, player } = observation;
  const t = bodyBase(target);
  if (((state[t + BODY.flags] as number) & FLAG.alive) === 0) return normal;
  const ahead = (state[t + BODY.z] as number) - (state[bodyBase(player) + BODY.z] as number);
  if (ahead < 0 || ahead > PROBE_TICKS * CROWD.speed) return normal;
  const lane = Math.sign(state[t + BODY.x] as number);
  return lane === intendedLane(observation) ? NO_INPUT : { buttons: 0, axis: lane * AXIS_MAX };
}

export const crowdBot: BotPiece<CrowdBotParams> = {
  id: 'crowd_bot',
  params: botParams,
  roles: ['player', 'obstacle'],
  reactionTicks: CROWD.reaction,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: crowdDecide,
};
