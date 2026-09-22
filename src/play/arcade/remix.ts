/**
 * Remix čipy na běžci (P25A T8). Mřížkové čipy (`src/play/director/remix.ts`)
 * mění mechaniky a role, které běžec nečte – trať staví generátor z
 * `controlParams`. Tady:
 *
 * - `harder` – právě jeden parametr tratě: rychlost, když ještě není `fast`,
 *   jinak hustota, jinak délka (+100 m do stropu);
 * - `twist` – pravidlo navíc: 3 životy (zásah ubírá místo prohry), nebo
 *   časový limit; jen kandidát, který projde `accept` (= `verifyArcade`);
 * - `swap_enemy` – jiná sada překážek a popisek role `obstacle`;
 * - `reskin` – mřížkový `reskin` beze změny (téma a popisky jsou společné).
 *
 * Plošinovka a poletování (P25C T8) stejně: `harder` = další obtížnost,
 * pak délka; `twist` = životy nebo limit; `swap_enemy` = plošinovka
 * přepne pohyblivé plošiny a přejmenuje hroty, poletování přejmenuje
 * trubky (geometrie trubek je jediná, kterou generátor má).
 *
 * Funkce mění `child` na místě; záplatu z něj staví `remixPatch`.
 */

import type { GameSpecV1 } from '../spec';

import { FLAP_DIFFICULTIES, FLAP_TRACK, flapTrack } from './pieces/flap';
import { PLATFORM_DIFFICULTIES, PLATFORM_LEVEL, platformLevel } from './pieces/platform';
import { RUNNER_DENSITIES, RUNNER_SPEEDS, RUNNER_TRACK, type ObstacleKind, runnerTrack } from './pieces/runner';

type Pick = (max: number) => number;

const OBSTACLE_LABELS: Readonly<Record<ObstacleKind, string>> = {
  hurdle: 'hurdle',
  'slide-bar': 'low bar',
  cone: 'traffic cone',
  crate: 'crate',
};

// Sady překážek pro `swap_enemy`; každá drží skok i skluz nebo pruh, aby trať zůstala hratelná generátorem.
const OBSTACLE_SETS: readonly (readonly ObstacleKind[])[] = [
  ['hurdle', 'cone'],
  ['slide-bar', 'crate'],
  ['cone', 'crate'],
  ['hurdle', 'slide-bar'],
];

function next<T>(values: readonly T[], current: T): T | null {
  const index = values.indexOf(current);
  return index < values.length - 1 ? values[index + 1] : null;
}

export function runnerHarder(child: GameSpecV1): boolean {
  const params = runnerTrack.params.parse({ ...child.controlParams });
  const speed = next(RUNNER_SPEEDS, params.speed);
  const density = next(RUNNER_DENSITIES, params.density);
  const change =
    speed !== null ? { speed }
    : density !== null ? { density }
    : params.lengthM < RUNNER_TRACK.maxLengthM ? { lengthM: Math.min(RUNNER_TRACK.maxLengthM, params.lengthM + 100) }
    : null;
  if (change === null) return false;
  child.controlParams = { ...child.controlParams, ...change };
  return true;
}

/** Plošinovka a poletování: další obtížnost, jinak delší trať do stropu. */
export function difficultyHarder(child: GameSpecV1): boolean {
  const flap = child.control === 'flap';
  const params = flap ? flapTrack.params.parse({ ...child.controlParams }) : platformLevel.params.parse({ ...child.controlParams });
  const difficulty = next<string>(flap ? FLAP_DIFFICULTIES : PLATFORM_DIFFICULTIES, params.difficulty);
  const ceiling = flap ? FLAP_TRACK.maxLengthM : PLATFORM_LEVEL.maxLengthM;
  const change = difficulty !== null ? { difficulty } : params.lengthM < ceiling ? { lengthM: Math.min(ceiling, params.lengthM + 50) } : null;
  if (change === null) return false;
  child.controlParams = { ...child.controlParams, ...change };
  return true;
}

// Text cíle po twistu; u běžce zůstává původní znění (P25A).
const LIVES_LINE: Readonly<Record<string, string>> = {
  runner: 'Run to the finish line. You have 3 lives.',
  platform: 'Jump to the flag. Spikes cost a life – you have 3.',
  flap: 'Fly to the finish. A pipe costs a life – you have 3.',
};

function withHealth(child: GameSpecV1): GameSpecV1 | null {
  if (child.mechanics.some((m) => m.id === 'health')) return null;
  const probe = structuredClone(child);
  probe.mechanics.push({ id: 'health', params: { max: 3 } });
  // Zásah teď ubírá život – jádro to čte z přítomnosti `health`, text i spec to musí říct taky.
  for (const m of probe.mechanics) if (m.id === 'hazard_zone') (m.params as Record<string, unknown>).effect = 'damage';
  probe.objective.description = LIVES_LINE[child.control ?? 'runner'] ?? LIVES_LINE.runner!;
  return probe;
}

function withTimer(child: GameSpecV1): GameSpecV1 | null {
  if (child.mechanics.some((m) => m.id === 'timer')) return null;
  const probe = structuredClone(child);
  probe.mechanics.push({ id: 'timer', params: { id: 'clock', seconds: child.targetDurationSec, onEnd: 'lose' } });
  probe.objective.description = `Reach the finish line within ${String(child.targetDurationSec)} seconds.`;
  return probe;
}

export function runnerTwist(child: GameSpecV1, pick: Pick, accept?: (spec: GameSpecV1) => boolean): boolean {
  const makers = [withHealth, withTimer];
  const start = pick(makers.length);
  for (let step = 0; step < makers.length; step += 1) {
    const probe = makers[(start + step) % makers.length](child);
    if (probe === null || (accept !== undefined && !accept(probe))) continue;
    Object.assign(child, probe);
    return true;
  }
  return false;
}

export function runnerSwapObstacles(child: GameSpecV1, pick: Pick): boolean {
  const current = runnerTrack.params.parse({ ...child.controlParams }).obstacles.join(',');
  const candidates = OBSTACLE_SETS.filter((set) => set.join(',') !== current);
  const set = candidates[pick(candidates.length)];
  child.controlParams = { ...child.controlParams, obstacles: [...set] };
  const obstacle = child.roles.find((role) => role.id === 'obstacle');
  if (obstacle !== undefined) obstacle.label = OBSTACLE_LABELS[set[0]];
  return true;
}

// Popisky překážky, které sedí na kreslený tvar (řada hrotů / svislý sloup).
const HAZARD_LABELS: Readonly<Record<string, readonly string[]>> = {
  platform: ['spikes', 'thorns', 'saw teeth', 'icicles'],
  flap: ['pipe', 'pillar', 'tree trunk', 'chimney'],
};

/** Plošinovka: přepne pohyblivé plošiny a přejmenuje hroty; poletování: přejmenuje trubky. */
export function hazardSwap(child: GameSpecV1, pick: Pick): boolean {
  const control = child.control === 'flap' ? 'flap' : 'platform';
  const hazard = child.roles.find((role) => role.kind === 'hazard');
  if (hazard === undefined) return false;
  const labels = (HAZARD_LABELS[control] ?? []).filter((label) => label !== hazard.label);
  hazard.label = labels[pick(labels.length)] ?? hazard.label;
  if (control === 'platform') {
    const moving = platformLevel.params.parse({ ...child.controlParams }).movingPlatforms;
    child.controlParams = { ...child.controlParams, movingPlatforms: !moving };
  }
  return true;
}
