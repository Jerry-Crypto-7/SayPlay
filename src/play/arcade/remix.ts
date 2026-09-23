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
 * Střelba a hod (P25G T6): `harder` = další obtížnost; `twist` = životy nebo
 * limit u střelby, u hodu jen limit; `swap_enemy` = střelba přejmenuje
 * nepřátele a přepne pohyb terčů, hod vymění cíl (terč → koš → věž).
 *
 * Načasování, rytmus a souboj (P25H T5): `harder` = rychlost / hustota /
 * obtížnost, pak kola nebo tempo; `twist` = životy (načasování) nebo limit;
 * `swap_enemy` přejmenuje, co hráč trefuje – blok, notu, soupeře.
 *
 * Funkce mění `child` na místě; záplatu z něj staví `remixPatch`.
 */

import { type GameSpecV1, arenaWinOf } from '../spec';

import { ARENA_DENSITIES, arenaLevel } from './pieces/arena';
import { DUEL_DIFFICULTIES, duelArena } from './pieces/duel';
import { FLAP_DIFFICULTIES, FLAP_TRACK, flapTrack } from './pieces/flap';
import { PLATFORM_DIFFICULTIES, PLATFORM_LEVEL, platformLevel } from './pieces/platform';
import { RHYTHM, RHYTHM_DENSITIES, rhythmLevel } from './pieces/rhythm';
import { RUNNER_DENSITIES, RUNNER_SPEEDS, RUNNER_TRACK, type ObstacleKind, runnerTrack } from './pieces/runner';
import { SHOOTER_DIFFICULTIES, type ShooterDifficulty, shooterRange } from './pieces/shooter';
import { STEER_DIFFICULTIES, STEER_TRACK, steerTrack } from './pieces/steer';
import { THROW_DIFFICULTIES, THROW_GOALS, THROW_GOAL_LABELS, type ThrowDifficulty, throwField } from './pieces/throw';
import { TIMING, TIMING_SPEEDS, timingLevel } from './pieces/timing';

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

/**
 * Aréna: jen hustší. Delší přežití by muselo přepsat časovač, cíl i text
 * najednou – hustá aréna už těžší není.
 */
function arenaHarder(child: GameSpecV1): boolean {
  const density = next(ARENA_DENSITIES, arenaLevel.params.parse({ ...child.controlParams }).density);
  if (density === null) return false;
  child.controlParams = { ...child.controlParams, density };
  return true;
}

/** Plošinovka, poletování a závod: další obtížnost, jinak delší trať do stropu; aréna zvlášť. */
export function difficultyHarder(child: GameSpecV1): boolean {
  if (child.control === 'move_free') return arenaHarder(child);
  const flap = child.control === 'flap';
  const steer = child.control === 'steer';
  const params = steer ? steerTrack.params.parse({ ...child.controlParams }) : flap ? flapTrack.params.parse({ ...child.controlParams }) : platformLevel.params.parse({ ...child.controlParams });
  const difficulty = next<string>(steer ? STEER_DIFFICULTIES : flap ? FLAP_DIFFICULTIES : PLATFORM_DIFFICULTIES, params.difficulty);
  const ceiling = steer ? STEER_TRACK.maxLengthM : flap ? FLAP_TRACK.maxLengthM : PLATFORM_LEVEL.maxLengthM;
  const change = difficulty !== null ? { difficulty } : params.lengthM < ceiling ? { lengthM: Math.min(ceiling, params.lengthM + 50) } : null;
  if (change === null) return false;
  child.controlParams = { ...child.controlParams, ...change };
  return true;
}

/** Střelba a hod (P25G): další obtížnost; na nejtěžší už čip nemá co přitvrdit. */
export function aimHarder(child: GameSpecV1): boolean {
  const current = child.control === 'shooter' ? shooterRange.params.parse({ ...child.controlParams }).difficulty : throwField.params.parse({ ...child.controlParams }).difficulty;
  const difficulty = next<ShooterDifficulty | ThrowDifficulty>(child.control === 'shooter' ? SHOOTER_DIFFICULTIES : THROW_DIFFICULTIES, current);
  if (difficulty === null) return false;
  child.controlParams = { ...child.controlParams, difficulty };
  return true;
}

/** Načasování, rytmus a souboj: rychlejší / hustší / těžší, pak víc kol nebo rychlejší tempo. */
export function beatHarder(child: GameSpecV1): boolean {
  let change: Record<string, unknown> | null = null;
  if (child.control === 'timing') {
    const params = timingLevel.params.parse({ ...child.controlParams });
    const speed = next(TIMING_SPEEDS, params.speed);
    change = speed !== null ? { speed } : params.rounds < TIMING.maxRounds ? { rounds: Math.min(TIMING.maxRounds, params.rounds + 3) } : null;
  } else if (child.control === 'rhythm') {
    const params = rhythmLevel.params.parse({ ...child.controlParams });
    const density = next(RHYTHM_DENSITIES, params.density);
    change = density !== null ? { density } : params.bpm < RHYTHM.maxBpm ? { bpm: Math.min(RHYTHM.maxBpm, params.bpm + 20) } : null;
  } else {
    const difficulty = next(DUEL_DIFFICULTIES, duelArena.params.parse({ ...child.controlParams }).difficulty);
    change = difficulty !== null ? { difficulty } : null;
  }
  if (change === null) return false;
  child.controlParams = { ...child.controlParams, ...change };
  return true;
}

// Text cíle po twistu; u běžce zůstává původní znění (P25A).
const LIVES_LINE: Readonly<Record<string, string>> = {
  runner: 'Run to the finish line. You have 3 lives.',
  platform: 'Jump to the flag. Spikes cost a life – you have 3.',
  flap: 'Fly to the finish. A pipe costs a life – you have 3.',
  shooter: 'Hit every target. An enemy that reaches you costs a life – you have 3.',
  move_free: 'A bite costs a life – you have 3.',
  timing: 'Stop each block over the target. A miss costs a life – you have 3.',
};

const TIMER_LINE: Readonly<Record<string, (seconds: string) => string>> = {
  shooter: (seconds) => `Hit every target and stop every wave within ${seconds} seconds.`,
  throw: (seconds) => `Hit every target within ${seconds} seconds.`,
  move_free: (seconds) => `Outgrow every hunter within ${seconds} seconds.`,
  timing: (seconds) => `Finish every round within ${seconds} seconds.`,
  rhythm: (seconds) => `Play the song to the last beat within ${seconds} seconds.`,
  duel: (seconds) => `Knock your rival out within ${seconds} seconds.`,
};

function withHealth(child: GameSpecV1): GameSpecV1 | null {
  // Závod životy nečte (náraz do mantinelu zastaví, soupeř v cíli vyhraje) – twist je tam jen limit.
  if (child.control === 'steer' || child.mechanics.some((m) => m.id === 'health')) return null;
  const probe = structuredClone(child);
  probe.mechanics.push({ id: 'health', params: { max: 3 } });
  // Zásah teď ubírá život – jádro to čte z přítomnosti `health`, text i spec to musí říct taky.
  for (const m of probe.mechanics) if (m.id === 'hazard_zone') (m.params as Record<string, unknown>).effect = 'damage';
  // Aréna si nechá svůj cíl (vyrůst včas / přežít N s) – životy jen přidá.
  probe.objective.description =
    child.control === 'move_free' ? `${child.tutorial.goalLine} ${LIVES_LINE.move_free!}` : (LIVES_LINE[child.control ?? 'runner'] ?? LIVES_LINE.runner!);
  return probe;
}

function withTimer(child: GameSpecV1): GameSpecV1 | null {
  if (child.mechanics.some((m) => m.id === 'timer')) return null;
  // Aréna na přežití už na čas vyhrává; limit „vyrůst do N s“ by jí lhal.
  if (child.control === 'move_free' && (arenaWinOf(child) as { goal?: string }).goal === 'survive') return null;
  const probe = structuredClone(child);
  probe.mechanics.push({ id: 'timer', params: { id: 'clock', seconds: child.targetDurationSec, onEnd: 'lose' } });
  const seconds = String(child.targetDurationSec);
  probe.objective.description = TIMER_LINE[child.control ?? 'runner']?.(seconds) ?? `Reach the finish line within ${seconds} seconds.`;
  return probe;
}

export function runnerTwist(child: GameSpecV1, pick: Pick, accept?: (spec: GameSpecV1) => boolean): boolean {
  // Hod nemá čím ubrat život – jediný twist je časový limit.
  const makers = child.control === 'throw' ? [withTimer] : [withHealth, withTimer];
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
  steer: ['rival car', 'police car', 'taxi', 'go-kart'],
  move_free: ['big fish', 'shark', 'giant cell', 'whale'],
};

// Co hráč trefuje u načasování, rytmu a souboje – role a popisky pro `swap_enemy`.
const TARGET_LABELS: Readonly<Record<string, { readonly role: string; readonly labels: readonly string[] }>> = {
  timing: { role: 'block', labels: ['block', 'crate', 'pancake', 'cake layer'] },
  rhythm: { role: 'note', labels: ['tile', 'drum', 'star', 'gem'] },
  duel: { role: 'rival', labels: ['ninja', 'samurai', 'robot', 'bear'] },
};

/** Načasování, rytmus a souboj: jiný popisek toho, co hráč trefuje; hra se nemění. */
export function targetSwap(child: GameSpecV1, pick: Pick): boolean {
  const entry = TARGET_LABELS[child.control ?? ''];
  const target = child.roles.find((role) => role.id === entry?.role);
  if (entry === undefined || target === undefined) return false;
  const labels = entry.labels.filter((label) => label !== target.label);
  target.label = labels[pick(labels.length)] ?? target.label;
  return true;
}

/**
 * Plošinovka: přepne pohyblivé plošiny a přejmenuje hroty; poletování: přejmenuje
 * trubky; závod přejmenuje soupeře, aréna větší buňky.
 */
export function hazardSwap(child: GameSpecV1, pick: Pick): boolean {
  const control = child.control === 'flap' || child.control === 'steer' || child.control === 'move_free' ? child.control : 'platform';
  const hazard = child.roles.find((role) => (control === 'steer' ? role.id === 'rival' : role.kind === 'hazard'));
  if (hazard === undefined) return false;
  const labels = (HAZARD_LABELS[control] ?? []).filter((label) => label !== hazard.label);
  hazard.label = labels[pick(labels.length)] ?? hazard.label;
  if (control === 'platform') {
    const moving = platformLevel.params.parse({ ...child.controlParams }).movingPlatforms;
    child.controlParams = { ...child.controlParams, movingPlatforms: !moving };
  }
  return true;
}

const ENEMY_LABELS: readonly string[] = ['robot', 'zombie', 'alien', 'ghost'];

/** Střelba: jiní nepřátelé a terče přepnou pohyb; hod: jiný cíl (terč → koš → věž). */
export function aimSwap(child: GameSpecV1, pick: Pick): boolean {
  if (child.control === 'shooter') {
    const enemy = child.roles.find((role) => role.id === 'enemy');
    if (enemy !== undefined) {
      const labels = ENEMY_LABELS.filter((label) => label !== enemy.label);
      enemy.label = labels[pick(labels.length)] ?? enemy.label;
    }
    const moving = shooterRange.params.parse({ ...child.controlParams }).moving;
    child.controlParams = { ...child.controlParams, moving: !moving };
    return true;
  }
  const current = throwField.params.parse({ ...child.controlParams }).goal;
  const others = THROW_GOALS.filter((goal) => goal !== current);
  const goal = current === undefined ? others[pick(others.length)] : THROW_GOALS[(THROW_GOALS.indexOf(current) + 1) % THROW_GOALS.length];
  if (goal === undefined) return false;
  child.controlParams = { ...child.controlParams, goal };
  const target = child.roles.find((role) => role.id === 'target');
  if (target !== undefined) target.label = THROW_GOAL_LABELS[goal];
  return true;
}
