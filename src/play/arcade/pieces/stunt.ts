/**
 * Závod s triky (P68V T2, kategorie `vozidla-sport`): trať řízení prodloužená o rampy se skokem a hromady věcí
 * z věty, které se nárazem rozletí (trosky Rapieru s rozpočtem), poškození nárazem do mantinelu a cíl na konci.
 * Vstup náklonu `steer` (osa = řízení, `DOWN` = brzda), plyn automatický – nic nového ve vstupu.
 *
 * **Kdo co dělá v tiku:**
 * - ovládání `stunt` (obal `steerControl`, import): účetnictví minulého tiku na počítadle (`STUNT_SLOTS`: tiky ve vzduchu
 *   a skoky, rozbité krabice a zpomalení po nárazu do hromady, hodiny trosek), pak jízda: na zemi řízení závodu (bez
 *   turba), ve vzduchu ztlumené řízení a stálá rychlost vpřed, po nárazu omráčení; na rampě drží auto na ploše klínu
 *   a dává mu svislou rychlost úměrnou rychlosti vpřed – za hranou letí celočíselnou gravitací jádra (`GRAVITY`);
 * - `stunt_crash` (kontakt): pevná překážka (mantinel) a změna rychlosti nad prahem = −1 život s milostí (omráčení);
 * - `stunt_impact` a `stunt_debris` (tik, `stunt-impact.ts`): náraz do hromady → trosky, zhasínání trosek;
 * - `finish` (cíl = výhra), `out_of_health` a `time_limit` (prohra), `score_bonus` (bonus za životy a čas).
 *
 * Skóre = 10 × rozbitá krabice + tiky ve vzduchu / 2 (za každý skok) + bonus na konci výhry. Hráč-auto zůstává
 * kinematické (nikdy `FLAG.physics`); Rapier hýbe jen krabicemi a troskami. Trať a konstanty: `stunt-track.ts`.
 */

import { z } from 'zod';

import { STUNT_DEBRIS_MAX } from '../../genre/p68-contract';
import {
  ARCADE_LIMITS,
  AXIS_MAX,
  type ArcadeInput,
  type ArcadeState,
  BODY,
  BUTTON,
  COUNTER,
  type ControlPiece,
  FLAG,
  HEADER,
  type ModeGeneratorPiece,
  type RulePiece,
  bodyBase,
  bodyHp,
  graceOf,
  setBodyHp,
} from '../contract';
import { GRAVITY } from '../kernel';
import { STEER, steerControl } from './steer';
import { stuntDebris, stuntImpact } from './stunt-impact';
import {
  STUNT,
  STUNT_SLOTS,
  type StuntRamp,
  type StuntTrackParams,
  pileSectionLength,
  rampClimb,
  rampHeightAt,
  rampSectionLength,
  rampUnder,
  stuntDebrisOf,
  stuntPartsOf,
  stuntTrackParams,
} from './stunt-track';

export * from './stunt-track';
export { debrisGone, stuntDebris, stuntImpact, touches } from './stunt-impact';

const index = z.int().min(0).max(ARCADE_LIMITS.maxBodies - 1);
const rampSchema = z.object({ x: z.int(), z0: z.int(), z1: z.int(), w: z.int().min(1), h: z.int().min(1) }).strict().refine((ramp) => ramp.z1 > ramp.z0);

const controlParams = z
  .object({
    /** Řízení závodu (`steerControl`): nejvyšší rychlost, smyk; bez osy soupeřů, bez značek rampy. */
    drive: steerControl.params,
    keeper: index,
    ramps: z.array(rampSchema).max(STUNT.ramps.max),
    /** První krabice hromad a počty krabic hromad po sobě (bity `STUNT_SLOTS.dead`). */
    firstBox: index,
    piles: z.array(z.int().min(1).max(STUNT.boxes.max)).max(STUNT.piles.max).refine((piles) => piles.reduce((sum, count) => sum + count, 0) <= STUNT_DEBRIS_MAX),
  })
  .strict();
export type StuntControlParams = z.infer<typeof controlParams>;

const toward = (value: number, target: number, step: number): number => (value < target ? Math.min(target, value + step) : Math.max(target, value - step));
const clamp = (value: number, limit: number): number => Math.max(-limit, Math.min(limit, value));

/** Boční rychlost, kterou osa nebo šipky chtějí (jako `steerControl`). */
function lateralTarget(input: ArcadeInput): number {
  if ((input.buttons & BUTTON.LEFT) !== 0) return -STEER.latMax;
  if ((input.buttons & BUTTON.RIGHT) !== 0) return STEER.latMax;
  return Math.trunc((clamp(input.axis, AXIS_MAX) * STEER.latMax) / AXIS_MAX);
}

const bitCount = (bits: number): number => {
  let count = 0;
  for (let rest = bits; rest !== 0; rest &= rest - 1) count += 1;
  return count;
};

/** Účetnictví minulého tiku: hodiny trosek, rozbité krabice (počítadlo, body, zpomalení), vzduch a skoky. */
function settleLastTick(state: ArcadeState, player: number, params: StuntControlParams, onRamp: boolean): void {
  const p = bodyBase(player);
  const k = bodyBase(params.keeper);
  const score = HEADER.counters + COUNTER.score;
  // Hodiny trosek: HP = zbylé tiky; na nule ji `stunt_debris` zhasne.
  for (const debris of stuntDebrisOf(state)) setBodyHp(state, debris, bodyHp(state, debris) - 1);
  // Krabice, které pravidlo nárazu od minulého tiku rozbilo.
  let dead = 0;
  let total = 0;
  let piles = 0;
  for (const count of params.piles) {
    let pileDead = 0;
    for (let j = 0; j < count; j += 1) if (((state[bodyBase(params.firstBox + total + j) + BODY.flags] as number) & FLAG.alive) === 0) pileDead |= 1 << (total + j);
    if ((pileDead & ~(state[k + STUNT_SLOTS.dead] as number)) !== 0) piles += 1;
    dead |= pileDead;
    total += count;
  }
  const fresh = bitCount(dead & ~(state[k + STUNT_SLOTS.dead] as number));
  if (fresh > 0) {
    state[k + STUNT_SLOTS.dead] = dead;
    state[k + STUNT_SLOTS.smash] = (state[k + STUNT_SLOTS.smash] as number) + fresh;
    state[k + STUNT_SLOTS.impacts] = (state[k + STUNT_SLOTS.impacts] as number) + piles;
    state[score] = (state[score] as number) + fresh * STUNT.smash.points;
    state[p + BODY.vz] = Math.trunc(((state[p + BODY.vz] as number) * STUNT.smash.keepPct) / 100);
  }
  // Vzduch: auto nad zemí a ne na rampě. Dopad po aspoň `minJumpTicks` = skok a body za něj.
  const streak = state[k + STUNT_SLOTS.streak] as number;
  if ((state[p + BODY.y] as number) > 0 && !onRamp) {
    state[k + STUNT_SLOTS.air] = (state[k + STUNT_SLOTS.air] as number) + 1;
    state[k + STUNT_SLOTS.streak] = streak + 1;
  } else if (streak > 0) {
    if (streak >= STUNT.air.minJumpTicks) {
      state[k + STUNT_SLOTS.jumps] = (state[k + STUNT_SLOTS.jumps] as number) + 1;
      state[score] = (state[score] as number) + Math.floor(streak / STUNT.air.ticksPerPoint);
    }
    state[k + STUNT_SLOTS.streak] = 0;
  }
}

/**
 * Ovládání závodu s triky. Před krokem řízení zapíše autu `aux1` = skóre a `aux0` = 0: řízení by skok skóre (body za
 * krabice a skoky) četlo jako sebrané turbo, a turbo tu není – nejvyšší rychlost, se kterou počítá dojezd za rampou,
 * by jinak neplatila.
 */
export const stuntControl: ControlPiece<StuntControlParams> = {
  id: 'stunt',
  params: controlParams,
  roles: ['player', 'platform', 'target'],
  cost: () => ({ bodies: 1, rules: 0 }),
  step: (state, player, input, params) => {
    const p = bodyBase(player);
    const k = bodyBase(params.keeper);
    const x = state[p + BODY.x] as number;
    const z = state[p + BODY.z] as number;
    const ramp = rampUnder(params.ramps, x, state[p + BODY.y] as number, z);
    settleLastTick(state, player, params, ramp >= 0);
    const airborne = (state[p + BODY.y] as number) > 0 && ramp < 0;
    const grace = graceOf(state, player);
    // První tik omráčení (jádro už milost o tik ubralo): rychlost na zlomek.
    if (grace === STUNT.crash.grace - 1) state[p + BODY.vz] = Math.trunc(((state[p + BODY.vz] as number) * STUNT.crash.keepPct) / 100);
    if (airborne) {
      // Ve vzduchu: plyn ani brzda nic, řízení ztlumené.
      const target = Math.trunc((lateralTarget(input) * STUNT.air.lat) / STEER.latMax);
      state[p + BODY.vx] = clamp(toward(state[p + BODY.vx] as number, target, STUNT.air.steerRate), STUNT.air.lat);
    } else if (grace > STUNT.crash.grace - STUNT.crash.stunTicks) {
      // Omráčení: bez plynu a řízení, boční rychlost dojíždí přilnavostí.
      state[p + BODY.vx] = toward(state[p + BODY.vx] as number, 0, STEER.grip);
    } else {
      state[p + BODY.aux0] = 0;
      state[p + BODY.aux1] = state[HEADER.counters + COUNTER.score] as number;
      steerControl.step(state, player, input, params.drive);
    }
    if (ramp >= 0) {
      // Na rampě: na ploše klínu, stoupá rychlostí úměrnou rychlosti vpřed (jádro hned odečte `GRAVITY`).
      const on = params.ramps[ramp] as StuntRamp;
      state[p + BODY.vx] = clamp(state[p + BODY.vx] as number, STUNT.air.lat);
      state[p + BODY.y] = rampHeightAt(on, z);
      state[p + BODY.vy] = GRAVITY + rampClimb(on, state[p + BODY.vz] as number);
    }
    state[k + STUNT_SLOTS.preVx] = state[p + BODY.vx] as number;
    state[k + STUNT_SLOTS.preVz] = state[p + BODY.vz] as number;
  },
};

const crashParams = z.object({ keeper: index }).strict();

/**
 * Náraz do pevné překážky (kontakt): mantinel nebo ostrůvek, o který auto ztratilo víc rychlosti než `crash.speed`
 * (jádro mu v kolizi vynulovalo složku proti překážce; před tím ji ovládání zapsalo do počítadla) = −1 život
 * s milostí `crash.grace` – druhý mantinel téhož tiku ani omráčené auto život nevezme. Fyzikální těleso náraz není.
 */
export const stuntCrash: RulePiece<z.infer<typeof crashParams>> = {
  id: 'stunt_crash',
  params: crashParams,
  roles: ['player', 'obstacle'],
  trigger: 'contact',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player, other }, params) => {
    const flags = state[bodyBase(other) + BODY.flags] as number;
    if ((flags & (FLAG.alive | FLAG.solid | FLAG.physics)) !== (FLAG.alive | FLAG.solid) || graceOf(state, player) > 0) return [];
    const p = bodyBase(player);
    const k = bodyBase(params.keeper);
    const lost = Math.max(Math.abs((state[k + STUNT_SLOTS.preVx] as number) - (state[p + BODY.vx] as number)), Math.abs((state[k + STUNT_SLOTS.preVz] as number) - (state[p + BODY.vz] as number)));
    return lost > STUNT.crash.speed ? [{ kind: 'damage', amount: 1, grace: STUNT.crash.grace }] : [];
  },
};

/** Pravidla závodu s triky – `library.ts` je rozbalí do `rules`. */
export const STUNT_RULES: Readonly<Record<string, RulePiece>> = {
  stunt_crash: stuntCrash as RulePiece,
  stunt_impact: stuntImpact as RulePiece,
  stunt_debris: stuntDebris as RulePiece,
};

/**
 * Režim `stunt` (generátor `stunt_track`): trať, rampy, hromady, pravidla a parametry robota (`stunt_bot`, T3).
 * Životy ze specu, výchozí `START_LIVES`; `issues` = `checkStuntLevel` nad hotovou tratí.
 */
export const stuntTrack: ModeGeneratorPiece<StuntTrackParams> = {
  id: 'stunt_track',
  params: stuntTrackParams,
  roles: ['player', 'obstacle', 'platform', 'target', 'goal'],
  cost: (params) => {
    const sections = params.ramps * rampSectionLength() + params.piles * pileSectionLength();
    const segments = Math.ceil((params.lengthM * 1000 + sections) / 10_000) + 4;
    const boxes = params.piles * params.boxes;
    return { bodies: 3 + params.things.length + 2 * segments + params.ramps + 2 * boxes, rules: 7 };
  },
  generate: (seed, params) => stuntPartsOf(seed, params, undefined).level,
  parts: (seed, params, health) => stuntPartsOf(seed, params, health),
};
