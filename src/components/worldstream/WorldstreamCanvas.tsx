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
import { useEffect, useMemo, useSyncExternalStore } from 'react';

import WorldstreamLighting, {
  WORLDSTREAM_GL,
  WORLDSTREAM_SHADOWS,
} from '@/components/viewer/WorldstreamLighting';
import WorldstreamStage from '@/components/viewer/WorldstreamStage';
import { FRAMING_FOV, frameScene, type Bounds } from '@/worldstream/framing';
import type { RuntimeController, RuntimeSnapshot } from '@/worldstream/runtime-controller';
import { CELL_SIZE } from '@/components/viewer/projection';
import type { ProxyWorld } from '@/worldstream/proxy';
import { budgetFor, type QualityTier } from '@/worldstream/quality';

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
 * Posadí kameru tak, aby se svět vešel do snímku.
 *
 * Uvnitř plátna, ne v `<Canvas camera>`: prop `camera` platí jen při vzniku
 * plátna a svět přichází o vteřiny později. Kamera se přestaví **při každé
 * změně světa**, takže druhá věta dostane svoje rámování a nezůstane po té
 * první.
 */
function FrameCamera({ world, controller }: { readonly world: ProxyWorld | null; readonly controller: RuntimeController | null }) {
  const state = useSyncExternalStore(controller?.subscribe ?? subscribeEmpty,
    controller?.getSnapshot ?? emptySnapshot, emptySnapshot);
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const bounds = useMemo(() => (world === null ? null : worldExtent(world, state)), [world, state]);
  const hero = useMemo(() => (world === null ? null : heroCenter(world)), [world]);

  useEffect(() => {
    if (bounds === null) return;

    const framing = frameScene({
      bounds,
      hero,
      aspect: size.width / size.height,
      fov: FRAMING_FOV,
    });
    camera.position.set(framing.eye.x, framing.eye.y, framing.eye.z);
    camera.lookAt(framing.target.x, framing.target.y, framing.target.z);
    camera.updateProjectionMatrix();
  }, [bounds, camera, hero, size.height, size.width]);

  return null;
}

export default function WorldstreamCanvas({ world, controller = null }: {
  readonly world: ProxyWorld | null;
  readonly controller?: RuntimeController | null;
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
      <WorldstreamLighting quality={quality} />
      <FrameCamera world={world} controller={controller} />
      {world !== null && world.kind === 'built' && <RuntimeStage world={world} controller={controller} />}
    </Canvas>
  );
}

const subscribeEmpty = () => () => {};
const emptySnapshot = () => null;

function RuntimeStage({ world, controller }: { readonly world: ProxyWorld; readonly controller: RuntimeController | null }) {
  const state = useSyncExternalStore(controller?.subscribe ?? subscribeEmpty,
    controller?.getSnapshot ?? emptySnapshot, emptySnapshot);
  return <WorldstreamStage world={world} runtimeState={state} />;
}
