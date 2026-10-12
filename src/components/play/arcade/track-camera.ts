/**
 * Kamera tratí a kde v jejím záběru stojí pronásledovatel (P39 T16). Přesunuto
 * z `World.tsx`, ať jde záběr spočítat i v testu bez plátna.
 *
 * Pronásledovatel doplňku `+chaser` je v jádře tam, kde má smysl pro hru: běžci
 * běží naproti (zezadu by ho pomalejší nedohnal) a vyběhne z mlhy až kolem třetiny
 * trati, plošinovce startuje 12 m za zády a hráč mu utíká. Z věty „running from
 * a monkey“ ale hráč musí vidět, že ho něco honí – první vteřiny i po 3 s hry
 * (slepý soud P39 T14: opice ani lapič psů nebyli v záběru). Scéna ho proto
 * kreslí v záběru, kde ho jádro má mimo: běžci v patách hrdiny, plošinovce na
 * kraji obrazu za ním. Kde je blízko nebo v útoku, kreslí se přesně tam, kde je
 * v jádře – srážka sedí s obrazem. Jen kresba: stav, hash ani robot se nemění.
 */

import type { PerspectiveCamera, Vector3 } from 'three';

import { type Path, slopeAt } from './runner/path';

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));

/**
 * Boční kamera: stojí na −x a kouká po +x, takže +z jádra jde na obrazovce
 * doprava. Vzdálenost se řídí poměrem stran – na výšku (mobil) ustoupí,
 * aby bylo vidět aspoň `ahead` metrů trati. `lead` = o kolik poloviny šířky
 * obrazu je hráč vlevo od středu (0,4 → levá třetina).
 */
export function placeSide(camera: PerspectiveCamera, look: Vector3, z: number, y: number, ahead: number, tall: number, far: number, lead: number): void {
  const tan = Math.tan((camera.fov * Math.PI) / 360);
  const dist = clamp(Math.max(ahead / (2 * tan * camera.aspect), tall / (2 * tan)), 10, far);
  const shift = dist * tan * camera.aspect * lead;
  camera.position.set(-dist, y, z + shift);
  look.set(0, y, z + shift);
  camera.lookAt(look);
}

/**
 * Boční kamera na výšku (P30B T5): kolmý záběr je úzký – hrdina přes 4 % výšky
 * a zároveň ~11 m trati před ním se do něj nevejdou. Kamera se proto natočí
 * o `yaw` po trati: hrdina je jí blíž (větší), trať před ním se zkrátí
 * perspektivou. `dist` = vzdálenost k bodu pohledu, `lead` = o kolik metrů
 * před hrdinou kamera míří.
 */
export function placeAngled(camera: PerspectiveCamera, look: Vector3, z: number, y: number, dist: number, yaw: number, lead: number): void {
  look.set(0, y, z + lead);
  camera.position.set(-dist * Math.cos(yaw), y, z + lead - dist * Math.sin(yaw));
  camera.lookAt(look);
}

const DEG = Math.PI / 180;

/**
 * Kamera běžce: za hrdinou a nad ním, kouká po trati před něj. `x`, `z` = hrdina ve scéně (m),
 * `x` v pruzích bez zatáčky. Na zakřivené trati (P46D T3) stojí kamera i bod pohledu na tečně
 * křivky v místě hrdiny: hrdina je v záběru tam, kde na rovné trati, a zatáčka se stáčí před ním.
 */
export function placeRunner(camera: PerspectiveCamera, look: Vector3, x: number, z: number, path?: Path): void {
  const at = path?.(z) ?? { x: 0, y: 0 };
  const slope = path === undefined ? { x: 0, y: 0 } : slopeAt(path, z);
  camera.position.set(x * 0.6 + at.x - 6.5 * slope.x, 3.4 + at.y - 6.5 * slope.y, z - 6.5);
  look.set(x * 0.4 + at.x + 9 * slope.x, 1.1 + at.y + 9 * slope.y, z + 9);
  camera.lookAt(look);
}

/**
 * Kamera plošinovky; `y` = výška, za kterou kamera dojíždí (ať skok netřese obrazem).
 * Na výšku natočená do tří čtvrtin, ať je vidět nejbližší mince či hrot ~11 m před startem
 * i vedle širokého hrdiny (P27A T6, P30B T5, `e2e/play-frame`). Hrdina ~13 m od kamery má
 * ~10 % výšky obrazu – z 22 m při bočním pohledu měl 6 % a minimum je 8 % (P36C T6, `e2e/play-hero-size`).
 */
export function placePlatform(camera: PerspectiveCamera, look: Vector3, z: number, y: number): void {
  if (camera.aspect < 1) placeAngled(camera, look, z, y + 1.2, 16, 55 * DEG, 3.5);
  else placeSide(camera, look, z, y + 1.2, 16, 7, 18, 0.4);
}

/** Poloha ve scéně (m): x je zrcadlené x jádra, jako u těl ve `World`. */
export interface Spot {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const CHASER_VIEW = {
  /**
   * Běžec: pronásledovatel v patách hrdiny – tolik metrů za ním (celý nad spodní hranou
   * obrazu) a tolik vedle, ať hrdinovi nezakryje nohy (`heelsX`).
   */
  heelsBehind: 1.5,
  heelsSide: 1,
  /** Běžec: na kolika metrech, než pronásledovatel vyběhne z mlhy proti hrdinovi, odpadne o `dropBack` m dozadu z obrazu. */
  dropWindow: 12,
  dropBack: 7,
  /** Běžec: po kolika metrech za patami se pronásledovatel, který hrdinu minul, srovná z vlastního pruhu do pat. */
  heelsBlend: 4,
  /** Plošinovka: nejdál za hrdinou, kde ho boční kamera ukáže celého (na šířku), a natočená na výšku. */
  platformBehind: 3.5,
  platformBehindTall: 1.5,
} as const;

/**
 * Kam vedle hrdiny (x scény) pronásledovatel v patách: ve středním a pravém pruhu
 * o `heelsSide` na +x (vlevo na obrazovce), v levém pruhu (+x) ke středu – na výšku
 * by jinak vyběhl z úzkého obrazu. Strana se otočí plynule uprostřed přebíhání
 * mezi středním a levým pruhem, ne v pruhu, kde hrdina běží.
 */
function heelsX(heroX: number): number {
  const lane = clamp(heroX - 0.5, 0, 1);
  return heroX + CHASER_VIEW.heelsSide * (1 - 2 * lane);
}

export interface ChaserSpot {
  readonly spot: Spot;
  /** Běží proti hrdinovi (útok běžce) – model se otočí čelem k němu. */
  readonly oncoming: boolean;
}

/**
 * Kde scéna kreslí pronásledovatele. `chaser` je jeho poloha v jádře, `hero` hrdinova,
 * `view` dohled kamery (konec mlhy, m), `aspect` poměr stran obrazu.
 *
 * Běžec: v útoku (před hrdinou do dohledu) a při míjení přesně podle jádra. Než
 * vyběhne z mlhy, a když hrdinu mine, běží mu v patách; těsně před útokem odpadne
 * dozadu z obrazu, takže se nezdvojí. Plošinovka: podle jádra, dokud je blíž než
 * kraj obrazu; dál zůstane na kraji obrazu za hrdinou.
 */
export function chaserSpot(control: string, hero: Spot, chaser: Spot, view: number, aspect: number): ChaserSpot {
  const dz = chaser.z - hero.z;
  if (control === 'steer' && dz < -4) {
    // Keep a distant pursuer visible behind the vehicle. Near contact its
    // position is exact, so this presentation never shifts the collision.
    return { spot: { x: chaser.x, y: chaser.y, z: hero.z - 4 }, oncoming: false };
  }
  if (control === 'platform') {
    const behind = aspect < 1 ? CHASER_VIEW.platformBehindTall : CHASER_VIEW.platformBehind;
    return { spot: dz >= -behind ? chaser : { x: chaser.x, y: chaser.y, z: hero.z - behind }, oncoming: false };
  }
  if (control !== 'runner') return { spot: chaser, oncoming: false };
  const behind = CHASER_VIEW.heelsBehind;
  if (dz >= -behind && dz <= view) return { spot: chaser, oncoming: true };
  const heels = { x: heelsX(hero.x), y: chaser.y, z: hero.z - behind };
  if (dz < -behind) {
    const blend = clamp((-behind - dz) / CHASER_VIEW.heelsBlend, 0, 1);
    return { spot: { ...heels, x: chaser.x + (heels.x - chaser.x) * blend }, oncoming: false };
  }
  const drop = clamp((view + CHASER_VIEW.dropWindow - dz) / CHASER_VIEW.dropWindow, 0, 1) * CHASER_VIEW.dropBack;
  return { spot: { ...heels, z: heels.z - drop }, oncoming: false };
}
