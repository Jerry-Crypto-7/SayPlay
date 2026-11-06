/**
 * Rámování diorama (P73D T2): jedna tabulka, jak kamera každého ovládání kouká na hru – 3/4 pohled s obzorem místo
 * pohledu shora nebo od země. QA 6. 11.: honička a quest skoro shora bez obzoru, stohování u země, golf 50° do mlhy,
 * běh a závod 8–9° (stěna kaňonu přes půl obrazu).
 *
 * Pravidla (`FRAMING_LIMITS`): sklon osy pohledu 22–38° pod vodorovnou, svislé zorné pole 45–60°, obzor v horní
 * třetině obrazu a hrdina v dolní. Obzor leží v nekonečnu, takže jeho místo v obraze dává jen sklon a zorné pole
 * (`horizonNdc`) – posun kamery (`fitTall`, `fitChase` na výšku) ho nehne. Hrdinu do dolní třetiny posadí kamera,
 * která na něj kouká o úhel `drop` strměji, než míří osa pohledu (`dropOf`).
 *
 * Jen obraz: kamera nejde do stavu ani hashe (`p64-hash.test.ts`).
 */

import { MathUtils, type PerspectiveCamera, type Vector3 } from 'three';

export const FRAMING_LIMITS = {
  /** Sklon osy pohledu pod vodorovnou (°). */
  pitch: { min: 22, max: 38 },
  /** Svislé zorné pole (°). */
  fov: { min: 45, max: 60 },
  /** Obzor nad touto NDC y (horní třetina), hrdina pod `hero` (dolní třetina). */
  horizon: 1 / 3,
  hero: -1 / 3,
} as const;

/** Zorné pole plátna (`STAGE_CANVAS`, vlastní plátno hry); rámování ho nemění, ať scény feedu sdílí kameru. */
export const CANVAS_FOV = 60;

export interface Framing {
  /** Sklon osy pohledu pod vodorovnou (°). */
  readonly pitch: number;
  /** Kde v obraze stojí hrdina (NDC y, −1 dolní hrana). */
  readonly hero: number;
  /** Vzdálenost kamery od hrdiny (m) na šířku; na výšku ji dává fit hracího obdélníku. */
  readonly reach: number;
}

/**
 * Ovládání → rámování. `timing`: středem záběru je jezdec nad věží (AC „věž ve středu“), hrdina věty stojí u paty
 * věže níž. Plošinovka a střelnice zůstávají své (boční pohled, střelnice z kokpitu) – QA je vzala jako vzor
 * kvality, ne cíl úprav; proto nejsou v tabulce (`FRAMING_KEEP`).
 */
export const DIORAMA_FRAMING = {
  // Na hrdinu kamera kouká z 25° + `dropOf` = 38°; s hrozbou za zády se zvedne míň (`raiseArena`), sklon pak až 38°.
  move_free: { pitch: 25, hero: -0.4, reach: 0 },
  // `hero` = bod na zemi pod hrdinou; střed těla (0,7 m nad ním) pak leží kolem NDC −0,4.
  runner: { pitch: 22, hero: -0.55, reach: 7.8 },
  steer: { pitch: 22, hero: -0.45, reach: 10 },
  timing: { pitch: 24, hero: 0, reach: 0 },
  minigolf: { pitch: 26, hero: -0.4, reach: 0 },
  lanes: { pitch: 23, hero: -0.45, reach: 0 },
} as const satisfies Readonly<Record<string, Framing>>;

export type FramedControl = keyof typeof DIORAMA_FRAMING;

/** Ovládání se svým záběrem, které rámování nemění, a proč. */
export const FRAMING_KEEP: Readonly<Record<string, string>> = {
  platform: 'boční pohled plošinovky, QA 6. 11. vzor kvality',
  shooter: 'střelnice, QA 6. 11. vzor kvality (hloubka, siluety)',
  flap: 'boční pohled poletování, překážky čte z profilu',
};

/** Ovládání, kde střed záběru není hrdina věty (`timing`: jezdec nad věží). */
export const CENTRED_SUBJECT: ReadonlySet<string> = new Set(['timing']);

const halfTan = (fov: number): number => Math.tan(MathUtils.degToRad(fov) / 2);

/** Obzor (bod v nekonečnu ve výšce kamery) v obraze jako NDC y – při sklonu `pitch`° a svislém poli `fov`°. */
export function horizonNdc(pitch: number, fov: number = CANVAS_FOV): number {
  return Math.tan(MathUtils.degToRad(pitch)) / halfTan(fov);
}

/** O kolik (rad) strměji kamera kouká na hrdinu, než míří osa pohledu, aby stál v NDC y `hero`. */
export function dropOf(framing: Pick<Framing, 'hero'>, fov: number = CANVAS_FOV): number {
  return Math.atan(-framing.hero * halfTan(fov));
}

/** Kamera za hrdinou: o `back` m za ním, `up` m nad ním; osa pohledu protne výšku hrdiny `ahead` m před ním. */
export interface DioramaRig {
  readonly back: number;
  readonly up: number;
  readonly ahead: number;
}

/** Kamera ve sklonu `framing.pitch`, která má hrdinu ve vzdálenosti `reach` m v NDC y `framing.hero`. */
export function dioramaRig(framing: Framing, reach: number = framing.reach, fov: number = CANVAS_FOV): DioramaRig {
  const pitch = MathUtils.degToRad(framing.pitch);
  const sight = pitch + dropOf(framing, fov);
  const back = reach * Math.cos(sight);
  const up = reach * Math.sin(sight);
  return { back, up, ahead: up / Math.tan(pitch) - back };
}

/** `dioramaRig` po +z scény: kamera za hrdinou `hero`, `look` na ose pohledu ve výšce hrdiny. */
export function placeDiorama(camera: PerspectiveCamera, look: Vector3, hero: { readonly x: number; readonly y: number; readonly z: number }, framing: Framing, reach: number = framing.reach): void {
  const rig = dioramaRig(framing, reach, camera.fov);
  camera.position.set(hero.x, hero.y + rig.up, hero.z - rig.back);
  look.set(hero.x, hero.y, hero.z + rig.ahead);
  camera.lookAt(look);
}

/** Kamera, která už kouká na hrdinu (`lookAt` na něj), zvedne osu pohledu o `dropOf`: hrdina klesne do NDC y `framing.hero`. */
export function raiseToHorizon(camera: PerspectiveCamera, framing: Pick<Framing, 'hero'>): void {
  camera.rotateX(dropOf(framing, camera.fov));
}
