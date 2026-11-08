'use client';

/**
 * Orientační bod sady a rámující kusy v popředí (P54B T8). Kde stojí, počítá
 * `landmark-places.ts` z herní kamery žánru; tady se kreslí. Místo se spočítá
 * z kamery, kterou scéna postavila (druhý snímek – první ji scéna teprve staví),
 * vrácené z úvodního průletu na herní pohled (`restCamera`).
 *
 * Kamera, která se hýbe, bod veze (`follow`), jinak by za vteřinu ujel ze záběru:
 * - `track` – scéna jede po trati (běžec, závod, plavba, let, poletování, plošinovka):
 *   bod jede s kamerou po z a drží odstup od středu trati jako cíl na obzoru;
 * - `camera` – kamera jde za hrdinou po ploše (aréna, souboj, úkol, agar, bludiště):
 *   bod jede s kamerou do všech stran, ale z hrací plochy se vždy vysune za její kraj.
 * Rámující kusy jsou jen u pevné kamery (míč, střelnice, hod, věž, rytmus, ring):
 * v popředí by s jedoucí kamerou ujely z obrazu, nebo jako vezené klouzaly po zemi;
 * kraje obrazu u trati rámují řady kulis, které kolem ní ubíhají.
 *
 * Bod ani kus se v obraze nepotká s ničím, co se hraje (P54B T15a): s kvádrem každého uzlu
 * sondy záběru (`userData.frame` = `hero` / `target` – hrdina, soupeř, nepřátelé, noty, věž)
 * ani s pásem, který scéna předá v `play` (trubky poletování, pruhy rytmu, koridor přistání).
 *
 * Skupina bodu nese `userData.landmark` (id modelu), kusy `userData.framing`. Sonda
 * `window.__playLandmark()` vrátí, jak jsou v záběru a kolik z hrdiny zakrývají.
 * Jen vzhled: jádro o nich neví, stín nevrhají – kus je jedno kreslicí volání.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Box3, type Group, type Mesh, type Object3D, PerspectiveCamera, Raycaster, Vector2, Vector3 } from 'three';

import type { Look } from '@/play/arcade/look';

import type { Box } from './ground';
import { restCamera } from './intro';
import { footOf, frameShare, type HeroBox, IN_VIEW_SHARE, keepOff, type Placed, placeFraming, placeLandmark, type ScreenRect, screenRect, type Volume } from './landmark-places';
import { isInk } from './rig/InkOutline';
import { SceneryModelProp } from './Scenery';

export interface LandmarkProps {
  readonly look: Look;
  /** Semínko hry (`ArcadeWorld.seed`). */
  readonly seed: number;
  /** Hrací plocha (m ve scéně), nic na ní nestojí; pás trati má `z0`/`z1` nekonečné. */
  readonly area: readonly Box[];
  /** Kamera se hýbe a bod jede s ní: `track` po trati, `camera` za hrdinou po ploše; bez něj stojí bod i rám pevně. */
  readonly follow?: 'track' | 'camera';
  /** Střed zakřivené trati v `z` (m): bod, který jede po trati, drží odstup od něj, ne od přímky. */
  readonly bend?: (z: number) => { readonly x: number };
  /** Výška terénu (m); bez ní rovina y = 0. */
  readonly ground?: (x: number, z: number) => number;
  /** Hrací pásy žánru, které uzly sondy záběru nepokryjí (předměty, které teprve přijedou); bod ani kus je v obraze nezakryje. */
  readonly play?: readonly Volume[];
}

interface Placement {
  readonly landmark: Placed | null;
  readonly framing: readonly Placed[];
  /** Herní kamera (x, z), podle které se místo spočítalo – bod jede o tolik, o kolik se pohnula. */
  readonly eye: readonly [number, number];
}

/** Hrdina bez načteného modelu: pata, poloměr a výška náhradního kvádru (m). */
const HERO_NOMINAL = { r: 0.6, h: 1.6 } as const;
/** Mřížka paprsků přes obdélník hrdiny v sondě zakrytí. */
const HERO_RAYS = 7;

const shown = (object: Object3D): boolean => {
  for (let node: Object3D | null = object; node !== null; node = node.parent) if (!node.visible) return false;
  return true;
};

/** Hrdina sondy záběru (`userData.frame = 'hero'`), poslední viditelný jako ve `FrameProbe`. */
function heroNodeOf(scene: Object3D): Object3D | null {
  let hero: Object3D | null = null;
  scene.traverse((node) => {
    if (node.userData.frame === 'hero' && shown(node)) hero = node;
  });
  return hero;
}

/** Kvádr hrdiny ve scéně; model, který se ještě nenačetl, nahradí `HERO_NOMINAL`. */
function heroBoxOf(hero: Object3D | null): HeroBox | null {
  if (hero === null) return null;
  const at = hero.getWorldPosition(new Vector3());
  const box = new Box3().setFromObject(hero);
  if (box.isEmpty()) return { x: at.x, y: at.y, z: at.z, ...HERO_NOMINAL };
  const size = box.getSize(new Vector3());
  return { x: at.x, y: box.min.y, z: at.z, r: Math.max(HERO_NOMINAL.r, size.x / 2, size.z / 2), h: Math.max(HERO_NOMINAL.h, size.y) };
}

/** Kvádry viditelných cílů sondy záběru (soupeř, nepřátelé, noty, věž); nenačtený model nahradí `HERO_NOMINAL`. */
function targetsOf(scene: Object3D): Volume[] {
  const volumes: Volume[] = [];
  scene.traverse((node) => {
    if (node.userData.frame !== 'target' || !shown(node)) return;
    const box = new Box3().setFromObject(node);
    if (box.isEmpty()) {
      const at = node.getWorldPosition(new Vector3());
      box.set(new Vector3(at.x - HERO_NOMINAL.r, at.y, at.z - HERO_NOMINAL.r), new Vector3(at.x + HERO_NOMINAL.r, at.y + HERO_NOMINAL.h, at.z + HERO_NOMINAL.r));
    }
    volumes.push({ x0: box.min.x, y0: box.min.y, z0: box.min.z, x1: box.max.x, y1: box.max.y, z1: box.max.z });
  });
  return volumes;
}

export interface PieceReport {
  readonly id: string;
  readonly scale: number;
  /** Model se načetl a kreslí se. */
  readonly loaded: boolean;
  readonly rect: ScreenRect | null;
  readonly inFrame: number;
}

export interface LandmarkReport {
  readonly landmark: (PieceReport & { readonly distance: number; readonly inView: boolean }) | null;
  readonly framing: readonly PieceReport[];
  /** Viditelné sítě bodu a kusů = kreslicí volání navíc (stín nevrhají). */
  readonly calls: number;
  /** Podíl paprsků kamery na hrdinu, které bod ani kus nezakryje; `null` = hrdina v obraze není. */
  readonly hero: { readonly visible: number; readonly samples: number } | null;
}

declare global {
  interface Window {
    __playLandmark?: () => LandmarkReport;
  }
}

/** Kvádr kusu (jen viditelné sítě) promítnutý kamerou; `null` = model ještě není. */
function rectOf(group: Object3D, camera: PerspectiveCamera): ScreenRect | null {
  const box = new Box3();
  group.traverseVisible((node) => {
    if ((node as Mesh).isMesh === true) box.expandByObject(node);
  });
  return box.isEmpty() ? null : screenRect(camera, box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z);
}

const meshesOf = (group: Object3D): number => {
  let count = 0;
  group.traverseVisible((node) => {
    if ((node as Mesh).isMesh === true) count += 1;
  });
  return count;
};

/** Sonda: bod a kusy promítnuté živou kamerou a zakrytí hrdiny paprsky přes jeho obdélník. */
function report(scene: Object3D, camera: PerspectiveCamera, landmark: Group | null, framing: readonly (Group | null)[], placement: Placement | null): LandmarkReport {
  scene.updateMatrixWorld();
  camera.updateMatrixWorld();
  const piece = (group: Group | null, placed: Placed): PieceReport => {
    const rect = group === null ? null : rectOf(group, camera);
    return { id: placed.id, scale: placed.scale, loaded: rect !== null, rect, inFrame: rect === null ? 0 : frameShare(rect) };
  };
  const own = [landmark, ...framing].filter((group): group is Group => group !== null);
  const lead = placement?.landmark ?? null;
  const main = lead === null ? null : piece(landmark, lead);
  const at = landmark?.getWorldPosition(new Vector3());
  return {
    landmark: main === null || at === undefined ? null : { ...main, distance: Math.hypot(at.x - camera.position.x, at.z - camera.position.z), inView: main.loaded && !main.rect!.behind && main.inFrame >= IN_VIEW_SHARE },
    framing: (placement?.framing ?? []).map((placed, index) => piece(framing[index] ?? null, placed)),
    calls: own.reduce((sum, group) => sum + meshesOf(group), 0),
    hero: heroCover(scene, camera, own),
  };
}

const raycaster = new Raycaster();
const ndc = new Vector2();

/** Kolik paprsků kamery, které trefí hrdinu, trefí dřív bod nebo kus. */
function heroCover(scene: Object3D, camera: PerspectiveCamera, own: readonly Object3D[]): LandmarkReport['hero'] {
  const hero = heroNodeOf(scene);
  if (hero === null) return null;
  const box = new Box3().setFromObject(hero);
  if (box.isEmpty()) return null;
  const rect = screenRect(camera, box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z);
  if (rect.behind) return null;
  const drawn = (object: Object3D): boolean => shown(object) && !isInk(object);
  let samples = 0;
  let covered = 0;
  for (let i = 0; i < HERO_RAYS; i += 1) {
    for (let j = 0; j < HERO_RAYS; j += 1) {
      const x = rect.minX + ((i + 0.5) / HERO_RAYS) * (rect.maxX - rect.minX);
      const y = rect.minY + ((j + 0.5) / HERO_RAYS) * (rect.maxY - rect.minY);
      if (Math.abs(x) > 1 || Math.abs(y) > 1) continue;
      raycaster.setFromCamera(ndc.set(x, y), camera);
      const onHero = raycaster.intersectObject(hero, true).find((hit) => drawn(hit.object));
      if (onHero === undefined) continue;
      samples += 1;
      const block = raycaster.intersectObjects([...own], true).find((hit) => drawn(hit.object));
      if (block !== undefined && block.distance < onHero.distance) covered += 1;
    }
  }
  return samples === 0 ? null : { visible: 1 - covered / samples, samples };
}

/** Kus ve scéně: pata, natočení a měřítko kolem modelu katalogu. */
function Piece({ placed, register, mark, palette }: { readonly placed: Placed; readonly register: (group: Group | null) => void; readonly mark: Record<string, string>; readonly palette: readonly string[] }) {
  return (
    <group ref={register} position={[placed.x, placed.y, placed.z]} userData={mark}>
      <group rotation={[0, placed.turn, 0]} scale={placed.scale}>
        <SceneryModelProp id={placed.id} cast={false} palette={palette} />
      </group>
    </group>
  );
}

export function Landmark({ look, seed, area, follow, bend, ground, play }: LandmarkProps) {
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const scene = useThree((three) => three.scene);
  const width = useThree((three) => three.size.width);
  const height = useThree((three) => three.size.height);
  const invalidate = useThree((three) => three.invalidate);
  const rest = useMemo(() => new PerspectiveCamera(), []);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const waited = useRef(0);
  const landmark = useRef<Group | null>(null);
  const framing = useRef<(Group | null)[]>([]);

  // Nová sada, semínko, plocha nebo velikost obrazu = nové místo. Plochu scény často staví každý snímek znovu: klíčem je její obsah.
  const areaKey = JSON.stringify(area);
  const playKey = JSON.stringify(play ?? []);
  useEffect(() => {
    waited.current = 0;
    setPlacement(null);
  }, [look, seed, areaKey, playKey, follow, bend, ground, width, height]);

  useFrame(() => {
    if (placement === null) {
      // První snímek kamera stojí, kde ji nechalo plátno: scéna ji postaví až svým snímkem.
      if (waited.current++ < 1) {
        invalidate();
        return;
      }
      restCamera(camera, rest);
      const hero = heroBoxOf(heroNodeOf(scene));
      const input = { camera: rest, look, seed, area, hero, play: [...(play ?? []), ...targetsOf(scene)], ground };
      setPlacement({ landmark: placeLandmark(input), framing: follow === undefined ? placeFraming(input) : [], eye: [rest.position.x, rest.position.z] });
      return;
    }
    const lead = placement.landmark;
    const group = landmark.current;
    if (follow === undefined || lead === null || group === null) return;
    restCamera(camera, rest);
    let z = lead.z + rest.position.z - placement.eye[1];
    let x: number;
    if (follow === 'track') {
      // Po trati s kamerou, do strany s tratí: odstup od středu trati se nemění, takže bod nevjede na trať v zatáčce.
      x = bend === undefined ? lead.x : lead.x + bend(z).x - bend(lead.z).x;
    } else {
      ({ x, z } = keepOff(area, lead.x + rest.position.x - placement.eye[0], z, footOf(lead)));
    }
    group.position.set(x, ground === undefined ? lead.y : ground(x, z) - (ground(lead.x, lead.z) - lead.y), z);
  });

  useEffect(() => {
    const probe = (): LandmarkReport => report(scene, camera, landmark.current, framing.current, placement);
    window.__playLandmark = probe;
    return () => {
      if (window.__playLandmark === probe) delete window.__playLandmark;
    };
  }, [scene, camera, placement]);

  if (placement === null) return null;
  return (
    <>
      {placement.landmark !== null && <Piece placed={placement.landmark} register={(group) => { landmark.current = group; }} mark={{ landmark: placement.landmark.id }} palette={look.palette} />}
      {placement.framing.map((placed, index) => (
        <Piece key={index} placed={placed} register={(group) => { framing.current[index] = group; }} mark={{ framing: placed.id }} palette={look.palette} />
      ))}
    </>
  );
}
