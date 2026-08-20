'use client';

/**
 * WorldScene — běžící simulace nakreslená do scény.
 *
 * Do 19. 8. 2026 tahle vrstva neexistovala: plátno umělo vykreslit ručně
 * skládaný layout z kitu, ale stav běžícího světa se do 3D nepromítal vůbec.
 * Tenhle soubor to zavírá a drží se přitom tří pravidel:
 *
 * 1. **Je to čistě zobrazovací vrstva.** Jediný systém pravidel zůstává
 *    `src/ir/` a `src/sim/interpreter.ts`. Odsud se do nich jen čte —
 *    `createRuntime`, `step`, `entityPlacements`. Nic se tu nerozhoduje.
 * 2. **Scéna se staví jednou, ne každý snímek.** Geometrie, materiály a
 *    instancované meshe vzniknou v `useMemo` a snímek už jen přepisuje matice
 *    instancí. React se na tikové frekvenci nepřekresluje — kdyby ano, platil
 *    by se rekonciliací dvacetkrát za vteřinu za data, která nikdo nečte.
 * 3. **Simulovaný tik je jediná jednotka.** Nástěnný čas se čte právě jednou,
 *    v `pump()` z `src/sim/clock.ts`, a jeho jediný výstup je celý počet tiků.
 *    Co se v tiku stane, na nástěnných hodinách nezávisí; závisí na nich jen
 *    KDY se tik odkrokuje. Proto scéna zároveň vystavuje `step(n)`, kterým se
 *    dá běh posunout deterministicky bez čekání na skutečný čas.
 *
 * **Čím je která entita** rozhoduje `projection.ts` podle role ze zmrazeného
 * korpusu. Je to ta volba, kterou stroj posoudit nemůže — proto za fází 1 stojí
 * `HALT` a člověk se na ni podívá dřív, než se na ni začne vrstvit vizuál.
 */

import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  BoxGeometry,
  CapsuleGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshToonMaterial,
  OctahedronGeometry,
  PlaneGeometry,
  type BufferGeometry,
} from 'three';

import { SCENE_ROLES } from '@/kit';
import { createClock, pump, runTicks } from '@/sim/clock';
import {
  createRuntime,
  entityPlacements,
  step,
  type RunState,
  type Runtime,
  type TraceInput,
  type WorldDocRuntime,
} from '@/sim/interpreter';

import { toonRamp } from './Lighting';
import {
  CELL_SIZE,
  WALL_HEIGHT,
  elevationOf,
  projectEntities,
  projectStatic,
  visualRoleOf,
  type ProjectedEntity,
  type VisualRole,
} from './projection';

/**
 * Sémantické barvy scény přicházejí od T9 z kitu (`SCENE_ROLES`), ne odsud.
 *
 * Do té doby tu byla vlastní kopie s komentářem, že sjednocení patří do T9 —
 * a lišila se: `goal` byl zelený vedle oranžového agenta, což je právě ta
 * dvojice, kterou červeno-zelená barvoslepost zamění. V kitu je modrý.
 */
const COLORS: Readonly<Record<VisualRole | 'wall' | 'floor' | 'zone', string>> = SCENE_ROLES;

/** Podoby v pevném pořadí — jedna instancovaná dávka na podobu, tedy sedm kreslicích volání. */
const VISUALS: readonly VisualRole[] = ['avatar', 'agent', 'collectible', 'goal', 'gate', 'trigger', 'prop'];

/**
 * Tvar podle podoby.
 *
 * Volba tvarů je celý smysl `HALT` na konci fáze 1: kapsle čte jako postava,
 * kužel jako něco, co se pohybuje samo a nechceš do toho vrazit, osmistěn jako
 * něco ke sebrání. Když se to na první pohled neplete, fáze 2 to jen doleští.
 */
function geometryFor(visual: VisualRole): BufferGeometry {
  switch (visual) {
    case 'avatar':
      return new CapsuleGeometry(0.28, 0.42, 4, 12);
    case 'agent':
      return new ConeGeometry(0.34, 0.8, 10);
    case 'collectible':
      return new OctahedronGeometry(0.26, 0);
    case 'goal':
      return new CylinderGeometry(0.42, 0.42, 0.1, 16);
    case 'gate':
      return new BoxGeometry(0.9 * CELL_SIZE, 1.05, 0.22);
    case 'trigger':
      return new CylinderGeometry(0.36, 0.36, 0.05, 12);
    case 'prop':
      return new BoxGeometry(0.6, 0.62, 0.6);
    default: {
      const exhaustive: never = visual;
      return exhaustive;
    }
  }
}

interface RoleBatch {
  readonly mesh: InstancedMesh;
  /** `stableId` entit v pořadí instancí. Prázdné místo v dávce se schová pod nulovou maticí. */
  readonly ids: string[];
}

interface BuiltScene {
  readonly group: Group;
  readonly batches: ReadonlyMap<VisualRole, RoleBatch>;
  readonly dispose: () => void;
}

/**
 * Statická část scény plus prázdné instancované dávky.
 *
 * Kapacita dávky se bere z **deklarace světa**, ne z počtu entit v tuhle
 * chvíli: `spawn` umí za běhu entitu přidat a `InstancedMesh` se po vytvoření
 * nedá zvětšit. Bez toho by spawnutá entita tiše zmizela ze scény, zatímco
 * simulace by s ní dál počítala.
 */
function buildScene(world: WorldDocRuntime): BuiltScene {
  const group = new Group();
  const ramp = toonRamp();
  const owned: { dispose: () => void }[] = [ramp];

  const material = (color: string, extra: Partial<MeshToonMaterial> = {}): MeshToonMaterial => {
    const created = new MeshToonMaterial({ color, gradientMap: ramp, ...extra });
    owned.push(created);
    return created;
  };

  const geometry = <T extends BufferGeometry>(created: T): T => {
    owned.push(created);
    return created;
  };

  const projected = projectStatic(world);

  const floor = new Mesh(
    geometry(new PlaneGeometry(projected.floor.width, projected.floor.depth)),
    material(COLORS.floor),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(projected.floor.center.x, projected.floor.center.y, projected.floor.center.z);
  floor.receiveShadow = true;
  group.add(floor);

  // Zóny leží těsně nad podlahou. `depthWrite: false` proto, že jinak by
  // průhledná plocha zapsala hloubku a schovala entitu, která na ní stojí.
  for (const zone of projected.zones) {
    const patch = new Mesh(
      geometry(new PlaneGeometry(zone.width, zone.depth)),
      material(COLORS.zone, { transparent: true, opacity: 0.28, depthWrite: false, side: DoubleSide }),
    );
    patch.rotation.x = -Math.PI / 2;
    patch.position.set(zone.center.x, 0.02, zone.center.z);
    patch.name = `zone:${zone.name}`;
    group.add(patch);
  }

  if (projected.walls.length > 0) {
    const walls = new InstancedMesh(
      geometry(new BoxGeometry(CELL_SIZE, WALL_HEIGHT, CELL_SIZE)),
      material(COLORS.wall),
      projected.walls.length,
    );
    walls.castShadow = true;
    walls.receiveShadow = true;
    const matrix = new Matrix4();
    projected.walls.forEach((wall, index) => {
      matrix.makeTranslation(wall.position.x, wall.position.y, wall.position.z);
      walls.setMatrixAt(index, matrix);
    });
    walls.instanceMatrix.needsUpdate = true;
    group.add(walls);
  }

  const capacity = Math.max(world.ir.entities.length, world.ir.limits.maxEntities);
  const counts = new Map<VisualRole, number>();
  for (const decl of world.ir.entities) {
    const visual = visualRoleOf(decl.role);
    counts.set(visual, (counts.get(visual) ?? 0) + 1);
  }

  const batches = new Map<VisualRole, RoleBatch>();
  for (const visual of VISUALS) {
    if ((counts.get(visual) ?? 0) === 0) continue;
    const mesh = new InstancedMesh(geometry(geometryFor(visual)), material(COLORS[visual]), capacity);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.name = `entities:${visual}`;
    // Dokud první tik nenaplní matice, drží se instance mimo obraz nulovou
    // maticí. Bez toho by se celá dávka na jeden snímek slila v počátku.
    mesh.count = 0;
    batches.set(visual, { mesh, ids: [] });
    group.add(mesh);
  }

  return {
    group,
    batches,
    dispose: () => {
      for (const resource of owned) resource.dispose();
      for (const batch of batches.values()) batch.mesh.dispose();
    },
  };
}

/** Zapíše polohy entit do matic instancí. Volá se po každém tiku, ne každý snímek. */
function writeInstances(scene: BuiltScene, entities: readonly ProjectedEntity[], matrix: Matrix4): void {
  for (const batch of scene.batches.values()) {
    batch.ids.length = 0;
    batch.mesh.count = 0;
  }

  for (const entity of entities) {
    if (!entity.active) continue;
    const batch = scene.batches.get(entity.visual);
    if (batch === undefined) continue;
    const index = batch.ids.length;
    if (index >= batch.mesh.instanceMatrix.count) continue;
    matrix.makeTranslation(entity.position.x, entity.position.y, entity.position.z);
    batch.mesh.setMatrixAt(index, matrix);
    batch.ids.push(entity.stableId);
    batch.mesh.count = index + 1;
  }

  for (const batch of scene.batches.values()) batch.mesh.instanceMatrix.needsUpdate = true;
}

/**
 * Co scéna umí zvenčí. Plní to `WorldScene`, čte `Viewer` a přes něj
 * `window.__viewer` — jediná cesta, jak se z prohlížeče zeptat skutečného běhu
 * místo jeho napodobeniny.
 */
export interface WorldRunner {
  /** Entity ve světových souřadnicích, v pořadí deklarace a v plné délce. */
  readonly entities: () => readonly ProjectedEntity[];
  /** Kolik tiků svět odkrokoval. */
  readonly tick: () => number;
  /** Posune běh o `count` tiků bez čekání na nástěnný čas. */
  readonly step: (count: number) => void;
  readonly runState: () => RunState;
}

export type RunnerRef = { current: WorldRunner | null };

/**
 * Vstup jednoho tiku.
 *
 * V T2 je to zaznamenaná stopa světa — svět si přehraje vlastního svědka, takže
 * je vidět, že se entity opravdu hýbou. Ovládání hráčem přijde v T3 a nahradí
 * tenhle zdroj vstupem z `src/sim/input.ts`; podpis se kvůli tomu nezmění.
 */
function inputsForTick(trace: readonly TraceInput[], tick: number): TraceInput[] {
  return trace.filter((input) => input.tick === tick);
}

export default function WorldScene({
  world,
  runnerRef,
}: {
  readonly world: WorldDocRuntime;
  /** Plní ho tahle komponenta; čte `Bridge` ve `Viewer.tsx`. */
  readonly runnerRef: RunnerRef;
}) {
  const scene = useMemo(() => buildScene(world), [world]);
  const runtime = useMemo<Runtime>(() => createRuntime(world), [world]);
  const clock = useMemo(() => createClock(), [world]);
  const matrix = useRef(new Matrix4());

  const advance = useMemo(() => {
    const drawFromState = () => {
      const entities = projectEntities(world, entityPlacements(runtime));
      writeInstances(scene, entities, matrix.current);
      return entities;
    };

    return {
      drawFromState,
      run: (count: number) => {
        runTicks(clock, count, (tick) => {
          if (runtime.runState !== 'running') return;
          step(runtime, inputsForTick(world.trace, tick));
        });
        drawFromState();
      },
    };
  }, [clock, runtime, scene, world]);

  // První snímek kreslí výchozí stav, ne prázdno. Bez toho je scéna do prvního
  // tiku prázdná, což vypadá jako vada vykreslení, ne jako svět před startem.
  useEffect(() => {
    advance.drawFromState();
  }, [advance]);

  useEffect(() => {
    runnerRef.current = {
      entities: () => projectEntities(world, entityPlacements(runtime)),
      tick: () => runtime.tick,
      step: (count: number) => advance.run(count),
      runState: () => runtime.runState,
    };
    return () => {
      runnerRef.current = null;
    };
  }, [advance, runnerRef, runtime, world]);

  useEffect(() => () => scene.dispose(), [scene]);

  useFrame((_, delta) => {
    // Jediné čtení nástěnného času v celé scéně, a jeho jediný výstup je celý
    // počet tiků. Zbytek pod tikem zůstává v akumulátoru — dělený tik neexistuje.
    const due = pump(clock, delta * 1000);
    if (due > 0) advance.run(due);
  });

  return <primitive object={scene.group} />;
}

export { elevationOf };
