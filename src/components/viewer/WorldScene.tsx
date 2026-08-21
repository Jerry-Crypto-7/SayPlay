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

import { SCENE_ROLES, pieceById } from '@/kit';
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

import {
  assemblySnapshot,
  createAssemblyLog,
  createAssemblyPlan,
  prefersReducedMotion,
  recordReveal,
  orderForReveal,
  revealRanks,
  revealedInBatch,
  type AssemblySnapshot,
} from './Assembly';
import { planDressing, type DressingKind, type DressingPlan } from './dressing';
import { toonRamp } from './Lighting';
import {
  CELL_SIZE,
  cellToWorld,
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

/**
 * Jedna instancovaná dávka na **id kusu** kitu — ne na kategorii a ne na roli.
 *
 * Podlaha o dvou stech dlaždicích je tak jedno kreslicí volání. Statika sedí na
 * začátku dávky a zapíše se jednou při stavbě; propy se dopisují za ni po
 * každém tiku, protože se s entitou hýbou.
 */
interface KitBatch {
  readonly mesh: InstancedMesh;
  readonly staticCount: number;
  /** O kolik se kus musí zvednout, aby stál na podlaze a ne v ní. */
  readonly lift: number;
  /**
   * Pořadí odhalování instancí téhle dávky v celkovém pořadí stavby, vzestupně.
   * Instance jsou zapsané v témž pořadí, takže odhalená část je předpona dávky.
   */
  readonly ranks: readonly number[];
}

interface BuiltScene {
  readonly group: Group;
  readonly batches: ReadonlyMap<VisualRole, RoleBatch>;
  readonly kit: ReadonlyMap<string, KitBatch>;
  readonly plan: DressingPlan;
  /** Kolik nehybných kusů se celkem odhaluje. Vstup rozvrhu stavby. */
  readonly revealTotal: number;
  readonly dispose: () => void;
}

/** Čtvrtiny otáčky kolem osy Y a posun v jedné matici. */
function place(matrix: Matrix4, yaw: number, x: number, y: number, z: number): Matrix4 {
  matrix.makeRotationY((yaw * Math.PI) / 2);
  matrix.setPosition(x, y, z);
  return matrix;
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
  const plan = planDressing(world);
  const grid = { width: world.ir.limits.gridWidth, height: world.ir.limits.gridHeight };

  // Rovina pod dlaždicemi, ne místo nich. Leží uprostřed jejich tloušťky, takže
  // se s ničím nepere o hloubku a je vidět jen tam, kde by jinak byla díra.
  const floor = new Mesh(
    geometry(new PlaneGeometry(projected.floor.width, projected.floor.depth)),
    material(COLORS.floor),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(projected.floor.center.x, -0.06, projected.floor.center.z);
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

  // Kit má jediný materiál, protože barvu nese geometrie (`vertexColors`).
  // Kdyby ho měl každý kus vlastní, přibyl by materiál na dávku a nic by se tím
  // nezískalo — dávky se stejně nesloučí, každá má jinou geometrii.
  const kitMaterial = material('#ffffff', { vertexColors: true });

  const wornBy = new Map<string, number>();
  for (const piece of Object.values(plan.props)) {
    wornBy.set(piece, (wornBy.get(piece) ?? 0) + 1);
  }

  const kit = new Map<string, KitBatch>();
  const matrix = new Matrix4();

  // Pořadí stavby je globální přes všechny dávky, ne uvnitř každé zvlášť —
  // jinak by se svět stavěl po druzích kusů, ne od středu ven.
  const revealRankOf = revealRanks(plan.statics, grid);

  for (const id of plan.pieces) {
    const piece = pieceById(id);
    // Neznámé id je vada výzdoby, ne stav k vykreslení — a `dressing.ts`
    // vybírá jen z pevných seznamů, takže sem to nemá jak dojít.
    if (piece === undefined) continue;

    const shape = geometry(piece.build());
    shape.computeBoundingBox();
    const box = shape.boundingBox!;
    // Dlaždice se zapouští HORNÍ plochou do nuly — je to ta pochozí rovina, na
    // které stojí všechno ostatní. Zbytek kitu na ní stojí spodkem.
    const lift = -box.min.y;
    const liftOf = (kind: DressingKind) => (kind === 'floor' ? -box.max.y : lift);

    // Instance se zapisují v pořadí odhalování, ne v pořadí plánu. Dávka kreslí
    // instance [0, count), takže odhalená část musí být její předpona.
    const placements = orderForReveal(plan.statics, revealRankOf, (placement) => placement.piece === id);

    const mesh = new InstancedMesh(
      shape,
      kitMaterial,
      placements.length + (wornBy.get(id) ?? 0),
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.name = `kit:${id}`;

    placements.forEach(({ item: placement }, index) => {
      const at = cellToWorld(placement.cell, grid, liftOf(placement.kind));
      mesh.setMatrixAt(index, place(matrix, placement.yaw, at.x, at.y, at.z));
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.count = placements.length;

    kit.set(id, {
      mesh,
      staticCount: placements.length,
      lift,
      ranks: placements.map((entry) => entry.rank),
    });
    group.add(mesh);
  }

  const capacity = Math.max(world.ir.entities.length, world.ir.limits.maxEntities);
  const counts = new Map<VisualRole, number>();
  for (const decl of world.ir.entities) {
    // Entita, která na sobě nese kus kitu, se kreslí v jeho dávce. Do dávky
    // podle role by se pak zapsala podruhé a stála by ve scéně dvakrát.
    if (plan.props[decl.stableId] !== undefined) continue;
    const visual = visualRoleOf(decl.role);
    counts.set(visual, (counts.get(visual) ?? 0) + 1);
  }
  // `spawn` umí za běhu přidat entitu, kterou výzdoba nezná — ta spadne do
  // dávky podle role, takže ta dávka musí existovat i když teď nikoho nemá.
  if (capacity > world.ir.entities.length) {
    counts.set('prop', (counts.get('prop') ?? 0) + 1);
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
    kit,
    plan,
    // Součet dávek, ne délka plánu: kus, který kit nezná, žádnou dávku nedostal
    // a nakreslit se nemá jak — stavba by na něj čekala navždy.
    revealTotal: [...kit.values()].reduce((sum, batch) => sum + batch.staticCount, 0),
    dispose: () => {
      for (const resource of owned) resource.dispose();
      for (const batch of batches.values()) batch.mesh.dispose();
      for (const batch of kit.values()) batch.mesh.dispose();
    },
  };
}

/**
 * Zapíše polohy entit do matic instancí. Volá se po každém tiku, ne každý snímek.
 *
 * Entita s rolí kulisy jde do dávky **svého kusu z kitu**, za jeho nehybnou
 * část; ostatní do dávky podle podoby. Statika se nepřepisuje, jen se za ni
 * dopisuje — proto se počet vrací na `staticCount` a ne na nulu.
 *
 * `revealed` je hranice stavby (viz `Assembly.tsx`): dávka kreslí jen ty své
 * instance, jejichž pořadí je pod ní. **Dokud dávka není odhalená celá, nenese
 * ani kulisovou entitu** — ta se zapisuje až za nehybnou část, tedy na index,
 * který by se v nedostavěné dávce nekreslil, a psát ji na uvolněné místo by
 * přepsalo matici kusu, který se teprve objeví. Po dostavění se scéna chová
 * přesně jako před tím, než stavba existovala.
 */
function writeInstances(
  scene: BuiltScene,
  entities: readonly ProjectedEntity[],
  matrix: Matrix4,
  revealed: number,
): number {
  for (const batch of scene.batches.values()) {
    batch.ids.length = 0;
    batch.mesh.count = 0;
  }
  const built = new Map<string, boolean>();
  let shownTotal = 0;
  for (const [id, batch] of scene.kit) {
    const shown = revealedInBatch(batch.ranks, revealed);
    batch.mesh.count = shown;
    shownTotal += shown;
    built.set(id, shown >= batch.staticCount);
  }

  for (const entity of entities) {
    if (!entity.active) continue;

    const worn = scene.plan.props[entity.stableId];
    // Nedostavěná dávka kulisu nenese — a entita se v tu chvíli nekreslí vůbec.
    // Spadnout zatím do dávky podle role by ji na okamžik ukázalo jako krychli,
    // což je přesně to probliknutí, které má stavba odstranit.
    if (worn !== undefined && scene.kit.has(worn) && built.get(worn) !== true) continue;

    const dressed = worn === undefined ? undefined : scene.kit.get(worn);
    if (dressed !== undefined) {
      const index = dressed.mesh.count;
      if (index >= dressed.mesh.instanceMatrix.count) continue;
      dressed.mesh.setMatrixAt(
        index,
        place(matrix, 0, entity.position.x, dressed.lift, entity.position.z),
      );
      dressed.mesh.count = index + 1;
      continue;
    }

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
  for (const batch of scene.kit.values()) batch.mesh.instanceMatrix.needsUpdate = true;

  // Vrací se, co dávky OPRAVDU kreslí, ne co rozvrh chtěl. Zápisník stavby na
  // tom stojí — viz `recordReveal` v `Assembly.tsx`.
  return shownTotal;
}

/**
 * Co scéna umí zvenčí. Plní to `WorldScene`, čte `Viewer` a přes něj
 * `window.__viewer` — jediná cesta, jak se z prohlížeče zeptat skutečného běhu
 * místo jeho napodobeniny.
 */
export interface DressingBatch {
  /** Id kusu z `KIT`. Každé se v seznamu objeví právě jednou. */
  readonly piece: string;
  /** Kolik instancí dávka právě kreslí — nehybná výzdoba plus kulisové entity. */
  readonly instances: number;
}

export interface WorldRunner {
  /** Entity ve světových souřadnicích, v pořadí deklarace a v plné délce. */
  readonly entities: () => readonly ProjectedEntity[];
  /**
   * Dávky kitu, jedna na id kusu. Jediná cesta, jak se z prohlížeče zeptat, co
   * scéna doopravdy postavila — ze zdrojáku se to spočítat nedá, protože co kde
   * stojí rozhoduje semínko odvozené z konkrétního světa.
   */
  readonly dressing: () => readonly DressingBatch[];
  /** Kolik tiků svět odkrokoval. */
  readonly tick: () => number;
  /**
   * Jak daleko je stavba světa — a hlavně, ve kterém tiku se objevil první a
   * poslední kus. Obojí je **pozorované za běhu**, ne opsané z rozvrhu, takže
   * se z prohlížeče dá poznat rozvrh, který stavbu jen předstírá.
   */
  readonly assembly: () => AssemblySnapshot;
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

  // Rozvrh se čte jednou při stavbě scény. Tlumený pohyb je volba diváka, ne
  // stav, který by se měl uprostřed stavby přepínat.
  const assembly = useMemo(
    () => ({
      plan: createAssemblyPlan(scene.revealTotal, { reducedMotion: prefersReducedMotion() }),
      log: createAssemblyLog(),
    }),
    [scene],
  );

  const advance = useMemo(() => {
    const drawFromState = () => {
      const entities = projectEntities(world, entityPlacements(runtime));
      const shown = writeInstances(
        scene,
        entities,
        matrix.current,
        assembly.plan.revealedAt(clock.tick),
      );
      recordReveal(assembly.log, assembly.plan, clock.tick, shown);
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
  }, [assembly, clock, runtime, scene, world]);

  // První snímek kreslí výchozí stav, ne prázdno. Bez toho je scéna do prvního
  // tiku prázdná, což vypadá jako vada vykreslení, ne jako svět před startem.
  useEffect(() => {
    advance.drawFromState();
  }, [advance]);

  useEffect(() => {
    runnerRef.current = {
      entities: () => projectEntities(world, entityPlacements(runtime)),
      dressing: () =>
        [...scene.kit.entries()].map(([piece, batch]) => ({ piece, instances: batch.mesh.count })),
      tick: () => runtime.tick,
      assembly: () => assemblySnapshot(assembly.log, assembly.plan),
      step: (count: number) => advance.run(count),
      runState: () => runtime.runState,
    };
    return () => {
      runnerRef.current = null;
    };
  }, [advance, assembly, runnerRef, runtime, scene, world]);

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
