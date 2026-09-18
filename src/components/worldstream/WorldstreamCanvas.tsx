'use client';

/**
 * Plátno hlavní cesty — **hrubý svět z běžící relace na celé obrazovce**
 * (P15 `T21b` / `T47-t21bunblock`).
 *
 * Do 6. 9. 2026 kreslila úvodní stránka `Stage`, tedy starou herní scénu nad
 * `WorldDocRuntime`. Ta se přestěhovala na `/classic` a tohle je plátno
 * produktu: `WorldstreamStage` nad `ProxyWorld`, který si prohlížeč postavil
 * z blueprintu doručeného proudem relace.
 *
 * ## Proč vlastní soubor, a ne kus `page.tsx`
 *
 * `<Canvas>` sahá na `document` a WebGL2 kontext na serveru neexistuje, takže
 * se sem chodí přes `dynamic(..., { ssr: false })`. Je to totéž rozhodnutí,
 * jaké měla stará stránka u `Stage`, a ze stejného důvodu.
 *
 * ## Kamera se počítá ze světa, nekonstantuje se
 *
 * `/dev/worldstream` má kameru napsanou ručně (`DEMO_CAMERA`), protože staví
 * jediný známý dokument. Tady přijde svět, který nikdo nepředvídal — pevná
 * kamera by ho podle věty buď minula, nebo přiblížila na jeden roh. Rámuje ho
 * proto `frameScene()` ze **skutečných** kvádrů slotů, tedy z toho, co je na
 * scéně, ne z toho, co blueprint zamýšlel.
 */

import { Canvas, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PerspectiveCamera } from 'three';

import WorldstreamLighting, {
  WORLDSTREAM_GL,
  WORLDSTREAM_SHADOWS,
} from '@/components/viewer/WorldstreamLighting';
import WorldstreamStage from '@/components/viewer/WorldstreamStage';
import { FRAMING_FOV, frameScene, safeAreaFromRects, type Bounds, type SafeArea } from '@/worldstream/framing';
import { applyDiagramProjection, frameDiagram } from '@/worldstream/diagram-framing';
import type { RuntimeController, RuntimeSnapshot } from '@/worldstream/runtime-controller';
import { CELL_SIZE } from '@/components/viewer/projection';
import type { ProxyWorld } from '@/worldstream/proxy';
import { budgetFor, type QualityTier } from '@/worldstream/quality';
import { routeMarkers } from '@/worldstream/guide-answer';

export interface SharedCamera {
  current: { eye: number[]; target: number[] } | null;
  listeners: Set<() => void>;
}

/**
 * Obal všech slotů, nebo `null` u prázdného světa.
 *
 * Bere `worldBounds`, ne `localBounds`: rámuje se to, kam objekt po transformu
 * doopravdy padne. `localBounds` je kvádr, ve kterém je podoba napsaná, a
 * u posunutého objektu ukazuje jinam, než kde ten objekt stojí.
 */
function worldExtent(world: ProxyWorld, state: RuntimeSnapshot | null): Bounds | null {
  if (world.kind !== 'built' || world.slots.length === 0) return null;

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const { slot } of world.slots) {
    const entity = state?.entities.find(entry => entry.stableId === slot.stableId);
    const offset = entity ? [entity.dx * CELL_SIZE, 0, entity.dy * CELL_SIZE] : [0, 0, 0];
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], slot.worldBounds.min[axis], slot.worldBounds.min[axis] + offset[axis]);
      max[axis] = Math.max(max[axis], slot.worldBounds.max[axis], slot.worldBounds.max[axis] + offset[axis]);
    }
  }
  return { min: { x: min[0], y: min[1], z: min[2] }, max: { x: max[0], y: max[1], z: max[2] } };
}

/** Nejdůležitější slot je hrdina snímku. Při shodě rozhoduje pořadí blueprintu. */
function heroCenter(world: ProxyWorld): { x: number; y: number; z: number } | null {
  if (world.kind !== 'built' || world.slots.length === 0) return null;

  let best = world.slots[0].slot;
  for (const { slot } of world.slots) if (slot.importance > best.importance) best = slot;

  const { min, max } = best.worldBounds;
  return { x: (min[0] + max[0]) / 2, y: (min[1] + max[1]) / 2, z: (min[2] + max[2]) / 2 };
}

/**
 * Kolik hran plátna kryje rozhraní, v podílu jeho rozměru.
 *
 * Skořápka je mřížka přes celý viewport (`theme.css` `.ws-shell`), ne panel
 * vedle scény: dolní řádek patří doku, krajní sloupce ovládání a zásuvce
 * Inspect. Rámovat do celého okna tedy znamená postavit hrdinu pod dok.
 *
 * **Měří se z DOM za běhu**, protože napsat ta čísla natvrdo nejde: sloupce
 * mění šířku podle `data-controls` a `data-inspecting` (`minmax(0, 1fr)` proti
 * `minmax(16rem, 20rem)`), pod 760 px se mřížka překlápí do jediného sloupce a
 * dok roste s délkou stavové věty.
 *
 * Boční sloupec se počítá, jen když sahá **nad** dok. Ovládání i přepínač
 * Inspect jinak stojí v dolním pruhu, který je odečtený už jednou, a odečíst
 * ho podruhé by scénu bezdůvodně odtlačilo do dálky.
 */
function measureSafeArea(canvas: HTMLCanvasElement): SafeArea {
  const box = (selector: string): DOMRect | null =>
    document.querySelector(selector)?.getBoundingClientRect() ?? null;

  // Sbírá se tady, počítá se ve `framing.ts`. Rozdíl hran, který tu stál do
  // 16. 9. 2026, přestal platit ve chvíli, kdy T2 zmenšila samo plátno — celý
  // ten příběh je u `safeAreaFromRects()`.
  return safeAreaFromRects(canvas.getBoundingClientRect(), {
    bottom: box('.ws-dock'),
    left: box('.ws-controls'),
    right: box('.ws-inspect-panels'),
  });
}

/**
 * Posadí kameru tak, aby se svět vešel do snímku.
 *
 * Uvnitř plátna, ne v `<Canvas camera>`: prop `camera` platí jen při vzniku
 * plátna a svět přichází o vteřiny později. Automatické rámování proběhne
 * pro novou session/source identitu a na výslovný reset. Editace, pohyb
 * návštěvníka i doplnění detailu zachovají ruční pohled.
 */
function FrameCamera({ world, controller, sceneId, reset, framing, sharedCamera, focusId }: { readonly world: ProxyWorld | null;
  readonly controller: RuntimeController | null; readonly sceneId: string | null; readonly reset: number;
  readonly framing: 'scene' | 'diagram'; readonly sharedCamera?: SharedCamera; readonly focusId?: string | null }) {
  const camera = useThree((state) => state.camera);
  const canvas = useThree((state) => state.gl.domElement);
  const size = useThree((state) => state.size);
  const controls = useMemo(() => new OrbitControls(camera), [camera]);
  const framed = useRef<{ sceneId: string | null; reset: number; framing: 'scene' | 'diagram'; focusId?: string | null } | null>(null);

  useEffect(() => {
    if (!sharedCamera) return;
    let receiving = false;
    const receive = () => {
      if (!sharedCamera.current) return;
      receiving = true;
      camera.position.fromArray(sharedCamera.current.eye);
      controls.target.fromArray(sharedCamera.current.target);
      controls.update(); receiving = false;
    };
    const publish = () => {
      if (receiving) return;
      sharedCamera.current = { eye: camera.position.toArray(), target: controls.target.toArray() };
      for (const listener of sharedCamera.listeners) if (listener !== receive) listener();
    };
    sharedCamera.listeners.add(receive); receive();
    controls.addEventListener('change', publish);
    return () => { sharedCamera.listeners.delete(receive); controls.removeEventListener('change', publish); };
  }, [camera, controls, sharedCamera]);

  useEffect(() => {
    canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', 'Scene camera: drag to orbit, scroll to zoom, arrow keys to pan');
    controls.connect(canvas);
    controls.listenToKeyEvents(canvas);
    controls.minDistance = 0.5;
    controls.maxPolarAngle = Math.PI / 2 - 0.01;
    const focus = () => canvas.focus({ preventScroll: true });
    canvas.addEventListener('pointerdown', focus);
    return () => { canvas.removeEventListener('pointerdown', focus); controls.dispose(); };
  }, [canvas, controls]);

  useEffect(() => {
    if (camera instanceof PerspectiveCamera)
      applyDiagramProjection(camera, size.width, size.height, framing === 'diagram');
  }, [camera, framing, size.width, size.height]);

  useEffect(() => {
    if (world === null) { framed.current = null; return; }
    if (framed.current?.sceneId === sceneId && framed.current.reset === reset && framed.current.framing === framing && framed.current.focusId === focusId) return;
    const focused = world.kind === 'built' && focusId ? {...world, slots: world.slots.filter(entry => entry.slot.stableId === focusId)} : world;
    const bounds = worldExtent(focused, controller?.getSnapshot() ?? null);
    if (bounds === null) return;
    const view = framing === 'diagram' ? frameDiagram(bounds, size.width / size.height) : frameScene({
      bounds,
      hero: heroCenter(focused),
      ...(world.kind === 'built' && world.environment?.kind === 'interior' ? {pitch: Math.PI * 0.27, heroHeight: 0.5} : {}),
      aspect: size.width / size.height,
      fov: FRAMING_FOV,
      // Měří se tady, ne v `frameScene`: rámování musí zůstat čistá funkce.
      // Změna zásuvky pohledem nehne schválně — přerámovat pod rukou někomu,
      // kdo si scénu zrovna otočil, je horší vada než hrdina o kus níž.
      safeArea: measureSafeArea(canvas),
    });
    camera.position.set(view.eye.x, view.eye.y, view.eye.z);
    controls.target.set(view.target.x, view.target.y, view.target.z);
    controls.update();
    camera.updateProjectionMatrix();
    framed.current = { sceneId, reset, framing, focusId };
  }, [world, controller, sceneId, reset, framing, focusId, camera, controls, size.height, size.width]);

  return null;
}

/**
 * Zvýraznění cesty, kterou průvodce našel (P21 T13).
 *
 * Kreslí se **prstenec na zemi kolem každé zastávky**, ne obarvený objekt:
 * materiál slotu nese podobu, kterou napsal model, a přebarvit ji kvůli
 * odpovědi by z ní udělalo něco jiného, než co ten svět je. Prstenec leží
 * mimo hashovaný stav — je to vykreslení, ne událost simulace.
 *
 * Jantarová, ne fialová: viz `rules/design-output.md`.
 */
function RouteRings({ world, highlight }: { readonly world: ProxyWorld; readonly highlight: readonly string[] }) {
  const markers = useMemo(() => routeMarkers(world, highlight), [world, highlight]);
  if (markers.length === 0) return null;

  return (
    <group name="guide-route">
      {markers.map((marker) => (
        <mesh
          key={marker.stableId}
          position={[marker.at[0], marker.at[1] + 0.02, marker.at[2]]}
          rotation={[-Math.PI / 2, 0, 0]}
          renderOrder={2}
        >
          <ringGeometry args={[marker.radius * 1.08, marker.radius * 1.3, 48]} />
          <meshBasicMaterial color="#f59e0b" transparent opacity={0.85} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}

export default function WorldstreamCanvas({ world, controller = null, sceneId = null, reset = 0, framing = 'scene', onPresented, sharedCamera, adaptiveAssets, focusId,cutaway=true, routeHighlight }: {
  readonly world: ProxyWorld | null;
  readonly controller?: RuntimeController | null;
  readonly sceneId?: string | null;
  readonly reset?: number;
  readonly framing?: 'scene' | 'diagram';
  readonly onPresented?: (world: ProxyWorld) => void;
  readonly sharedCamera?: SharedCamera;
  readonly adaptiveAssets?: boolean;
  readonly focusId?: string | null;
  readonly cutaway?:boolean;
  /** Zastávky cesty od průvodce, v jejím pořadí. Prázdné pole nekreslí nic. */
  readonly routeHighlight?: readonly string[];
}) {
  // Úroveň se čte ze **světa**, ne z volajícího: kdo svět dostane, ví, proti
  // jakému rozpočtu se má soudit (`proxy.ts`). Prázdné plátno kreslí `full`,
  // protože nekreslí nic.
  const quality: QualityTier = world?.kind === 'built' ? world.quality : 'full';

  return (
    <Canvas
      data-testid="worldstream-canvas"
      gl={{ ...WORLDSTREAM_GL }}
      shadows={WORLDSTREAM_SHADOWS}
      camera={{ position: [17, 12, 21], fov: FRAMING_FOV }}
      // Rozsah, ne jedno číslo — viz `/dev/worldstream`: rozpočet úrovně je
      // horní mez, ne příkaz vykreslovat na ni i na stroji, který ji nemá.
      dpr={[1, budgetFor(quality).pixelRatio]}
    >
      <WorldstreamLighting quality={quality} environment={world?.kind === 'built' ? world.environment : undefined} />
      <FrameCamera world={world} controller={controller} sceneId={sceneId} reset={reset} framing={framing} sharedCamera={sharedCamera} focusId={focusId} />
      {world !== null && world.kind === 'built' && <RuntimeStage key={sceneId} world={world} controller={controller} onPresented={onPresented} adaptiveAssets={adaptiveAssets} cutaway={cutaway} />}
      {world !== null && routeHighlight !== undefined && <RouteRings world={world} highlight={routeHighlight} />}
    </Canvas>
  );
}

const subscribeEmpty = () => () => {};
const emptySnapshot = () => null;

function RuntimeStage({ world, controller, onPresented, adaptiveAssets,cutaway }: { readonly world: ProxyWorld; readonly controller: RuntimeController | null;
  readonly onPresented?: (world: ProxyWorld) => void; readonly adaptiveAssets?: boolean;readonly cutaway?:boolean }) {
  const state = useSyncExternalStore(controller?.subscribe ?? subscribeEmpty,
    controller?.getSnapshot ?? emptySnapshot, emptySnapshot);
  return <WorldstreamStage world={world} runtimeState={state} onPresented={onPresented} adaptiveAssets={adaptiveAssets} cutaway={cutaway} />;
}
