/**
 * Zdroj ducha (P37C T3): druhá instance jádra přehrává uložený běh výzvy
 * (vstupy a živé změny, `DareReplay` z P37C T1) v kroku s tikem hráče a dává
 * `poseAt(tick)` pro `GhostSlot`. Přehrání je týž průchod jako `replayLive`,
 * takže duch dojede k témuž hashi konce, jaký server spočítal při ověření výzvy.
 *
 * Duch má vlastní stav, vlastní program i vlastní svět Rapieru (ten patří
 * instanci stavu); stav hráče nevidí a nesahá na něj – hash hráčovy hry je
 * s duchem i bez něj týž (`__tests__/ghost-source.test.ts`).
 *
 * Krokuje se líně: `poseAt` dotočí ducha k tiku, na který se scéna ptá.
 * Hráč jde dopředu po tiku, takže to stojí jeden krok jádra na tik; póza
 * tiku před tím je v paměti pro interpolaci. Dotaz do minulosti (restart
 * hráče) přehraje ducha znovu od tiku 0.
 */

import { ARCADE_LIMITS, type ArcadeWorld, BODY, HEADER, type InputEvent, NO_INPUT, bodyBase } from '@/play/arcade/contract';
import { type ArcadeLibrary, type ArcadeOutcome, hashArcade, outcomeOf, worldHasPhysics } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { type LiveEntry, type LivePatch, type LiveRun, startLive, stepLive } from '@/play/arcade/live';
import { releasePhysics } from '@/play/arcade/physics/step';
import { loadRapier } from '@/play/arcade/physics/world';
import { unpackInputs } from '@/play/score/dare';

import type { GhostPose, GhostSource } from './GhostSlot';

/** Běh pro ducha rozbalený a zkontrolovaný: vstupy seřazené podle tiku a živé změny. */
export interface GhostRun {
  readonly inputs: readonly InputEvent[];
  readonly patches: readonly LiveEntry[];
}

/** Kde a jak duchův běh skončil – týž tik a hash jako výzva, kterou server ověřil. */
export interface GhostEnd {
  readonly tick: number;
  readonly outcome: ArcadeOutcome;
  readonly hash: string;
}

export interface GhostReplay extends GhostSource {
  /** Konec záznamu, jakmile ho duch dojel; `null`, dokud jede. */
  end(): GhostEnd | null;
  /** Uvolní svět Rapieru rozjetého ducha (scéna ducha odmontovala). */
  dispose(): void;
}

const COUNTERS = new Set(['health', 'time', 'ammo']);
const whole = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

/** Tvar živé změny, jak ho zapisuje `POST …/dare`; obsah (roli, strop) hlídá jádro při přehrání (`patchProblem`). */
function isPatch(value: unknown): value is LivePatch {
  if (typeof value !== 'object' || value === null) return false;
  const patch = value as Record<string, unknown>;
  if (patch.kind === 'spawn') return typeof patch.role === 'string' && whole(patch.count);
  if (patch.kind === 'count') return typeof patch.counter === 'string' && COUNTERS.has(patch.counter) && whole(patch.amount);
  return patch.kind === 'visual';
}

function isEntry(value: unknown): value is LiveEntry {
  if (typeof value !== 'object' || value === null) return false;
  const { tick, patch } = value as Record<string, unknown>;
  return whole(tick) && tick >= 0 && tick < ARCADE_LIMITS.maxTicks && isPatch(patch);
}

/**
 * Běh z odpovědi `GET /api/play/games/:id/dare/:dareId` (pole `replay`).
 * Kontrola na hranici: `null` = výzva bez ducha (chybí, jiná verze tvaru,
 * rozbitý záznam) – hra pak běží bez něj.
 */
export function ghostRunOf(replay: unknown): GhostRun | null {
  if (typeof replay !== 'object' || replay === null) return null;
  const { v, inputs, patches } = replay as Record<string, unknown>;
  if (v !== 1 || !Array.isArray(patches) || !patches.every(isEntry)) return null;
  const unpacked = unpackInputs(inputs);
  return typeof unpacked === 'string' ? null : { inputs: unpacked, patches: [...patches].sort((a, b) => a.tick - b.tick) };
}

/** Natočení kolem svislé osy podle vodorovné rychlosti v osách jádra (0 = po +z); stojící tělo drží poslední. */
function headingOf(state: Int32Array, base: number, was: number): number {
  const vx = state[base + BODY.vx] as number;
  const vz = state[base + BODY.vz] as number;
  return vx === 0 && vz === 0 ? was : Math.atan2(vx, vz);
}

export function createGhostSource(world: ArcadeWorld, run: GhostRun, library: ArcadeLibrary = ARCADE_LIBRARY): GhostReplay {
  let live: LiveRun = startLive(world, library);
  let nextInput = 0;
  let nextPatch = 0;
  let current: GhostPose = { x: 0, y: 0, z: 0, yaw: 0 };
  let previous: GhostPose | null = null;
  let ended: GhostEnd | null = null;

  const tickNow = (): number => live.state[HEADER.tick] as number;

  const poseNow = (was: number): GhostPose => {
    const state = live.state;
    const base = bodyBase(state[HEADER.player] as number);
    return { x: state[base + BODY.x] as number, y: state[base + BODY.y] as number, z: state[base + BODY.z] as number, yaw: headingOf(state, base, was) };
  };

  const rewind = (): void => {
    releasePhysics(live.state);
    live = startLive(world, library);
    nextInput = 0;
    nextPatch = 0;
    current = poseNow(0);
    previous = null;
    ended = null;
  };

  /** Jeden tik týmž výběrem vstupu a změn jako `replayLive`. */
  const stepOnce = (): void => {
    const tick = tickNow();
    while (nextInput < run.inputs.length && (run.inputs[nextInput] as InputEvent).tick < tick) nextInput += 1;
    while (nextPatch < run.patches.length && (run.patches[nextPatch] as LiveEntry).tick < tick) nextPatch += 1;
    const due: LivePatch[] = [];
    while (nextPatch < run.patches.length && (run.patches[nextPatch] as LiveEntry).tick === tick) due.push((run.patches[nextPatch++] as LiveEntry).patch);
    const event = run.inputs[nextInput];
    stepLive(world, live, event !== undefined && event.tick === tick ? event : NO_INPUT, due);
    previous = current;
    current = poseNow(current.yaw);
    if (outcomeOf(live.state) !== 'running') ended = { tick: tickNow(), outcome: outcomeOf(live.state), hash: hashArcade(live.state) };
  };

  current = poseNow(0);
  return {
    poseAt: (tick) => {
      if (!Number.isInteger(tick) || tick < 0) return null;
      if (tick === tickNow() - 1) return previous;
      if (tick < tickNow()) rewind();
      while (tickNow() < tick && ended === null && tickNow() < ARCADE_LIMITS.maxTicks) stepOnce();
      // Za koncem záznamu duch není: dojel, scéna ho nechá zmizet.
      return tickNow() === tick ? current : null;
    },
    end: () => ended,
    dispose: () => releasePhysics(live.state),
  };
}

/**
 * Duch výzvy z úložiště: přečte běh (`GET …/dare/:dareId`) a postaví zdroj.
 * Hra s fyzikou počká na Rapier – duch bez něj nekrokuje. Výzva bez běhu,
 * neznámá, prošlá nebo nedostupná = `null`: hra běží dál, jen bez ducha.
 */
export async function fetchGhost(versionId: string, dareId: string, world: ArcadeWorld, fetcher: typeof fetch = fetch): Promise<GhostReplay | null> {
  try {
    const response = await fetcher(`/api/play/games/${encodeURIComponent(versionId)}/dare/${encodeURIComponent(dareId)}`);
    if (!response.ok) return null;
    const run = ghostRunOf(((await response.json()) as { replay?: unknown }).replay);
    if (run === null) return null;
    if (worldHasPhysics(world)) await loadRapier();
    return createGhostSource(world, run);
  } catch {
    return null;
  }
}
