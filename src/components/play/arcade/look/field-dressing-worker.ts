/**
 * Worker kulis v hrací ploše (P62 T4). Kus se nesmí dotknout cesty robota a tu zná jen jeho běh:
 * `runBot` stojí v Node nad arénami P62 60–400 ms (naměřeno 27. 10.), telefon by na startu hry
 * zamrzl. Worker pustí týž `runBot(world)` jako kompilace na serveru, přehraje jeho vstupy a vrátí
 * místa kusů (`fieldDressing`) – hlavní vlákno jen postaví hotové kusy.
 *
 * Logika sedí v čisté `fieldJob()` (test ji volá přímo); obsluha zprávy kolem ní je tenká, jako
 * v `feed/bot-worker.ts`. Stav ani streamy hry se nemění: běh je kopie ve workeru.
 */

import { baseControlOf } from '@/play/arcade/addons';
import { ARCADE_LIMITS, type ArcadeWorld, BODY, FLAG, HEADER, NO_INPUT, ROLE, UNIT, bodyBase } from '@/play/arcade/contract';
import { instantiate, loadProgram, step, worldHasPhysics } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import type { Look } from '@/play/arcade/look';
import { releasePhysics } from '@/play/arcade/physics/step';
import { loadRapier } from '@/play/arcade/physics/world';
import { ARENA } from '@/play/arcade/pieces/arena';
import { SHOOTER } from '@/play/arcade/pieces/shooter';
import { runBot } from '@/play/arcade/verify';

import { FIGHT_TILT, STYLED_TILT } from '../arena/arena-camera';
import { bodiesOf, bodiesStale, drawsNothing } from '../bodies';
import { TALL, WIDE } from '../shooter/view';
import { type FieldArea, type FieldJob, type FieldPiece, type FieldSpot, type FieldView, fieldDressing } from './field-dressing';

/** Odstup paty kusu od stěny arény (m). */
const EDGE_M = 0.5;
/** Kus střelnice stojí až tolik metrů před hráčem: blíž by v obraze na šířku vjel do kamery. */
const RANGE_NEAR_M = 2;
/** Mřížka (m), po které se slévají místa stopy: na hustotě tiků nezáleží a střed buňky je od každého jejího bodu nejvýš 0,36 m, pod `KEEP_M`. */
const GRID_M = 0.5;

/** Místa stopy slitá do středů buněk mřížky; v buňce zůstane největší kvádr. */
class Spots {
  private readonly cells = new Map<string, FieldSpot>();
  add(x: number, z: number, view: { readonly w: number; readonly d: number; readonly h: number }): void {
    const [i, j] = [Math.round(x / GRID_M), Math.round(z / GRID_M)];
    const key = `${String(i)},${String(j)}`;
    const known = this.cells.get(key);
    const [hx, hz] = [view.w / 2, view.d / 2];
    if (known === undefined || known.hx < hx || known.hz < hz || known.h < view.h) {
      this.cells.set(key, { x: i * GRID_M, z: j * GRID_M, hx: Math.max(hx, known?.hx ?? 0), hz: Math.max(hz, known?.hz ?? 0), h: Math.max(view.h, known?.h ?? 0) });
    }
  }
  list(): FieldSpot[] {
    return [...this.cells.values()];
  }
}

/** Plocha a kamera podle ovládání: aréna (útěk, sběr, úkol, souboj) a střelnice; jiné ovládání plochu nezdobí. */
function frameOf(world: ArcadeWorld): { readonly area: FieldArea; readonly view: FieldView } | null {
  const control = baseControlOf(world.control);
  if (control.id === 'move_free' || control.id === 'fight') {
    const half = Number(control.params.half ?? ARENA.half) / UNIT - EDGE_M;
    const tilt = control.id === 'fight' ? FIGHT_TILT : STYLED_TILT;
    return { area: { x0: -half, x1: half, z0: -half, z1: half }, view: { follow: tilt.sin / tilt.cos } };
  }
  if (control.id !== 'shooter') return null;
  const player = bodyBase(world.initial[HEADER.player] as number);
  // Jádro má +x vlevo od kamery, scéna ho zrcadlí (x → −x).
  const x = -(world.initial[player + BODY.x] as number) / UNIT;
  const z = (world.initial[player + BODY.z] as number) / UNIT;
  const range = SHOOTER.range / UNIT;
  return {
    area: { x0: x - range, x1: x + range, z0: z + RANGE_NEAR_M, z1: z + range, cone: { x, z, tan: SHOOTER.tanMax, range } },
    // Kamera na šířku stojí na ose střelnice, na výšku nad hráčem (natočení 0 = ke středu kuželu).
    view: { eyes: [[0, WIDE.up, z - WIDE.back], [x, TALL.up, z - TALL.back]] },
  };
}

/**
 * Stopa běhu robota pro výzdobu plochy; `null` = ovládání bez zdobené plochy. Hrdina každý tik,
 * ostatní kreslená těla (kromě střel) v tiku, kdy se objevila, a u střelnice všechno po celé
 * dráze i se střelami – nepřítel tam jde po přímce k hráči, terč kyvadlem a rána letí z hlavně
 * k nim: kus v cestě by prošli a stojan uprostřed střelnice by stál v paprsku zaměřovače.
 */
export function fieldJob(world: ArcadeWorld): FieldJob | null {
  const frame = frameOf(world);
  if (frame === null) return null;
  const bot = runBot(world);
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  const session = { world, state: () => state };
  const tracks = baseControlOf(world.control).id === 'shooter';
  let views = bodiesOf(session);
  const alive = new Set<number>();
  const hero = bodyBase(state[HEADER.player] as number);
  const start = { x: -(state[hero + BODY.x] as number) / UNIT, z: (state[hero + BODY.z] as number) / UNIT };
  const path = new Spots();
  const bodies = new Spots();
  let next = 0;
  for (let tick = 0; tick <= ARCADE_LIMITS.maxTicks; tick += 1) {
    if (bodiesStale(views, session)) views = bodiesOf(session);
    for (const view of views) {
      const base = bodyBase(view.index);
      if (((state[base + BODY.flags] as number) & FLAG.alive) === 0) {
        alive.delete(view.index);
        continue;
      }
      if (drawsNothing(view) || (view.role === ROLE.projectile && !tracks)) continue;
      const x = -(state[base + BODY.x] as number) / UNIT;
      const z = (state[base + BODY.z] as number) / UNIT;
      const spawned = !alive.has(view.index);
      alive.add(view.index);
      if (view.role === ROLE.player) path.add(x, z, view);
      else if (spawned || tracks) bodies.add(x, z, view);
    }
    if (state[HEADER.runState] !== 0 || tick > bot.tick) break;
    while (next < bot.inputs.length && bot.inputs[next]!.tick < tick) next += 1;
    const event = bot.inputs[next];
    step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program);
  }
  // Běh, který nedojel do konce, svět Rapieru neuvolní sám.
  releasePhysics(state);
  return { ...frame, start, path: path.list(), bodies: bodies.list() };
}

export interface FieldWorkerRequest {
  readonly id: number;
  readonly world: ArcadeWorld;
  readonly look: Look;
}

export interface FieldWorkerResponse {
  readonly id: number;
  /** Prázdné = plocha bez kusů (jiné ovládání, sada bez vhodného modelu, nebo chyba běhu). */
  readonly pieces: readonly FieldPiece[];
}

export async function handleFieldJob({ id, world, look }: FieldWorkerRequest): Promise<FieldWorkerResponse> {
  try {
    if (worldHasPhysics(world)) await loadRapier();
    const job = fieldJob(world);
    return { id, pieces: job === null ? [] : fieldDressing({ look, seed: world.seed, ...job }) };
  } catch {
    // Výzdoba je jen vzhled: hra bez ní hraje dál.
    return { id, pieces: [] };
  }
}

/** Jen ta část `self`, kterou worker používá (knihovna `webworker` se s `dom` v jednom `tsconfig` nesnese). */
interface FieldWorkerScope {
  postMessage(message: FieldWorkerResponse): void;
  onmessage: ((event: { data: FieldWorkerRequest }) => void) | null;
}

// Obsluha jen tam, kde `self` je worker – ne v okně, v Node ani v SSR.
const workerScope: FieldWorkerScope | undefined =
  typeof self !== 'undefined' && typeof self.postMessage === 'function' && !('document' in self) ? (self as unknown as FieldWorkerScope) : undefined;

if (workerScope !== undefined) {
  workerScope.onmessage = (event) => {
    void handleFieldJob(event.data).then((response) => workerScope.postMessage(response));
  };
}
