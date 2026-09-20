'use client';

/**
 * **`WorldstreamStage` — most z hrubého světa na plátno** (P15 T19b).
 *
 * Do 3. 9. 2026 tahle vrstva chyběla a byla to tatáž vada, jakou měl `src/geom/**`
 * do 25. 8.: hotová, otestovaná, a **nikdo ji nevolal**. `buildProxyWorld()` uměl
 * postavit sloty, `RepresentationRegistry` uměl vyměnit podobu, `RepresentationSlot`
 * uměl slot vykreslit — a mezi „hrubý svět" a „scéna" nevedla jediná čára. Tenhle
 * soubor je ta čára a nic jiného: bere `ProxyWorld`, vyrobí z každé příčky žebříku
 * uzel, **předá ho registry** a nechá `RepresentationSlots` vykreslit, co registry
 * drží.
 *
 * ## Registry je jediné dveře, i pro tu úplně první podobu
 *
 * Nabízí se hrubou podobu připojit rovnou — vždyť ještě není co vyměňovat. Bylo by
 * to špatně: obal se sockety a transformací slotu zakládá `open()`, a podoba
 * pověšená vedle něj by při prvním hot-swapu (`T20`) zůstala viset. Proto sem
 * `.add()` nepatří ani jednou; každý uzel jde do `registry.open(slot, rough)`.
 *
 * ## Materiál na každý slot vlastní, ne jeden sdílený
 *
 * `clayMaterial()` vrací novou instanci schválně a tady se to poprvé vyplácí:
 * `registry.offer()` odloží prohranou podobu přes `disposeSubtree()`, který
 * odloží i její materiál. Kdyby ho sdílelo všech pět slotů, sebral by první
 * hot-swap povrch zbylým čtyřem — a projevilo by se to až u druhé věty, tedy
 * o dvě úlohy dál.
 *
 * ## Co tenhle soubor nedělá
 *
 * Nevolá model, nemešuje a nedrží relaci. Dostane hotový `ProxyWorld` a vrátí
 * scénu. Kdo ten svět vyrobí — dev harness na `/dev/worldstream`, později hlavní
 * cesta (`T21b`) — je jeho věc.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { addAfterEffect, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  Vector3,
  type Object3D,
} from 'three';

import type { RuntimeSnapshot } from '@/worldstream/runtime-controller';
import { canonical } from '@/ir/worlddoc';
import { planRootRepeat, repeatedBounds, type RepeatInstances } from '@/shape/repeat-plan';
import { PALETTES, type Palette } from '@/kit';
import type { MeshResult } from '@/shape/mesh-client';
import type { AnchorSpec, Vec3 } from '@/shape/types';
import { admitMesh, type DetailLevel } from '@/worldstream/mesh-gate';
import type { ProxyRung, ProxySlot, ProxyWorld } from '@/worldstream/proxy';
import { budgetFor, type QualityBudget, type QualityTier } from '@/worldstream/quality';
import { boundsExtent, type SlotTransform } from '@/worldstream/slots';

import { clayMaterial, shadeForRole } from './ClayMaterial';
import { CELL_SIZE } from './projection';
import Materialize, { createRevealPlan, type RevealPlan } from './Materialize';
import { RepresentationSlots } from './RepresentationSlot';
import {
  createRepresentationRegistry,
  slotGroupName,
  slotIdOfNode,
  type RepresentationRegistry,
  type SlotView,
} from './representation';
import { buildPlacementGroup } from './scenery';
import { registerSubtreeDisposer } from './dispose';
import { createAssetLoader } from '@/assets/loader';
import { createAssetCache } from '@/assets/cache';
import { WORLDSTREAM_ASSETS } from '@/assets/catalog';
import { applyRuntimeAppearance } from './runtime-appearance';
import { framePressure,observeVisibility, projectedExtent, selectAssetLod,visibleIntersection } from '@/scene/visibility';
import type { VisualObservation } from '@/scene/visibility-report';
import { surfaceMaterial } from '@/assets/materials';
import {createCutawayController,planCutaway} from './cutaway';
import {createZoneTracker,ZONE_STREAM_POLICY,zoneKey} from '@/scene/zones';
import {assessShapeDetail,type ShapeDetailAssessment} from '@/shape/detail-policy';
import {MESH_DETAIL} from '@/shape/types';
import {createRenderProfiler,type RenderTiming} from './gpu-profile';

const assetLoader = createAssetLoader(WORLDSTREAM_ASSETS);
const assetCache = createAssetCache(assetLoader);

/** Jméno skupiny kulisy. Sonda i testy ji hledají podle něj, ne podle pořadí. */
export const SCENERY_NAME = 'worldstream:scenery';

/** Jméno podoby uvnitř slotu. Předpona je společná, ať přišla z kterékoli příčky. */
export function formName(stableId: string): string {
  return `form:${stableId}`;
}

/**
 * Jméno kandidáta, který se právě odhaluje.
 *
 * **Jiné než `formName()` schválně.** Během odhalení stojí v jednom obalu obě
 * podoby (§13.3) a otázka „je jich tam víc, než má být?" se dá položit jedině
 * tehdy, když se ta dvojice dá od sebe rozeznat po jménu.
 */
export function detailName(stableId: string): string {
  return `detail:${stableId}`;
}

/* ------------------------------------------------------------------ *
 * Příčka žebříku → uzel scény.
 * ------------------------------------------------------------------ */

/** Uzel jedné podoby a účet za to, co si k němu stage drží. */
interface RoughBuild {
  /** `null` znamená slot bez podoby — hlína, která se schválně nekreslí. */
  readonly object: Object3D | null;
  readonly triangles: number;
  readonly dispose: () => void;
}

const NOTHING: RoughBuild = { object: null, triangles: 0, dispose: () => {} };

/**
 * Mesh z workeru → geometrie.
 *
 * Pole se **přebírají, nekopírují**: worker je posílá jako transferable, takže
 * kopie by zaplatila druhou paměť za data, která už nikdo jiný nedrží. Je to
 * tatáž úvaha jako v `normalize.ts`, kde se z téhož důvodu vracejí tatáž pole.
 */
function geometryFromMesh(mesh: MeshResult): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
  geometry.setIndex(new BufferAttribute(mesh.indices, 1));
  return geometry;
}

/**
 * Hlína jako kvádr slotu.
 *
 * `localBounds` je u hlíny vycentrovaný kvádr (`slotFromWorldForm`), takže bedna
 * sedí v počátku prostoru slotu a do světa ji posadí `transform` — stejně jako
 * každou jinou podobu. Žádný posun navíc se tu proto nedělá.
 */
function clayBox(extent: Vec3): BufferGeometry {
  return new BoxGeometry(extent[0], extent[1], extent[2]);
}

function buildRough(entry: ProxySlot, palette: Palette): RoughBuild {
  const name = formName(entry.slot.stableId);

  if (entry.form.kind === 'mesh') {
    const geometry = geometryFromMesh(entry.form.mesh);
    // Odstín nese **role slotu**, ne jeden token hlíny na všechno (P18 T3).
    const material = entry.slot.surface ? surfaceMaterial(entry.slot.surface) : clayMaterial({ color: shadeForRole(entry.slot.role, palette) });
    const mesh = entry.form.repeat ? new InstancedMesh(geometry,material,entry.form.repeat.offsets.length) : new Mesh(geometry, material);
    if(mesh instanceof InstancedMesh)entry.form.repeat!.offsets.forEach((offset,index)=>mesh.setMatrixAt(index,new Matrix4().makeTranslation(...offset)));
    mesh.name = name;
    mesh.castShadow = !material.transparent;
    mesh.receiveShadow = true;
    return {
      object: mesh,
      triangles: entry.form.mesh.triangleCount*(entry.form.repeat?.offsets.length??1),
      dispose: () => {
        if(mesh instanceof InstancedMesh)mesh.dispose();
        geometry.dispose();
        material.dispose();
      },
    };
  }

  if (entry.form.kind === 'placements') {
    // Kusy kitu vezou odstín ve vrcholech a `repaint` je přebarvuje paletou,
    // takže základ musí být bílý s `vertexColors` — jinak se celý řádek
    // kompozice vykreslí jedním odstínem hlíny (past zapsaná u `ClayOverrides`).
    const material = entry.slot.surface ? surfaceMaterial(entry.slot.surface) : clayMaterial({ color: '#ffffff', vertexColors: true });
    const built = buildPlacementGroup(entry.form.placements, palette, material, { name, shadows: !material.transparent });
    built.object.traverse(node=>{
      if(node instanceof Mesh) node.frustumCulled=true;
      if(node instanceof InstancedMesh) node.computeBoundingSphere();
    });
    built.object.castShadow = true;
    return {
      object: built.object,
      triangles: built.triangles,
      dispose: () => {
        // `built.dispose()` je tu **navíc** k úklidu registry, ne místo něj:
        // `disposeSubtree()` projde geometrie a materiály, ale `InstancedMesh`
        // drží ještě matici instancí, kterou uvolní jen `mesh.dispose()`.
        built.dispose();
        material.dispose();
      },
    };
  }

  if (!entry.form.drawn) return NOTHING;

  const geometry = clayBox(boundsExtent(entry.slot.localBounds));
  const material = clayMaterial({ color: shadeForRole(entry.slot.role, palette) });
  const box = new Mesh(geometry, material);
  // Asset bounds are authored in meters and need not be centered on the pivot.
  if (entry.form.kind === 'asset') {
    const { min, max } = entry.slot.localBounds;
    box.position.set(...min.map((value, axis) => (value + max[axis]) / 2) as [number, number, number]);
  }
  box.name = name;
  box.castShadow = true;
  box.receiveShadow = true;
  return {
    object: box,
    triangles: 12,
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}

/* ------------------------------------------------------------------ *
 * Sonda — jediná cesta, jak se z prohlížeče zeptat, co scéna drží.
 * ------------------------------------------------------------------ */

/** Fakta o jednom slotu. **Syrová**, aby si závěr udělal ten, kdo se ptá. */
export type AssetRetryResult = {status:'loaded'|'failed'|'stale'|'unavailable'|'exhausted';stableId:string;reason:string|null};
export type AssetRetryState = {status:'unavailable'|'available'|'running'|'exhausted'|'succeeded';reason:string|null};
export interface StageSlotProbe {
  readonly assetRetry: AssetRetryState;
  readonly asset?: { readonly nodes: readonly string[]; readonly materials: readonly { name: string; transparent: boolean; roughness: number; metalness: number }[] };
  readonly stableId: string;
  readonly objectId: string | null;
  readonly representationId: string | null;
  readonly rung: ProxyRung;
  /** Kolik uzlů `slot:<id>` scéna doopravdy drží. Právě jeden je ta podmínka. */
  readonly groups: number;
  /**
   * Kolik uzlů `form:<id>` je ve scéně a kolik z nich visí **uvnitř vlastního
   * obalu**. Dvě čísla, ne jedno: podoba nakreslená dvakrát a podoba
   * nakreslená vedle svého slotu jsou různé vady a obě vypadají na jednom
   * snímku správně. Kdo obchází registry, se pozná právě tady.
   */
  readonly forms: { readonly total: number; readonly inGroup: number };
  /**
   * Totéž pro kandidáta vyššího detailu. **Během odhalení musí být `1` spolu
   * s `forms`** — §13.3 chce, aby hrubá podoba pod kandidátem zůstala; po
   * commitu je hrubá pryč a zbude sám.
   */
  readonly details: { readonly total: number; readonly inGroup: number };
  /** Má slot připojenou podobu? Nekreslená hlína ji nemá, a je to legitimní. */
  readonly attached: boolean;
  /** Čeká na tomhle slotu kandidát na odhalení? */
  readonly staged: boolean;
  /** Hash připojené podoby. Po commitu je to hash kandidáta, ne hrubé podoby. */
  readonly contentHash: string | null;
  /**
   * Proč se detail nepřipojil — kód brány nebo registry, nikdy volný text.
   * `null` znamená „nic se nepokazilo", ne „nic se nezkoušelo".
   */
  readonly failure: string | null;
  readonly detailAssessment:ShapeDetailAssessment|null;
  readonly samplingAction:{kind:'repeat-instanced'|'unsupported';reason:string}|null;
  readonly internalInstances:number;
  /**
   * Kolik trojúhelníků obal doopravdy kreslí — **čteno ze scény**, ne z účtu
   * pořízeného při stavbě. Během odhalení je to součet obou podob.
   */
  readonly triangles: number;
  readonly transform: SlotTransform;
  readonly anchors: readonly AnchorSpec[];
  /**
   * Kde sockety leží **podle scény** — `getWorldPosition()` na obalu, tedy tak,
   * jak je uvidí kamera. Kdo se ptá, si druhou stranu rovnice spočítá sám
   * z `transform` a `anchors` (`toWorld()` v `slots.ts`); počítat tady obě
   * strany by znamenalo porovnávat výpočet sám se sebou.
   */
  readonly sockets: readonly { readonly name: string; readonly at: Vec3 }[];
}

export interface StageSceneryProbe {
  readonly present: boolean;
  readonly triangles: number;
  readonly drawCalls: number;
  /** Kolik uzlů kulisy scéna drží. Jeden, nebo nula, když kompozici rozebraly sloty. */
  readonly groups: number;
  /**
   * Kolik uzlů slotu nebo podoby visí **uvnitř** kulisy. Musí být nula: kulisa
   * je zbytek kompozice, tedy to, co si nenárokoval nikdo. Kus nakreslený
   * v kulise **i** ve slotu je dvojobraz, který na snímku vypadá jen o něco
   * hustěji, a hot-swap by pak vyměnil polovinu objektu.
   */
  readonly slotNodes: number;
}

/**
 * Úroveň kvality a co proti jejímu rozpočtu **doopravdy stálo** (`T26`).
 *
 * Rozpočet i naměřené jde ven **v jedné odpovědi schválně.** Kdyby si sada
 * rozpočet importovala z `quality.ts` a naměřené brala odsud, porovnávala by
 * dvě čísla, mezi kterými nikdo neručí za to, že popisují touž scénu — stačilo
 * by, aby se svět postavil na jiné úrovni, než si test myslel, a zelená by
 * neznamenala nic.
 *
 * `drawCalls` a `triangles` jsou z `gl.info.render`, tedy **za poslední
 * nakreslený snímek** (`autoReset` je zapnutý). `textures` je z
 * `gl.info.memory`, což je stav, ne snímek.
 */
export interface StageQualityProbe {
  readonly tier: QualityTier;
  readonly budget: QualityBudget;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly textures: number;
  /**
   * **Největší textura scény, měřeno na osu** — jediné číslo, proti kterému se
   * dá strop „2K na osu" z §23 vůbec soudit.
   *
   * `gl.info.memory.textures` je počet, ne velikost, takže rozpočet na osu by
   * se z něj přečíst nedal. Naměřeno 3. 9. 2026: worldstreamová scéna nese
   * čtyři textury, materiály z nich žádnou obrázkovou — velká je **stínová
   * mapa**, a ta je proto to jediné, co texturový stupínek žebříku doopravdy
   * utrácí.
   */
  readonly textureAxis: number;
  /** Kolik slotů doopravdy dostalo vymeshovaný tvar. Proti `budget.heroes`. */
  readonly heroes: number;
  /**
   * Pixel ratio, se kterým renderer doopravdy kreslí — **první stupínek
   * žebříku §23** (`quality.ts`, `DEGRADE_LADDER`).
   *
   * Čte se z rendereru, ne z rozpočtu: rozpočet je horní mez a stroj
   * s `devicePixelRatio` 1 zůstane na 1 i na nejvyšší úrovni. Rozdíl mezi
   * „strop je 2" a „kreslí se na 2" je přesně to, co by se dalo prohlásit
   * omylem.
   */
  readonly pixelRatio: number;
  /**
   * Kolik fragmentů má snímek, tedy plocha kreslicího bufferu v pixelech.
   *
   * **Tohle je ta veličina, kterou pixel ratio doopravdy platí**, a jediná
   * z celé té škály, která nezávisí na ovladači — proto se dá měřit
   * i na softwarovém rendereru, kde je snímková frekvence bezcenná.
   */
  readonly drawingBufferPixels: number;
}

/** Co se právě odhaluje. `null` je stav, ve kterém scéna tráví většinu času. */
export interface StageRevealProbe {
  readonly stableId: string;
  readonly reducedMotion: boolean;
  readonly durationMs: number;
}

export interface StageProbe {
  retryAsset:(stableId:string)=>Promise<AssetRetryResult>;
  measureRender:(count?:number)=>Promise<RenderTiming>;
  streaming:()=>{readonly suspended:readonly string[];readonly acquisitions:number;readonly evictions:number;readonly cacheEntries:number;readonly cameraZone:string};
  assetLoads:()=>readonly import('@/assets/loader').AssetLoadTiming[];
  cutaway:()=>{readonly requested:boolean;readonly active:boolean;readonly height:number|null;readonly architectureIds:readonly string[]};
  visibility: () => readonly VisualObservation[];
  /** Postavila se scéna z hrubého světa? Do té doby jsou ostatní odpovědi prázdné. */
  ready: () => boolean;
  slots: () => readonly StageSlotProbe[];
  scenery: () => StageSceneryProbe;
  /** Běžící odhalení, nebo `null`. */
  reveal: () => StageRevealProbe | null;
  /**
   * Rozvrh **posledního** odhalení, i když už doběhlo.
   *
   * Bez toho se tlumený pohyb nedá doložit: při `reduce` je odhalení hotové
   * v prvním snímku, takže okno, ve kterém `reveal()` něco vrací, nemusí
   * nastat vůbec — a ptát se na něj by byl závod, ne měření.
   */
  lastReveal: () => StageRevealProbe | null;
  /**
   * Kde stojí kamera. Materializace s ní nesmí hnout — detail se má objevit
   * tam, kam se porotce zrovna dívá, ne po přeletu, který mu vezme orientaci.
   */
  camera: () => Vec3;
  /** Kolik odhalení se uzavřelo commitem. Roste jen po úspěchu. */
  commits: () => number;
  /** Kolik snímků plátno vykreslilo. Bez toho se nepozná, že scéna došla na GPU. */
  frames: () => number;
  /**
   * Co renderer **doopravdy** drží — jediný oracle úklidu, jaký z prohlížeče
   * existuje. `disposeSubtree()` umí vrátit poctivý účet a přitom nechat zdroj
   * naživu, protože ho vedle registry drží ještě někdo jiný; tohle číslo čte
   * druhou stranu, tedy GPU.
   *
   * `programs` je tu kvůli **materiálům odhalení**. Každá výměna podoby si
   * vyrobí vlastní `clayMaterial()`, a zapomenutý materiál se v počtu geometrií
   * ani textur neprojeví vůbec — projeví se právě jen tady.
   */
  memory: () => { readonly geometries: number; readonly textures: number; readonly programs: number };
  /**
   * Kolikrát se scéna postavila. **Jediné číslo, které přežije remount**, a
   * proto jediné, kterým jde doložit, že přetočení času reprezentace
   * nepřepočítalo: `memory()` ani `slots()` po přestavbě nic nenamítnou.
   */
  builds: () => number;
  /**
   * Kam se má kliknout, aby paprsek trefil ten objekt — **střed kvádru
   * v pixelech plátna** (`T23`).
   *
   * Bez tohohle by sada musela souřadnice dopočítávat sama z kamery a
   * `worldBounds`, tedy podruhé opsat projekci, kterou stage už umí — a
   * porovnávala by pak výpočet sám se sebou. `null` znamená neznámý slot nebo
   * bod za kamerou.
   */
  screen: (stableId: string) => { readonly x: number; readonly y: number } | null;
  /**
   * Úroveň kvality a účet za ni (`T26`). `null` u odmítnutého světa — tam se
   * nekreslí nic a rozpočet, proti kterému by se to soudilo, by byl výmysl.
   */
  quality: () => StageQualityProbe | null;
}

declare global {
  interface HTMLCanvasElement { __worldstreamStage?:StageProbe }
  interface Window {
    __worldstreamStage?: StageProbe;
    __worldstreamStages?: Record<string,StageProbe>;
  }
}

/**
 * Největší textura ve scéně, na osu.
 *
 * Prochází **celou scénu, ne jen sloty**: stínová mapa visí na světle, tedy
 * mimo `worldstream:stage`, a je to zrovna ta největší. Kdo by se ptal jen
 * uvnitř vlastního podstromu, dostal by nulu a rozpočet by se tvářil, že drží.
 */
function largestTextureAxis(root: Object3D): number {
  let largest = 0;
  root.traverse((node) => {
    const shadow = (node as { shadow?: { mapSize?: { x: number; y: number } } }).shadow;
    if (shadow?.mapSize != null && (node as { castShadow?: boolean }).castShadow === true)
      largest = Math.max(largest, shadow.mapSize.x, shadow.mapSize.y);

    const material = (node as { material?: unknown }).material;
    for (const slot of Array.isArray(material) ? material : [material]) {
      const map = (slot as { map?: { image?: { width?: number; height?: number } } } | undefined)
        ?.map;
      if (map?.image != null) largest = Math.max(largest, map.image.width ?? 0, map.image.height ?? 0);
    }
  });
  return largest;
}

/* ------------------------------------------------------------------ *
 * Stavba.
 * ------------------------------------------------------------------ */

interface StageBuild {
  retryAsset:(id:string,onError:(id:string,reason:string|null)=>void)=>Promise<AssetRetryResult>;
  assetRetryState:(id:string)=>AssetRetryState;
  readonly suspendAsset:(id:string)=>boolean;
  readonly suspended:ReadonlySet<string>;
  readonly streamStats:{acquisitions:number;evictions:number};
  readonly requestAssetLod: (stableId: string, level: number, onError: (id: string, reason: string | null) => void) => () => void;
  readonly assetLevels: ReadonlyMap<string, number>;
  readonly loadAssets: (onError: (id: string, reason: string | null) => void) => () => void;
  readonly reconcile: (world: ProxyWorld, palette: Palette) => void;
  /**
   * Registry, ne jen jeho snímek. Sonda i odhalení se ptají **živě**: `SlotView`
   * je hodnota pořízená v okamžiku stavby, takže po `stage()` a `commit()` už
   * o připojené podobě lhala.
   */
  readonly registry: RepresentationRegistry;
  /** Snímek pro vykreslení. Obaly se nemění, mění se jen jejich obsah. */
  readonly views: readonly SlotView[];
  readonly rungs: ReadonlyMap<string, ProxyRung>;
  readonly triangles: ReadonlyMap<string, number>;
  readonly slots: readonly ProxySlot[];
  readonly scenery: Group | null;
  /** Co kulisa stála. Zbytek sondy se čte ze scény, ne ze stavby. */
  readonly sceneryCost: Omit<StageSceneryProbe, 'groups' | 'slotNodes'>;
  readonly socketWorld: (stableId: string, name: string) => Vec3 | null;
  readonly dispose: () => void;
}

/**
 * Kolikrát se scéna postavila od načtení stránky — **modulová proměnná
 * schválně** (P15 T24).
 *
 * Ref uvnitř komponenty by se s ní odmountoval, a přesně to je případ, který má
 * tohle číslo chytit: přestavba scény vrátí tytéž počty geometrií i tytéž hashe
 * podob, protože stará se odloží a nová vznikne. Počty tedy „nic se nezměnilo"
 * potvrdí i po úplném přepočtu — naměřeno mutací 3. 9. 2026, která scénu při
 * každém přetočení času remountovala a sadu nechala zelenou.
 */
let stageBuilds = 0;

export function buildStage(world: ProxyWorld, palette: Palette, assets: Pick<typeof assetCache, 'acquire'> = assetCache): StageBuild {
  stageBuilds += 1;
  const registry = createRepresentationRegistry();
  const rungs = new Map<string, ProxyRung>();
  const triangles = new Map<string, number>();
  const previous = new Map<string, ProxySlot>();
  const assetLevels = new Map<string, number>();
  const suspended=new Set<string>();
  const streamStats={acquisitions:0,evictions:0};
  type AssetRequest={entry:ProxySlot;level:number;cancelled:boolean;failure:string|null;done:Promise<AssetRetryResult>;finish:(result:AssetRetryResult)=>void};
  const requests = new Map<string, AssetRequest>();
  const retryAttempts=new Map<string,{key:string;state:AssetRetryState}>();
  const entryKey=(entry:ProxySlot)=>canonical({slot:entry.slot,reference:entry.form.kind==='asset'?entry.form.reference:null});
  const cancelRequest=(id:string)=>{const request=requests.get(id);if(request){request.cancelled=true;request.finish({status:'stale',stableId:id,reason:'Accepted representation changed or request was cancelled.'});}};
  let disposed = false;
  let activeWorld = world;
  let activePalette: Palette | null = null;
  let scenery: Group | null = null;
  let sceneryCost: StageBuild['sceneryCost'] = { present: false, triangles: 0, drawCalls: 0 };
  let sceneryKey = '';
  let disposeScenery = () => {};
  const reconcile = (next: ProxyWorld, nextPalette: Palette) => {
    const slots = next.kind === 'built' ? next.slots : [];
    const replacements = new Map<string, RoughBuild>();
    const nextScenery = next.kind === 'built' ? next.scenery : [];
    const nextSceneryKey = canonical({ scenery: nextScenery, palette: nextPalette });
    let preparedScenery: ReturnType<typeof buildPlacementGroup> | null = null;
    let sceneryMaterial: ReturnType<typeof clayMaterial> | null = null;
    try {
      for (const entry of slots) {
        const old = previous.get(entry.slot.stableId);
        const onlyAssetLod = old?.form.kind === 'asset' && entry.form.kind === 'asset' && canonical(old.slot) === canonical(entry.slot) && canonical(old.form.reference) === canonical(entry.form.reference);
        if (!onlyAssetLod && (!old || activePalette !== nextPalette || !sameProxySlot(old, entry)))
          replacements.set(entry.slot.stableId, buildRough(entry, nextPalette));
      }
      if (nextSceneryKey !== sceneryKey && nextScenery.length) {
        sceneryMaterial = clayMaterial({ color: '#ffffff', vertexColors: true });
        preparedScenery = buildPlacementGroup(nextScenery, nextPalette, sceneryMaterial, { name: SCENERY_NAME });
      }
    } catch (error) {
      replacements.forEach(rough => rough.dispose()); preparedScenery?.dispose(); sceneryMaterial?.dispose(); throw error;
    }
    for (const id of previous.keys()) if (!slots.some(entry => entry.slot.stableId === id)) {
      cancelRequest(id);retryAttempts.delete(id);registry.remove(id); previous.delete(id); rungs.delete(id); triangles.delete(id); assetLevels.delete(id); requests.delete(id);suspended.delete(id);
    }
    for (const entry of slots) {
      const id = entry.slot.stableId;
      const rough = replacements.get(id);
      if (rough) {
        suspended.delete(id);
        registry.replaceRough(entry.slot, rough.object);
        rungs.set(id, entry.form.rung); triangles.set(id, rough.triangles);
      }
      if(previous.get(id)!==entry)cancelRequest(id);
      if(retryAttempts.get(id)?.key!==entryKey(entry))retryAttempts.delete(id);
      previous.set(id, entry);
    }
    if (nextSceneryKey !== sceneryKey) {
      scenery?.removeFromParent(); disposeScenery();
      scenery = preparedScenery?.object ?? null;
      sceneryCost = preparedScenery ? { present: true, triangles: preparedScenery.triangles, drawCalls: preparedScenery.drawCalls }
        : { present: false, triangles: 0, drawCalls: 0 };
      disposeScenery = () => { preparedScenery?.dispose(); sceneryMaterial?.dispose(); };
      sceneryKey = nextSceneryKey;
    }
    activeWorld = next; activePalette = nextPalette;
  };
  reconcile(world, palette);
  const requestAssetLod: StageBuild['requestAssetLod'] = (id, level, onError) => {
    const entry=previous.get(id);
    if (!entry || entry.form.kind !== 'asset') return () => {};
    const {reference}=entry.form;
    const view=registry.view(id);
    const resolved=WORLDSTREAM_ASSETS.resolve(reference);
    const targetHash=resolved.ok?resolved.asset.lods.find(lod=>lod.level===level)?.hash:undefined;
    if (!view || !targetHash) return () => {};
    const old=requests.get(id);
    if(old&&retryAttempts.get(id)?.state.status==='running'&&!old.cancelled)return ()=>{};
    if (old && old.entry===entry && old.level===level && !old.cancelled) return () => {};
    if(old) cancelRequest(id);
    if(view.contentHash===targetHash) {assetLevels.set(id,level);requests.delete(id);return () => {};}
    let finish!:(result:AssetRetryResult)=>void;
    const done=new Promise<AssetRetryResult>(resolve=>{finish=resolve;});
    const request:AssetRequest={entry,level,cancelled:false,failure:null,done,finish};requests.set(id,request);
    suspended.delete(id);streamStats.acquisitions++;
    const revision=view.revision;
    onError(id,null);
    void assets.acquire(reference,level).then(lease=>{
      if(request.cancelled || disposed || previous.get(id)!==entry) {lease.release();finish({status:'stale',stableId:id,reason:'Accepted representation changed.'});return;}
      lease.object.name=formName(id);
      lease.object.traverse(node=>{
        if(!(node instanceof Mesh)) return;
        const materials=Array.isArray(node.material)?node.material:[node.material];
        node.castShadow=materials.every(material=>!material.transparent);node.receiveShadow=true;
      });
      registerSubtreeDisposer(lease.object,lease.release);
      const offered=registry.offer({stableId:id,revision,object:lease.object,bounds:entry.slot.localBounds,contentHash:lease.hash});
      if(offered.ok) {rungs.set(id,'g3-ready');triangles.set(id,lease.triangles);assetLevels.set(id,level);finish({status:'loaded',stableId:id,reason:null});}
      else {onError(id,offered.refusal);finish({status:offered.refusal==='STALE_REVISION'?'stale':'failed',stableId:id,reason:offered.refusal});}
    }).catch(error=>{
      if(!request.cancelled && !disposed && previous.get(id)===entry) {
        request.failure=error instanceof Error?error.message:'Asset loading failed';onError(id,request.failure);
        finish({status:'failed',stableId:id,reason:request.failure});
      }else finish({status:'stale',stableId:id,reason:'Accepted representation changed.'});
    });
    return ()=>{request.cancelled=true;finish({status:'stale',stableId:id,reason:'Request cancelled.'});};
  };
  const assetRetryState:StageBuild['assetRetryState']=(id)=>{
    const entry=previous.get(id),view=registry.view(id),request=requests.get(id);
    if(disposed||!entry||entry.form.kind!=='asset'||!view||suspended.has(id))return {status:'unavailable',reason:null};
    const attempted=retryAttempts.get(id);
    if(attempted?.key===entryKey(entry))return attempted.state;
    if(view.contentHash===null&&request?.entry===entry&&!request.cancelled&&request.failure)return {status:'available',reason:request.failure};
    return {status:'unavailable',reason:null};
  };
  return {
    assetRetryState,
    async retryAsset(id,onError){
      const state=assetRetryState(id),entry=previous.get(id),failed=requests.get(id);
      if(state.status!=='available'||!entry||!failed)return {status:state.status==='unavailable'?'unavailable':'exhausted',stableId:id,reason:state.reason};
      const attempt={key:entryKey(entry),state:{status:'running',reason:null} as AssetRetryState};retryAttempts.set(id,attempt);
      // Explicit retry alone evicts the failed deduplication token; normal LOD
      // checks must not create an automatic retry loop after transport failure.
      cancelRequest(id);requests.delete(id);
      requestAssetLod(id,failed.level,onError);
      const request=requests.get(id);
      const result:AssetRetryResult=request?await request.done:{status:'unavailable',stableId:id,reason:'Accepted asset unavailable.'};
      if(retryAttempts.get(id)===attempt)attempt.state={status:result.status==='loaded'?'succeeded':'exhausted',reason:result.reason};
      return result;
    },
    suspendAsset(id) {
      const entry=previous.get(id),view=registry.view(id);
      if(!entry||entry.form.kind!=='asset'||entry.slot.importance>=3||entry.slot.role==='hero'||!view||suspended.has(id))return false;
      cancelRequest(id);requests.delete(id);
      const rough=buildRough(entry,activePalette??palette);
      const position=view.group.position.clone(),quaternion=view.group.quaternion.clone(),scale=view.group.scale.clone();
      registry.replaceRough(entry.slot,rough.object);
      view.group.position.copy(position);view.group.quaternion.copy(quaternion);view.group.scale.copy(scale);
      rungs.set(id,'semantic-clay');triangles.set(id,rough.triangles);assetLevels.delete(id);suspended.add(id);streamStats.evictions++;
      return true;
    },
    suspended,streamStats,
    loadAssets(onError) {
      const cancel: (()=>void)[]=[];
      for (const entry of previous.values()) {
        if (entry.form.kind !== 'asset') continue;
        if(suspended.has(entry.slot.stableId))continue;
        cancel.push(requestAssetLod(entry.slot.stableId,entry.form.level,onError));
      }
      return () => {cancel.forEach(stop=>stop());};
    },
    requestAssetLod,
    assetLevels,
    reconcile,
    registry,
    get views() { return registry.slots; },
    rungs,
    triangles,
    get slots() { return activeWorld.kind === 'built' ? activeWorld.slots : []; },
    get scenery() { return scenery; },
    get sceneryCost() { return sceneryCost; },
    socketWorld: (stableId, name) => registry.socketWorld(stableId, name),
    dispose: () => {
      disposed = true;
      for(const id of requests.keys())cancelRequest(id);
      registry.dispose();
      if (scenery !== null) scenery.removeFromParent();
      disposeScenery(); previous.clear();
    },
  };
}

/** Ignore meshing wall time; compare actual render input, including typed buffers. */
function sameProxySlot(a: ProxySlot, b: ProxySlot): boolean {
  if (a === b) return true;
  if (canonical(a.slot) !== canonical(b.slot) || a.form.kind !== b.form.kind) return false;
  if (a.form.kind === 'mesh' && b.form.kind === 'mesh') {
    const left = a.form.mesh, right = b.form.mesh;
    return canonical(a.form.repeat??null)===canonical(b.form.repeat??null) && a.form.resolution === b.form.resolution && left.shapeId === right.shapeId &&
      canonical(left.bounds) === canonical(right.bounds) && left.vertexCount === right.vertexCount && left.triangleCount === right.triangleCount &&
      (['positions', 'normals', 'indices'] as const).every(key => left[key].length === right[key].length &&
        left[key].every((value, index) => value === right[key][index]));
  }
  return canonical(a.form) === canonical(b.form);
}

/* ------------------------------------------------------------------ *
 * Komponenta.
 * ------------------------------------------------------------------ */

/**
 * Vyšší detail pro jeden slot, hotový mesh.
 *
 * Nese `contentHash` **od volajícího**, ne spočítaný tady: hash se skládá
 * z programu a rozlišení (`shapeContentHash()`), a program má ten, kdo mesh
 * objednal. Kdyby si ho stage počítala z výsledku, nebyl by to otisk zadání,
 * ale otisk toho, co z něj vylezlo — a kontrolní přečtení §13.3 by pak
 * porovnávalo mesh sám se sebou.
 */
export interface DetailUpgrade {
  readonly repeat?: RepeatInstances;
  readonly stableId: string;
  readonly contentHash: string;
  readonly level: DetailLevel;
  readonly mesh: MeshResult;
}

/** Validate unit geometry and the exact original-program instance plan before GPU allocation. */
export function admitDetailUpgrade(entry:ProxySlot,upgrade:DetailUpgrade) {
  const preserve=entry.form.kind==='mesh'&&!!entry.form.repeat;
  const plan=entry.detailProgram?planRootRepeat(entry.detailProgram,MESH_DETAIL[upgrade.level].resolution,preserve):null;
  if((preserve&&!upgrade.repeat)||(upgrade.repeat&&(plan?.kind!=='repeat-instanced'||canonical(plan.instances)!==canonical(upgrade.repeat))))
    return {ok:false as const,rejection:'REPEAT_PLAN_MISMATCH'};
  const verdict=admitMesh(upgrade.mesh,{bounds:upgrade.repeat?.unitBounds??entry.slot.localBounds,level:upgrade.level});
  if(!verdict.ok)return verdict;
  const triangles=upgrade.mesh.triangleCount*(upgrade.repeat?.offsets.length??1);
  if(triangles>MESH_DETAIL[upgrade.level].maxTriangles)return {ok:false as const,rejection:'TRIANGLE_BUDGET'};
  return {ok:true as const,triangles,bounds:upgrade.repeat?repeatedBounds(verdict.bounds,upgrade.repeat):verdict.bounds};
}

interface Reveal {
  readonly stableId: string;
  readonly object: Object3D;
  readonly plan: RevealPlan;
}

export interface WorldstreamStageProps {
  readonly cutaway?:boolean;
  readonly adaptiveAssets?: boolean;
  readonly runtimeState?: RuntimeSnapshot | null;
  readonly world: ProxyWorld;
  /** Called after this world's first completed renderer pass, not GPU scanout. */
  readonly onPresented?: (world: ProxyWorld) => void;
  /**
   * Paleta kusů kompozice.
   *
   * Výchozí je `harbor` a je to **provizorium, ne volba**: barvu má nakonec
   * určit `world.look`, který popsal model, a to je práce výtvarného systému
   * (fáze 2). Do té doby je jedna deklarovaná paleta lepší než odstín napsaný
   * do materiálu, protože ji jde vyměnit na jednom místě.
   */
  readonly palette?: Palette;
  /**
   * Detail, který má nahradit hrubou podobu jednoho slotu.
   *
   * Je to **prop, ne callback**, aby zdroj detailu zůstal venku: dneska ho
   * vyrábí dev harness ze svého meshovače, po `T21b` poteče ze SSE proudu
   * relace. Stage se v obou případech chová stejně — projde branou, připojí
   * neviditelně, odhalí, commitne.
   */
  readonly upgrade?: DetailUpgrade | null;
  /**
   * Vybraný objekt (`T23`). Stav drží volající, protože na něm visí i druhá
   * věta — stage jen kreslí a hlásí trefu.
   */
  readonly selected?: string | null;
  /**
   * Porotce klikl do světa. `null` znamená „vedle", tedy do kulisy nebo do
   * prázdna, a je to platná odpověď: výběr se tím ruší.
   */
  readonly onSelect?: (stableId: string | null) => void;
  /**
   * Uzel popisku, kterému stage každý snímek přepisuje polohu.
   *
   * Ref, ne prop se souřadnicí: souřadnice se mění každý snímek a `setState`
   * by překreslil celou skořápku šedesátkrát za vteřinu. Proč to nekreslí
   * `<Html>` z drei ani sprite ve scéně, je v `ObjectLabel.tsx`.
   */
  readonly labelAnchor?: RefObject<HTMLDivElement | null>;
}

export default function WorldstreamStage({
  world,
  runtimeState = null,
  adaptiveAssets = runtimeState !== null,
  cutaway = true,
  palette = PALETTES.harbor,
  upgrade = null,
  selected = null,
  onSelect,
  onPresented,
  labelAnchor,
}: WorldstreamStageProps): React.ReactElement {
  const [build] = useState(() => buildStage(world, palette));
  useFrame(() => {
    if (!runtimeState) return;
    for (const { slot } of build.slots) {
      const view = build.views.find(entry => entry.stableId === slot.stableId);
      if (view) applyRuntimeAppearance(view.group, slot, runtimeState);
    }
  });
  const reconciled = useRef({ world, palette });
  const [, setBuildRevision] = useState(0);
  useLayoutEffect(() => {
    if (reconciled.current.world === world && reconciled.current.palette === palette) return;
    if (pending.current) build.registry.abandon(pending.current);
    pending.current = null; setReveal(null);
    build.reconcile(world, palette);
    reconciled.current = { world, palette };
    setBuildRevision(value => value + 1);
  }, [build, world, palette]);
  // Transform je absolutní od autorské kotvy; opakovaný render nesčítá posun.
  useLayoutEffect(() => {
    if (runtimeState === null) return;
    for (const entity of runtimeState.entities) {
      const slot = build.slots.find(({ slot }) =>
        (slot.binding ? slot.binding.entityId : slot.stableId) === entity.stableId)?.slot;
      const view = build.views.find((candidate) => candidate.stableId === slot?.stableId);
      if (!view || !slot) continue;
      const origin = slot.transform.translation;
      view.group.position.set(origin[0] + entity.dx * CELL_SIZE, origin[1], origin[2] + entity.dy * CELL_SIZE);
      view.group.visible = entity.active;
      view.group.userData.runtime = entity;
    }
  }, [build, runtimeState, world]);
  const frames = useRef(0);
  const commits = useRef(0);
  const failures = useRef(new Map<string, string>());
  const detailResolutions=useRef(new Map<string,{hash:string;resolution:number}>());
  useEffect(() => build.loadAssets((id, reason) => {
    if (reason === null) failures.current.delete(id);
    else failures.current.set(id, reason);
  }), [build, world, palette]);
  /**
   * Slot, jehož odhalení běží a ještě se neuzavřelo. Jedna hodnota, kterou vidí
   * i `finishReveal` — bez ní by se commit dal spustit dvakrát, viz tam.
   */
  const pending = useRef<string | null>(null);
  const lastReveal = useRef<StageRevealProbe | null>(null);
  const [root, setRoot] = useState<Object3D | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const camera = useThree((state) => state.camera);
  const scene = useThree((state) => state.scene);
  const gl = useThree((state) => state.gl);
  const profiler=useMemo(()=>createRenderProfiler(gl),[gl]);
  useEffect(()=>()=>profiler.dispose(),[profiler]);
  const size = useThree((state) => state.size);
  const [cutawayController]=useState(createCutawayController);
  const cutawayPlan=useMemo(()=>planCutaway(world),[world]);
  useLayoutEffect(()=>{
    const previous=gl.localClippingEnabled;gl.localClippingEnabled=true;
    return ()=>{cutawayController.dispose();gl.localClippingEnabled=previous;};
  },[gl,cutawayController]);
  useFrame(()=>{
    const ids=cutaway&&cutawayPlan?new Set(cutawayPlan.architectureIds):new Set<string>();
    cutawayController.update(build.views.filter(view=>ids.has(view.stableId)).map(view=>view.group),cutaway&&cutawayPlan?cutawayPlan.height:null);
  });
  const lastLodCheck = useRef(-Infinity);
  const [zones]=useState(createZoneTracker);
  useEffect(()=>{
    if(adaptiveAssets)return;
    for(const entry of build.slots)if(entry.form.kind==='asset'&&build.suspended.has(entry.slot.stableId))
      build.requestAssetLod(entry.slot.stableId,entry.form.level,(id,reason)=>{if(reason===null)failures.current.delete(id);else failures.current.set(id,reason);});
  },[adaptiveAssets,build]);
  useFrame(({clock})=>{
    if(!adaptiveAssets || clock.elapsedTime-lastLodCheck.current<ZONE_STREAM_POLICY.intervalSeconds) return;
    lastLodCheck.current=clock.elapsedTime;
    zones.prune(new Set(build.slots.map(entry=>entry.slot.stableId)));
    // Účet za poslední snímek, ne konstanta: renderer ho sám nuluje na začátku
    // každého snímku, takže je to cena té scény, na kterou se teď někdo dívá.
    const pressure=framePressure({drawCalls:gl.info.render.calls,triangles:gl.info.render.triangles});
    for(const entry of build.slots) {
      if(entry.form.kind!=='asset') continue;
      const view=build.registry.view(entry.slot.stableId),resolved=WORLDSTREAM_ASSETS.resolve(entry.form.reference);
      if(!view || !resolved.ok) continue;
      const projection=projectedExtent(entry.slot.localBounds,view.group,camera,size.width,size.height);
      const decision=zones.decide({id:entry.slot.stableId,importance:entry.slot.role==='hero'?3:entry.slot.importance,distance:projection.box.distanceToPoint(camera.position),inFrame:projection.inFrame,suspended:build.suspended.has(entry.slot.stableId),now:clock.elapsedTime,pressure});
      if(decision==='suspend')build.suspendAsset(entry.slot.stableId);
      if(decision!=='resume'&&build.suspended.has(entry.slot.stableId))continue;
      const level=selectAssetLod(resolved.asset.lods,projection.screenPixels,entry.slot.importance,build.assetLevels.get(entry.slot.stableId)??null,pressure);
      build.requestAssetLod(entry.slot.stableId,level,(id,reason)=>{if(reason===null)failures.current.delete(id);else failures.current.set(id,reason);});
    }
  });
  const presentation = useRef({ world, onPresented });
  const presented = useRef(new WeakSet<ProxyWorld>());
  const pendingPresentation = useRef<{ world: ProxyWorld; frame: number; rendererFrame: number } | null>(null);
  useLayoutEffect(() => {
    presentation.current = { world, onPresented };
    pendingPresentation.current = null;
  }, [world, onPresented]);
  useLayoutEffect(() => {
    // Installed R3F calls global after-effects after all roots' gl.render().
    // A per-stage candidate plus this renderer's counter excludes callbacks
    // caused solely by another Canvas, skipped renders or a lost GL context.
    const remove = addAfterEffect(() => {
      const candidate = pendingPresentation.current;
      pendingPresentation.current = null;
      if (!candidate || candidate.frame !== frames.current || gl.info.render.frame <= candidate.rendererFrame) return;
      const current = presentation.current;
      if (candidate.world !== current.world || candidate.world !== reconciled.current.world || presented.current.has(candidate.world)) return;
      if (!current.onPresented) return;
      presented.current.add(candidate.world);
      current.onPresented(candidate.world);
    });
    return () => { remove(); pendingPresentation.current = null; };
  }, [gl]);
  /** Škrábací vektor projekce. `project()` mutuje, takže se nealokuje po snímcích. */
  const projected = useMemo(() => new Vector3(), []);

  useEffect(() => build.dispose, [build]);

  /**
   * Kde objekt leží na obrazovce, v CSS pixelech plátna.
   *
   * `height` volí výšku uvnitř kvádru: **popisek chce vrch** (`1`), protože
   * počátek slotu leží u většiny objektů na podlaze a popisek by visel uvnitř
   * hmoty; **paprsek chce střed** (`0.5`), protože vrch kvádru je bod nad
   * povrchem a kliknutí do něj by objekt minulo. Jeden výpočet pro obojí, aby
   * se popisek a trefa nemohly rozejít.
   *
   * `null` znamená „neznámý slot, nebo bod za kamerou". Po `project()` je bod
   * za kamerou `z > 1` a bez té podmínky by se zrcadlil na druhou stranu
   * obrazovky a ukazoval na nic.
   */
  const toScreen = useCallback(
    (stableId: string, height: number): { readonly x: number; readonly y: number } | null => {
      const entry = build.slots.find((candidate) => candidate.slot.stableId === stableId);
      if (entry === undefined) return null;

      const group = build.registry.view(stableId)?.group;
      if (group?.visible === false) return null;
      const origin = entry.slot.transform.translation;
      const dx = (group?.position.x ?? origin[0]) - origin[0];
      const dz = (group?.position.z ?? origin[2]) - origin[2];
      const { min, max } = entry.slot.worldBounds;
      projected.set(
        (min[0] + max[0]) / 2 + dx,
        min[1] + (max[1] - min[1]) * height,
        (min[2] + max[2]) / 2 + dz,
      );
      projected.project(camera);
      if (projected.z > 1) return null;

      return {
        x: (projected.x * 0.5 + 0.5) * size.width,
        y: (-projected.y * 0.5 + 0.5) * size.height,
      };
    },
    [build, projected, camera, size],
  );

  useFrame((state) => {
    frames.current += 1;
    const current = presentation.current;
    // Do not claim an automatic pass if another subscriber owns rendering.
    pendingPresentation.current = root?.parent && !state.internal.priority && current.onPresented && !presented.current.has(current.world)
      ? { world: current.world, frame: frames.current, rendererFrame: gl.info.render.frame } : null;

    const node = labelAnchor?.current ?? null;
    if (node === null) return;

    const at = selected === null ? null : toScreen(selected, 1);
    if (at === null) {
      node.style.visibility = 'hidden';
      return;
    }

    node.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, -100%)`;
    node.style.visibility = 'visible';
  });

  /**
   * Trefa paprsku → `stableId`.
   *
   * `slotIdOfNode()` leze od trefeného meshe **nahoru k obalu**, takže jméno
   * podoby (`form:` / `detail:`) se do výběru nedostane ani omylem — a to je
   * celý smysl: podoba se vymění, slot zůstane. Kulisa žádný obal nad sebou
   * nemá, takže vrátí `null` a výběr se zruší, což je správná odpověď na
   * kliknutí do pozadí.
   */
  const pick = useCallback(
    (event: ThreeEvent<MouseEvent>) => {
      // Bez toho by jedno kliknutí ohlásilo tolik treb, kolik jich paprsek
      // protne, a poslední (nejvzdálenější) by přepsala tu, na kterou porotce
      // ukázal.
      event.stopPropagation();
      const hit=event.intersections.find(visibleIntersection);
      onSelect?.(hit?slotIdOfNode(hit.object):null);
    },
    [onSelect],
  );

  /**
   * Kliknutí, které netrefilo scénu vůbec. Ruší výběr stejně jako kulisa.
   *
   * ⚠ **Nefiltruje se, odkud ten klik přišel, a je to naměřené rozhodnutí.**
   * Napsala se sem nejdřív podmínka „jen když je cíl `<canvas>`", protože se
   * čekalo, že tlačítka skořápky (`Apply`, `Change it`) budou hlášená jako
   * netrefa a zrušila by výběr, kvůli kterému ten panel vůbec stojí. Mutace
   * 3. 9. 2026 tu podmínku vyhodila a **celá sada `worldstream-refine` zůstala
   * zelená**: R3F posílá `onPointerMissed` jen za kliky na samotné plátno, ne
   * za kliky do DOM nad ním. Podmínka tedy nechránila před ničím, a nechat ji
   * tu by znamenalo řádek, který nejde otestovat, protože nejde spustit.
   * Že výběr přežije `Apply`, drží připíchnuté ta sada.
   */
  const miss = useCallback(() => {
    onSelect?.(null);
  }, [onSelect]);

  useEffect(() => {
    if (upgrade === null) return;

    const entry = build.slots.find((candidate) => candidate.slot.stableId === upgrade.stableId);
    const view = build.registry.view(upgrade.stableId);
    if (entry === undefined || view === null) {
      failures.current.set(upgrade.stableId, 'UNKNOWN_SLOT');
      return;
    }

    // **Brána první, uzel až potom.** Kdyby se mesh nejdřív zabalil do `Mesh`
    // a teprve pak soudil, drží odmítnutý artefakt geometrii na GPU po celou
    // dobu, než ho někdo odloží — a odmítnutých je na failure cestách většina.
    const verdict = admitDetailUpgrade(entry,upgrade);
    if (!verdict.ok) {
      failures.current.set(upgrade.stableId, verdict.rejection);
      return;
    }

    const geometry = geometryFromMesh(upgrade.mesh);
    // Týž odstín jako hrubá podoba (P18 T3). Bez toho by objekt při výměně
    // podoby přeskočil ze své barvy zpátky na hlínu — §13.2 chce, aby výměnu
    // přežila identita, a barva je to, podle čeho ji porotce pozná.
    const material = entry.slot.surface ? surfaceMaterial(entry.slot.surface) : clayMaterial({ color: shadeForRole(entry.slot.role, palette) });
    const detail = upgrade.repeat ? new InstancedMesh(geometry,material,upgrade.repeat.offsets.length) : new Mesh(geometry, material);
    if(detail instanceof InstancedMesh)upgrade.repeat!.offsets.forEach((offset,index)=>detail.setMatrixAt(index,new Matrix4().makeTranslation(...offset)));
    detail.name = detailName(upgrade.stableId);
    detail.castShadow = !material.transparent;
    detail.receiveShadow = true;

    // Odmítnutého kandidáta odloží `stage()` sama, na každé ze svých cest.
    const staged = build.registry.stage({
      stableId: upgrade.stableId,
      revision: view.revision,
      contentHash: upgrade.contentHash,
      bounds: verdict.bounds,
      object: detail,
    });
    if (!staged.ok) {
      failures.current.set(upgrade.stableId, staged.refusal);
      return;
    }

    failures.current.delete(upgrade.stableId);
    detailResolutions.current.set(upgrade.stableId,{hash:upgrade.contentHash,resolution:MESH_DETAIL[upgrade.level].resolution});
    pending.current = upgrade.stableId;
    const plan = createRevealPlan();
    lastReveal.current = {
      stableId: upgrade.stableId,
      reducedMotion: plan.reducedMotion,
      durationMs: plan.durationMs,
    };
    setReveal({ stableId: upgrade.stableId, object: detail, plan });
  }, [upgrade, build, palette]);

  /**
   * §13.3 bod 6. **Nezavírá se přes updater `setReveal`**, protože commit je
   * vedlejší účinek a React updater může proběhnout dvakrát (StrictMode) —
   * druhý commit by na tomtéž slotu nenašel kandidáta a zapsal by `failure`
   * o vadě, která se nestala. Rozhoduje `pending`, tedy jedna hodnota, kterou
   * vidí obě strany.
   */
  const finishReveal = useCallback(() => {
    const stableId = pending.current;
    if (stableId === null) return;
    pending.current = null;

    const outcome = build.registry.commit(stableId);
    if (outcome.ok) commits.current += 1;
    else failures.current.set(stableId, outcome.refusal);
    setReveal(null);
  }, [build]);

  useEffect(() => {
    /**
     * Kolikrát scéna drží uzel toho jména — a kolikrát pod daným předkem.
     *
     * Počítá se **procházením scény**, ne dotazem do registry: registry ví, co
     * vydal, a otázka zní, co je na plátně. Dvojí připojení téhož uzlu by se
     * z registry nepoznalo, protože ten drží jednu položku na slot.
     */
    const count = (name: string, under: Object3D | null): number => {
      let found = 0;
      under?.traverse((object) => {
        if (object.name === name) found += 1;
      });
      return found;
    };

    /**
     * Kolik trojúhelníků ten podstrom doopravdy kreslí.
     *
     * **Čte se ze scény, ne z účtu pořízeného při stavbě** — a je to oprava
     * naměřené vady: dokud se hlásilo číslo ze stavby, hlásil slot po výměně
     * podoby pořád počet **hrubé** podoby, takže `e2e` na jemnější mřížku
     * viděla stejné číslo a nemohla poznat, jestli se vyměnilo cokoli.
     *
     * Během odhalení je to součet obou podob a je to správně: v tu chvíli se
     * obě opravdu kreslí.
     */
    const trianglesUnder = (under: Object3D | null): number => {
      let total = 0;
      under?.traverse((object) => {
        const geometry = (object as { geometry?: BufferGeometry }).geometry;
        if (geometry === undefined) return;
        const count = geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0;
        const instances = (object as { isInstancedMesh?: boolean; count?: number }).isInstancedMesh
          ? ((object as { count?: number }).count ?? 1)
          : 1;
        total += (count / 3) * instances;
      });
      return total;
    };

    const groupNamed = (name: string): Object3D | null => {
      let found: Object3D | null = null;
      root?.traverse((object) => {
        if (object.name === name && found === null) found = object;
      });
      return found;
    };

    const probe:StageProbe = {
      retryAsset:(id)=>build.retryAsset(id,(stableId,reason)=>{if(reason===null)failures.current.delete(stableId);else failures.current.set(stableId,reason);}),
      measureRender:profiler.measure,
      streaming:()=>({suspended:[...build.suspended],...build.streamStats,cacheEntries:assetCache.size,cameraZone:zoneKey(camera.position.toArray())}),
      assetLoads:()=>assetLoader.timings?.()??[],
      cutaway:()=>({requested:cutaway,active:cutaway&&cutawayPlan!==null,height:cutaway&&cutawayPlan?cutawayPlan.height:null,architectureIds:cutawayPlan?.architectureIds??[]}),
      visibility: () => build.slots.flatMap(entry=>{
        const view=build.registry.view(entry.slot.stableId);
        if(!view) return [];
        const loaded=entry.form.kind==='asset'?view.contentHash!==null:view.attached!==null;
        return [observeVisibility(entry.slot.stableId,entry.slot.localBounds,view.group,loaded,camera,scene,size.width,size.height)];
      }),
      ready: () => build.views.length > 0,
      frames: () => frames.current,
      builds: () => stageBuilds,
      quality: () => {
        if (world.kind !== 'built') return null;
        return {
          tier: world.quality,
          budget: budgetFor(world.quality),
          // `gl.info.render` nuluje renderer sám na začátku každého snímku,
          // takže je to účet za ten poslední — přesně to, co rozpočet §23
          // omezuje. Součet přes celou relaci by tu byl bezcenný.
          drawCalls: gl.info.render.calls,
          triangles: gl.info.render.triangles,
          textures: gl.info.memory.textures,
          textureAxis: largestTextureAxis(scene),
          heroes: build.slots.filter((entry) => entry.form.kind === 'mesh').length,
          pixelRatio: gl.getPixelRatio(),
          drawingBufferPixels: gl.domElement.width * gl.domElement.height,
        };
      },
      memory: () => ({
        geometries: gl.info.memory.geometries,
        textures: gl.info.memory.textures,
        // `programs` je u `WebGLRenderer` volitelné pole; když si ho renderer
        // nevede, je nula poctivější odpověď než výjimka uprostřed měření.
        programs: gl.info.programs?.length ?? 0,
      }),
      scenery: () => {
        // Jména se skládají ze **stejných funkcí** jako při stavbě, ne z předpony
        // opsané podruhé: kdyby se `slotGroupName()` někdy změnil, má tenhle
        // součet přestat počítat spolu s ním, ne tiše spadnout na nulu.
        const owned = new Set(
          build.slots.flatMap((entry) => [
            slotGroupName(entry.slot.stableId),
            formName(entry.slot.stableId),
          ]),
        );
        let slotNodes = 0;
        groupNamed(SCENERY_NAME)?.traverse((object) => {
          if (owned.has(object.name)) slotNodes += 1;
        });
        return { ...build.sceneryCost, groups: count(SCENERY_NAME, root), slotNodes };
      },
      reveal: () =>
        reveal === null
          ? null
          : {
              stableId: reveal.stableId,
              reducedMotion: reveal.plan.reducedMotion,
              durationMs: reveal.plan.durationMs,
            },
      lastReveal: () => lastReveal.current,
      commits: () => commits.current,
      camera: () => [camera.position.x, camera.position.y, camera.position.z],
      screen: (stableId: string) => toScreen(stableId, 0.5),
      slots: () =>
        build.slots.map((entry) => {
          const { stableId, transform, anchors } = entry.slot;
          // **Živě z registry, ne ze snímku `views`.** Ten se pořídil při
          // stavbě a o `stage()` ani `commit()` nikdy neuslyší.
          const view = build.registry.view(stableId);
          const upgradedDetail=detailResolutions.current.get(stableId);
          const actualDetailResolution=upgradedDetail?.hash===view?.contentHash?upgradedDetail?.resolution:undefined;
          const form = formName(stableId);
          const detail = detailName(stableId);
          const group = groupNamed(slotGroupName(stableId));
          const assetNodes: string[] = [];
          const assetMaterials = new Map<string, { name: string; transparent: boolean; roughness: number; metalness: number }>();
          if (entry.form.kind === 'asset' && view?.contentHash) view.attached?.traverse(node => {
            assetNodes.push(node.name);
            if (!(node instanceof Mesh)) return;
            for (const material of Array.isArray(node.material) ? node.material : [node.material])
              assetMaterials.set(material.uuid, { name: material.name, transparent: material.transparent,
                roughness: material.roughness, metalness: material.metalness });
          });
          return {
            ...(entry.form.kind === 'asset' ? { asset: { nodes: assetNodes, materials: [...assetMaterials.values()] } } : {}),
            stableId,
            assetRetry:build.assetRetryState(stableId),
            objectId: view?.group.uuid ?? null,
            representationId: view?.attached?.uuid ?? null,
            rung: build.rungs.get(stableId)!,
            groups: count(slotGroupName(stableId), root),
            forms: { total: count(form, root), inGroup: count(form, group) },
            details: { total: count(detail, root), inGroup: count(detail, group) },
            staged: view?.staged != null,
            contentHash: view?.contentHash ?? null,
            failure: failures.current.get(stableId) ?? null,
            detailAssessment:entry.detailProgram&&(actualDetailResolution!==undefined||entry.form.kind==='mesh')
              ?assessShapeDetail(entry.detailProgram,actualDetailResolution??(entry.form.kind==='mesh'?entry.form.resolution:32)):null,
            samplingAction:entry.form.kind==='mesh'?entry.form.samplingAction??null:null,
            internalInstances:entry.form.kind==='mesh'?entry.form.repeat?.offsets.length??1:1,
            attached: view?.attached != null,
            triangles: trianglesUnder(group),
            transform: group === null ? transform : {
              scale: [group.scale.x, group.scale.y, group.scale.z],
              translation: [group.position.x, group.position.y, group.position.z],
              ...(group.rotation.y===0?{}:{rotationY:group.rotation.y}),
            },
            anchors,
            // Kotva slotu je socket obalu, takže `socketWorld` ho vždycky najde
            // — obojí zakládá `open()` z téhož pole `anchors`.
            sockets: anchors.map((anchor) => ({
              name: anchor.name,
              at: build.socketWorld(stableId, anchor.name)!,
            })),
          };
        }),
    };
    window.__worldstreamStage=probe;
    gl.domElement.__worldstreamStage=probe;
    const canvasKey=gl.domElement.dataset.worldstreamStageId??(gl.domElement.dataset.worldstreamStageId=crypto.randomUUID());
    (window.__worldstreamStages??={})[canvasKey]=probe;
    return () => {
      if(window.__worldstreamStage===probe)delete window.__worldstreamStage;
      if(gl.domElement.__worldstreamStage===probe)delete gl.domElement.__worldstreamStage;
      if(window.__worldstreamStages?.[canvasKey]===probe)delete window.__worldstreamStages[canvasKey];
    };
  }, [build, root, reveal, camera, gl, scene, toScreen, world,cutaway,cutawayPlan,profiler]);

  return (
    <group ref={setRoot} name="worldstream:stage" onClick={pick} onPointerMissed={miss}>
      <RepresentationSlots views={build.views} />
      {build.scenery !== null && <primitive object={build.scenery} />}
      {reveal !== null && (
        // Odhalení je vždycky nejvýš jedno, takže `key` tu nic neřeší a není
        // tu. Naběhlý čas nuluje `Materialize` sám, na změně `object` a `plan`
        // — a ty jsou u druhého odhalení téhož slotu nové objekty.
        <Materialize object={reveal.object} plan={reveal.plan} onDone={finishReveal} />
      )}
    </group>
  );
}
