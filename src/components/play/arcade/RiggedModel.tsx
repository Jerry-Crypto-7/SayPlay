'use client';

/**
 * Riggovaná postava s klipy (P26B T5). Model se klonuje přes
 * `SkeletonUtils.clone` – `clone(true)` by nechal skin ukazovat na kosti
 * originálu a všechny kopie by se hýbaly jako jedna. `AnimationMixer` běží
 * v `useFrame`, mimo hashovaný stav; klip volí scéna funkcí `clipOf` ze stavu
 * těla a tady se jen prolne. Klipy mapuje manifest (P32C T2); stav, na který
 * postava klip nemá (`procedural`, hit u Kenney), hraje nejbližší náhradu
 * a pohyb stavu (poskok, zásah, pád) k ní dopočítá `proceduralPose`. Scéna,
 * která předá pohled těla po tiku (`toy`), dostane místo něj hračkový pohyb
 * (P45D T13): výpad, oslavu výhry, nesení a chůzi tam, kde klip chybí.
 */

import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type AnimationAction, AnimationMixer, type Group, LoopOnce, type Object3D } from 'three';
import { type GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

import { PROCEDURAL_CLIP, RIGGED_PREFIX, type RiggedCharacter } from '@/play/arcade/models';
import type { ClipState } from '@/play/arcade/motion';
import { type ToyPose, type ToyView, toyPoseOf } from '@/play/arcade/toy-motion';

import { HIT_S, fallOf, jumpStretchOf, landSquashOf, squashPose, tiltPose } from './characterMotion';
import { mergeRig } from './look/load';
import { applyToy, toyMotionOn } from './toy/applyToy';
import { bodyClassOf } from './toy/body-class';

/** Výška postavy v GLB – `scripts/assets/rigged/build.mjs` ji tak normalizuje. */
const RIGGED_HEIGHT_M = 1.8;
/** Prolnutí klipů (s). */
const FADE_S = 0.15;
/** Nejdelší krok animace za jeden snímek. */
const MAX_MIXER_STEP_S = 0.1;
/** Klipy, které dohrají jednou a zůstanou v poslední póze. */
export const ONCE: ReadonlySet<ClipState> = new Set(['shoot', 'hit', 'die', 'win']);
/**
 * Náhrada za stav, na který postava klip nemá. Chůze a běh se zastoupí navzájem
 * (P54B T5): postava bez chůze jde svým během, příšera P54 bez běhu běží chůzí.
 */
const FALLBACK: Readonly<Record<ClipState, readonly ClipState[]>> = {
  idle: ['idle'],
  walk: ['walk', 'run', 'idle'],
  run: ['run', 'walk', 'idle'],
  jump: ['jump', 'run', 'idle'],
  shoot: ['shoot', 'idle'],
  hit: ['hit', 'idle'],
  die: ['die', 'idle'],
  win: ['win', 'idle'],
};

/** Klip, který postava pro stav těla opravdu hraje: první z řetězce náhrad, který má. */
export function playedClip(state: ClipState, hasClip: (state: ClipState) => boolean): ClipState {
  return FALLBACK[state].find(hasClip) ?? 'idle';
}

/**
 * Pohyb stavu bez klipu, přičtený k postavě (`since` = sekundy ve stavu, `h` výška těla,
 * `sinceLand` = sekundy od dopadu skoku bez klipu): běh poskakuje, skok se natáhne a dopad
 * zmáčkne, zásah cukne dozadu a zakymácí, smrt postavu položí (P36C T8, `characterMotion.ts`).
 * Klid nic nepřidá; dopad doznívá i do stavu, na který postava klip má.
 */
export function proceduralPose(group: Group, state: ClipState | null, since: number, h: number, sinceLand = Infinity): void {
  group.position.y = state === 'run' ? h * 0.05 * Math.abs(Math.sin(since * 12)) : 0;
  tiltPose(group, state === 'hit' ? since / HIT_S : 1, state === 'die' ? fallOf(since) : 0);
  squashPose(group, state === 'jump' ? -jumpStretchOf(since) : landSquashOf(sinceLand));
}

/** Stav těla, jak dlouho v něm je a jak dávno dopadl skok bez klipu (s). */
export interface HeldState {
  readonly state: ClipState;
  readonly since: number;
  readonly sinceLand: number;
}

/**
 * Jeden snímek `useFrame` pro pohyb bez klipu: čas ve stavu roste, nový stav ho
 * vynuluje, a `proceduralPose` dostane stav jen tehdy, když na něj postava klip nemá.
 * Chůze bez klipu je běh (hraje jeho klip, bez něj poskakuje jako on). Skok bez klipu,
 * který skončí během, chůzí nebo klidem, je dopad.
 */
export function poseTick(group: Group | null, held: HeldState | null, body: ClipState, hasClip: (state: ClipState) => boolean, step: number, h: number): HeldState {
  const now = body === 'walk' && !hasClip('walk') ? 'run' : body;
  const landed = held?.state === 'jump' && (now === 'run' || now === 'walk' || now === 'idle') && !hasClip('jump');
  const sinceLand = landed ? 0 : (held?.sinceLand ?? Infinity) + step;
  const next = held?.state === now ? { state: now, since: held.since + step, sinceLand } : { state: now, since: 0, sinceLand };
  if (group !== null) proceduralPose(group, hasClip(now) ? null : now, next.since, h, sinceLand);
  return next;
}

/** Pohled těla po tiku a tik s podílem (`tick + alpha`) – co scéna předá hračkovému pohybu postavy. */
export interface ToyFrame {
  readonly view: ToyView;
  readonly tick: number;
  /**
   * Tik začátku úderu, když ho scéna posouvá (aréna, P45D T23): rána dopadá v tiku zásahu, takže
   * úder začne o nápřah dřív a tik zásahu je vrchol výpadu k zasaženému. Bez něj úder čte pohled.
   */
  readonly attackAt?: number;
}

/**
 * Pohled bez toho, co postava hraje klipem (P45D T13): klip má přednost a hračka by ho
 * zdvojila – poskok navrch klipu běhu. Klip kryje, z čeho ho volí `clipOf`: běh nebo
 * chůze krok, skok vzlet i dopad, střelba výstřel hráče (úder nepřítele klip nemá),
 * zásah zásah, smrt pád i zásah, kterým tělo zaniklo, výhra oslavu (P54B T5).
 * Nesení klip nemá nikdy.
 */
export function unclippedView(view: ToyView, hasClip: (state: ClipState) => boolean): ToyView {
  const still = hasClip('run') || hasClip('walk');
  const dieClip = !view.alive && hasClip('die');
  return {
    ...view,
    vx: still ? 0 : view.vx,
    vy: still ? 0 : view.vy,
    vz: still ? 0 : view.vz,
    grounded: view.grounded || hasClip('jump'),
    alive: view.alive || dieClip,
    hit: view.hit && !hasClip('hit') && !dieClip,
    attack: view.attack && !(view.shot && hasClip('shoot')),
    won: view.won && !hasClip('win'),
  };
}

const cache = new Map<string, Promise<GLTF | null>>();

function loadRigged(path: string): Promise<GLTF | null> {
  let pending = cache.get(path);
  if (pending === undefined) {
    // Slít jednou na načtený model (P36C T9): klony z `cloneSkinned` pak nesou jednu síť na materiál.
    pending = new GLTFLoader()
      .loadAsync(path)
      .then((gltf) => {
        mergeRig(gltf.scene);
        return gltf;
      })
      .catch(() => null);
    cache.set(path, pending);
  }
  return pending;
}

interface Rig {
  readonly scene: Object3D;
  readonly mixer: AnimationMixer;
  readonly actions: ReadonlyMap<ClipState, AnimationAction>;
}

export function RiggedModel({
  character,
  h,
  clip,
  onClip,
  fallback,
  yaw,
  toy,
}: {
  readonly character: RiggedCharacter;
  /** Výška těla (m); postava se do ní vepíše. */
  readonly h: number;
  /** Stav těla v tomhle snímku – čte se v `useFrame`, ne přes React. */
  readonly clip: () => ClipState;
  /** Klip, který opravdu začal hrát (po náhradě). */
  readonly onClip?: (state: ClipState) => void;
  readonly fallback: string;
  /** Natočení po směru pohybu (rad kolem y) – kde ho scéna nedrží sama nad modelem. */
  readonly yaw?: () => number;
  /**
   * Pohled těla po tiku (P45D T13): stavy bez klipu pak hraje `toyPoseOf` podle třídy
   * postavy z manifestu; bez něj dnešní `poseTick`.
   */
  readonly toy?: () => ToyFrame;
}) {
  const [gltf, setGltf] = useState<GLTF | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void loadRigged(character.path).then((loaded) => {
      if (live) setGltf(loaded);
    });
    return () => {
      live = false;
    };
  }, [character.path]);

  const rig = useMemo((): Rig | null => {
    if (gltf === null || gltf === undefined) return null;
    const scene = cloneSkinned(gltf.scene);
    const mixer = new AnimationMixer(scene);
    const actions = new Map<ClipState, AnimationAction>();
    for (const [state, name] of Object.entries(character.clips) as [ClipState, string][]) {
      if (name === PROCEDURAL_CLIP) continue;
      const source = gltf.animations.find((animation) => animation.name === name);
      if (source === undefined) continue;
      const action = mixer.clipAction(source);
      if (ONCE.has(state)) {
        action.setLoop(LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      actions.set(state, action);
    }
    return { scene, mixer, actions };
  }, [gltf, character]);

  // Mixer si drží akce a vazby na kosti klonu; bez `uncacheRoot` je feed po každém přepnutí nechá v paměti (P28B T6).
  useEffect(
    () => () => {
      if (rig === null) return;
      rig.mixer.stopAllAction();
      rig.mixer.uncacheRoot(rig.scene);
    },
    [rig],
  );

  const playing = useRef<ClipState | null>(null);
  const holder = useRef<Group>(null);
  /** Stav těla a jak dlouho v něm je – pro pohyb stavu, na který postava klip nemá. */
  const held = useRef<HeldState | null>(null);
  /** Hračková póza minulého snímku (P45D T13) a třída těla postavy podle manifestu (T5). */
  const toyPose = useRef<ToyPose | null>(null);
  const bodyClass = useMemo(() => bodyClassOf(`${RIGGED_PREFIX}${character.id}`), [character.id]);
  useFrame((_, delta) => {
    if (rig === null) return;
    const now = clip();
    const step = Math.min(delta, MAX_MIXER_STEP_S);
    const hasClip = (state: ClipState): boolean => rig.actions.has(state);
    const frame = toy?.();
    if (frame === undefined) {
      held.current = poseTick(holder.current, held.current, now, hasClip, step, h);
      if (yaw !== undefined && holder.current !== null) holder.current.rotation.y = yaw();
    } else if (holder.current !== null) {
      // Póza čte jen pohled a tik; tik, který jde zpátky (restart), zahodí paměť minulého snímku.
      const kept = toyPose.current !== null && frame.tick >= toyPose.current.at ? toyPose.current : null;
      const previous = kept === null || frame.attackAt === undefined || kept.attackAt === frame.attackAt ? kept : { ...kept, attackAt: frame.attackAt };
      toyPose.current = toyPoseOf(unclippedView(frame.view, hasClip), bodyClass, previous, frame.tick, !toyMotionOn());
      applyToy({ group: holder.current }, toyPose.current, h, yaw?.() ?? 0);
    }
    const wanted = playedClip(now, hasClip);
    if (wanted !== playing.current) {
      const next = rig.actions.get(wanted);
      const before = playing.current === null ? undefined : rig.actions.get(playing.current);
      // Příšera P54 bez běhu má pro chůzi i běh jeden klip, tedy jednu akci: přepnutí ji nechá hrát.
      if (next !== undefined && next !== before) {
        next.reset().setEffectiveWeight(1).fadeIn(playing.current === null ? 0 : FADE_S).play();
        before?.fadeOut(FADE_S);
      }
      playing.current = wanted;
      onClip?.(wanted);
    }
    // Pauza a konec běhu kreslí na požádání (P28E T2): první snímek po nich nese celou
    // dobu stání a animace by přes ni skočila. Stání se nepřehrává.
    rig.mixer.update(step);
  });

  if (rig !== null) {
    return (
      <group ref={holder}>
        <primitive object={rig.scene} scale={h / RIGGED_HEIGHT_M} />
      </group>
    );
  }
  return (
    <mesh position={[0, h / 2, 0]}>
      <boxGeometry args={[h * 0.4, h, h * 0.4]} />
      <meshStandardMaterial color={fallback} roughness={0.6} />
    </mesh>
  );
}
