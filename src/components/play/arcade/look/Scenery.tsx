'use client';

/**
 * Rekvizity sady prostředí (P26 T11) na okrajích trati: stromy, domy, regály,
 * korály… z primitiv a od P28D T6 i z modelů katalogu (`SCENERY_MODELS`) –
 * primitivy hodnotitel jako prostředí nepoznal. Rozmístění je čistá funkce délky trati –
 * žádná náhoda, táž hra vypadá pokaždé stejně. Na hru nesahají: stojí mimo
 * trať a jádro o nich neví.
 *
 * Od P62 T4 i kulisy uvnitř hrací plochy arény a střelnice (`FieldDressing`): místa ze
 * semínka hry mimo cestu robota a věci hry (`field-dressing.ts`), počítá je worker.
 */

import { lazy, Suspense, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Box3, type Group, Mesh, type Object3D, Vector3 } from 'three';

import type { ArcadeWorld } from '@/play/arcade/contract';
import { type Flora, floraIds, isSceneryModel, landmarks, type Look, modelHeight, type PropKind, type SceneryKind, type SceneryModel, sparseLandmarks } from '@/play/arcade/look';

import type { FieldPiece } from './field-dressing';
import { fieldPiecesNow, fieldPiecesOf } from './field-dressing-client';
import { UNDER_PANORAMA } from './under-panorama';
import { loadFlatModel, type PlantModel, paintedPlant, plantDepthMaterial, plantMaterial } from './load';
import { PlayEnv } from './play-env';
import { capSnow } from './rig/snowcap';
import { useWarmed } from './warm-gate';

// Líně: stránka gridu importuje tenhle soubor staticky a Panorama táhne @react-three/fiber
// do úvodního balíku – první snímek gridu byl o ~220 ms později (P29C T5).
const Panorama = lazy(() => import('./Panorama').then((module) => ({ default: module.Panorama })));

/** `sides` = obě strany dráhy (kamera za hráčem), `behind` = za tratí (boční kamera na −x). */
export type SceneryLayout = 'sides' | 'behind';

export interface SceneryPlace {
  readonly kind: SceneryKind;
  readonly x: number;
  readonly z: number;
  readonly scale: number;
  readonly turn: number;
}

/** Výška rekvizity z primitiv při měřítku 1 (m) – vršek nejvyššího dílu v `Prop`. */
const PROP_HEIGHTS: Readonly<Record<PropKind, number>> = {
  tree: 3.3, pine: 3.4, palm: 4.1, cactus: 2.2, rock: 0.8, building: 7, lamp: 3.3, shelf: 2, crate: 1, sofa: 1.2,
  chimney: 6, tower: 6.6, grave: 1.35, coral: 1.8, seaweed: 2.4, crystal: 1.7, iceblock: 1.2, volcano: 5, buoy: 1.45,
};

/** Výška kulisy při měřítku 1 (m): model z katalogu (`SCENERY_MODELS`, rekvizity prostředí), primitivy z `PROP_HEIGHTS`. */
export const sceneryHeight = (kind: SceneryKind): number => (isSceneryModel(kind) ? modelHeight(kind) : PROP_HEIGHTS[kind]);

/**
 * Strop kulisy v popředí: nejvýš 3 výšky hrdiny (P36C T5). Kamera arény kouká
 * pod 48°, první řada kulis stojí 4,5 m před hranou (mezera, stěna, odstup),
 * takže hrdinovi u hrany zakryje nohy kulisa vyšší než 4,5 · tg 48° ≈ 5 m;
 * 3 × 1,3 m nejmenšího hrdiny je 3,9 m – pod tím, a pořád dům nad hrdinou.
 */
export const FOREGROUND_TALLEST = 3;

/** Řada na straně `side` (znaménko x) zůstane pod výškou `height` (m). */
export interface SceneryCap {
  readonly side: -1 | 1;
  readonly height: number;
}

/** Krok kulis vedle vegetace (P46G T4): stromy stojí ve vegetaci, v řadě zůstanou stavby a věci jako řídké akcenty. */
export const LANDMARK_STEP = 24;

/**
 * Kde rekvizity stojí: krok 7 m, odsazení a velikost se střídají podle pořadí. `cap` zmenší vysoké kulisy jedné řady.
 * `sparse` (vedle vegetace) = krok `LANDMARK_STEP` a strany se střídají, jedna kulisa na krok.
 */
export function sceneryPlaces(props: readonly SceneryKind[], layout: SceneryLayout, inner: number, from: number, to: number, cap?: SceneryCap, sparse = false): SceneryPlace[] {
  const places: SceneryPlace[] = [];
  if (props.length === 0) return places;
  for (let index = 0, z = from; z <= to; index += 1, z += sparse ? LANDMARK_STEP : 7) {
    for (const side of layout === 'behind' ? [1] : sparse ? [index % 2 === 0 ? -1 : 1] : [-1, 1]) {
      const n = index * 7 + (side + 1) * 3;
      const kind = props[n % props.length] as SceneryKind;
      const scale = 0.8 + ((index * 29 + side * 7) % 5) * 0.12;
      // Kladný zbytek (P62 T1-R1): `-11 % 5` je v JS −1, první levý kus pak stál 1,3 m uvnitř `inner` – u rytmu v pruzích.
      places.push({
        kind,
        x: side * (inner + ((((index * 37 + side * 11) % 5) + 5) % 5) * 1.3),
        z: z + ((index * 13) % 3),
        scale: cap?.side === side ? Math.min(scale, cap.height / sceneryHeight(kind)) : scale,
        turn: (index % 4) * (Math.PI / 2),
      });
    }
  }
  return places;
}

function Prop({ kind, tint: [main, accent] }: { readonly kind: PropKind; readonly tint: Look['tint'] }) {
  switch (kind) {
    case 'tree':
      return (
        <>
          <mesh position={[0, 0.8, 0]}><cylinderGeometry args={[0.18, 0.25, 1.6, 6]} /><meshStandardMaterial color="#78350f" roughness={1} /></mesh>
          <mesh position={[0, 2.2, 0]}><sphereGeometry args={[1.1, 8, 6]} /><meshStandardMaterial color={main} roughness={0.9} flatShading /></mesh>
        </>
      );
    case 'pine':
      return (
        <>
          <mesh position={[0, 0.4, 0]}><cylinderGeometry args={[0.15, 0.2, 0.8, 6]} /><meshStandardMaterial color="#78350f" roughness={1} /></mesh>
          <mesh position={[0, 2, 0]}><coneGeometry args={[1, 2.8, 7]} /><meshStandardMaterial color={main} roughness={0.9} flatShading /></mesh>
        </>
      );
    case 'palm':
      return (
        <>
          <mesh position={[0.2, 1.6, 0]} rotation={[0, 0, -0.12]}><cylinderGeometry args={[0.12, 0.2, 3.2, 6]} /><meshStandardMaterial color="#a16207" roughness={1} /></mesh>
          {[0, 1, 2, 3, 4].map((leaf) => (
            <mesh key={leaf} position={[0.4, 3.2, 0]} rotation={[0, (leaf * Math.PI * 2) / 5, 0.9]}>
              <boxGeometry args={[0.25, 1.8, 0.05]} />
              <meshStandardMaterial color={main} roughness={0.9} />
            </mesh>
          ))}
        </>
      );
    case 'cactus':
      return (
        <>
          <mesh position={[0, 1.1, 0]}><cylinderGeometry args={[0.28, 0.3, 2.2, 8]} /><meshStandardMaterial color={main} roughness={0.8} /></mesh>
          <mesh position={[0.45, 1.3, 0]}><cylinderGeometry args={[0.16, 0.16, 0.9, 8]} /><meshStandardMaterial color={main} roughness={0.8} /></mesh>
        </>
      );
    case 'rock':
      return <mesh position={[0, 0.45, 0]} scale={[1.3, 0.8, 1]}><dodecahedronGeometry args={[0.7, 0]} /><meshStandardMaterial color={accent} roughness={1} flatShading /></mesh>;
    case 'building':
      return (
        <>
          <mesh position={[0, 3.5, 0]}><boxGeometry args={[3, 7, 3]} /><meshStandardMaterial color={main} roughness={0.8} /></mesh>
          {[1.5, 3.2, 4.9].map((y) => (
            <mesh key={y} position={[0, y, -1.51]}><planeGeometry args={[2.2, 0.6]} /><meshBasicMaterial color={accent} /></mesh>
          ))}
        </>
      );
    case 'lamp':
      return (
        <>
          <mesh position={[0, 1.5, 0]}><cylinderGeometry args={[0.06, 0.08, 3, 6]} /><meshStandardMaterial color="#334155" /></mesh>
          <mesh position={[0, 3.05, 0]}><sphereGeometry args={[0.22, 8, 6]} /><meshBasicMaterial color={accent} /></mesh>
        </>
      );
    case 'shelf':
      return (
        <>
          <mesh position={[0, 1, 0]}><boxGeometry args={[0.8, 2, 3]} /><meshStandardMaterial color="#e2e8f0" roughness={0.7} /></mesh>
          {[0.5, 1.1, 1.7].map((y, row) => (
            <mesh key={y} position={[-0.42, y, 0]}><boxGeometry args={[0.05, 0.35, 2.6]} /><meshStandardMaterial color={row % 2 === 0 ? main : accent} roughness={0.6} /></mesh>
          ))}
        </>
      );
    case 'crate':
      return <mesh position={[0, 0.5, 0]}><boxGeometry args={[1, 1, 1]} /><meshStandardMaterial color="#a16207" roughness={0.9} /></mesh>;
    case 'sofa':
      return (
        <>
          <mesh position={[0, 0.35, 0]}><boxGeometry args={[1, 0.7, 2.4]} /><meshStandardMaterial color={main} roughness={0.9} /></mesh>
          <mesh position={[0.4, 0.85, 0]}><boxGeometry args={[0.25, 0.7, 2.4]} /><meshStandardMaterial color={main} roughness={0.9} /></mesh>
        </>
      );
    case 'chimney':
      return (
        <>
          <mesh position={[0, 1.5, 0]}><boxGeometry args={[3, 3, 3]} /><meshStandardMaterial color={main} roughness={0.9} /></mesh>
          <mesh position={[0.8, 4.5, 0.8]}><cylinderGeometry args={[0.35, 0.45, 3, 8]} /><meshStandardMaterial color={accent} roughness={0.8} /></mesh>
        </>
      );
    case 'tower':
      return (
        <>
          <mesh position={[0, 2.5, 0]}><cylinderGeometry args={[1, 1.1, 5, 8]} /><meshStandardMaterial color={main} roughness={1} flatShading /></mesh>
          <mesh position={[0, 5.8, 0]}><coneGeometry args={[1.3, 1.6, 8]} /><meshStandardMaterial color={accent} roughness={0.8} /></mesh>
        </>
      );
    case 'grave':
      return (
        <>
          <mesh position={[0, 0.5, 0]}><boxGeometry args={[0.2, 1, 0.7]} /><meshStandardMaterial color={main} roughness={1} /></mesh>
          <mesh position={[0, 1, 0]} rotation={[Math.PI / 2, 0, 0]}><cylinderGeometry args={[0.35, 0.35, 0.2, 10, 1, false, 0, Math.PI]} /><meshStandardMaterial color={main} roughness={1} /></mesh>
        </>
      );
    case 'coral':
      return (
        <>
          {[-0.3, 0, 0.35].map((dz, branch) => (
            <mesh key={dz} position={[0, 0.5 + branch * 0.2, dz]} rotation={[dz, 0, 0]}><cylinderGeometry args={[0.08, 0.14, 1 + branch * 0.4, 6]} /><meshStandardMaterial color={main} roughness={0.7} /></mesh>
          ))}
        </>
      );
    case 'seaweed':
      return <mesh position={[0, 1.2, 0]} rotation={[0, 0, 0.1]}><boxGeometry args={[0.08, 2.4, 0.35]} /><meshStandardMaterial color={accent} roughness={0.9} /></mesh>;
    case 'crystal':
      return <mesh position={[0, 0.9, 0]} rotation={[0.2, 0, 0.25]}><octahedronGeometry args={[0.8, 0]} /><meshStandardMaterial color={main} emissive={main} emissiveIntensity={0.5} roughness={0.2} flatShading /></mesh>;
    case 'iceblock':
      return <mesh position={[0, 0.6, 0]}><boxGeometry args={[1.2, 1.2, 1.2]} /><meshStandardMaterial color={accent} roughness={0.1} metalness={0.1} transparent opacity={0.85} /></mesh>;
    case 'volcano':
      return (
        <>
          <mesh position={[0, 2.5, 0]}><cylinderGeometry args={[1.2, 3.8, 5, 10, 1, true]} /><meshStandardMaterial color={main} roughness={1} flatShading /></mesh>
          <mesh position={[0, 4.95, 0]} rotation={[-Math.PI / 2, 0, 0]}><circleGeometry args={[1.2, 10]} /><meshBasicMaterial color={accent} /></mesh>
        </>
      );
    case 'buoy':
      return (
        <>
          <mesh position={[0, 0.4, 0]}><cylinderGeometry args={[0.4, 0.5, 0.8, 10]} /><meshStandardMaterial color={main} roughness={0.6} /></mesh>
          <mesh position={[0, 1.1, 0]}><coneGeometry args={[0.3, 0.7, 8]} /><meshStandardMaterial color="#f8fafc" roughness={0.6} /></mesh>
        </>
      );
  }
}

/**
 * Model katalogu postavený na zem ve výšce kulisy (`modelHeight`); dokud se nenačte, nic. `cap` = sněhová čepička.
 * `cast = false`: stín jen přijímá – orientační bod a rámující kusy (P54B T8) nestojí stínový průchod navíc.
 */
export function SceneryModelProp({ id, cap, cast = true }: { readonly id: SceneryModel; readonly cap?: string; readonly cast?: boolean }) {
  const [model, setModel] = useState<Object3D | null>(null);
  useEffect(() => {
    let live = true;
    void loadFlatModel(id).then((loaded) => {
      if (live) setModel(loaded);
    });
    return () => {
      live = false;
    };
  }, [id]);
  const fitted = useMemo(() => {
    if (model === null) return null;
    const copy = model.clone(true);
    const box = new Box3().setFromObject(copy);
    const size = box.getSize(new Vector3());
    const scale = modelHeight(id) / Math.max(size.y, 1e-3);
    copy.scale.setScalar(scale);
    const center = box.getCenter(new Vector3());
    copy.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
    if (cap !== undefined) capSnow(copy, cap);
    if (!cast) {
      copy.traverse((node) => {
        if ((node as Mesh).isMesh !== true) return;
        // Značka rigu: `ShadowFlags` ji už nepřepíše na vrhání stínu.
        node.userData.rigShadow = 'receive';
        node.castShadow = false;
        node.receiveShadow = true;
      });
    }
    freeze(copy);
    return copy;
  }, [model, id, cap, cast]);
  // Model doběhne po prvním snímku: nový program se přeloží mimo hlavní vlákno, kulisa se ukáže hotová (P68-M T2).
  const shown = useWarmed(fitted);
  return shown === null ? null : <primitive object={shown} />;
}

/**
 * Rostlina vegetace sady jako kulisa (P46G T4): barvy jako ve vegetaci (`paintedPlant`),
 * takže jehličnan v lese je zelený i ve scéně bez vegetace a šedé listí katalogu dostane barvu sady.
 */
function PlantProp({ id, flora, height, cap }: { readonly id: string; readonly flora: Flora; readonly height: number; readonly cap?: string }) {
  const [plant, setPlant] = useState<PlantModel | null>(null);
  useEffect(() => {
    let live = true;
    void paintedPlant(id, flora).then((loaded) => {
      if (live) setPlant(loaded);
    });
    return () => {
      live = false;
    };
  }, [id, flora]);
  const mesh = useMemo(() => {
    if (plant === null) return null;
    const made = new Mesh(plant.geometry, plantMaterial(plant.double));
    made.scale.setScalar(height);
    // Zasněžená rostlina má vlastní materiál bez větru (`snowcapped`) a stojí, stín s ní.
    if (cap !== undefined) capSnow(made, cap);
    else made.customDepthMaterial = plantDepthMaterial();
    freeze(made);
    return made;
  }, [plant, height, cap]);
  return mesh === null ? null : <primitive object={mesh} />;
}

/** Buňka mřížky je 1 m, kulisa arkády počítá s hrdinou ~2 m: na mřížce stojí zmenšená. */
const GRID_SCALE = 0.55;
/** Mezera mezi hranou mřížky a osou první řady kulis, v buňkách: sopka má poloměr 2,1 buňky. */
const GRID_GAP = 2.2;

/**
 * Kulisy sady prostředí za mřížkovou hrou (P28D T6). Kamera mřížky přichází od
 * +x/+z (`blueprint.ts`), takže kulisa stojí podél vzdálených hran −z a −x,
 * mimo hrací plochu a mimo hash – jádro o ní neví.
 */
export function GridScenery({ look, width, height }: { readonly look: Look; readonly width: number; readonly height: number }) {
  const at = (cells: number) => cells / GRID_SCALE;
  // Panorama prostředí z věty (P29C T5); kontext prochází do plátna přes most R3F.
  const env = useContext(PlayEnv);
  return (
    <group name="grid-scenery">
      {env !== null && (
        <Suspense fallback={null}>
          <Panorama env={env} />
        </Suspense>
      )}
      {/* Zem v barvě sady těsně nad terénem rodiny: béžová pod „icy moon“ ani sopkou prostředí neřekla. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.004, 0]} receiveShadow renderOrder={UNDER_PANORAMA}>
        <planeGeometry args={[140, 140]} />
        <meshStandardMaterial color={look.ground} roughness={1} depthWrite={false} />
      </mesh>
      <group rotation={[0, Math.PI / 2, 0]} scale={GRID_SCALE}>
        <Scenery look={look} layout="behind" inner={at(height / 2 + GRID_GAP)} from={at(-width / 2 - 3)} to={at(width / 2)} />
      </group>
      <group rotation={[0, Math.PI, 0]} scale={GRID_SCALE}>
        <Scenery look={look} layout="behind" inner={at(width / 2 + GRID_GAP)} from={at(-height / 2)} to={at(height / 2 + 3)} />
      </group>
    </group>
  );
}

/** Kulisy stojí: matice se spočítá jednou, ne každý snímek. */
function freeze(root: Object3D): void {
  root.traverse((node) => {
    node.updateMatrix();
    node.matrixAutoUpdate = false;
  });
}

/** Poloměr paty kulisy (m při měřítku 1): kulisa na svahu stojí na nejnižším bodě paty, ať nevisí. */
const FOOT = 0.7;

/**
 * Řada kulis. Matice se spočítají hned, takže rig (`SceneryWindow` v `StyleRig`)
 * podle `userData.scenery` smí kulisy za koncem mlhy vypnout – bez R3F tady,
 * stránka mřížky tenhle soubor importuje staticky (viz `Panorama` výš).
 * `ground` = výška terénu pod kulisou (údolí běžce, P32A T3), `cap` = barva sněhové čepičky,
 * `tallest` = strop výšky řady v popředí (v metrech scény, už se `size`), `bend` = posun po
 * zakřivené trati běžce (P46D T3, `runner/path.ts`): kulisa stojí vedle zatáčky, ne v ní.
 * `vegetation` = scéna kreslí vegetaci sady (`Vegetation.tsx`): řada nese jen stavby a věci, vedle přírody řídce
 * a střídavě; vedle výplně (P54B T7, `sparseLandmarks`) zůstane hustá.
 */
export function Scenery({ look, layout, inner, from, to, y = 0, size = 1, ground, cap, tallest, bend, vegetation = false }: { readonly look: Look; readonly layout: SceneryLayout; readonly inner: number; readonly from: number; readonly to: number; readonly y?: number; readonly size?: number; readonly ground?: (x: number, z: number) => number; readonly cap?: string; readonly tallest?: SceneryCap; readonly bend?: (z: number) => { readonly x: number; readonly y: number }; readonly vegetation?: boolean }) {
  const side = tallest?.side;
  const height = tallest === undefined ? undefined : tallest.height / size;
  const props = useMemo(() => (vegetation ? landmarks(look) : look.props), [look, vegetation]);
  const sparse = vegetation && sparseLandmarks(look);
  const places = useMemo(() => sceneryPlaces(props, layout, inner, from, to, side === undefined || height === undefined ? undefined : { side, height }, sparse), [props, layout, inner, from, to, side, height, sparse]);
  const plants = useMemo(() => (look.flora === undefined ? new Set<string>() : floraIds(look.flora)), [look.flora]);
  const heights = useMemo(
    () =>
      places.map((place) => {
        if (ground === undefined) return y;
        const r = FOOT * place.scale * size;
        return y + Math.min(ground(place.x, place.z), ground(place.x - r, place.z), ground(place.x + r, place.z), ground(place.x, place.z - r), ground(place.x, place.z + r));
      }),
    [places, ground, y, size],
  );
  const root = useRef<Group>(null);
  useLayoutEffect(() => {
    if (root.current === null) return;
    if (cap !== undefined) capSnow(root.current, cap);
    freeze(root.current);
    root.current.updateWorldMatrix(true, true);
  }, [places, size, heights, cap]);
  return (
    <group ref={root} userData={{ scenery: true }}>
      {places.map((place, index) => (
        <group key={index} position={[place.x + (bend?.(place.z).x ?? 0), heights[index]! + (bend?.(place.z).y ?? 0), place.z]} rotation={[0, place.turn, 0]} scale={place.scale * size}>
          <SceneryPiece kind={place.kind} look={look} plants={plants} cap={cap} />
        </group>
      ))}
    </group>
  );
}

/** Kulisa sady: primitiva, rostlina vegetace v barvách sady, nebo model katalogu. */
function SceneryPiece({ kind, look, plants, cap }: { readonly kind: SceneryKind; readonly look: Look; readonly plants: ReadonlySet<string>; readonly cap?: string }) {
  if (!isSceneryModel(kind)) return <Prop kind={kind} tint={look.tint} />;
  return plants.has(kind) ? <PlantProp id={kind} flora={look.flora!} height={modelHeight(kind)} cap={cap} /> : <SceneryModelProp id={kind} cap={cap} />;
}

// ---------------------------------------------------------------------------
// Kulisy uvnitř hrací plochy (P62 T4)

/** Sonda kusů plochy (`window.__playField`): kolik jich je a kolik sítí kreslí; `show(false)` je schová (A/B kreslicích volání). */
interface FieldProbe {
  readonly report: () => { readonly pieces: number; readonly meshes: number; readonly kinds: readonly string[] };
  readonly show: (on: boolean) => void;
}

declare global {
  interface Window {
    __playField?: FieldProbe;
  }
}

/**
 * 4–10 kulis sady uvnitř hrací plochy arény a střelnice (P62 T4). Kde stojí, spočítá
 * `field-dressing.ts` ve workeru z běhu robota (`field-dressing-worker.ts`), takže se cestě
 * robota, spawnům ani dráhám nepřátel vyhnou. Worker běží od hydratace stránky
 * (`prefetchFieldDressing` v `ArcadePlay`, P62 T4-R1): hotové kusy stojí už v první montáži,
 * jinak se objeví, až doběhne. Jen vzhled: jádro o nich neví.
 */
export function FieldDressing({ look, world }: { readonly look: Look; readonly world: ArcadeWorld }) {
  const [pieces, setPieces] = useState<readonly FieldPiece[]>(() => fieldPiecesNow(world, look) ?? []);
  useEffect(() => {
    let live = true;
    setPieces(fieldPiecesNow(world, look) ?? []);
    void fieldPiecesOf(world, look).then((found) => {
      if (live) setPieces(found);
    });
    return () => {
      live = false;
    };
  }, [world, look]);
  const cap = look.terrain?.cap;
  const root = useRef<Group>(null);
  useLayoutEffect(() => {
    if (root.current === null) return;
    if (cap !== undefined) capSnow(root.current, cap);
    freeze(root.current);
    root.current.updateWorldMatrix(true, true);
  }, [pieces, cap]);
  useEffect(() => {
    const probe: FieldProbe = {
      report: () => {
        let meshes = 0;
        root.current?.traverse((node) => {
          if ((node as Mesh).isMesh === true) meshes += 1;
        });
        return { pieces: pieces.length, meshes, kinds: pieces.map((piece) => piece.kind) };
      },
      show: (on) => {
        if (root.current !== null) root.current.visible = on;
      },
    };
    window.__playField = probe;
    return () => {
      if (window.__playField === probe) delete window.__playField;
    };
  }, [pieces]);
  return (
    <group ref={root} userData={{ scenery: true }}>
      {pieces.map((piece, index) => (
        <group key={index} position={[piece.x, 0, piece.z]} rotation={[0, piece.turn, 0]}>
          {piece.plant ? (
            <PlantProp id={piece.kind} flora={look.flora!} height={piece.height} cap={cap} />
          ) : (
            <group scale={piece.height / modelHeight(piece.kind)}>
              <SceneryModelProp id={piece.kind} cap={cap} />
            </group>
          )}
        </group>
      ))}
    </group>
  );
}
