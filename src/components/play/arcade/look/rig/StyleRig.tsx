'use client';

/**
 * Světlo, obloha a mlha scén, které si je nestaví samy (P32-0 T5, vlastní P32A):
 * běžec, plošinovka, poletování, závod, střelnice, hod a aréna. Přesunuto beze
 * změny vzhledu z `ArcadeStage.tsx`; načasování, rytmus a souboj mají světla
 * ve vlastní scéně.
 */

import { useThree } from '@react-three/fiber';
import { useEffect } from 'react';
import type { PerspectiveCamera } from 'three';

import type { Look } from '@/play/arcade/look';

/**
 * Kamera končí tam, kde mlha (P28E-R1). Za koncem mlhy má každý pixel barvu oblohy,
 * takže to, co ořízne vzdálená rovina, by vypadalo stejně – jen se to nekreslí.
 * Běžec tak nekreslí celou trať (Moto G Power emulace: 416 volání na snímek, 10 fps).
 * Mlha i vzdálená rovina měří hloubku v prostoru kamery, hranice sedí přesně.
 */
function FarAtFog({ far }: { readonly far: number }) {
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  useEffect(() => {
    camera.far = far;
    camera.updateProjectionMatrix();
  }, [camera, far]);
  return null;
}

export function StyleRig({ look, control }: { readonly look: Look; readonly control: string }) {
  return (
    <>
      <color attach="background" args={[look.sky]} />
      <fog attach="fog" args={[look.sky, ...look.fog]} />
      <FarAtFog far={look.fog[1]} />
      <hemisphereLight args={[...look.light]} />
      {/* Boční scény svítí ze strany kamery (−x). */}
      <directionalLight position={[control === 'runner' || control === 'shooter' ? 6 : -6, 12, -4]} intensity={look.sun} />
    </>
  );
}
