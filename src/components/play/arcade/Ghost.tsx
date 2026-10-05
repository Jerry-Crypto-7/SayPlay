'use client';

/**
 * Duch (P37C T3): průhledný hrdina dřívějšího běhu – kamaráda z odkazu výzvy
 * (`friend`) nebo nejlepšího běhu hry (`best`) – závodí vedle hráče. Pózu
 * dává `GhostSource.poseAt(tik hráče)` (`ghost-source.ts`) a kreslí se mezi
 * posledními dvěma tiky stejně jako hráč (`session.alpha()`). Když záznam
 * skončí, duch zmizí s efektem (poskok a zhasnutí); restart hráče ho vrátí
 * na start.
 *
 * Jen čte: zdroj má vlastní jádro, stav hráče se tu nemění, a všechno, co tu
 * běží na hodinách snímků (zmizení), leží mimo hashovaný stav.
 *
 * Bez `children` kreslí siluetu v rozměrech hrdiny; scéna může podat model
 * hrdiny jako `children` a duch mu materiály zprůhlední (kopie, originál
 * hrdiny zůstane). Zapojení přes `GhostSlot` popisuje `GHOST.md`.
 */

import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei/web/Html';
import { type ReactNode, useEffect, useMemo, useRef } from 'react';
import { type Group, type Material, type Mesh, MeshStandardMaterial } from 'three';

import { colorHex } from '@/brand/tokens';
import { BODY, HEADER, UNIT, bodyBase } from '@/play/arcade/contract';

import { turnToward } from './characterMotion';
import type { GhostPose, GhostSource } from './GhostSlot';
import type { ArcadeSession } from './session';

export type GhostLabel = 'friend' | 'best';

/** Štítek ve světě (kit `.sp-world-tag`, nejvýš 12 znaků, sentence case). */
export const GHOST_TAGS: Readonly<Record<GhostLabel, string>> = { friend: 'Friend', best: 'Best run' };

/** Poloha (metry scény) a natočení kolem svislé osy (radiány). */
export type GhostPlacement = readonly [x: number, y: number, z: number, yaw: number];

/** Převod `World` (běžec, plošinovka, poletování, závod): kamera kouká po +z, x jádra je zrcadlené, natočení tedy taky. */
export const worldPlacement = (pose: GhostPose): GhostPlacement => [-pose.x / UNIT, pose.y / UNIT, pose.z / UNIT, -pose.yaw];

export const GHOST_OPACITY = 0.45;
/** Zmizení na konci záznamu – délka kitu pro oslavu (`--sp-duration-celebrate`). */
export const GHOST_VANISH_MS = 420;
/** Štítek visí nad hlavou o tolik metrů. */
const TAG_LIFT_M = 0.35;

export interface GhostProbe {
  readonly tick: number;
  readonly shown: boolean;
  readonly vanishing: boolean;
  readonly label: GhostLabel;
  /** Poloha nakreslené skupiny v metrech scény. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

declare global {
  interface Window {
    /** Sonda e2e: co duch v posledním snímku nakreslil. */
    __playGhost?: () => GhostProbe;
  }
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Co si duch pamatuje mezi snímky: byl vidět a odkdy (ms hodin snímků) mizí. */
export interface GhostMemory {
  shown: boolean;
  vanishAt: number | null;
}

export interface GhostFrame {
  readonly visible: boolean;
  /** Kam skupinu posadit; `null` = nechat, kde je (mizí tam, kde záznam skončil). */
  readonly at: GhostPlacement | null;
  readonly scale: number;
  readonly opacity: number;
}

/**
 * Jeden snímek ducha z póz tiku před a tiku hráče (už převedených do scény).
 * Póza je → interpolace jako u hráče. Póza chybí, ač byl duch vidět → záznam
 * skončil: poskok a zhasnutí za `GHOST_VANISH_MS`, pak schovaný, dokud se
 * póza nevrátí (restart).
 */
export function ghostFrame(memory: GhostMemory, before: GhostPlacement | null, now: GhostPlacement | null, alpha: number, clockMs: number): GhostFrame {
  if (now !== null) {
    memory.shown = true;
    memory.vanishAt = null;
    const from = before ?? now;
    return { visible: true, at: [lerp(from[0], now[0], alpha), lerp(from[1], now[1], alpha), lerp(from[2], now[2], alpha), turnToward(from[3], now[3], alpha)], scale: 1, opacity: GHOST_OPACITY };
  }
  if (!memory.shown) return { visible: false, at: null, scale: 1, opacity: GHOST_OPACITY };
  memory.vanishAt ??= clockMs;
  const t = Math.min(1, (clockMs - memory.vanishAt) / GHOST_VANISH_MS);
  if (t >= 1) memory.shown = false;
  return { visible: t < 1, at: null, scale: (1 + 0.3 * Math.sin(t * Math.PI)) * (1 - t), opacity: GHOST_OPACITY * (1 - t) };
}

/** Kopie materiálu se stínem ducha; originál (sdílený s hrdinou) zůstane neprůhledný. */
function ghostMaterial(source: Material): Material {
  const copy = source.clone();
  copy.transparent = true;
  copy.opacity = GHOST_OPACITY;
  copy.depthWrite = false;
  copy.userData.ghost = true;
  return copy;
}

export interface GhostProps {
  readonly source: GhostSource;
  /** Relace hráče: z ní tik a podíl rozběhnutého tiku – duch jede v kroku s hráčem. */
  readonly session: ArcadeSession;
  readonly label: GhostLabel;
  /** Póza jádra → scéna; výchozí převod `World`. Scéna s jiným převodem (aréna, souboj) podá vlastní. */
  readonly place?: (pose: GhostPose) => GhostPlacement;
  /** Model hrdiny; bez něj silueta v rozměrech hrdiny. */
  readonly children?: ReactNode;
}

export function Ghost({ source, session, label, place = worldPlacement, children }: GhostProps) {
  const group = useRef<Group>(null);
  const tag = useRef<HTMLSpanElement>(null);
  const materials = useRef(new Set<Material>());
  const view = useRef({ tick: 0, clock: 0, memory: { shown: false, vanishAt: null } as GhostMemory });

  // Rozměry hrdiny ze startu světa: duch hraje tutéž hru, tělo má stejné.
  const size = useMemo(() => {
    const base = bodyBase(session.world.initial[HEADER.player] as number);
    const w = (session.world.initial[base + BODY.w] as number) / UNIT;
    const h = (session.world.initial[base + BODY.h] as number) / UNIT;
    const radius = Math.min(w / 2, h / 4);
    return { h, radius, length: Math.max(0, h - 2 * radius) };
  }, [session.world]);
  const silhouette = useMemo(() => {
    const material = new MeshStandardMaterial({ color: colorHex.sky, roughness: 0.6, transparent: true, opacity: GHOST_OPACITY, depthWrite: false });
    material.userData.ghost = true;
    return material;
  }, []);

  useEffect(() => {
    const owned = materials.current;
    return () => {
      for (const material of owned) material.dispose();
      owned.clear();
      silhouette.dispose();
    };
  }, [silhouette]);

  useEffect(() => {
    const probe = (): GhostProbe => {
      const at = group.current?.position;
      return { tick: view.current.tick, shown: group.current?.visible === true, vanishing: view.current.memory.vanishAt !== null, label, x: at?.x ?? 0, y: at?.y ?? 0, z: at?.z ?? 0 };
    };
    window.__playGhost = probe;
    return () => {
      if (window.__playGhost === probe) delete window.__playGhost;
    };
  }, [label]);

  useFrame((_, delta) => {
    const node = group.current;
    if (node === null) return;
    const state = view.current;
    state.clock += delta * 1000;

    // Model hrdiny se může dotáhnout později: každý nový materiál dostane průhlednou kopii.
    node.traverse((object) => {
      const mesh = object as Mesh;
      if (mesh.isMesh !== true) return;
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (list.every((material) => material.userData.ghost === true)) return;
      const ghosted = list.map((material) => {
        if (material.userData.ghost === true) return material;
        const copy = ghostMaterial(material);
        materials.current.add(copy);
        return copy;
      });
      mesh.material = Array.isArray(mesh.material) ? ghosted : (ghosted[0] as Material);
    });

    const tick = session.state()[HEADER.tick] as number;
    state.tick = tick;
    const before = tick > 0 ? source.poseAt(tick - 1) : null;
    const now = source.poseAt(tick);
    const frame = ghostFrame(state.memory, before === null ? null : place(before), now === null ? null : place(now), session.alpha(), state.clock);
    if (frame.at !== null) {
      node.position.set(frame.at[0], frame.at[1], frame.at[2]);
      node.rotation.y = frame.at[3];
    }
    node.scale.setScalar(frame.scale);
    node.visible = frame.visible;
    silhouette.opacity = frame.opacity;
    for (const material of materials.current) material.opacity = frame.opacity;
    if (tag.current !== null) tag.current.style.visibility = frame.visible && state.memory.vanishAt === null ? 'visible' : 'hidden';
  });

  return (
    <group ref={group} visible={false} userData={{ ghost: label }}>
      {children ?? (
        <mesh position={[0, size.h / 2, 0]} material={silhouette} userData={{ rigShadow: 'none' }}>
          <capsuleGeometry args={[size.radius, size.length, 4, 12]} />
        </mesh>
      )}
      <Html position={[0, size.h + TAG_LIFT_M, 0]} pointerEvents="none" zIndexRange={[10, 0]}>
        <span ref={tag} className="sp-world-tag sp-world-tag--goal" data-testid="play-ghost-tag" style={{ visibility: 'hidden' }}>
          {GHOST_TAGS[label]}
        </span>
      </Html>
    </group>
  );
}
