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
 * Prostředí, které knihovna nezná (`env.poll`, P29C T7), se mezitím generuje
 * na míru; Panorama se na něj ptá a hotové vymění za knihovní bez přenačtení.
 *
 * Mimo hash i robota: jen obraz, jádro hry o něm neví. Plátno nese
 * `data-first-frame` (první snímek je venku) a `data-env` (id panoramatu na
 * obrazovce) – e2e podle nich měří pořadí stahování a výměnu.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BackSide, Color, Fog, type Mesh, type PerspectiveCamera, SphereGeometry, SRGBColorSpace, type Texture, TextureLoader, Vector3 } from 'three';

import type { PlayEnvValue } from './play-env';

/** Poloměr koule jako podíl vzdálené roviny kamery: celá koule je vždy vidět. */
const RADIUS_OF_FAR = 0.9;

/**
 * Výška kamery nad zemí jako podíl poloměru, zaokrouhlená na čtvrtinu oktávy:
 * geometrie podlahy se přestaví jen při znatelné změně (kamera věže stoupá).
 */
function floorStep(height: number, radius: number): number {
  const share = Math.min(0.5, Math.max(0.002, height / radius));
  return 2 ** (Math.round(Math.log2(share) * 4) / 4);
}

/**
 * Koule, jejíž dolní půlka leží na rovině `floor` pod středem – postup
 * `GroundedSkybox` z three/addons. Obsah panoramatu (stůl, dno jeskyně) je
 * v dolní půlce: jako nekonečně vzdálená koule by ho zem scény celý zakryla,
 * takhle leží pod hráčem a zem sady se kreslí pod ním (`UNDER_PANORAMA`).
 */
function groundedSphere(floor: number): SphereGeometry {
  // Rozlišení jako GroundedSkybox: s hrubší sítí zubatí pás mezi podlahou a horizontem.
  const geometry = new SphereGeometry(1, 256, 128);
  const position = geometry.getAttribute('position');
  const blend = (-floor * 3) / 2;
  const point = new Vector3();
  for (let i = 0; i < position.count; i++) {
    point.fromBufferAttribute(position, i);
    if (point.y >= 0) continue;
    point.multiplyScalar(point.y < blend ? -floor / point.y : 1 - (point.y * point.y) / (3 * blend * blend));
    position.setXYZ(i, point.x, point.y, point.z);
  }
  return geometry;
}

/** Jak často a jak dlouho se ptát na vlastní panorama (generování ~25–160 s na sdílené kartě). */
const POLL_EVERY_MS = 5_000;
const POLL_FOR_MS = 5 * 60_000;

/** Co je na obrazovce: knihovní panorama, nebo vlastní ze služby. */
interface Shown {
  readonly id: string;
  readonly low: string;
  readonly url: string;
  readonly horizon: string;
}

/** UV koule jsou equirektangulární samy, takže stačí barevný prostor. */
function prepare(texture: Texture): Texture {
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** Ptá se na vlastní panorama, dokud není hotové, nepadne nebo nevyprší čas. */
function useCustomEnv(poll: string | null, started: boolean, fallbackHorizon: string): Shown | null {
  const [custom, setCustom] = useState<Shown | null>(null);
  useEffect(() => {
    if (!started || poll === null) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const until = performance.now() + POLL_FOR_MS;
    const ask = async () => {
      try {
        const response = await fetch(poll, { cache: 'no-store' });
        if (!alive || !response.ok) return;
        const body = (await response.json()) as { status: string; id?: string; url?: string; low?: string; horizon?: string | null };
        if (!alive) return;
        if (body.status === 'ready' && body.id && body.url && body.low) {
          setCustom({ id: body.id, url: body.url, low: body.low, horizon: body.horizon ?? fallbackHorizon });
          return;
        }
        if (body.status !== 'pending' || performance.now() > until) return;
      } catch {
        return;
      }
      timer = setTimeout(() => void ask(), POLL_EVERY_MS);
    };
    void ask();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [poll, started, fallbackHorizon]);
  return custom;
}

export function Panorama({ env }: { readonly env: PlayEnvValue }) {
  const gl = useThree((three) => three.gl);
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const scene = useThree((three) => three.scene);
  const invalidate = useThree((three) => three.invalidate);
  const sphere = useRef<Mesh>(null);
  const drawn = useRef(false);
  const [started, setStarted] = useState(false);
  const [texture, setTexture] = useState<Texture | null>(null);
  const [floor, setFloor] = useState(0.05);
  const custom = useCustomEnv(env.poll, started, env.horizon);
  const shown: Shown = custom ?? env;

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
    // Zem scén leží na y = 0, podlaha panoramatu tedy výšku kamery pod středem.
    const step = floorStep(camera.position.y, radius);
    if (step !== floor) setFloor(step);
  });
  const geometry = useMemo(() => groundedSphere(floor), [floor]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  // Náhled, pak plné. Předchozí textura zůstává na kouli, dokud nová nedorazí.
  useEffect(() => {
    if (!started) return;
    let alive = true;
    const loader = new TextureLoader();
    const show = (next: Texture) => {
      setTexture(prepare(next));
      gl.domElement.dataset.env = shown.id;
      invalidate();
    };
    loader.load(shown.low, (low) => {
      if (!alive) return void low.dispose();
      show(low);
      loader.load(shown.url, (full) => (alive ? show(full) : full.dispose()));
    });
    return () => {
      alive = false;
    };
  }, [started, shown.id, shown.low, shown.url, gl, invalidate]);

  // Textura, kterou vystřídala jiná (nebo odpojení), se uvolní až po výměně.
  useEffect(() => () => texture?.dispose(), [texture]);
  useEffect(
    () => () => {
      delete gl.domElement.dataset.env;
    },
    [gl],
  );

  // Mlha v barvě horizontu, dokud panorama visí; potom zpět.
  useEffect(() => {
    if (texture === null || !(scene.fog instanceof Fog)) return;
    const fog = scene.fog;
    const before = fog.color.clone();
    fog.color = new Color(shown.horizon);
    return () => {
      fog.color = before;
    };
  }, [texture, scene, shown.horizon]);

  if (texture === null) return null;
  return (
    <mesh ref={sphere} geometry={geometry} renderOrder={-1} frustumCulled={false}>
      <meshBasicMaterial map={texture} side={BackSide} fog={false} depthWrite={false} toneMapped={false} />
    </mesh>
  );
}
