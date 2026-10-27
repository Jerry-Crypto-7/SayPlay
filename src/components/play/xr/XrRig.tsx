'use client';

import { useFrame, useThree } from '@react-three/fiber';
import { useXR } from '@react-three/xr';
import { type ReactNode, type RefObject, useEffect, useRef } from 'react';
import { ACESFilmicToneMapping } from 'three';

/**
 * Hráč ve VR (P65 T1). Kameru vlastní hlava: kamery žánrů dál nastavují kameru R3F, jenže tou je v relaci kamera
 * brýlí a její pozici každý snímek přepíše póza hlavy. Svět se v relaci zmenší na stůl (diorama) 0,9 m před hráčem
 * ve výšce 0,8 m a otočí se o půl kruhu, aby hráč stál tam, kde ve 2D stojí kamera (za hrdinou, na straně −z).
 * Mimo relaci je obal identita, takže 2D se nemění a vstup do VR scénu nepřestaví.
 * simplified: pevné měřítko 1:15 pro všechny žánry; T4 ho dopočítá z velikosti arény.
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
}

declare global {
  interface Window {
    __playXr?: () => XrReport;
  }
}

function XrProbe({ presenting, calls }: { readonly presenting: boolean; readonly calls: RefObject<number> }) {
  const gl = useThree((three) => three.gl);
  useEffect(() => {
    const probe = (): XrReport => ({ presenting, eyes: presenting ? gl.xr.getCamera().cameras.length : 0, calls: presenting ? calls.current : 0 });
    window.__playXr = probe;
    return () => {
      if (window.__playXr === probe) delete window.__playXr;
    };
  }, [gl, presenting, calls]);
  return null;
}

export function XrRig({ children }: { readonly children: ReactNode }) {
  const presenting = useXR((xr) => xr.session != null);
  const calls = useRef(0);
  return (
    <>
      <group position={presenting ? DIORAMA.at : ORIGIN} rotation={[0, presenting ? DIORAMA.turn : 0, 0]} scale={presenting ? DIORAMA.scale : 1}>
        {children}
      </group>
      {presenting && <DirectRender calls={calls} />}
      <XrProbe presenting={presenting} calls={calls} />
    </>
  );
}
