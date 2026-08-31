'use client';

/**
 * `/gallery` — brána K1. Dvanáct ručních tvarů vedle sebe (P13 vlna 1 T7).
 *
 * ## Proč tahle stránka vůbec musí být
 *
 * `diversity.test.ts` odpoví na „jsou ty tvary různé?" — spočítá 66 dvojic a
 * žádnou nepustí pod práh. Na druhou půlku brány, **„vypadá aspoň osm z nich
 * modelovaně, ne jako blob?"**, žádné strojové orákulum neexistuje: blobovatost
 * je vlastnost dojmu, ne siluety. Bez téhle stránky se brána K1 nedá projít,
 * protože by nebylo na co se podívat.
 *
 * ## Meshuje se přes worker, ne přímo
 *
 * `createMeshClient()` je táž fronta, jakou použije potrubí ve vlně 3 — sériová
 * schválně. Dvanáct tvarů v mřížce 48³ stojí několik vteřin a na hlavním vlákně
 * by po tu dobu stránka stála. Takhle se tvary objevují po jednom a je vidět
 * postup; navíc se ta cesta při každém pohledu na galerii projde nanečisto.
 *
 * **Mřížka je `DIVERSITY_RESOLUTION`, ne vlastní číslo.** Člověk musí soudit
 * přesně ten mesh, který změřilo měřidlo. Kdyby stránka meshovala hruběji,
 * rozhodovala by se brána nad jinou geometrií, než o jaké mluví report.
 *
 * ## Tvary se otáčejí
 *
 * Měřidlo soudí siluety ze **čtyř** kamer po 90°, protože z jedné je kdejaká
 * dvojice tvarů totéž. Člověk má mít stejnou příležitost, takže se každý kus
 * pomalu otáčí kolem `y`. Otáčení jede z `useFrame`, tedy z wall-clocku — je to
 * mimo hashovaný stav a mimo replay cestu, přesně jak `CLAUDE.md` žádá.
 */

import { Canvas, useFrame } from '@react-three/fiber';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BufferAttribute, BufferGeometry, type Group } from 'three';

import { UI_TOKENS } from '@/kit';
import { createMeshClient, type MeshResult } from '@/shape/mesh-client';

import { clayMaterial } from '../../components/viewer/ClayMaterial';
import WorldstreamLighting from '../../components/viewer/WorldstreamLighting';
import { GALLERY, GALLERY_SEED, galleryIndex } from '../../../evals/shape/gallery';
import { DIVERSITY_RESOLUTION } from '../../../evals/shape/measure-diversity';

/** Sloupců v mřížce. Dvanáct kusů tak vyjde na 4 × 3. */
const COLUMNS = 4;

/** Rozteč buněk. Tvar se do buňky zmenší, takže je to i jeho největší rozměr. */
const CELL = 3.4;

/** Otáček za vteřinu. Pomalu — brána se soudí okem, ne stopkami. */
const TURNS_PER_SECOND = 0.06;

function geometryOf(mesh: MeshResult): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
  geometry.setIndex(new BufferAttribute(mesh.indices, 1));
  return geometry;
}

/**
 * Kam a jak velký kus patří.
 *
 * **`index` je pořadí v `GALLERY`, ne pořadí, ve kterém kus došel z fronty.**
 * Popisky se kreslí z celé galerie na pevných dvanácti buňkách, takže kus,
 * který by se sázel podle délky hotového pole, by po každém selhání stál pod
 * cizím jménem.
 *
 * Tvar se posadí středem svého **naměřeného** kvádru do počátku buňky a zmenší
 * tak, aby se jeho největší rozměr vešel do buňky. Normalizuje se **jedním**
 * číslem pro všechny osy, stejně jako v `measure-diversity.ts`: kdyby se každá
 * osa škálovala zvlášť, placatá síť by se roztáhla do krychle a člověk by
 * soudil jiný tvar, než jaký změřilo měřidlo.
 */
function placement(mesh: MeshResult, index: number) {
  const span = Math.max(
    mesh.bounds.max[0] - mesh.bounds.min[0],
    mesh.bounds.max[1] - mesh.bounds.min[1],
    mesh.bounds.max[2] - mesh.bounds.min[2],
    1e-6,
  );
  const rows = Math.ceil(GALLERY.length / COLUMNS);

  return {
    scale: (CELL * 0.78) / span,
    center: [
      (mesh.bounds.min[0] + mesh.bounds.max[0]) / 2,
      (mesh.bounds.min[1] + mesh.bounds.max[1]) / 2,
      (mesh.bounds.min[2] + mesh.bounds.max[2]) / 2,
    ] as const,
    cell: [
      (index % COLUMNS) * CELL - ((COLUMNS - 1) * CELL) / 2,
      ((rows - 1) * CELL) / 2 - Math.floor(index / COLUMNS) * CELL,
      0,
    ] as const,
  };
}

function Piece({
  mesh,
  index,
  onPlaced,
}: {
  readonly mesh: MeshResult;
  readonly index: number;
  /**
   * Ohlásí buňku, do které se kus **doopravdy** posadil.
   *
   * Kusy jsou uvnitř plátna, takže z DOM je nepřečte nikdo. Kdyby si stránka
   * dopočítala rozmístění podruhé vedle plátna, měřila by vlastní výpočet, ne
   * scénu — vyzkoušeno mutací 31. 8. 2026: paralelně počítaný atribut nechal
   * vadu projít zelenou. Ohlašuje se proto ta hodnota, kterou kus použil.
   */
  readonly onPlaced: (shapeId: string, cell: number) => void;
}) {
  const spin = useRef<Group>(null);
  const geometry = useMemo(() => geometryOf(mesh), [mesh]);
  const material = useMemo(() => clayMaterial(), []);
  const { scale, center, cell } = useMemo(() => placement(mesh, index), [mesh, index]);

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  useEffect(() => {
    onPlaced(mesh.shapeId, index);
  }, [onPlaced, mesh.shapeId, index]);

  useFrame((_, delta) => {
    if (spin.current !== null) spin.current.rotation.y += delta * TURNS_PER_SECOND * Math.PI * 2;
  });

  return (
    <group position={[cell[0], cell[1], cell[2]]}>
      <group ref={spin} scale={scale}>
        {/* Vlastní kvádr do počátku až uvnitř otáčení, jinak by kus obíhal
            kolem osy buňky místo aby se otáčel kolem sebe. */}
        <mesh
          geometry={geometry}
          material={material}
          position={[-center[0], -center[1], -center[2]]}
        />
      </group>
    </group>
  );
}

export default function GalleryPage(): React.JSX.Element {
  const [meshes, setMeshes] = useState<readonly MeshResult[]>([]);
  const [failed, setFailed] = useState<readonly string[]>([]);
  const [placed, setPlaced] = useState<readonly string[]>([]);

  const onPlaced = useCallback((shapeId: string, cell: number) => {
    setPlaced((current) => [...current, `${shapeId}:${cell}`]);
  }, []);

  useEffect(() => {
    const client = createMeshClient();
    let live = true;

    void (async () => {
      for (const item of GALLERY) {
        try {
          const mesh = await client.mesh({
            program: item.program,
            sessionSeed: GALLERY_SEED,
            resolution: DIVERSITY_RESOLUTION,
            bounds: item.program.targetBounds,
          });
          if (!live) return;
          // Přidávat po jednom, ne až celou dvanáctku: fronta je sériová, takže
          // je vidět postup a stránka nestojí několik vteřin prázdná.
          setMeshes((current) => [...current, mesh]);
        } catch (error) {
          if (!live) return;
          // Selhání se **vypíše**, nezamlčí. Chybějící tvar v mřížce vypadá
          // stejně jako tvar, který se ještě meshuje, a brána by se soudila
          // nad neúplnou galerií.
          setFailed((current) => [...current, `${item.id}: ${String(error)}`]);
        }
      }
    })();

    return () => {
      live = false;
      client.dispose();
    };
  }, []);

  const done = meshes.length + failed.length === GALLERY.length;

  return (
    <main
      data-testid="gallery-root"
      data-ready={done ? 'yes' : 'no'}
      data-meshed={meshes.length}
      /* Které jméno stojí ve které buňce — ohlášené kusy samotnými, ne
         dopočítané vedle nich. Je to jediná vlastnost téhle stránky, kterou
         brána K1 potřebuje mít jistou: člověk soudí tvar podle popisku pod
         ním. Viz `e2e/gallery.spec.ts` a `gallery-cells.test.ts`. */
      data-cells={placed.join(',')}
      style={{
        position: 'relative',
        height: '100dvh',
        width: '100vw',
        overflow: 'hidden',
        background: UI_TOKENS.pelagic,
        color: UI_TOKENS.nacre,
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <Canvas
        data-testid="gallery-canvas"
        shadows={false}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        camera={{ position: [0, 0, 16], fov: 42, near: 0.1, far: 100 }}
      >
        <WorldstreamLighting />
        {meshes.map((mesh) => (
          <Piece
            key={mesh.shapeId}
            mesh={mesh}
            index={galleryIndex(mesh.shapeId)}
            onPlaced={onPlaced}
          />
        ))}
      </Canvas>

      <header
        style={{
          position: 'absolute',
          top: '1.25rem',
          left: '1.5rem',
          fontSize: '0.8rem',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: UI_TOKENS.verdigris,
        }}
      >
        Twelve hand-written shape programs
        <span style={{ color: UI_TOKENS.muted, marginLeft: '0.75rem', textTransform: 'none' }}>
          {done ? `${meshes.length} of ${GALLERY.length} meshed` : 'meshing…'}
        </span>
      </header>

      {/* Popisky nejsou v 3D: bez `drei` by to znamenalo vlastní atlas písma,
          a mřížka je pevná, takže HTML mřížka nad plátnem přesně sedne. */}
      <ul
        aria-label="Shape names"
        style={{
          position: 'absolute',
          inset: '3.5rem 0 1rem',
          display: 'grid',
          gridTemplateColumns: `repeat(${COLUMNS}, 1fr)`,
          gridAutoRows: '1fr',
          listStyle: 'none',
          margin: 0,
          padding: 0,
          pointerEvents: 'none',
        }}
      >
        {GALLERY.map((item) => (
          <li
            key={item.id}
            data-testid={`gallery-label-${item.id}`}
            style={{
              display: 'flex',
              alignItems: 'flex-end',
              justifyContent: 'center',
              paddingBottom: '0.35rem',
              fontSize: '0.75rem',
              letterSpacing: '0.06em',
              color: UI_TOKENS.muted,
            }}
          >
            {item.label}
          </li>
        ))}
      </ul>

      {failed.length > 0 && (
        <p
          data-testid="gallery-failures"
          style={{
            position: 'absolute',
            bottom: '1rem',
            left: '1.5rem',
            color: UI_TOKENS.coral,
            fontSize: '0.8rem',
          }}
        >
          {failed.join(' · ')}
        </p>
      )}
    </main>
  );
}
