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

import { Box3, type PerspectiveCamera, Vector3 } from 'three';

import { UNIT } from '@/play/arcade/contract';
import { FLAP } from '@/play/arcade/pieces/flap';

import { DIORAMA_FRAMING, dioramaRig } from './look/framing';
import { type PlayRect, fitTall } from './portrait-frame';
import { type Path, slopeAt } from './runner/path';

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));

const moved = new Vector3();
const forward = new Vector3();

/**
 * Honička na výšku (P64 T5): kamera, kterou scéna postavila (poloha, `lookAt`), dojede po své ose pohledu a ose
 * nahoru, až krabice hry `box` leží v hracím obdélníku `rect` mezi HUD a ovládáním (`fitTall`, `keep` jako tam).
 * Bod pohledu `look` jede s ní o týž vektor, takže úvodní průlet (`applyIntro`) i `lookAt` na něj drží orientaci
 * fitu. Couvnout smí nejvýš o `most` m po ose pohledu (hrdina by jinak zmenšil pod dnešní velikost): kam fit chce
 * dál, ujede kamera jen poměrnou část cesty. Střed záběru do středu `rect` se při stropu nesune – přesah by se
 * rozdělil nahoru i dolů a hrdinu u spodní hrany by uřízl. Bez změřeného obdélníku (první snímek, mimo
 * `StageCanvas`) a na šířku zůstane kamera, jak je.
 */
export function fitChase(camera: PerspectiveCamera, look: Vector3, box: Box3, rect: PlayRect | null, keep?: Box3, most = Infinity): void {
  if (rect === null || !(camera.aspect < 1)) return;
  const { position } = fitTall(camera, box, rect, keep === undefined ? undefined : { keep });
  moved.subVectors(position, camera.position);
  const back = -moved.dot(forward.set(0, 0, -1).applyQuaternion(camera.quaternion));
  if (back > most) moved.multiplyScalar(most / back);
  look.add(moved);
  camera.position.add(moved);
}

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
export function placeAngled(camera: PerspectiveCamera, look: Vector3, z: number, y: number, dist: number, yaw: number, lead: number, pitch = 0): void {
  look.set(0, y, z + lead);
  const flat = dist * Math.cos(pitch);
  camera.position.set(-flat * Math.cos(yaw), y + dist * Math.sin(pitch), z + lead - flat * Math.sin(yaw));
  camera.lookAt(look);
}

const DEG = Math.PI / 180;

/**
 * Běžec na výšku (P64 T5): kamera stojí nad osou trati (pruh hrdiny ji nehýbe) ve sklonu `pitch` a míří `ahead` m
 * před hrdinu, takže trať běží nahoru po obrazovce až k obzoru pod horní lištou HUD. Do `playRect` se vejdou všechny
 * tři pruhy (`half` m od osy: krajní pruh 2 m a půl hrdiny), od pat (`behind` m za hrdinou, kde běží
 * pronásledovatel) po `depth` m před ním a do výšky `top` m. Vzdálenost a svislý posun dává `fitChase`.
 * P70D T3: sklon 32° (dřív 22°) – hrdina shora šikmo místo zad jako kvádr, tři řady překážek před ním v záběru.
 * P73D T2: 27° – při 32° a zorném poli 60° ležel obzor nad horní hranou (NDC 1,14), sopka ani panorama vidět nebyly.
 */
export const RUNNER_TALL = { pitch: 27 * DEG, ahead: 10, reach: 21, half: 2.5, behind: 2, depth: 2, top: 2 } as const;

const fitBox = new Box3();

/**
 * Kamera běžce: za hrdinou a nad ním, kouká po trati před něj. `x`, `z` = hrdina ve scéně (m),
 * `x` v pruzích bez zatáčky. Na zakřivené trati (P46D T3) stojí kamera i bod pohledu na tečně
 * křivky v místě hrdiny: hrdina je v záběru tam, kde na rovné trati, a zatáčka se stáčí před ním.
 * Na výšku `RUNNER_TALL` a `fitChase` do hracího obdélníku `rect`.
 */
export function placeRunner(camera: PerspectiveCamera, look: Vector3, x: number, z: number, path?: Path, rect: PlayRect | null = null): void {
  const at = path?.(z) ?? { x: 0, y: 0 };
  const slope = path === undefined ? { x: 0, y: 0 } : slopeAt(path, z);
  if (camera.aspect < 1) {
    const view = RUNNER_TALL;
    // Bod pohledu i kamera na tečně křivky jako na šířku; `reach` je zhruba vzdálenost po fitu (bez změřeného
    // obdélníku zůstane kamera tady).
    const back = view.reach * Math.cos(view.pitch);
    look.set(at.x + view.ahead * slope.x, at.y + view.ahead * slope.y, z + view.ahead);
    camera.position.set(look.x - back * slope.x, look.y - back * slope.y + view.reach * Math.sin(view.pitch), look.z - back);
    camera.lookAt(look);
    fitBox.min.set(at.x - view.half, at.y, z - view.behind);
    fitBox.max.set(at.x + view.half, at.y + view.top, z + view.depth);
    fitChase(camera, look, fitBox, rect);
    return;
  }
  // P73D T2: 3/4 s obzorem (`DIORAMA_FRAMING.runner`) – dřív 8° od země a stěna kaňonu přes půl obrazu.
  const { back, up, ahead } = dioramaRig(DIORAMA_FRAMING.runner, DIORAMA_FRAMING.runner.reach, camera.fov);
  camera.position.set(x * 0.6 + at.x - back * slope.x, up + at.y - back * slope.y, z - back);
  look.set(x * 0.4 + at.x + ahead * slope.x, at.y + ahead * slope.y, z + ahead);
  camera.lookAt(look);
}

/**
 * Plošinovka na výšku (P64 T5): natočená do tří čtvrtin (`yaw`, P27A T6, P30B T5 – nejbližší mince či hrot před
 * startem i vedle širokého hrdiny) a navíc kousek shora (`pitch`), ať plošiny před hrdinou stoupají po obrazovce.
 * Míří `lead` m před hrdinu. Do `playRect` se vejde úsek od `behind` m za hrdinou (pronásledovatel na kraji,
 * `CHASER_VIEW.platformBehindTall`) po `depth` m před ním, `half` m napříč a od `low` po `high` m nad výškou, za
 * kterou kamera dojíždí. Krabice je těsná schválně: větší by kameru odsunula a hrdina by klesl pod dnešní velikost
 * (na iPhonu jen 408 px mezi HUD a zónami). Vzdálenost a posun dává `fitChase`.
 */
export const PLATFORM_TALL = { yaw: 55 * DEG, pitch: 10 * DEG, lead: 2, behind: 1.2, depth: 8, low: 0.6, high: 2.4, half: 0.4 } as const;

/**
 * Kamera plošinovky; `y` = výška, za kterou kamera dojíždí (ať skok netřese obrazem).
 * Na šířku z boku. Na výšku `PLATFORM_TALL` a `fitChase` do hracího obdélníku `rect`; hrdinu drží čitelnost
 * (`LEGIBLE_SHARE.hero`, `e2e/play-hero-size`).
 */
export function placePlatform(camera: PerspectiveCamera, look: Vector3, z: number, y: number, rect: PlayRect | null = null): void {
  if (camera.aspect < 1) {
    const view = PLATFORM_TALL;
    placeAngled(camera, look, z, y + 1.2, 16, view.yaw, view.lead, view.pitch);
    fitBox.min.set(-view.half, y + view.low, z - view.behind);
    fitBox.max.set(view.half, y + view.high, z + view.depth);
    fitChase(camera, look, fitBox, rect);
  } else placeSide(camera, look, z, y + 1.2, 16, 7, 18, 0.4);
}

/**
 * Poletování na výšku (P64 T5): víc zezadu než na šířku (`yaw` 65° od boku, P30B T5 – kolmá kamera by ptáčka
 * zmenšila na 3 % výšky), takže koridor s trubkami ubíhá doprava do hloubky a dohled dopředu je delší. Míří `lead` m
 * před ptáčka. Do `playRect` se vejde celá výška letu (`low` až `high`, podlaha až strop – horní trubka nesmí pod
 * HUD) a koridor od `behind` m za ptáčkem po `depth` m před ním, `half` m napříč. Vzdálenost a posun dává `fitChase`.
 */
export const FLAP_TALL = { yaw: 65 * DEG, dist: 22, lead: 2, pitch: 0, behind: 0.5, depth: 5, half: 0.6, low: 0, high: FLAP.ceiling / UNIT } as const;

/**
 * Kamera poletování: na počítači ptáček blíž středu (v levém horním rohu by ho zakryl HUD) a kamera tak daleko, ať je
 * vidět první trubka i mince za ní (P30B T5); na výšku `FLAP_TALL`.
 */
export function placeFlap(camera: PerspectiveCamera, look: Vector3, z: number, rect: PlayRect | null): void {
  const ceiling = FLAP.ceiling / UNIT;
  if (!(camera.aspect < 1)) {
    placeSide(camera, look, z, ceiling / 2, 30, ceiling + 1, 26, 0.1);
    return;
  }
  const view = FLAP_TALL;
  placeAngled(camera, look, z, ceiling / 2, view.dist, view.yaw, view.lead, view.pitch);
  fitBox.min.set(-view.half, view.low, z - view.behind);
  fitBox.max.set(view.half, view.high, z + view.depth);
  fitChase(camera, look, fitBox, rect);
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
  /**
   * Plošinovka: nejdál za hrdinou, kde ho boční kamera ukáže celého (na šířku), a na výšku zadní hrana krabice,
   * kterou `fitChase` drží v `playRect` (`PLATFORM_TALL.behind`).
   */
  platformBehind: 3.5,
  platformBehindTall: PLATFORM_TALL.behind,
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
