/**
 * Záběr zblízka v klidu (P75 T4, koncept A „hračkové diorama“): na startu, v pauze a prvních `REST_SHOT.holdS` s
 * hry stojí kamera nízko za hrdinou – hrdina ~1/4 výšky obrazu, obzor v horní třetině. Pak za `REST_SHOT.moveS` s
 * plynule odjede na herní rámování P73D (`DIORAMA_FRAMING`) a při pauze nebo restartu se stejně vrátí; na kartě
 * výsledku zůstává herní záběr (P76 T1).
 *
 * Jedna vrstva nad kamerou scény, ne další kamera v každém žánru: scéna postaví herní záběr (priorita 0, i s úvodním
 * průletem), `RestShot` ho uloží (`camera.userData.game`) a prolne se záběrem zblízka; na začátku dalšího snímku ho
 * vrátí, takže scény, které za cílem dojíždí z polohy kamery, jedou dál z herního záběru. Čitelnost těl, kulisy
 * a orientační body měří herní záběr (`restCamera`), ne záběr zblízka.
 *
 * Jen ovládání v `REST_CONTROLS`. `timing`: středem záběru je věž, ne hrdina (`CENTRED_SUBJECT`). `minigolf`: klidový
 * přehled rámuje jamku pod úvodní kartou uprostřed obrazu a míček zblízka by ležel za ní.
 *
 * Jen obraz: kamera nejde do stavu ani hashe (`p64-hash.test.ts`); hodiny držení čtou tik jádra, přejezd nástěnné.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useMemo } from 'react';
import { Box3, MathUtils, type Object3D, PerspectiveCamera, Quaternion, Vector3 } from 'three';

import { baseControlOf } from '@/play/arcade/addons';
import { ARCADE_HZ, HEADER } from '@/play/arcade/contract';

import type { ArcadeSession } from '../session';
import { type Framing, TILT_LIFT, dioramaRig } from './framing';
import { applyIntro, introLeftOf, introLookOf, restCamera } from './intro';

export const REST_SHOT = {
  /** Prvních tolik sekund hry (tik jádra) zůstává kamera zblízka. */
  holdS: 1.5,
  /** Přejezd mezi záběrem zblízka a herním (s). */
  moveS: 0.8,
  /** Delší mezera mezi snímky (kreslení na požádání) se počítá jako tolik sekund – jinak by přejezd přeskočil. */
  maxStepS: 0.1,
  /** Kolik výšky obrazu zabere hrdina. */
  share: 0.25,
  /** Nejmenší výška hrdiny (m), ze které se počítá odstup – ještě nenačtený model nemá rozměr. */
  floor: 0.9,
} as const;

/**
 * Sklon osy pohledu 14° (obzor v NDC 0,43, horní třetina) a střed hrdiny v NDC y −0,3 – jako koncept (−0,34). Níž
 * (−0,4) ho v aréně z poloviny kryla lišta „Change one thing“ dole a na telefonu by se mu nevešly nohy.
 */
export const REST_FRAMING: Framing = { pitch: 14, hero: -0.3, reach: 0 };

/** Ovládání se záběrem zblízka v klidu. */
export const REST_CONTROLS: ReadonlySet<string> = new Set(['runner', 'steer', 'move_free', 'lanes']);

/** Ostrý pás tilt-shiftu (výška obrazu 0–1) přes hrdinu v záběru zblízka – jako `tiltFocus` u herního rámování. */
export const REST_FOCUS = (REST_FRAMING.hero + 1) / 2 + TILT_LIFT;

/**
 * Kde má být kamera: 1 = zblízka (start, pauza, prvních `holdS` s), 0 = herní záběr. Po konci hry (`running`
 * false) zůstává herní záběr (P76 T1): karta výsledku kryje spodek obrazu a záběr zblízka pod ní byl jen rozmazaný
 * hrdina – soudce proti `main` ho u hradu po konci ukázky robota označil za „heavily blurred and zoomed in“.
 */
export function restTarget(running: boolean, paused: boolean, tick: number): 0 | 1 {
  return running && (paused || tick < REST_SHOT.holdS * ARCADE_HZ) ? 1 : 0;
}

/** Jeden snímek přejezdu: lineárně k `target`, celý přejezd za `moveS` s. */
export function stepRest(weight: number, target: number, seconds: number): number {
  const step = Math.min(Math.max(0, seconds), REST_SHOT.maxStepS) / REST_SHOT.moveS;
  return target > weight ? Math.min(target, weight + step) : Math.max(target, weight - step);
}

/** Váha prolnutí z lineárního přejezdu: smoothstep, rozjezd i dojezd bez škubnutí. */
export const restEase = (weight: number): number => weight * weight * (3 - 2 * weight);

/**
 * Záběr zblízka: kamera `eye` za středem hrdiny `center` proti směru `heading` (jednotkový, vodorovný – kam kouká
 * herní kamera), `look` = bod na ose pohledu ve výšce středu. Odstup tak, ať hrdina vysoký `height` m zabere
 * `share` výšky obrazu při svislém zorném poli `fov`°.
 */
export function restPose(eye: Vector3, look: Vector3, center: Vector3, heading: Vector3, height: number, fov: number): void {
  const reach = Math.max(height, REST_SHOT.floor) / (2 * Math.tan(MathUtils.degToRad(fov) / 2) * REST_SHOT.share);
  const rig = dioramaRig(REST_FRAMING, reach, fov);
  eye.copy(center).addScaledVector(heading, -rig.back);
  eye.y += rig.up;
  look.copy(center).addScaledVector(heading, rig.ahead);
}

/** Herní záběr snímku, který `RestShot` prolnul se záběrem zblízka (`restCamera` ho vrací místo kresleného). */
export interface GamePose {
  readonly position: Vector3;
  readonly quaternion: Quaternion;
}

/** Váha záběru zblízka v tomhle snímku (0–1, po `restEase`) – tilt-shift podle ní posune a zesílí rozostření. */
export const restWeightOf = (camera: { readonly userData: Record<string, unknown> }): number => (camera.userData.restWeight as number | undefined) ?? 0;

/** Priorita prolnutí: po scéně (0), před ostrým pásem tilt-shiftu a skládačem (`BEFORE_COMPOSER` = 0,5). */
const REST_PRIORITY = 0.25;
/** Vrácení herního záběru před scénou. */
const RESTORE_PRIORITY = -1;
/** Hrdina a jeho rozměr se hledají znovu po tolika snímcích (model se dotáhne, čitelnost ho zvětší). */
const MEASURE_EVERY = 20;

/** Uzel hrdiny scény (`userData.frame === 'hero'`, jak ho hledají sondy záběru). */
function findHero(root: Object3D): Object3D | null {
  let hero: Object3D | null = null;
  root.traverseVisible((node) => {
    if (hero === null && node.userData.frame === 'hero') hero = node;
  });
  return hero;
}

export function RestShot({ session }: { readonly session: ArcadeSession }) {
  const control = baseControlOf(session.world.control).id;
  const on = REST_CONTROLS.has(control);
  const rig = useMemo(
    () => ({
      weight: 1,
      last: -1,
      frames: 0,
      hero: null as Object3D | null,
      height: 0,
      lift: 0,
      game: { position: new Vector3(), quaternion: new Quaternion() } satisfies GamePose,
      scratch: new PerspectiveCamera(),
      aim: new PerspectiveCamera(),
      box: new Box3(),
      at: new Vector3(),
      center: new Vector3(),
      heading: new Vector3(),
      eye: new Vector3(),
      look: new Vector3(),
      gameLook: new Vector3(),
    }),
    [],
  );
  const scene = useThree((three) => three.scene);

  useFrame(({ camera }) => {
    if (camera.userData.game !== rig.game) return;
    camera.position.copy(rig.game.position);
    camera.quaternion.copy(rig.game.quaternion);
    camera.userData.game = undefined;
  }, RESTORE_PRIORITY);

  useFrame(({ camera, frameloop, invalidate }) => {
    if (!on || !(camera as PerspectiveCamera).isPerspectiveCamera) return;
    const view = camera as PerspectiveCamera;
    const now = performance.now() / 1000;
    const target = restTarget(session.snapshot().runState === 'running', session.paused(), session.state()[HEADER.tick] as number);
    rig.weight = rig.last < 0 ? target : stepRest(rig.weight, target, now - rig.last);
    rig.last = now;
    const weight = restEase(rig.weight);
    view.userData.restWeight = weight;
    // Kreslení na požádání (pauza, konec): přejezd si další snímek vyžádá sám.
    if (frameloop === 'demand' && rig.weight !== target) invalidate();
    if (weight === 0) return;

    if (rig.frames % MEASURE_EVERY === 0 || rig.hero === null || rig.hero.parent === null) {
      rig.hero = findHero(scene);
      if (rig.hero !== null) {
        rig.box.setFromObject(rig.hero);
        rig.hero.getWorldPosition(rig.at);
        rig.height = rig.box.isEmpty() ? 0 : rig.box.max.y - rig.box.min.y;
        rig.lift = rig.box.isEmpty() ? REST_SHOT.floor / 2 : (rig.box.min.y + rig.box.max.y) / 2 - rig.at.y;
      }
    }
    rig.frames += 1;
    if (rig.hero === null) return;

    // Herní záběr bez úvodního průletu; průlet se pak přidá k prolnutému záběru.
    const game = restCamera(view, rig.scratch);
    const left = introLeftOf(view);
    if (left !== 0) introLookOf(view, rig.gameLook);
    rig.game.position.copy(game.position);
    rig.game.quaternion.copy(game.quaternion);

    rig.heading.set(0, 0, -1).applyQuaternion(game.quaternion).setY(0);
    if (rig.heading.lengthSq() < 1e-6) rig.heading.set(0, 0, 1);
    rig.heading.normalize();
    rig.center.copy(rig.hero.getWorldPosition(rig.at));
    rig.center.y += rig.lift;
    restPose(rig.eye, rig.look, rig.center, rig.heading, rig.height, view.fov);
    rig.aim.position.copy(rig.eye);
    rig.aim.up.copy(view.up);
    rig.aim.lookAt(rig.look);

    view.position.lerpVectors(game.position, rig.eye, weight);
    view.quaternion.slerpQuaternions(game.quaternion, rig.aim.quaternion, weight);
    if (left !== 0) applyIntro(view, rig.gameLook.lerp(rig.look, weight), left);
    view.updateMatrixWorld();
    view.userData.game = rig.game;
  }, REST_PRIORITY);

  return null;
}
