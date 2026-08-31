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

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BufferAttribute, BufferGeometry, Vector3, type Group } from 'three';

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

/** Řádků v mřížce. Dvanáct kusů na čtyřech sloupcích dá tři. */
const ROWS = Math.ceil(GALLERY.length / COLUMNS);

/**
 * O kolik pixelů popisky spadnou pod svou buňku.
 *
 * Tvar se do buňky zmenší na 0,78 její strany, jenže zmenšuje se podle
 * **největšího** rozměru — kdo je široký a nízký jako `machine`, sáhne na
 * spodní hranu buňky téměř celou výškou a popisek se mu opře o podstavec.
 * Deset pixelů je mezera, ne posun: vodorovné sazení, o které bráně jde,
 * se tím nemění.
 */
const LABEL_DROP = 10;

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

  return {
    scale: (CELL * 0.78) / span,
    center: [
      (mesh.bounds.min[0] + mesh.bounds.max[0]) / 2,
      (mesh.bounds.min[1] + mesh.bounds.max[1]) / 2,
      (mesh.bounds.min[2] + mesh.bounds.max[2]) / 2,
    ] as const,
    cell: [
      (index % COLUMNS) * CELL - ((COLUMNS - 1) * CELL) / 2,
      ((ROWS - 1) * CELL) / 2 - Math.floor(index / COLUMNS) * CELL,
      0,
    ] as const,
  };
}

/** Obdélník mřížky na obrazovce, v pixelech plátna. */
interface Frame {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Kam mřížka kusů doopravdy dopadla — a tím i kam patří popisky.
 *
 * **Popisky se do plátna netrefovaly a nikdo si toho nevšiml, protože se to
 * nedalo poznat z indexu.** HTML mřížka stála na čtyřech dílech šířky okna
 * (320 px při 1280), kdežto kusy stojí 3,4 světové jednotky od sebe, což při
 * kameře na `z = 16` a zorném úhlu 42° dělá 199 px. Kost tak vyšla blíž
 * k popisku `Root` než ke svému vlastnímu — přesně to, co brána K1 potřebuje
 * mít jisté, protože člověk soudí tvar podle jména pod ním.
 *
 * Obdélník se **nedopočítává vedle scény**, ale promítá skutečnou kamerou, do
 * které se kreslí. Vlastní vzorec pro „kolik pixelů je jednotka" by byl druhá
 * kopie projekce a rozešel by se s ní při první změně objektivu nebo vzdálenosti.
 *
 * Počítá se v `useFrame`, ne v efektu: po změně velikosti okna R3F přepočítá
 * matici kamery až ve smyčce, takže efekt by promítal ještě tou starou.
 */
function LabelFrame({ onFrame }: { readonly onFrame: (frame: Frame) => void }): null {
  const last = useRef<Frame | null>(null);

  useFrame(({ camera, size }) => {
    const halfWidth = (COLUMNS * CELL) / 2;
    const halfHeight = (ROWS * CELL) / 2;
    const topLeft = new Vector3(-halfWidth, halfHeight, 0).project(camera);
    const bottomRight = new Vector3(halfWidth, -halfHeight, 0).project(camera);
    const left = ((topLeft.x + 1) / 2) * size.width;
    const top = ((1 - topLeft.y) / 2) * size.height;
    const frame: Frame = {
      left,
      top,
      width: ((bottomRight.x + 1) / 2) * size.width - left,
      height: ((1 - bottomRight.y) / 2) * size.height - top,
    };

    // Půl pixelu: pod tím se popisek nemá kam pohnout a přepis stavu by jel
    // každý snímek.
    const previous = last.current;
    if (
      previous !== null &&
      Math.abs(previous.left - frame.left) < 0.5 &&
      Math.abs(previous.top - frame.top) < 0.5 &&
      Math.abs(previous.width - frame.width) < 0.5 &&
      Math.abs(previous.height - frame.height) < 0.5
    ) {
      return;
    }
    last.current = frame;
    onFrame(frame);
  });

  return null;
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
  /** Kolik tvarů vynechalo `?skip=`. Bez toho by `done` nikdy nenastalo. */
  const [skipped, setSkipped] = useState(0);
  /** Kam mřížka dopadla. Do prvního snímku se popisky nekreslí — je jasnější
      žádný popisek než popisek na odhadnutém místě. */
  const [frame, setFrame] = useState<Frame | null>(null);

  const onFrame = useCallback((next: Frame) => setFrame(next), []);

  const onPlaced = useCallback((shapeId: string, cell: number) => {
    setPlaced((current) => [...current, `${shapeId}:${cell}`]);
  }, []);

  useEffect(() => {
    const client = createMeshClient();
    let live = true;

    /**
     * `?skip=root,shell` vynechá jmenované tvary. Popisky zůstanou všechny.
     *
     * **Dvě použití, obě potřebná.** U brány dovolí odložit tvar, který táhne
     * pozornost, a podívat se na zbytek. A hlavně dovolí testu vyrobit
     * **záměrnou díru**: buňka se počítá z jména, ne z pořadí příchodu, a ten
     * rozdíl se pozná jedině tehdy, když nějaký tvar chybí. Dokud se díra brala
     * z toho, co zrovna přetáhlo rozpočet, měřil test náhodu — a po zvednutí
     * stropu 31. 8. 2026 by nepoznal nic.
     *
     * Čte se z `location.search` až v efektu, tedy po připojení: hydratace tím
     * nemá jak neladit, protože server vykreslí stránku bez tvarů tak jako tak.
     */
    const skip = new Set(
      new URLSearchParams(window.location.search).get('skip')?.split(',').filter(Boolean) ?? [],
    );

    setSkipped(GALLERY.filter((item) => skip.has(item.id)).length);

    void (async () => {
      for (const item of GALLERY) {
        if (skip.has(item.id)) continue;
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

  const done = meshes.length + failed.length + skipped === GALLERY.length;

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
      /* Kolik který tvar stál ve workeru. Rozpočet `MESH_DETAIL.high` se
         kalibroval na stránce **bez plátna** (`/dev/mesh-budget` schválně nic
         nekreslí), kdežto v produktu meshing běží vedle živé renderovací
         smyčky. Tady je ta druhá podmínka, a je to jediné místo, kde se dá
         změřit. Viz `T7-meshbudget`. */
      data-times={meshes.map((mesh) => `${mesh.shapeId}:${Math.round(mesh.elapsedMs)}`).join(',')}
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
        /* `preserveDrawingBuffer` je tu kvůli bráně, ne kvůli obrazu: bez něj je
           obsah plátna mimo vykreslovací smyčku nedefinovaný a test, který se ptá
           „leží ten tvar nad svým popiskem?", by četl prázdno. Je to stránka brány,
           ne produkt — cena za držený buffer se tu platí jednou a jinde nikde. */
        gl={{ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true }}
        camera={{ position: [0, 0, 16], fov: 42, near: 0.1, far: 100 }}
      >
        <WorldstreamLighting />
        <LabelFrame onFrame={onFrame} />
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
          {done
            ? `${meshes.length} of ${GALLERY.length} meshed${skipped > 0 ? `, ${skipped} skipped` : ''}`
            : 'meshing…'}
        </span>
      </header>

      {/* Popisky nejsou v 3D: bez `drei` by to znamenalo vlastní atlas písma.
          Mřížka je pevná, ale **pevná ve světě, ne v pixelech** — kolik z okna
          zabere, rozhoduje kamera. HTML mřížka proto sedí na obdélníku, který
          promítla ta kamera, ne na čtyřech dílech šířky okna. */}
      <ul
        aria-label="Shape names"
        data-testid="gallery-labels"
        style={{
          position: 'absolute',
          left: frame === null ? 0 : `${frame.left}px`,
          top: frame === null ? 0 : `${frame.top + LABEL_DROP}px`,
          width: frame === null ? 0 : `${frame.width}px`,
          height: frame === null ? 0 : `${frame.height}px`,
          visibility: frame === null ? 'hidden' : 'visible',
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
