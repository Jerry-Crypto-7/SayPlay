/**
 * Vizuální póza těla arkády (P26B T1). Čistá funkce: z pohledu těla (rychlost,
 * na zemi, zásah) a z předchozí pózy spočítá poskok, náklon, zmáčknutí a
 * bliknutí. Čte jen tik, nikdy hodiny – stejný záznam dá stejný pohyb – a do
 * hashovaného stavu nic nepíše; scéna pózu jen přičte ke kreslené skupině.
 */

import { ARCADE_HZ, BODY, COUNTER, FLAG, HEADER, ROLE, RUN_STATE, UNIT, bodyBase } from './contract';

/** Co scéna ví o těle v jednom tiku. Rychlosti jsou jednotky jádra za tik. */
export interface MotionView {
  readonly vx: number;
  readonly vy: number;
  readonly vz: number;
  readonly grounded: boolean;
  readonly alive: boolean;
  /** Tělo v tomhle tiku dostalo zásah (hráči ubyl život, cíl zmizel). */
  readonly hit: boolean;
  /** Tělo v tomhle tiku vystřelilo nebo hodilo (hráči naskočilo čekání zbraně). */
  readonly shot: boolean;
  /** Hráč vyhrál běh (P54B T5); chybí = nevyhrál. */
  readonly won?: boolean;
}

/**
 * `bob` metry nahoru, `lean` radiány předklonu po +z (záporný = po −z),
 * `squash` > 0 zmáčknutí / < 0 natažení (podíl výšky), `flash` 0..1.
 * Zbylá pole jsou paměť pro další tik.
 */
export interface Pose {
  readonly bob: number;
  readonly lean: number;
  readonly squash: number;
  readonly flash: number;
  readonly grounded: boolean;
  readonly landedAt: number;
  readonly hitAt: number;
  readonly shotAt: number;
}

/** Pod touhle rychlostí (m/s) tělo stojí. */
const RUN_MIN = 0.5;
/** Jak dlouho doznívá dopad a zásah (tiky). */
const LAND_TICKS = 10;
const HIT_TICKS = 18;
/** Jak dlouho po výstřelu hraje klip střelby (tiky). */
const SHOT_TICKS = 20;
const LAND_SQUASH = 0.22;
const MAX_STRETCH = 0.18;
const MAX_LEAN = 0.3;
const MAX_BOB = 0.14;

const NEVER = -1_000_000;
const REST: Pose = { bob: 0, lean: 0, squash: 0, flash: 0, grounded: true, landedAt: NEVER, hitAt: NEVER, shotAt: NEVER };

const metresPerSecond = (perTick: number): number => (perTick * ARCADE_HZ) / UNIT;

export function poseOf(view: MotionView, previous: Pose | null, tick: number): Pose {
  if (!view.alive) return REST;
  const before = previous ?? REST;
  const landedAt = view.grounded && !before.grounded ? tick : before.landedAt;
  const hitAt = view.hit ? tick : before.hitAt;
  const shotAt = view.shot ? tick : before.shotAt;

  const forward = metresPerSecond(view.vz);
  const speed = Math.hypot(metresPerSecond(view.vx), forward);
  const running = view.grounded && speed > RUN_MIN;
  // Krok: čím rychleji, tím častěji a výš; |sin| dává dva dopady nohou na cyklus.
  const bob = running ? Math.min(MAX_BOB, speed * 0.012) * Math.abs(Math.sin(tick * (0.18 + speed * 0.02))) : 0;
  const lean = speed > RUN_MIN ? Math.sign(forward) * Math.min(MAX_LEAN, Math.abs(forward) * 0.03) : 0;

  const sinceLand = tick - landedAt;
  const squash = !view.grounded
    ? -Math.min(MAX_STRETCH, Math.abs(metresPerSecond(view.vy)) * 0.03)
    : sinceLand < LAND_TICKS ? LAND_SQUASH * (1 - sinceLand / LAND_TICKS) : 0;

  const sinceHit = tick - hitAt;
  const flash = sinceHit < HIT_TICKS ? 1 - sinceHit / HIT_TICKS : 0;

  return { bob, lean, squash, flash, grounded: view.grounded, landedAt, hitAt, shotAt };
}

/** Stavy, na které manifest riggovaných postav mapuje klipy (`src/assets/rigged.json`, `rigged-p54.json`). */
export const CLIP_STATES = ['idle', 'walk', 'run', 'jump', 'shoot', 'hit', 'die', 'win'] as const;
export type ClipState = (typeof CLIP_STATES)[number];

/**
 * Do téhle rychlosti (m/s) postava jde, nad ní běží (P54B T5). Plošinovka běží
 * až 6,6 m/s a rozjede se za 9 tiků, běžec jede od 7 m/s – chůzi tak hraje
 * pomalý krok (dotyková páčka, rozjezd, dobrzdění), ne plný běh.
 */
export const WALK_MAX_MPS = 2.5;

/**
 * Klip riggované postavy z téhož pohledu a pózy, ze kterých `poseOf` hýbe
 * statickými modely (`pose` = výsledek `poseOf` pro tentýž tik). Přednost:
 * smrt, výhra, zásah, střelba, skok, běh, chůze, klid.
 */
export function clipOf(view: MotionView, pose: Pose, tick: number): ClipState {
  if (!view.alive) return 'die';
  if (view.won === true) return 'win';
  if (pose.flash > 0) return 'hit';
  if (tick - pose.shotAt < SHOT_TICKS) return 'shoot';
  if (!view.grounded) return 'jump';
  const speed = Math.hypot(metresPerSecond(view.vx), metresPerSecond(view.vz));
  return speed > WALK_MAX_MPS ? 'run' : speed > RUN_MIN ? 'walk' : 'idle';
}

/**
 * Pohled těla ze stavu jádra – jen čte. `prev` je stav před posledním tikem;
 * zásah hráče = ubyl život, zásah ostatních = tělo v tomhle tiku zaniklo.
 * Hráč prohraného běhu je mrtvý, i když jeho tělo dál existuje.
 */
export function viewOf(state: Int32Array, prev: Int32Array, index: number): MotionView {
  const base = bodyBase(index);
  const flags = state[base + BODY.flags] as number;
  const player = (state[base + BODY.role] as number) === ROLE.player;
  const alive = (flags & FLAG.alive) !== 0 && !(player && (state[HEADER.runState] as number) === RUN_STATE.lost);
  const health = HEADER.counters + COUNTER.health;
  const cooldown = HEADER.counters + COUNTER.cooldown;
  const hit = player ? (state[health] as number) < (prev[health] as number) : !alive && ((prev[base + BODY.flags] as number) & FLAG.alive) !== 0;
  return {
    vx: state[base + BODY.vx] as number,
    vy: state[base + BODY.vy] as number,
    vz: state[base + BODY.vz] as number,
    // Tělo bez gravitace (mince, plošina, ptáček) nepadá, takže nikdy „neletí“.
    grounded: (flags & FLAG.grounded) !== 0 || (flags & FLAG.gravity) === 0,
    alive,
    hit,
    shot: player && (state[cooldown] as number) > (prev[cooldown] as number),
    won: player && (state[HEADER.runState] as number) === RUN_STATE.won,
  };
}

/** Pózy všech těl pro jeden snímek; `memory` jsou pózy minulého snímku (po indexu těla) a přepíše se. */
export function posesOf(state: Int32Array, prev: Int32Array, memory: (Pose | null)[], tick: number): readonly (Pose | null)[] {
  const count = state[HEADER.bodyCount] as number;
  for (let index = 0; index < count; index += 1) memory[index] = poseOf(viewOf(state, prev, index), memory[index] ?? null, tick);
  return memory;
}
