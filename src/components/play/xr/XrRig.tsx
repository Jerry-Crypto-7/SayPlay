'use client';

import { useFrame, useThree } from '@react-three/fiber';
import { useXR } from '@react-three/xr';
import { type ReactNode, type RefObject, useEffect, useMemo, useRef } from 'react';
import { ACESFilmicToneMapping, type Group, Vector3 } from 'three';

import { BODY, HEADER, UNIT, bodyBase } from '@/play/arcade/contract';
import { type Point, deskOfWorld } from '@/play/xr/diorama-scale';
import { REACH, type XrControl, type XrMotion } from '@/play/xr/input-map';

import { frameOf } from '../arcade/ArcadeStage';
import type { ArcadeSession } from '../arcade/session';
import { Diorama, type DeskReport, heroNodeOf } from './Diorama';
import { useXrGame } from './xr-context';
import { MOTION_PRIORITY, XrAim } from './XrAim';
import { XrInput, xrControlOf } from './XrInput';
import { XrSwing } from './XrSwing';

/**
 * Hráč ve VR (P65 T1). Kameru vlastní hlava: kamery žánrů dál nastavují kameru R3F, jenže tou je v relaci kamera
 * brýlí a její pozici každý snímek přepíše póza hlavy. Svět se otočí o půl kruhu, aby hráč stál tam, kde ve 2D
 * stojí kamera (za hrdinou, na straně −z). VR-nativní žánry (T3) svět nezmenší, nebo ho dají do dosahu ruky
 * (`placementOf`); ostatní se hrají jako diorama na desce před hráčem (T4, `Diorama`).
 * Mimo relaci je obal identita, takže 2D se nemění a vstup do VR scénu nepřestaví.
 * `DIORAMA` je jen poloha, než relace dostane hru (pak měřítko spočte `Diorama` z velikosti hřiště).
 */
export const DIORAMA = { scale: 1 / 15, at: [0, 0.8, -0.9], turn: Math.PI } as const;

const ORIGIN = [0, 0, 0] as const;

/**
 * Ve VR se scéna kreslí naposled sama, po skládači postprocessingu (`look/rig/Post.tsx`, soubor P62): skládač
 * kreslí přes celoobrazovkový trojúhelník, takže do obou očí dá tentýž obraz, a stereo se rozpadne. Vyšší priorita
 * než skládač (1) = kreslí se po něm, `autoClear` jeho výsledek smaže. Tónuje se jako bez skládače (`StyleRig`).
 * simplified: skládač dál kreslí naprázdno a stojí GPU; vypnout ho ve VR jde jen v `Post.tsx` (nález v `docs/vr/README.md`).
 */
const XR_RENDER_PRIORITY = 100;

function DirectRender({ calls }: { readonly calls: RefObject<number> }) {
  useFrame(({ gl, scene, camera }) => {
    const before = { autoClear: gl.autoClear, toneMapping: gl.toneMapping };
    gl.autoClear = true;
    gl.toneMapping = ACESFilmicToneMapping;
    gl.render(scene, camera);
    calls.current = gl.info.render.calls;
    gl.autoClear = before.autoClear;
    gl.toneMapping = before.toneMapping;
  }, XR_RENDER_PRIORITY);
  return null;
}

/** Co e2e o VR čte (`e2e/vr-enter.spec.ts`). */
export interface XrReport {
  readonly presenting: boolean;
  /** Pohledy kamery brýlí – v relaci dvě oči. */
  readonly eyes: number;
  /** Draw cally posledního snímku ve VR. */
  readonly calls: number;
  /** Osa míření z paprsku a osa pruhu pod rukou v posledním snímku (T3, `vr-native.spec.ts`); `null` = žádná. */
  readonly aim: number | null;
  readonly laneAxis: number | null;
  /** Hráčovo tělo ve stavu hry (jednotky jádra) – „hrdina se pohnul“ (T4, `vr-diorama.spec.ts`); `null` = bez hry. */
  readonly heroAt: Point | null;
  /** Střed kresleného hrdiny promítnutý kamerou každého oka (NDC −1…1, +y nahoru); `behind` = za okem. */
  readonly heroView: readonly ({ readonly x: number; readonly y: number; readonly behind: boolean } | null)[] | null;
  /** Kreslený hrdina v osách desky dioramy (m: x doprava, y nad deskou, z k hráči); `null` = bez dioramy. */
  readonly heroOnDesk: Point | null;
  /** Deska dioramy (poloha, otočení, měřítko světa); `null` = VR-nativní žánr nebo mimo relaci. */
  readonly desk: DeskReport | null;
}

declare global {
  interface Window {
    __playXr?: () => XrReport;
  }
}

function XrProbe({
  presenting,
  calls,
  motion,
  game,
  desk,
}: {
  readonly presenting: boolean;
  readonly calls: RefObject<number>;
  readonly motion: RefObject<XrMotion>;
  readonly game: ArcadeSession | null;
  readonly desk: RefObject<DeskReport | null>;
}) {
  const get = useThree((three) => three.get);
  useEffect(() => {
    const probe = (): XrReport => {
      const { gl, scene } = get();
      const state = game?.state() ?? null;
      const body = state === null ? null : bodyBase(state[HEADER.player] as number);
      const heroAt = state === null || body === null ? null : { x: state[body + BODY.x] as number, y: state[body + BODY.y] as number, z: state[body + BODY.z] as number };
      const hero = presenting ? heroNodeOf(scene) : null;
      if (hero !== null) scene.updateMatrixWorld();
      const at = hero?.getWorldPosition(new Vector3()) ?? null;
      return {
        presenting,
        eyes: presenting ? gl.xr.getCamera().cameras.length : 0,
        calls: presenting ? calls.current : 0,
        aim: presenting ? motion.current.aim : null,
        laneAxis: presenting ? motion.current.laneAxis : null,
        heroAt,
        heroView:
          hero === null
            ? null
            : gl.xr.getCamera().cameras.map((eye) => {
                const box = frameOf(hero, eye, 1, 1);
                return box === null ? null : { x: box.x, y: box.y, behind: box.behind };
              }),
        heroOnDesk: at === null || desk.current === null ? null : deskOfWorld(desk.current, at),
        desk: presenting ? desk.current : null,
      };
    };
    window.__playXr = probe;
    return () => {
      if (window.__playXr === probe) delete window.__playXr;
    };
  }, [get, presenting, calls, motion, game, desk]);
  return null;
}

/**
 * VR-nativní žánry (T3) stojí 1:1 na zemi: střílečka na místě kamery žánru (`ShooterRig`: 5,5 m za hrdinou,
 * bez její výšky 3,6 m – hlavu má hráč ve své výšce), hod 3 m za hrdinou čelem k hřišti (kamera hodu je boční
 * a švih dopředu by letěl doprava). Krájení a bouchání mají pruhy v dosahu ruky (`REACH`).
 */
const STAND_BACK = { 'shooter-rig': 5.5, 'throw-rig': 3 } as const;

interface Placement {
  readonly scale: number;
  readonly at: readonly [number, number, number];
}

/** VR-nativní žánr (T3): hraje se rukou ve skutečné velikosti nebo v dosahu ruky, ne na desce. */
const nativeOf = (control: XrControl | null): boolean => control?.swing !== undefined || control?.input === 'shooter-rig' || control?.input === 'throw-rig';

function placementOf(control: XrControl | null, state: Int32Array): Placement {
  if (control?.swing !== undefined) return REACH;
  if (control?.input === 'shooter-rig' || control?.input === 'throw-rig') {
    const hero = bodyBase(state[HEADER.player] as number);
    // Obal otočený o půl kruhu postaví bod scény (x, 0, z) k nohám hráče, když sám stojí v (x, 0, z).
    // simplified: hrdina střílečky úkrokem posune svět po ticích bez vyhlazení; kdyby to v T8 cukalo, interpolovat.
    return { scale: 1, at: [-(state[hero + BODY.x] as number) / UNIT, 0, (state[hero + BODY.z] as number) / UNIT - STAND_BACK[control.input]] };
  }
  return DIORAMA;
}

/** Postaví svět VR-nativního žánru kolem hráče každý snímek (hrdina střílečky se hýbe); mimo relaci vrátí obal na identitu. */
function XrPlace({ world, session, control }: { readonly world: RefObject<Group | null>; readonly session: ArcadeSession | null; readonly control: XrControl | null }) {
  useFrame(() => {
    const group = world.current;
    if (group === null) return;
    const { scale, at } = session === null ? DIORAMA : placementOf(control, session.state());
    group.position.set(...at);
    group.rotation.set(0, DIORAMA.turn, 0);
    group.scale.setScalar(scale);
  }, MOTION_PRIORITY - 1);
  useEffect(
    () => () => {
      world.current?.position.set(...ORIGIN);
      world.current?.rotation.set(0, 0, 0);
      world.current?.scale.setScalar(1);
    },
    [world],
  );
  return null;
}

export function XrRig({ children }: { readonly children: ReactNode }) {
  const presenting = useXR((xr) => xr.session != null);
  const game = useXrGame();
  const control = useMemo(() => (game === null ? null : xrControlOf(game.world)), [game]);
  const world = useRef<Group>(null);
  const motion = useRef<XrMotion>({ aim: null, velocity: null, laneAxis: null });
  const calls = useRef(0);
  const desk = useRef<DeskReport | null>(null);
  const aims = control?.input === 'shooter-rig' || control?.input === 'lanes';
  const swings = control?.input === 'throw-rig' || control?.swing !== undefined;
  const diorama = game !== null && !nativeOf(control);
  return (
    <>
      <group ref={world}>{children}</group>
      {presenting && diorama && <Diorama world={world} session={game} report={desk} />}
      {presenting && !diorama && <XrPlace world={world} session={game} control={control} />}
      {presenting && <DirectRender calls={calls} />}
      {presenting && game !== null && control !== null && aims && <XrAim session={game} control={control} world={world} motion={motion} />}
      {presenting && game !== null && swings && <XrSwing session={game} world={world} motion={motion} />}
      {presenting && game !== null && <XrInput session={game} motion={motion} />}
      <XrProbe presenting={presenting} calls={calls} motion={motion} game={game} desk={desk} />
    </>
  );
}
