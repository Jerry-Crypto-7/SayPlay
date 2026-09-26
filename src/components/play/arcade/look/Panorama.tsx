'use client';

/**
 * Panorama prostředí za hrou (P29C T5). Obloha z věty místo jedné ploché barvy:
 * koule s panoramatem kolem kamery, kreslená první, bez mlhy a bez zápisu
 * hloubky, takže všechno ostatní leží před ní.
 *
 * První snímek se nezdrží: do prvního vykreslení se nic nestahuje a scéna má
 * dnešní barvu oblohy. Pak přijde náhled 512×256 a po něm plné 2048×1024.
 * S panoramatem se barva mlhy srovná s jeho horizontem – vzdálené kulisy
 * mizí do téže barvy, kterou obraz za nimi má.
 *
 * Mimo hash i robota: jen obraz, jádro hry o něm neví. Plátno nese
 * `data-first-frame` (první snímek je venku) a `data-env` (id panoramatu na
 * obrazovce) – e2e podle nich měří pořadí stahování a výměnu.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef, useState } from 'react';
import { BackSide, Color, Fog, type Mesh, type PerspectiveCamera, SRGBColorSpace, type Texture, TextureLoader } from 'three';

import type { EnvEntry } from '@/play/arcade/look/env';

/** Poloměr koule jako podíl vzdálené roviny kamery: celá koule je vždy vidět. */
const RADIUS_OF_FAR = 0.9;

/** UV koule jsou equirektangulární samy, takže stačí barevný prostor. */
function prepare(texture: Texture): Texture {
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

export function Panorama({ env }: { readonly env: EnvEntry }) {
  const gl = useThree((three) => three.gl);
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const scene = useThree((three) => three.scene);
  const invalidate = useThree((three) => three.invalidate);
  const sphere = useRef<Mesh>(null);
  const drawn = useRef(false);
  const [started, setStarted] = useState(false);
  const [texture, setTexture] = useState<Texture | null>(null);

  useFrame(() => {
    if (!drawn.current) {
      drawn.current = true;
      gl.domElement.dataset.firstFrame = '';
      // Stahování začne až po tomto snímku (efekt po překreslení Reactu).
      setStarted(true);
    }
    // Poloměr podle aktuální vzdálené roviny: jeviště ji nastavuje podle mlhy až po montáži.
    const radius = camera.far * RADIUS_OF_FAR;
    sphere.current?.position.copy(camera.position);
    sphere.current?.scale.set(-radius, radius, radius);
  });

  useEffect(() => {
    if (!started) return;
    let alive = true;
    const loaded: Texture[] = [];
    const loader = new TextureLoader();
    const show = (next: Texture) => {
      loaded.push(prepare(next));
      setTexture(next);
      gl.domElement.dataset.env = env.id;
      invalidate();
    };
    loader.load(env.low, (low) => {
      if (!alive) return void low.dispose();
      show(low);
      loader.load(env.url, (full) => (alive ? show(full) : full.dispose()));
    });
    return () => {
      alive = false;
      loaded.forEach((t) => t.dispose());
      delete gl.domElement.dataset.env;
    };
  }, [started, env.id, env.low, env.url, gl, invalidate]);

  // Mlha v barvě horizontu, dokud panorama visí; potom zpět.
  useEffect(() => {
    if (texture === null || !(scene.fog instanceof Fog)) return;
    const fog = scene.fog;
    const before = fog.color.clone();
    fog.color = new Color(env.horizon);
    return () => {
      fog.color = before;
    };
  }, [texture, scene, env.horizon]);

  if (texture === null) return null;
  return (
    <mesh ref={sphere} renderOrder={-1} frustumCulled={false}>
      <sphereGeometry args={[1, 48, 24]} />
      <meshBasicMaterial map={texture} side={BackSide} fog={false} depthWrite={false} toneMapped={false} />
    </mesh>
  );
}
