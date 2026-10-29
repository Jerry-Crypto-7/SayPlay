'use client';

/**
 * Prostorový zvuk ve VR (P67 T8): po dobu relace s hrou dosadí do `@/play/audio` cestu přes panner
 * (`xr/spatial-sound.ts`). Zvuk události sběrnice pak zní z místa, kde scéna tělo kreslí – přes matici obalu světa,
 * která nese režim rigu. Posluchač je hlava: každý snímek z pózy brýlí. Mimo relaci se nemontuje a zvuk jde jako dřív.
 */

import { useFrame } from '@react-three/fiber';
import { useXR } from '@react-three/xr';
import { type RefObject, useEffect, useMemo } from 'react';
import { type Group, Quaternion, Vector3 } from 'three';

import { spatial } from '@/play/audio';
import { type SpatialReport, createSpatialSound } from '@/play/xr/spatial-sound';

import { runnerPathOf } from '../arcade/runner/path';
import type { ArcadeSession } from '../arcade/session';

declare global {
  interface Window {
    /** Sonda e2e (`vr-native.spec.ts`): zvuky přes panner a posluchač. */
    __playXrSound?: () => SpatialReport;
  }
}

export function XrAudio({ world, session }: { readonly world: RefObject<Group | null>; readonly session: ArcadeSession }) {
  const space = useXR((xr) => xr.originReferenceSpace);
  const sound = useMemo(
    () =>
      createSpatialSound(() => {
        const group = world.current;
        if (group === null) return null;
        group.updateWorldMatrix(true, false);
        return group.matrixWorld;
      }, runnerPathOf(session.world)),
    [world, session],
  );
  const head = useMemo(() => ({ position: new Vector3(), forward: new Vector3(), up: new Vector3(), turn: new Quaternion() }), []);

  useEffect(() => {
    spatial.route = sound.route;
    window.__playXrSound = sound.report;
    return () => {
      if (spatial.route === sound.route) spatial.route = null;
      if (window.__playXrSound === sound.report) delete window.__playXrSound;
    };
  }, [sound]);

  useFrame((_, __, frame: XRFrame | undefined) => {
    const pose = space !== undefined && frame !== undefined ? frame.getViewerPose(space) : undefined;
    if (pose == null) return;
    const { position, orientation } = pose.transform;
    head.turn.set(orientation.x, orientation.y, orientation.z, orientation.w);
    head.position.set(position.x, position.y, position.z);
    head.forward.set(0, 0, -1).applyQuaternion(head.turn);
    head.up.set(0, 1, 0).applyQuaternion(head.turn);
    sound.hear(head);
  });

  return null;
}
