'use client';

/**
 * Riggovaná postava s klipy (P26B T5). Model se klonuje přes
 * `SkeletonUtils.clone` – `clone(true)` by nechal skin ukazovat na kosti
 * originálu a všechny kopie by se hýbaly jako jedna. `AnimationMixer` běží
 * v `useFrame`, mimo hashovaný stav; klip volí scéna funkcí `clipOf` ze stavu
 * těla a tady se jen prolne. Stav, který postava klip nemá (hit u Kenney),
 * hraje nejbližší náhradu.
 */

import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type AnimationAction, AnimationMixer, LoopOnce, type Object3D } from 'three';
import { type GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

import type { RiggedCharacter } from '@/play/arcade/models';
import type { ClipState } from '@/play/arcade/motion';

/** Výška postavy v GLB – `scripts/assets/rigged/build.mjs` ji tak normalizuje. */
const RIGGED_HEIGHT_M = 1.8;
/** Prolnutí klipů (s). */
const FADE_S = 0.15;
/** Klipy, které dohrají jednou a zůstanou v poslední póze. */
const ONCE: ReadonlySet<ClipState> = new Set(['shoot', 'hit', 'die']);
/** Náhrada za stav, na který postava klip nemá. */
const FALLBACK: Readonly<Record<ClipState, readonly ClipState[]>> = {
  idle: ['idle'],
  run: ['run', 'idle'],
  jump: ['jump', 'run', 'idle'],
  shoot: ['shoot', 'idle'],
  hit: ['hit', 'idle'],
  die: ['die', 'idle'],
};

const cache = new Map<string, Promise<GLTF | null>>();

function loadRigged(path: string): Promise<GLTF | null> {
  let pending = cache.get(path);
  if (pending === undefined) {
    pending = new GLTFLoader().loadAsync(path).catch(() => null);
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
}: {
  readonly character: RiggedCharacter;
  /** Výška těla (m); postava se do ní vepíše. */
  readonly h: number;
  /** Stav těla v tomhle snímku – čte se v `useFrame`, ne přes React. */
  readonly clip: () => ClipState;
  /** Klip, který opravdu začal hrát (po náhradě). */
  readonly onClip?: (state: ClipState) => void;
  readonly fallback: string;
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
  useFrame((_, delta) => {
    if (rig === null) return;
    const wanted = FALLBACK[clip()].find((state) => rig.actions.has(state)) ?? 'idle';
    if (wanted !== playing.current) {
      const next = rig.actions.get(wanted);
      const before = playing.current === null ? undefined : rig.actions.get(playing.current);
      if (next !== undefined) {
        next.reset().setEffectiveWeight(1).fadeIn(playing.current === null ? 0 : FADE_S).play();
        before?.fadeOut(FADE_S);
      }
      playing.current = wanted;
      onClip?.(wanted);
    }
    rig.mixer.update(delta);
  });

  if (rig !== null) return <primitive object={rig.scene} scale={h / RIGGED_HEIGHT_M} />;
  return (
    <mesh position={[0, h / 2, 0]}>
      <boxGeometry args={[h * 0.4, h, h * 0.4]} />
      <meshStandardMaterial color={fallback} roughness={0.6} />
    </mesh>
  );
}
