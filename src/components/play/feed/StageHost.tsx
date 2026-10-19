'use client';

/**
 * Jedno trvalé plátno feedu (P54A T5, tunel v `stage-tunnel.ts`). `StageHost`
 * drží R3F `<Canvas>` po celou dobu feedu a dětem dá hostitele; `ArcadeStage`
 * s `host` vykreslí scénu do něj přes `HostedCanvas`, bez `host` má vlastní
 * plátno jako dnes (`/play/[id]`). Kamera, `dpr` a stíny jsou pro obě cesty
 * jedny (`STAGE_CANVAS`).
 */

import { Canvas, useThree } from '@react-three/fiber';
import { Fragment, type ReactNode, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { PerspectiveCamera } from 'three';

import { createStageTunnel, type Frameloop, type StageTunnel } from './stage-tunnel';

const CAMERA_AT = [0, 3.4, -6.5] as const;
const CAMERA_FOV = 60;

/** Plátno scény: kamera, hustota pixelů a stíny slunce rigu (P32A T1; PCF s poloměrem – měkký PCFSoft three 0.185 odmítá). */
export const STAGE_CANVAS = { camera: { position: [...CAMERA_AT] as [number, number, number], fov: CAMERA_FOV }, dpr: [1, 2] as [number, number], shadows: 'percentage' as const };

let owners = 0;

/** Kamera jako u nového plátna – další hra nezdědí záběr předchozí (R3F výchozí kameru míří na počátek). */
function FreshCamera() {
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  useLayoutEffect(() => {
    camera.position.set(...CAMERA_AT);
    camera.rotation.set(0, 0, 0);
    camera.fov = CAMERA_FOV;
    camera.zoom = 1;
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }, [camera]);
  return null;
}

function HostCanvas({ host }: { readonly host: StageTunnel }) {
  const content = useSyncExternalStore(host.subscribe, host.content, () => null);
  return (
    <Canvas {...STAGE_CANVAS} frameloop={content?.frameloop ?? 'demand'}>
      {content !== null && (
        <Fragment key={content.owner}>
          <FreshCamera />
          {content.node}
        </Fragment>
      )}
    </Canvas>
  );
}

/** Drží jedno plátno, dokud je feed na stránce; `children` dostanou hostitele pro `ArcadeStage`. */
export function StageHost({ children }: { readonly children: (host: StageTunnel) => ReactNode }) {
  const [host] = useState(() => {
    if (typeof document === 'undefined') return createStageTunnel(null);
    const element = document.createElement('div');
    element.className = 'play-stage-host';
    element.style.cssText = 'width:100%;height:100%';
    return createStageTunnel(element);
  });
  return (
    <>
      {host.element !== null && createPortal(<HostCanvas host={host} />, host.element)}
      {children(host)}
    </>
  );
}

/** Místo plátna v `ArcadeStage` s hostitelem: scéna jde tunelem, kontejner plátna se přesune sem. */
function StageSlot({ host, frameloop, children }: { readonly host: StageTunnel; readonly frameloop: Frameloop; readonly children: ReactNode }) {
  const slot = useRef<HTMLDivElement | null>(null);
  const [owner] = useState(() => (owners += 1));
  useLayoutEffect(() => {
    host.show({ owner, node: children, frameloop });
  });
  useLayoutEffect(() => {
    if (slot.current !== null) host.attach(owner, slot.current);
    return () => host.release(owner);
  }, [host, owner]);
  return <div ref={slot} style={{ width: '100%', height: '100%' }} />;
}

/** Plátno scény `ArcadeStage`: s `host` tunel do trvalého plátna feedu, bez něj vlastní `<Canvas>` jako dnes. */
export function HostedCanvas({ host, frameloop, children }: { readonly host?: StageTunnel; readonly frameloop: Frameloop; readonly children: ReactNode }) {
  if (host !== undefined) {
    return (
      <StageSlot host={host} frameloop={frameloop}>
        {children}
      </StageSlot>
    );
  }
  return (
    <Canvas {...STAGE_CANVAS} frameloop={frameloop}>
      {children}
    </Canvas>
  );
}
