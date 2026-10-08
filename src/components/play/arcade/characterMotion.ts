/**
 * Pohyb postavy, na který model klip nemá (P36C T8): natažení ve výskoku
 * a zmáčknutí po dopadu, zakymácení po zásahu, pád při prohře a natočení po
 * směru pohybu. Jen obraz – čte čas ve stavu nebo tik, do hashovaného stavu nic
 * nepíše. `RiggedModel` ho hraje za stavy bez klipu (zvířátka, duch, robot,
 * zásah lidiček Kenney), `World` a aréna k póze `poseOf` statických modelů.
 */

import type { Object3D } from 'three';

/** Natažení ve výskoku (podíl výšky): naběhne za `STRETCH_IN_S`, k vrcholu povolí na `STRETCH_APEX`. */
const JUMP_STRETCH = 0.14;
const STRETCH_IN_S = 0.08;
const STRETCH_APEX = 0.04;
const STRETCH_OUT_S = 0.45;
/** Zmáčknutí po dopadu (podíl výšky) a jak dlouho doznívá (s) – jako 10 tiků `poseOf`. */
const LAND_SQUASH = 0.24;
export const LAND_S = 0.17;
/** Zásah doznívá jako bliknutí `poseOf` (18 tiků): cukne dozadu a dvakrát a půl se zakymácí do stran. */
export const HIT_S = 0.3;
const RECOIL_RAD = 0.35;
const WOBBLE_RAD = 0.3;
const WOBBLE_SWINGS = 2.5;
/** Pád: zrychluje jako volný pád `FALL_S`, pak jednou odskočí a za `BOUNCE_S` dosedne. */
export const FALL_S = 0.42;
const BOUNCE_S = 0.22;
const BOUNCE = 0.12;
/** Padající postava se stočí i na bok – pád dozadu by kamera za zády běžce viděla jen zkrácený. */
const FALL_SIDE_RAD = 0.45;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** Natažení ve výskoku podle času ve vzduchu (s); kladné = vyšší a užší. */
export function jumpStretchOf(since: number): number {
  if (since < STRETCH_IN_S) return JUMP_STRETCH * (since / STRETCH_IN_S);
  return STRETCH_APEX + (JUMP_STRETCH - STRETCH_APEX) * (1 - clamp01((since - STRETCH_IN_S) / (STRETCH_OUT_S - STRETCH_IN_S)));
}

/** Zmáčknutí po dopadu podle času od něj (s); kladné = nižší a širší. */
export function landSquashOf(sinceLand: number): number {
  return sinceLand >= 0 && sinceLand < LAND_S ? LAND_SQUASH * (1 - sinceLand / LAND_S) : 0;
}

/** Zakymácení do strany (rad) – `hit` je podíl doznívání zásahu, 0 = právě teď, 1 = doznělo. */
export function wobbleOf(hit: number): number {
  const t = clamp01(hit);
  return WOBBLE_RAD * (1 - t) ** 2 * Math.sin(t * WOBBLE_SWINGS * 2 * Math.PI);
}

/** Cuknutí dozadu (rad, kladné) při zásahu – hned naplno, pak se narovná. */
export function recoilOf(hit: number): number {
  return RECOIL_RAD * (1 - clamp01(hit)) ** 2;
}

/** Kolik postava leží (0 stojí … 1 leží) za `since` s od smrti: zrychlí, odskočí, dosedne. */
export function fallOf(since: number): number {
  if (since <= 0) return 0;
  if (since < FALL_S) return (since / FALL_S) ** 2;
  const t = (since - FALL_S) / BOUNCE_S;
  return t >= 1 ? 1 : 1 - BOUNCE * Math.sin(t * Math.PI);
}

/**
 * Náklon skupiny postavy: předklon běhu `lean`, zásah (`hit` jako u `wobbleOf`)
 * a pád (`fall` z `fallOf`). Kolem paty – skupina má počátek u nohou.
 */
export function tiltPose(group: Object3D, hit: number, fall: number, lean = 0): void {
  tiltTo(group, lean, recoilOf(hit), wobbleOf(hit), fall);
}

/**
 * Náklon z hotových úhlů (P45D T5): předklon, cuknutí dozadu, zakymácení, pád
 * (0..1) a úklon do strany. Hračkový pohyb ho volá s cuknutím a kymácením,
 * které při omezeném pohybu vynuloval.
 */
export function tiltTo(group: Object3D, lean: number, recoil: number, wobble: number, fall: number, roll = 0): void {
  group.rotation.x = lean - recoil - (Math.PI / 2) * fall;
  group.rotation.z = roll + wobble + FALL_SIDE_RAD * fall;
}

/** Zmáčknutí na skupinu se zachovaným objemem (kladné = nižší a širší). */
export function squashPose(group: Object3D, squash: number, height = 1): void {
  const wide = 1 + squash / 2;
  group.scale.set(wide, height * (1 - squash), wide);
}

/** Natočení kolem y, aby lokální +z mířilo po pohybu jádra (dx, dz); scéna zrcadlí x. */
export const headingOf = (dx: number, dz: number): number => Math.atan2(-dx, dz);

/** Dotočí `was` k `want` kratší cestou o podíl `k` (0..1); bez minulého natočení rovnou. */
export function turnToward(was: number | undefined, want: number, k: number): number {
  if (was === undefined) return want;
  return was + Math.atan2(Math.sin(want - was), Math.cos(want - was)) * k;
}

/**
 * Sekundy od smrti těla pro `fallOf` – `memory` drží tik smrti po indexu těla.
 * Živé tělo záznam smaže (restart), mrtvé ho při prvním snímku založí.
 */
export function deadFor(memory: Map<number, number>, index: number, alive: boolean, tick: number, hz: number): number {
  if (alive) {
    memory.delete(index);
    return 0;
  }
  const at = memory.get(index);
  if (at === undefined || tick < at) {
    memory.set(index, tick);
    return 0;
  }
  return (tick - at) / hz;
}
