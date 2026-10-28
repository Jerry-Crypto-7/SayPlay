'use client';

/**
 * Plátno arkády (P25A T6, P25C T6, P25F T6) – shell (P32-0 T5): plátno se
 * sondami, výběr scény, vstup a odezva nad plátnem (`EventFeedback`). Scény
 * kreslí jinde:
 * - běžec `runner/RunnerWorld.tsx`, plošinovka `platform/PlatformWorld.tsx`;
 * - poletování, závod, střelnice a hod sdílený `World.tsx`;
 * - aréna `arena/`, načasování `timing/`, rytmus `rhythm/` a souboj `duel/`;
 * - světlo, oblohu, mlhu a ladění barev všech `look/rig/StyleRig.tsx`;
 * - efekty z událostí jádra `effects/Effects.tsx` (sběrnice `effects/bus.ts`).
 *
 * Vstup se jen zapíše do relace – padne do nejbližšího tiku, takže záznam jde přehrát.
 */

import { addAfterEffect, useFrame, useThree } from '@react-three/fiber';
import { Fragment, type ReactNode, memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box3, type Camera, Matrix4, Mesh, type Object3D, PerspectiveCamera, Quaternion, type SkinnedMesh, Vector3 } from 'three';

import { color as brand } from '@/brand/tokens';
import { baseControlOf } from '@/play/arcade/addons';
import { AXIS_MAX, BUTTON, type PieceRef, nativeRule } from '@/play/arcade/contract';
import { LOOKS, type Look, type LookId } from '@/play/arcade/look';
import { LEGIBLE_SHARE, type Legible, foeScale, legibleScale, legibleWrite, riggedCharacter } from '@/play/arcade/models';
import { duelCue, duelHurlOf } from '@/play/arcade/pieces/duel';
import { CAPABILITIES } from '@/play/capabilities';
import { stageOf } from '@/play/compose/stage-registry';
import type { ControlId, HeroAction } from '@/play/spec';

import { AbilityButton, ActionButton, abilitiesOf, actionsOf, useAbilityInput, useActionInput } from './ActionButton';
import { ArenaWorld, useArenaInput } from './arena/ArenaScene';
import { Effects } from './effects/Effects';
import type { ArcadeGhost } from './GhostSlot';
import { comboOf } from './effects/feel';
import { introLeftOf, restCamera } from './look/intro';
import { preloadBody } from './look/load';
import { inkCount, isInk } from './look/rig/InkOutline';
import { StyleRig } from './look/rig/StyleRig';
import { DuelScene, type RivalModel, useDuelInput } from './duel/DuelScene';
import { LaneStage, useLanesInput } from './genres/lanes/LaneScene';
import { HopScene } from './genres/hop/HopScene';
import { CrowdScene } from './genres/crowd/CrowdScene';
import { MergeScene } from './genres/merge/MergeScene';
import { PushScene } from './genres/push/PushScene';
import { isTyping, runnerGesture } from './input';
import { PlatformWorld } from './platform/PlatformWorld';
import { HudBoosts, boostKeepers } from './PowerupBadge';
import { RhythmScene } from './rhythm/RhythmScene';
import { loadRigged, RiggedModel } from './RiggedModel';
import { RunnerWorld } from './runner/RunnerWorld';
import type { ArcadeSession } from './session';
import { useGlideInput } from './glide/GlideScene';
import { useWalkerInput } from './walker/WalkerScene';
import { useBallInput } from './ball/BallScene';
import { useSteerInput } from './steer/SteerScene';
import { type BodyModel, TimingScene, useTapInput } from './timing/TimingScene';
import { TouchStick, TouchZones } from './TouchControls';
import { type ToyTarget, appliedToyOf } from './toy/applyToy';
import { DUEL_ZONES, PLATFORM_ZONES, zoneAt } from './touch-zones';
import { Snowfall } from './Weather';
import { type Cast, FittedModel, World } from './World';
import { KeepFrame } from '../feed/snapshot-cache';
import { DrawWhenCompiled, FreshCamera, HostedCanvas } from '../feed/StageHost';
import { XrGame } from '../xr/xr-context';
import type { StageTunnel } from '../feed/stage-tunnel';

/** Fire remains available when independent parts wrap the native weapon rule. */
export function hasBlaster(rules: readonly PieceRef[]): boolean {
  return nativeRule(rules, 'blaster') !== undefined;
}

/**
 * Sonda záběru (P27A T6): `window.__playFrame()` promítne hrdinu a nejbližší
 * živý cíl nebo hrozbu skutečnou kamerou scény. Scény značí objekty
 * `userData.frame = 'hero' | 'target'`; sonda čte jen to, co se opravdu kreslí
 * (objekt i všichni předci viditelní, jen viditelné meshe).
 */
export interface FrameBox {
  /** Střed promítnutého obdélníku v NDC (−1 … 1, +y nahoru). */
  readonly x: number;
  readonly y: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly widthPx: number;
  readonly heightPx: number;
  /** Velikost na obrazovce = větší z šířky a výšky promítnutého obdélníku (px). */
  readonly sizePx: number;
  /** Některý roh je za kamerou – promítnutí pak neplatí a objekt v záběru není. */
  readonly behind: boolean;
}

export interface FrameReport {
  readonly control: string;
  readonly width: number;
  readonly height: number;
  readonly hero: FrameBox | null;
  /** Hrdinu kreslí náhradní kvádr (`userData.standIn`), protože se jeho model ještě načítá (P62 T11). */
  readonly heroStandIn: boolean;
  /**
   * Úhel (°) mezi tím, kam hrdina kouká (jeho +z), a směrem od něj ke kameře, ve vodorovné
   * rovině: 0 = hledí do kamery, 180 = je k ní zády (P35 T12).
   */
  readonly heroFacing: number | null;
  /** Kolik inkoustových obalů (obrys, P36C T6) sítě hrdiny nesou; obrys nezávisí na úrovni kvality. */
  readonly heroInk: number;
  readonly target: FrameBox | null;
  /** Položka věty (`userData.item`) nejbližšího cíle, nebo `null` – kdo to je, když vyjde mimo záběr. */
  readonly targetItem: string | null;
  /** Vizuální měřítko čitelnosti (P58A T3) hrdiny a cíle; 1 = nezvětšené, `LEGIBLE_CAP` = strop, dál neroste. */
  readonly legible: { readonly hero: number; readonly target: number };
  /**
   * Nejbližší viditelný nepřítel z věty k hrdinovi (P62 T5): tělo se značkou `userData.foe` – pronásledovatel,
   * nepřítel, soupeř arény a terč střelnice, který kreslí model nepřítele. `null` = žádný není vidět.
   */
  readonly foe: FrameBox | null;
  /** Kolik viditelných kandidátů na cíl scéna má. */
  readonly targets: number;
  /** Cíl minus hrdina ve světě (m) – podklad, když cíl vyjde mimo záběr. */
  readonly offset: { readonly x: number; readonly y: number; readonly z: number } | null;
  /**
   * Položky z věty (P30B T5) podle role, jejíž popisek tělo kreslí (`userData.item`):
   * kolik jich je vidět a obdélník té, která je v záběru nejvíc.
   */
  readonly items: Readonly<Record<string, { readonly count: number; readonly box: FrameBox | null }>>;
  /**
   * Hračková póza hrdiny, jak ji `applyToy` nastavil (P45D T14): předklon a úklon (rad, bez
   * natočení po směru – to je hra), měřítko, poskok a výpad vnitřní skupiny (m; poloha ve
   * hře je na vnější), součet otočení dílů (rad) a uniformy deformace. Hledá
   * `userData.toyHero`, jinak první hračkovou skupinu pod hrdinou sondy; `null` = bez pózy.
   */
  readonly heroToy: Readonly<Record<'pitch' | 'roll' | 'sx' | 'sy' | 'sz' | 'hop' | 'lunge' | 'parts' | 'flap' | 'sway' | 'stride', number>> | null;
  /** Rozsah hry v obraze (P64 T1): hrdina a všechny živé cíle a nebezpečí před kamerou; `null` = žádné tělo. */
  readonly spread: FrameSpread | null;
  /** Otisk kamery (P64 T1): stráž rámování na šířku ho porovnává přesně. */
  readonly camera: CameraPrint;
}

export interface FrameSpread {
  /** Obdélník NDC přes klidové kvádry všech těl před kamerou (může přesahovat plátno). */
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  /** Kolik těl je před kamerou. */
  readonly bodies: number;
  /** Kolik z nich má střed mimo plátno do stran (`|x| > 1`) a nahoru či dolů (`|y| > 1`). */
  readonly outX: number;
  readonly outY: number;
}

export interface CameraPrint {
  readonly position: readonly [number, number, number];
  readonly quaternion: readonly [number, number, number, number];
  /** Svislé zorné pole (°); ortografická kamera `null`. */
  readonly fov: number | null;
  readonly aspect: number | null;
  /** Projekční matice po sloupcích – chytí i posun záběru (`setViewOffset`) a přiblížení. */
  readonly projection: readonly number[];
}

/**
 * Rozsah hry v obraze (P64 T1): obdélník NDC přes klidové kvádry těl, která neleží za kamerou. Klidový kvádr, ne
 * póza kostí – sonda ho počítá pro každý cíl a desítky riggovaných zombie by ji zdržely; rozsah snese pár procent.
 */
export function spreadOf(bodies: readonly Object3D[], camera: Camera, width: number, height: number): FrameSpread | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let count = 0;
  let outX = 0;
  let outY = 0;
  for (const body of bodies) {
    const box = frameOf(body, camera, width, height, false);
    if (box === null || box.behind) continue;
    count += 1;
    minX = Math.min(minX, box.minX);
    maxX = Math.max(maxX, box.maxX);
    minY = Math.min(minY, box.minY);
    maxY = Math.max(maxY, box.maxY);
    if (Math.abs(box.x) > 1) outX += 1;
    if (Math.abs(box.y) > 1) outY += 1;
  }
  return count === 0 ? null : { minX, maxX, minY, maxY, bodies: count, outX, outY };
}

/** Otisk kamery ve světě (P64 T1); matice světa musí být aktuální. */
export function cameraOf(camera: Camera): CameraPrint {
  const position = new Vector3();
  const quaternion = new Quaternion();
  camera.matrixWorld.decompose(position, quaternion, new Vector3());
  const perspective = (camera as PerspectiveCamera).isPerspectiveCamera === true;
  return {
    position: [position.x, position.y, position.z],
    quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
    fov: perspective ? (camera as PerspectiveCamera).fov : null,
    aspect: perspective ? (camera as PerspectiveCamera).aspect : null,
    projection: [...camera.projectionMatrix.elements],
  };
}

/** Hračková póza hrdiny pro `FrameReport.heroToy`. */
function heroToyOf(scene: Object3D, hero: Object3D | null): FrameReport['heroToy'] {
  let toy: ToyTarget | undefined;
  scene.traverse((node) => {
    if (toy === undefined && node.userData.toyHero === true && shown(node)) toy = appliedToyOf(node);
  });
  hero?.traverse((node) => {
    if (toy === undefined && shown(node)) toy = appliedToyOf(node);
  });
  if (toy === undefined) return null;
  const { group, parts = [], deform } = toy as ToyTarget;
  return {
    pitch: group.rotation.x,
    roll: group.rotation.z,
    sx: group.scale.x,
    sy: group.scale.y,
    sz: group.scale.z,
    hop: group.position.y,
    lunge: Math.hypot(group.position.x, group.position.z),
    parts: parts.reduce((sum, { pivot }) => sum + Math.abs(pivot.rotation.x) + Math.abs(pivot.rotation.y) + Math.abs(pivot.rotation.z), 0),
    flap: deform?.toyFlap.value ?? 0,
    sway: deform?.toySway.value ?? 0,
    stride: deform?.toyStride.value ?? 0,
  };
}

/** Jak daleko od středu obrazu obdélník leží (NDC); za kamerou nekonečno. */
const offCenter = (box: FrameBox): number => (box.behind ? Infinity : Math.max(Math.abs(box.x), Math.abs(box.y)));

/** Sonda kreslení (P28B T2, T6): draw cally posledního snímku a živé zdroje GPU. */
export interface RenderReport {
  readonly calls: number;
  readonly triangles: number;
  readonly geometries: number;
  readonly textures: number;
  /** Rig vzhledu (P32A T1): stíny zapnuté, tónování (`THREE.ACESFilmicToneMapping` = 4) a expozice. */
  readonly shadows: boolean;
  readonly toneMapping: number;
  readonly exposure: number;
  /** Efekty postprocessingu v pořadí (P32A T2, `look/rig/Post.tsx`); se skládačem tónuje `aces` a `toneMapping` je 0. */
  readonly post: readonly string[];
  /** Rodina ladění barev, kterou efekt ve skládači opravdu nastavil (P37B T3, `Grading`); `null` = bez ladění. */
  readonly grade: string | null;
  /**
   * Viditelné sítě scény (P35 T4) – co se kreslí, nezávisle na úrovni kvality, která
   * mění stínový výřez i průchody a s nimi `calls`.
   */
  readonly meshes: number;
  /**
   * Vyčleněné díly hýbajících se těl (P45D T6, `mergePosed`): viditelné sítě pod pivoty
   * dílů (`ink` z nich jsou obaly obrysu) a kolik těl díly má – bez nich by tělo bylo
   * jedna slitá síť jako dřív.
   */
  readonly toyParts: { readonly meshes: number; readonly ink: number; readonly bodies: number };
}

declare global {
  interface Window {
    __playFrame?: () => FrameReport;
    __playRender?: () => RenderReport;
  }
}

function RenderProbe() {
  const gl = useThree((three) => three.gl);
  const scene = useThree((three) => three.scene);
  useEffect(() => {
    const meshes = (): number => {
      let count = 0;
      scene.traverseVisible((node) => {
        if ((node as Mesh).isMesh === true) count += 1;
      });
      return count;
    };
    const toyParts = (): RenderReport['toyParts'] => {
      const bodies = new Set<Object3D>();
      let count = 0;
      let ink = 0;
      scene.traverseVisible((node) => {
        if (node.userData.toyPart === undefined) return;
        if (node.parent !== null) bodies.add(node.parent);
        node.traverseVisible((inner) => {
          if ((inner as Mesh).isMesh !== true) return;
          count += 1;
          if (isInk(inner as Mesh)) ink += 1;
        });
      });
      return { meshes: count, ink, bodies: bodies.size };
    };
    const probe = (): RenderReport => ({
      calls: gl.info.render.calls,
      triangles: gl.info.render.triangles,
      geometries: gl.info.memory.geometries,
      textures: gl.info.memory.textures,
      shadows: gl.shadowMap.enabled,
      toneMapping: gl.toneMapping,
      exposure: gl.toneMappingExposure,
      post: (gl.domElement.dataset.post ?? '').split(' ').filter(Boolean),
      grade: gl.domElement.dataset.grade ?? null,
      meshes: meshes(),
      toyParts: toyParts(),
    });
    window.__playRender = probe;    return () => {
      if (window.__playRender === probe) delete window.__playRender;
    };
  }, [gl, scene]);
  return null;
}

/** Tratě jedou po +z: cílem je nejbližší kandidát před hrdinou, ne ten, který už minul. */
const TRACK_CONTROLS: ReadonlySet<string> = new Set(['runner', 'platform', 'flap', 'steer']);

const shown = (object: Object3D): boolean => {
  for (let node: Object3D | null = object; node !== null; node = node.parent) if (!node.visible) return false;
  return true;
};

/** Kolik prvních snímků hledá sonda hrdinu prvního snímku; scéna bez něj (poletování, míč) by ho jinak hledala pořád. */
const HERO_FRAME_TRIES = 30;

/** Viditelný hrdina scény (`userData.frame`), nebo `null`. */
function heroOf(scene: Object3D): Object3D | null {
  let hero: Object3D | null = null;
  scene.traverse((node) => {
    if (node.userData.frame === 'hero' && shown(node)) hero = node;
  });
  return hero;
}

/** Hrdinu kreslí náhradní kvádr načítání (`FallbackPiece`, `RiggedModel`), ne jeho model. */
function standInOf(hero: Object3D): boolean {
  let found = false;
  hero.traverseVisible((node) => {
    if (node.userData.standIn === true) found = true;
  });
  return found;
}

const cornerOf = new Vector3();
const inView = new Vector3();
const posedOf = new Box3();
const restAt = new Vector3();
const nameAt = new Vector3();
/** Matice kůže po kostech (kost × inverze vazby); pole roste podle největší kostry. */
const skinOf: Matrix4[] = [];

/**
 * Kvádr riggované sítě v póze kostí – tytéž počty jako `SkinnedMesh.computeBoundingBox`, jen matici kosti
 * násobí jednou za kost, ne za každý vrchol a váhu. Three ji násobí až 4× na vrchol: ork a kovboj (13 tisíc
 * vrcholů) stáli na telefonu (CPU 4×) 50 ms každé měření `LegibleBodies`, scéna ztratila pětinu FPS (P58A T9r1).
 * Tady ~6× míň; kvádr vyšel do bitu stejný u všech 144 riggovaných postav a jejich klipů. `boundingBox` sítě nepřepisuje.
 */
export function posedBox(mesh: SkinnedMesh, box: Box3): Box3 {
  const { bones, boneInverses } = mesh.skeleton;
  for (let b = 0; b < bones.length; b += 1) (skinOf[b] ??= new Matrix4()).multiplyMatrices(bones[b]!.matrixWorld, boneInverses[b]!);
  const bind = mesh.bindMatrix.elements;
  const { skinIndex, skinWeight, position } = mesh.geometry.attributes;
  box.makeEmpty();
  for (let i = 0; i < position!.count; i += 1) {
    // Klidová poloha i s morfy, pak vazba (afinní: w = 1).
    Mesh.prototype.getVertexPosition.call(mesh, i, restAt);
    const bx = bind[0]! * restAt.x + bind[4]! * restAt.y + bind[8]! * restAt.z + bind[12]!;
    const by = bind[1]! * restAt.x + bind[5]! * restAt.y + bind[9]! * restAt.z + bind[13]!;
    const bz = bind[2]! * restAt.x + bind[6]! * restAt.y + bind[10]! * restAt.z + bind[14]!;
    let x = 0;
    let y = 0;
    let z = 0;
    for (let c = 0; c < 4; c += 1) {
      const weight = skinWeight!.getComponent(i, c);
      if (weight === 0) continue;
      const m = skinOf[skinIndex!.getComponent(i, c)]!.elements;
      x += (m[0]! * bx + m[4]! * by + m[8]! * bz + m[12]!) * weight;
      y += (m[1]! * bx + m[5]! * by + m[9]! * bz + m[13]!) * weight;
      z += (m[2]! * bx + m[6]! * by + m[10]! * bz + m[14]!) * weight;
    }
    box.expandByPoint(restAt.set(x, y, z).applyMatrix4(mesh.bindMatrixInverse));
  }
  return box;
}

/**
 * Rohy kvádru každého viditelného meshe promítnuté kamerou; obdélník kolem nich.
 * `posed = false` vezme riggované postavě klidový kvádr geometrie místo pózy kostí.
 */
export function frameOf(object: Object3D, camera: Camera, width: number, height: number, posed = true): FrameBox | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let behind = false;
  object.traverseVisible((node) => {
    const mesh = node as Mesh;
    // Obal obrysu (P36C T6) má kvádr svého těla. Riggovaný obal by navíc kostmi přepočítal
    // každý vrchol (3× víc než tělo, `toCreasedNormals`) – `PromptSpot` to dělá každý snímek.
    if (mesh.isMesh !== true || isInk(mesh)) return;
    let box: Box3;
    if (posed && (mesh as SkinnedMesh).isSkinnedMesh === true) {
      // Riggovaná postava: kvádr s pózou kostí, ne klidová geometrie.
      box = posedBox(mesh as SkinnedMesh, posedOf);
    } else {
      if (mesh.geometry.boundingBox === null) mesh.geometry.computeBoundingBox();
      box = mesh.geometry.boundingBox!;
    }
    for (let i = 0; i < 8; i += 1) {
      cornerOf.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(mesh.matrixWorld);
      // Kamera kouká po −z svého prostoru: roh s z ≥ 0 je za ní.
      if (inView.copy(cornerOf).applyMatrix4(camera.matrixWorldInverse).z >= 0) behind = true;
      cornerOf.project(camera);
      minX = Math.min(minX, cornerOf.x);
      maxX = Math.max(maxX, cornerOf.x);
      minY = Math.min(minY, cornerOf.y);
      maxY = Math.max(maxY, cornerOf.y);
    }
  });
  if (minX === Infinity) return null;
  const widthPx = ((maxX - minX) / 2) * width;
  const heightPx = ((maxY - minY) / 2) * height;
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, minX, maxX, minY, maxY, widthPx, heightPx, sizePx: Math.max(widthPx, heightPx), behind };
}

/**
 * Podíl nepřítele na plátně (P62 T5): větší z výšky a šířky jeho obdélníku (`sizePx`) k výšce plátna. Plochý brouk
 * 2,5× širší než vysoký by výškou 10 % (`LEGIBLE_SHARE.target`) zabral čtvrtinu šířky obrazu; postava měří výškou.
 */
export const foeShare = (box: FrameBox, height: number): number => box.sizePx / Math.max(1, height);

/** `FrameReport.heroFacing`: úhel mezi pohledem hrdiny (+z) a směrem ke kameře ve vodorovné rovině (°). */
function facingOf(hero: Object3D, at: Vector3, camera: Camera): number {
  const gaze = new Vector3(0, 0, 1).applyQuaternion(hero.getWorldQuaternion(new Quaternion())).setY(0);
  const toCamera = camera.getWorldPosition(new Vector3()).sub(at).setY(0);
  return (gaze.angleTo(toCamera) * 180) / Math.PI;
}

/**
 * Při kreslení na požádání překreslí scénu po každé změně relace – restart, konec běhu, pauza – a dokud úvodní
 * průlet nedosedne: úvodní karta jinak zamrzla u jeho startu a hrdina stál 2,6× dál (rytíř 9,8 % výšky, P58A T3).
 */
function RedrawOnChange({ session }: { readonly session: ArcadeSession }) {
  const get = useThree((three) => three.get);
  useEffect(() => session.subscribe(() => get().invalidate()), [session, get]);
  useEffect(() => {
    let last = 0;
    return addAfterEffect(() => {
      const { camera, frameloop, invalidate } = get();
      const left = introLeftOf(camera);
      // Stejný zbytek dvakrát po sobě = průlet už žádná scéna nepočítá; nepřekreslovat donekonečna.
      if (frameloop === 'demand' && left !== 0 && left !== last) invalidate();
      last = left;
    });
  }, [get]);
  return null;
}

/** Nejbližší cíl k hrdinovi; na trati jen cíle před ním, když nějaké jsou. */
function nearestTarget(heroAt: Vector3, candidates: readonly Object3D[], control: string): { node: Object3D; pos: Vector3 } | null {
  if (candidates.length === 0) return null;
  const at = candidates.map((node) => ({ node, pos: node.getWorldPosition(new Vector3()) }));
  const ahead = TRACK_CONTROLS.has(control) ? at.filter((c) => c.pos.z > heroAt.z) : [];
  const pool = ahead.length > 0 ? ahead : at;
  return pool.reduce((best, c) => (c.pos.distanceTo(heroAt) < best.pos.distanceTo(heroAt) ? c : best));
}

/** Jak často se těla měří (snímky): čtyřikrát za sekundu stačí, průchod scénou každý snímek stál na telefonu CPU. */
const LEGIBLE_EVERY = 15;
/** Kolik z rozdílu k `foeScale` nepřítel dojede za jedno měření (P62 T5): ~1 s na 90 %, póza kostry ho nerozkmitá. */
const FOE_EASE = 0.5;
/** Menší změnu měřítka nepřítele nepíše – scéna by se zbytečně překreslovala. */
const FOE_STILL = 0.005;
/**
 * Kolik nepřátel změří jeden průchod `LegibleBodies`. Kvádr riggované postavy v póze prochází každý vrchol (ork
 * a kovboj ~13 tisíc, na telefonu s CPU 4× jednotky ms za kus, `posedBox`) – deset riggovaných zombie naráz by každé
 * čtvrt sekundy zadrhlo snímek.
 * simplified: pevný počet za průchod; kdyby nepřátel v obraze bylo přes ~10 a dojížděli pozdě, měřit klidový kvádr.
 */
const FOE_PER_PASS = 2;

/**
 * Nepřátelé k měření v tomto průchodu: napřed ti, kdo se ještě neměřili (nově viditelní), pak nejbližší k hrdinovi –
 * ten je na snímku největší a jde do styku –, pak nejdéle neměřený.
 */
function foesToMeasure(foes: readonly Object3D[], heroAt: Vector3, control: string, measured: WeakMap<Object3D, number>): Object3D[] {
  const pick = foes.filter((node) => !measured.has(node)).slice(0, FOE_PER_PASS);
  const nearest = nearestTarget(heroAt, foes, control)?.node;
  if (pick.length < FOE_PER_PASS && nearest !== undefined && !pick.includes(nearest)) pick.push(nearest);
  const stale = foes.filter((node) => !pick.includes(node)).sort((a, b) => (measured.get(a) ?? 0) - (measured.get(b) ?? 0));
  return [...pick, ...stale].slice(0, FOE_PER_PASS);
}

/**
 * Čitelná těla (P58A T3): hrdina na plátně aspoň `LEGIBLE_SHARE.hero` výšky plátna, nejbližší cíl aspoň
 * `LEGIBLE_SHARE.target` – přepočtený na hloubku hrdiny, ať se překážka nezvětší jen proto, že je zatím daleko.
 * Zvětšuje jen skupinu se značkou `frame` (vizuál); simulace, kolize a stavový hash ho nevidí. Měří se po
 * nakresleném snímku (kamera už stojí, jak ji scéna postavila) herní kamerou bez úvodního průletu – široký
 * záběr průletu by tělo nafoukl a po dosednutí zase splaskl – a v póze, jakou má kostra, stejně jako sonda
 * `__playFrame` (klidový kvádr riggovaného rytíře je o ~20 % vyšší, zůstal pak na 16,5 %). Měřítko se píše
 * každý snímek po scénách – přepíše-li scéna měřítko skupiny sama, její hodnota je nový základ.
 */
function LegibleBodies({ control, foes }: { readonly control: string; readonly foes: boolean }) {
  const get = useThree((three) => three.get);
  const bodies = useRef(new Map<Object3D, Legible>());
  /** Nepřítel → průchod `LegibleBodies`, kdy se naposledy měřil (`foesToMeasure`). */
  const measured = useRef(new WeakMap<Object3D, number>());
  useFrame(() => {
    for (const [node, body] of bodies.current) {
      if (node.parent === null) {
        bodies.current.delete(node);
        continue;
      }
      legibleWrite(node.scale, body);
    }
  });
  useEffect(() => {
    let frames = 0;
    const view = new Vector3();
    const rest = new PerspectiveCamera();
    return addAfterEffect(() => {
      frames += 1;
      const { camera: drawn, scene, size, invalidate, frameloop } = get();
      // Kreslení na požádání (úvodní karta) dá snímků málo – změří se každý, i ten po dotaženém modelu.
      if (frameloop === 'always' && frames % LEGIBLE_EVERY !== 1) return;
      let hero: Object3D | null = null;
      const candidates: Object3D[] = [];
      const foeNodes: Object3D[] = [];
      scene.traverseVisible((node) => {
        if (node.userData.frame === 'hero') hero = node;
        else if (node.userData.frame === 'target') {
          candidates.push(node);
          if (foes && node.userData.foe === true) foeNodes.push(node);
        }
      });
      if (hero === null) return;
      const heroNode: Object3D = hero;
      const heroAt = heroNode.getWorldPosition(new Vector3());
      const target = nearestTarget(heroAt, candidates, control);
      const perspective = (drawn as PerspectiveCamera).isPerspectiveCamera === true;
      const camera = perspective ? restCamera(drawn as PerspectiveCamera, rest) : drawn;
      const depthOf = (at: Vector3): number => -view.copy(at).applyMatrix4(camera.matrixWorldInverse).z;
      const write = (node: Object3D, body: Legible, next: number): void => {
        body.scale = next;
        node.userData.legible = next;
        bodies.current.set(node, body);
        invalidate();
      };
      const grow = (node: Object3D, min: number, depthScale: number): void => {
        const box = frameOf(node, camera, size.width, size.height);
        if (box === null || box.behind) return;
        const body = bodies.current.get(node) ?? { scale: 1, base: node.scale.clone(), written: node.scale.clone() };
        const next = legibleScale(body.scale, ((box.maxY - box.minY) / 2) * depthScale, min);
        if (next !== body.scale) write(node, body, next);
      };
      grow(heroNode, LEGIBLE_SHARE.hero, 1);
      // Nepřátelé věty ve střílečce a aréně (P62 T5): každý podle podílu, jaký má na plátně on sám, ne přepočtený na
      // hloubku hrdiny – na střelnici stojí 12–36 m daleko a hráč na ně míří odtud. Podíl = větší z výšky a šířky
      // obdélníku (`foeShare`); v měřítku 1 = změřený / dnešní měřítko.
      for (const node of foesToMeasure(foeNodes, heroAt, control, measured.current)) {
        measured.current.set(node, frames);
        const box = frameOf(node, camera, size.width, size.height);
        if (box === null || box.behind) continue;
        const known = bodies.current.get(node);
        const body = known ?? { scale: 1, base: node.scale.clone(), written: node.scale.clone() };
        const goal = foeScale(foeShare(box, size.height) / body.scale);
        // Nový nepřítel hned, známý dojíždí: póza kostry hýbe obdélníkem o pár procent a měřítko by s ní pulzovalo.
        const next = known === undefined ? goal : body.scale + (goal - body.scale) * FOE_EASE;
        if (Math.abs(next - body.scale) > FOE_STILL) write(node, body, next);
      }
      // Zástupce (`userData.proxy`, nejbližší vozidlo hopu) se nekreslí – zvětšit by šel jen jeho kvádr v sondě.
      if (target === null || target.node.userData.proxy === true || (foes && target.node.userData.foe === true)) return;
      // Perspektiva zmenšuje s hloubkou: cíl se posuzuje, jak velký by byl vedle hrdiny.
      const heroDepth = depthOf(heroAt);
      grow(target.node, LEGIBLE_SHARE.target, perspective && heroDepth > 0 ? Math.max(depthOf(target.pos), 0) / heroDepth : 1);
    });
  }, [get, control, foes]);
  return null;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * Popisek jména (P58A T5) nad tělem, které jmenuje: štítek `.play-name-line` (vrstva nad plátnem) dostane
 * polohu promítnutého temene hrdiny, nebo nejbližšího těla, jehož slot (`userData.item`) má jméno z věty – a to
 * jméno. Tělo mimo záběr nebo bez jména = štítek zůstane schovaný. Scénou se prochází jen, když štítek visí
 * (3 s běhu). Jen obraz; simulace a hash ho nevidí.
 */
function NameAnchor({ surface, control, bodies }: { readonly surface: React.RefObject<HTMLDivElement | null>; readonly control: string; readonly bodies: Readonly<Record<string, string>> }) {
  useFrame(({ camera, scene, size }) => {
    const tag = surface.current?.querySelector<HTMLElement>('.play-name-line');
    if (tag == null) return;
    let hero: Object3D | null = null;
    // Rytmus a načasování (P58A T8): hrdinou sondy je lišta nebo jezdec, postava z věty stojí vedle – jméno patří nad ni.
    let figure: Object3D | null = null;
    const named: Object3D[] = [];
    scene.traverse((node) => {
      if (node.userData.frame === 'hero' && shown(node)) hero ??= node;
      else if (node.userData.toyHero === true && shown(node)) figure ??= node;
      else if (node.userData.frame === 'target' && bodies[node.userData.item as string] !== undefined && shown(node)) named.push(node);
    });
    const heroAt = hero === null ? null : (hero as Object3D).getWorldPosition(new Vector3());
    const body = tag.dataset.slot === 'hero' ? (figure ?? hero) : heroAt === null ? null : (nearestTarget(heroAt, named, control)?.node ?? null);
    const box = body === null ? null : frameOf(body, camera, size.width, size.height, false);
    if (box === null || box.behind || Math.abs(box.x) > 1 || box.maxY < -1) {
      tag.style.visibility = 'hidden';
      return;
    }
    if (tag.dataset.slot !== 'hero') {
      const name = bodies[body!.userData.item as string]!;
      if (tag.textContent !== name) tag.textContent = name;
    }
    // Vodorovně nad kořenem těla, ne nad středem rámečku: rámeček rytíře v souboji drží i meč namířený na soupeře
    // a jméno pak na telefonu stálo mezi nimi, pod povelem „Dodge!“ / „Strike!“ (P58C T6b).
    const root = body!.getWorldPosition(nameAt).project(camera);
    tag.style.left = `${(clamp((root.x + 1) / 2, 0.1, 0.9) * 100).toFixed(1)}%`;
    tag.style.top = `${(clamp((1 - box.maxY) / 2, 0.12, 0.95) * 100).toFixed(1)}%`;
    tag.style.visibility = 'visible';
  });
  return null;
}

function FrameProbe({ control }: { readonly control: string }) {
  const get = useThree((three) => three.get);
  useEffect(() => {
    const probe = (): FrameReport => {
      const { camera, scene, size } = get();
      scene.updateMatrixWorld();
      camera.updateMatrixWorld();
      let hero: Object3D | null = null;
      const candidates: Object3D[] = [];
      const foes: Object3D[] = [];
      const items: Record<string, { count: number; box: FrameBox | null }> = {};
      scene.traverse((node) => {
        const item = node.userData.item as string | undefined;
        if (item !== undefined && shown(node)) {
          const entry = (items[item] ??= { count: 0, box: null });
          const box = frameOf(node, camera, size.width, size.height);
          entry.count += 1;
          if (box !== null && (entry.box === null || offCenter(box) < offCenter(entry.box))) entry.box = box;
        }
        if (node.userData.frame === 'hero' && shown(node)) hero = node;
        else if (node.userData.frame === 'target' && shown(node)) {
          candidates.push(node);
          if (node.userData.foe === true) foes.push(node);
        }
      });
      const heroAt = hero === null ? null : (hero as Object3D).getWorldPosition(new Vector3());
      const target = heroAt === null ? null : nearestTarget(heroAt, candidates, control);
      const foe = heroAt === null ? null : nearestTarget(heroAt, foes, control);
      return {
        control,
        width: size.width,
        height: size.height,
        hero: hero === null ? null : frameOf(hero, camera, size.width, size.height),
        heroStandIn: hero !== null && standInOf(hero),
        heroFacing: hero === null || heroAt === null ? null : facingOf(hero, heroAt, camera),
        heroInk: hero === null ? 0 : inkCount(hero),
        target: target === null ? null : frameOf(target.node, camera, size.width, size.height),
        targetItem: (target?.node.userData.item as string | undefined) ?? null,
        legible: { hero: (hero as Object3D | null)?.userData.legible ?? 1, target: target?.node.userData.legible ?? 1 },
        foe: foe === null ? null : frameOf(foe.node, camera, size.width, size.height),
        targets: candidates.length,
        offset: target === null || heroAt === null ? null : { x: target.pos.x - heroAt.x, y: target.pos.y - heroAt.y, z: target.pos.z - heroAt.z },
        items,
        heroToy: heroToyOf(scene, hero),
        spread: spreadOf(hero === null ? candidates : [hero, ...candidates], camera, size.width, size.height),
        camera: cameraOf(camera),
      };
    };
    // Bez podmínky, stejně jako `__playShell`: e2e ji čte na každé arkádové hře.
    window.__playFrame = probe;
    return () => {
      if (window.__playFrame === probe) delete window.__playFrame;
    };
  }, [get, control]);
  useEffect(() => {
    const stage = get().gl.domElement.closest<HTMLElement>('[data-testid="arcade-stage"]');
    if (stage === null) return;
    // První nakreslený snímek s hrdinou (P62 T11): `model`, nebo `stand-in`, když ho kreslil náhradní kvádr.
    // Scéna bez hrdiny (`userData.frame`) se prohledává jen prvních `HERO_FRAME_TRIES` snímků, ne celou hru.
    let tries = 0;
    const stop = addAfterEffect(() => {
      tries += 1;
      const hero = heroOf(get().scene);
      if (hero !== null) stage.dataset.heroFirstFrame = standInOf(hero) ? 'stand-in' : 'model';
      if (hero !== null || tries >= HERO_FRAME_TRIES) stop();
    });
    return stop;
  }, [get]);
  return null;
}

/**
 * Místo výzvy „Tap to start“ (P35 T6): uprostřed obrazu v aréně a úkolu přesně
 * zakryla hrdinu. Dokud hra stojí na tiku 0, promítne hrdinu kamerou a dá stage,
 * kde v obraze je (`--_hero-top`, `--_hero-bottom` v % výšky) a na které straně
 * od něj je víc místa (`data-prompt-at`); CSS výzvu postaví nad, nebo pod něj.
 * Bez hrdiny v záběru zůstane výzva uprostřed.
 *
 * Měří se až nakreslený snímek (`addAfterEffect`), ne ve `useFrame`: kamera
 * stanoviště úkolu se přihlásí až druhým průchodem (`StationScene.tsx`) a přestaví
 * kameru po každém dřívějším `useFrame` – u kuchaře (P35 T11) se karta měřila
 * kamerou arény a na telefonu sedla přesně přes hrdinu. Hra na tiku 0 navíc kreslí
 * jen na požádání, takže snímek, kdy se dotáhne model, bývá poslední.
 *
 * Místo pro kartu je mezi hrdinou a lištami HUD (nahoře hodiny a cíl, dole akce).
 * Kde se nevejde ani nad, ani pod hrdinu, zmenší se do většího z obou míst
 * (`--_prompt-scale`) – přes hrdinu nejde nikdy.
 */
function PromptSpot({ session, surface }: { readonly session: ArcadeSession; readonly surface: React.RefObject<HTMLDivElement | null> }) {
  const get = useThree((three) => three.get);
  useEffect(() => {
    // Čekání na první vstup běží každý snímek (P37B T7, Pixel 7 CPU 4×): průchod scénou
    // a zápis stylu, který prohlížeči každý snímek zneplatnil rozvržení pro další
    // `getBoundingClientRect`, stály čaroději na úvodní kartě ~6 % CPU. Hrdina se proto
    // hledá znovu, jen když zmizí, a styl se píše, jen když se změní.
    let hero: Object3D | null = null;
    return addAfterEffect(() => {
      const host = surface.current;
      if (host === null || session.snapshot().tick !== 0) return;
      const { camera, scene, size } = get();
      if (hero === null || !shownIn(hero, scene)) {
        hero = null;
        scene.traverseVisible((node) => {
          if (node.userData.frame === 'hero') hero = node;
        });
      }
      // Klidový kvádr (P36C T9): póza kostí přepočítá každý vrchol postavy a tohle běží každý
      // snímek tiku 0 – u rytířů ~30 % CPU telefonu. Na místo pro kartu stačí postava v klidu.
      const box = hero === null ? null : frameOf(hero, camera, size.width, size.height, false);
      if (box === null || box.behind) {
        delete host.dataset.promptAt;
        return;
      }
      const spot = { top: (1 - box.maxY) / 2, bottom: (1 - box.minY) / 2, left: (1 + box.minX) / 2, right: (1 + box.maxX) / 2 };
      const stage = host.getBoundingClientRect();
      const bars = hudBars(host, stage);
      const element = host.querySelector<HTMLElement>('.play-first-prompt');
      const card = { width: element?.offsetWidth ?? 0, height: element?.offsetHeight ?? 0 };
      const { at, scale } = promptPlacement(spot, stage, bars, card);
      setStyleVar(host, '--_hero-top', `${(spot.top * 100).toFixed(1)}%`);
      setStyleVar(host, '--_hero-bottom', `${(spot.bottom * 100).toFixed(1)}%`);
      setStyleVar(host, '--_hero-left', `${(spot.left * 100).toFixed(1)}%`);
      setStyleVar(host, '--_hero-right', `${(spot.right * 100).toFixed(1)}%`);
      setStyleVar(host, '--_prompt-mid', `${(((bars.top + bars.bottom) / 2 / stage.height) * 100).toFixed(1)}%`);
      setStyleVar(host, '--_prompt-scale', scale === 1 ? '1' : scale.toFixed(3));
      if (host.dataset.promptAt !== at) host.dataset.promptAt = at;
    });
  }, [get, session, surface]);
  return null;
}

/** Pod tímhle zmenšením se karta nad ani pod hrdinou nečte (desktop, rytíř přes půl výšky: 0,3 – P58C T6). */
const MIN_PROMPT_SCALE = 0.8;

const fit = (size: number, room: number): number => (size > room ? Math.max(room, 0) / size : 1);

/**
 * Kam s úvodní kartou (`PromptSpot`): nad, nebo pod hrdinu, kde je víc místa. Kde by se tam musela
 * zmenšit pod `MIN_PROMPT_SCALE`, jde vedle hrdiny na širší stranu, mezi lišty HUD – na širokém
 * desktopu je místa vedle dost, na telefonu ne a karta zůstane nad, nebo pod ním zmenšená.
 * Hrdina v podílech stage od levého horního rohu, lišty a karta v px.
 */
export function promptPlacement(
  hero: { readonly top: number; readonly bottom: number; readonly left: number; readonly right: number },
  stage: { readonly width: number; readonly height: number },
  bars: { readonly top: number; readonly bottom: number },
  card: { readonly width: number; readonly height: number },
): { readonly at: 'above' | 'below' | 'left' | 'right'; readonly scale: number } {
  const above = hero.top * stage.height - bars.top - 2 * PROMPT_GAP_PX;
  const below = bars.bottom - hero.bottom * stage.height - 2 * PROMPT_GAP_PX;
  const vertical = { at: above >= below ? 'above' : 'below', scale: fit(card.height, Math.max(above, below)) } as const;
  if (vertical.scale >= MIN_PROMPT_SCALE) return vertical;
  const left = hero.left * stage.width - 2 * PROMPT_GAP_PX;
  const right = (1 - hero.right) * stage.width - 2 * PROMPT_GAP_PX;
  const band = bars.bottom - bars.top - 2 * PROMPT_GAP_PX;
  const beside = { at: left >= right ? 'left' : 'right', scale: Math.min(fit(card.width, Math.max(left, right)), fit(card.height, band)) } as const;
  return beside.scale > vertical.scale ? beside : vertical;
}

/** Uzel je ve scéně a viditelný i se všemi předky. */
function shownIn(object: Object3D, root: Object3D): boolean {
  let node: Object3D | null = object;
  for (; node !== null && node !== root; node = node.parent) if (!node.visible) return false;
  return node === root && root.visible;
}

/** Stejná hodnota se nepíše: i ta by zneplatnila styl a rozvržení stránky. */
export function setStyleVar(host: HTMLElement, name: string, value: string): void {
  if (host.style.getPropertyValue(name) !== value) host.style.setProperty(name, value);
}

/** Mezera mezi kartou a hrdinou i lištou HUD (`--sp-space-4` v `play.css`). */
const PROMPT_GAP_PX = 16;

/** Spodní hrana horní lišty HUD a horní hrana dolní, v px od horní hrany stage. */
function hudBars(host: HTMLElement, stage: DOMRect): { readonly top: number; readonly bottom: number } {
  const shell = host.parentElement;
  let top = 0;
  let bottom = stage.height;
  for (const bar of shell?.querySelectorAll('.play-hud-progress, .play-hud-corner, .play-hud-goal') ?? []) {
    const rect = bar.getBoundingClientRect();
    if (rect.height > 0) top = Math.max(top, rect.bottom - stage.top);
  }
  // Nad dolní řadou stojí přepínač verze a štítky dotykových zón (P58C T6) – karta pod hrdinou na ně nesmí.
  for (const bar of shell?.querySelectorAll('.play-hud-bottom, .play-hud > :is(.play-upgrade-status, .play-upgrade-toast), .play-touch-zone') ?? []) {
    const rect = bar.getBoundingClientRect();
    if (rect.height > 0) bottom = Math.min(bottom, rect.top - stage.top);
  }
  return { top, bottom };
}

/** Jak dlouho po konci běhu plátno ještě kreslí naplno: klip pádu či oslavy a pauza výsledku (600 ms). */
const END_CLIP_MS = 1500;

const JUMP_KEYS = new Set([' ', 'arrowup', 'w']);

/** Běžec: mezerník/šipka nahoru = skok, šipky/A-D = pruh, šipka dolů = skluz; dotyk a myš: `runnerGesture`. */
function useRunnerInput(session: ArcadeSession, target: React.RefObject<HTMLDivElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat || isTyping(event.target)) return;
      const key = event.key.toLowerCase();
      const button =
        JUMP_KEYS.has(key) ? BUTTON.TAP
        : key === 'arrowleft' || key === 'a' ? BUTTON.LEFT
        : key === 'arrowright' || key === 'd' ? BUTTON.RIGHT
        : key === 'arrowdown' || key === 's' ? BUTTON.DOWN
        : 0;
      if (button === 0) return;
      event.preventDefault();
      session.press(button);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session, active]);

  useEffect(() => {
    const element = target.current;
    if (!active || element === null) return;
    const gesture = runnerGesture(session);
    const onDown = (event: PointerEvent) => gesture.down(event);
    const onMove = (event: PointerEvent) => gesture.move(event);
    const onUp = (event: PointerEvent) => gesture.up(event);
    const onCancel = () => gesture.cancel();
    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', onCancel);
    return () => {
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onCancel);
    };
  }, [session, target, active]);
}

/**
 * Plošinovka: šipky/A-D drží osu, mezerník/šipka nahoru/W = skok. Dotyk:
 * levá čtvrtina drží vlevo, druhá vpravo, pravá polovina = skok – palec
 * vlevo běží, palec vpravo skáče (víc prstů najednou).
 */
function usePlatformInput(session: ArcadeSession, target: React.RefObject<HTMLDivElement | null>, active: boolean): void {
  useEffect(() => {
    const element = target.current;
    if (!active || element === null) return;
    const keys = new Set<'left' | 'right'>();
    const pointers = new Map<number, 'left' | 'right'>();
    const sync = (): void => {
      const held = new Set([...keys, ...pointers.values()]);
      session.hold(((held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0)) * AXIS_MAX);
    };
    const sideOf = (key: string): 'left' | 'right' | null => (key === 'arrowleft' || key === 'a' ? 'left' : key === 'arrowright' || key === 'd' ? 'right' : null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return;
      const key = event.key.toLowerCase();
      const side = sideOf(key);
      if (side !== null) {
        event.preventDefault();
        keys.add(side);
        sync();
      } else if (JUMP_KEYS.has(key) && !event.repeat) {
        event.preventDefault();
        session.press(BUTTON.TAP);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const side = sideOf(event.key.toLowerCase());
      if (side === null) return;
      keys.delete(side);
      sync();
    };
    const onDown = (event: PointerEvent) => {
      const box = element.getBoundingClientRect();
      const zone = zoneAt(PLATFORM_ZONES, (event.clientX - box.left) / Math.max(1, box.width));
      if (zone === 2) session.press(BUTTON.TAP);
      else {
        pointers.set(event.pointerId, zone === 0 ? 'left' : 'right');
        sync();
      }
    };
    const onUp = (event: PointerEvent) => {
      if (pointers.delete(event.pointerId)) sync();
    };
    const release = (): void => {
      keys.clear();
      pointers.clear();
      sync();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', release);
    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', release);
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onUp);
    };
  }, [session, target, active]);
}

/** Poletování: mezerník/šipka nahoru/W nebo dotyk kdekoli = mávnutí (hned při stisku). */
function useFlapInput(session: ArcadeSession, target: React.RefObject<HTMLDivElement | null>, active: boolean): void {
  useEffect(() => {
    const element = target.current;
    if (!active || element === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat || isTyping(event.target) || !JUMP_KEYS.has(event.key.toLowerCase())) return;
      event.preventDefault();
      session.press(BUTTON.TAP);
    };
    const onDown = () => session.press(BUTTON.TAP);
    window.addEventListener('keydown', onKey);
    element.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      element.removeEventListener('pointerdown', onDown);
    };
  }, [session, target, active]);
}

const FIRE_KEYS = new Set(['f', 'j', 'enter']);
/** S akcemi hrdiny (P46A T7) patří J akci A, střelba zůstane na F a Enter. */
const FIRE_KEYS_WITH_ABILITIES = new Set(['f', 'enter']);

/** Střelba doplňku `+shoot` (P26D): F/J/Enter, na dotyku tlačítko ve scéně – skok a skluz zůstávají, kde byly. */
function useFireInput(session: ArcadeSession, active: boolean, abilities: boolean): void {
  useEffect(() => {
    if (!active) return;
    const keys = abilities ? FIRE_KEYS_WITH_ABILITIES : FIRE_KEYS;
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat || isTyping(event.target) || !keys.has(event.key.toLowerCase())) return;
      event.preventDefault();
      session.press(BUTTON.FIRE);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session, active, abilities]);
}

function FireButton({ session }: { readonly session: ArcadeSession }) {
  const button = useRef<HTMLButtonElement | null>(null);
  // Ťuk na tlačítko nesmí doběhnout k ploše scény – tam je to skok. Plocha poslouchá
  // nativně, takže zastavit to musí nativní posluchač (React by přišel až po ní).
  useEffect(() => {
    const element = button.current;
    if (element === null) return;
    const stop = (event: PointerEvent) => event.stopPropagation();
    const fire = (event: PointerEvent) => {
      stop(event);
      session.press(BUTTON.FIRE);
    };
    element.addEventListener('pointerdown', fire);
    element.addEventListener('pointerup', stop);
    return () => {
      element.removeEventListener('pointerdown', fire);
      element.removeEventListener('pointerup', stop);
    };
  }, [session]);
  return (
    <button ref={button} type="button" className="play-fire" data-testid="arcade-fire">
      Fire
    </button>
  );
}

/** Jak dlouho visí „+1“ nad hráčem (P28C T3). */
export const SCORE_POP_MS = 500;

interface ScorePop {
  readonly id: number;
  /** „+N“ za bod, „×N“ za kombo (P36C T7). */
  readonly text: string;
  readonly combo: boolean;
  /** Vodorovná poloha hráče na obrazovce v % (střed, když ji scéna nehlásí). */
  readonly left: number;
}

/**
 * Odezva nad plátnem (P28C T3), společná všem scénám: „+N“ nad hráčem při
 * bodu. Je to DOM nad plátnem – žádný draw call navíc, stav relace se nemění.
 * Otřes po zásahu dělá kamera (`effects/Effects.tsx`, P32A T4). Poloha „+N“ je `data-player-x`,
 * který píše scéna běžce, plošinovky, poletování a závodu; ostatní scény ho
 * nemají a „+N“ je uprostřed.
 */
function EventFeedback({ session, surface }: { readonly session: ArcadeSession; readonly surface: React.RefObject<HTMLDivElement | null> }) {
  const [pops, setPops] = useState<readonly ScorePop[]>([]);
  useEffect(() => {
    let next = 0;
    const timers = new Set<number>();
    const later = (ms: number, fn: () => void): void => {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        fn();
      }, ms);
      timers.add(timer);
    };
    const off = session.onEvents((events) => {
      const amount = events.reduce((sum, event) => (event.kind === 'score' ? sum + event.amount : sum), 0);
      const combo = comboOf(events);
      const x = Number(surface.current?.dataset.playerX ?? 0);
      const left = 50 + Math.max(-0.9, Math.min(0.9, Number.isFinite(x) ? x : 0)) * 50;
      const fresh: ScorePop[] = [];
      if (amount > 0) fresh.push({ id: (next += 1), text: `+${amount}`, combo: false, left });
      if (combo !== null) fresh.push({ id: (next += 1), text: `×${combo}`, combo: true, left });
      for (const pop of fresh) {
        setPops((current) => [...current, pop]);
        later(SCORE_POP_MS, () => setPops((current) => current.filter((entry) => entry.id !== pop.id)));
      }
    });
    return () => {
      off();
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [session, surface]);
  return (
    <>
      {pops.map((pop) => (
        <span key={pop.id} className={pop.combo ? 'play-score-pop play-combo-pop' : 'play-score-pop'} data-testid={pop.combo ? 'combo-pop' : 'score-pop'} style={{ left: `${pop.left}%` }} aria-hidden="true">
          {pop.text}
        </span>
      ))}
    </>
  );
}

/**
 * Plátno se scénou za vlastní hranicí `memo` (P32A T2-R1). `ArcadePlay` se překresluje
 * s každým tikem (HUD čte snímek relace) a nový prvek `overlay` obejde `memo` celé
 * stage – bez téhle hranice React každý tik prošel celý strom scény (běžec na Pixel 7
 * se 4× CPU ~20 % času). Scény čtou stav relace ve `useFrame`, props se jim za běhu nemění.
 */
const StageCanvas = memo(function StageCanvas({
  session,
  cast,
  look,
  lookId,
  enabled,
  live,
  surface,
  heroAction,
  ghost,
  host,
  keepFrame,
  sceneKey,
  names,
}: {
  readonly session: ArcadeSession;
  readonly cast: Cast;
  readonly look: Look;
  /** Rodina ladění barev (P37B T3, `look/rig/grade.ts`). */
  readonly lookId: LookId;
  readonly enabled: boolean;
  readonly live: boolean;
  readonly surface: React.RefObject<HTMLDivElement | null>;
  readonly heroAction: HeroAction;
  readonly ghost?: ArcadeGhost;
  readonly host?: StageTunnel;
  readonly keepFrame?: string;
  readonly sceneKey?: string;
  readonly names?: Readonly<Record<string, string>>;
}) {
  // První scéna plátna nemá předchozí snímek, který by mohla držet (`DrawWhenCompiled`).
  const [firstScene] = useState(sceneKey);
  const base = baseControlOf(session.world.control);
  const control = base.id;
  const stage = stageOf(control);
  if (stage === null) throw new Error(`No scene registered for ${control}`);
  // Soupeř souboje z popisku (P27A T4): riggovaná postava stojí, model katalogu se vepíše do těla.
  const rival = cast.props.rival;
  const character = rival === undefined ? undefined : riggedCharacter(rival);
  const rivalModel: RivalModel | undefined =
    rival === undefined
      ? undefined
      : (w, h, d) => (character !== undefined ? <RiggedModel character={character} h={h} clip={() => 'idle'} fallback={brand['tomato-deep']} /> : <FittedModel id={rival} w={w} h={h} d={d} fallback={brand['tomato-deep']} rim />);
  // P43 T14b: hrdina souboje a rytmu z popisku (rytíř, pirát, babička); výchozí průzkumník zůstává postavou z kvádrů.
  const heroRig = riggedCharacter(cast.player);
  const castHero: RivalModel | undefined =
    cast.player === 'explorer'
      ? undefined
      : (w, h, d) => (heroRig !== undefined ? <RiggedModel character={heroRig} h={h} clip={() => 'idle'} fallback={brand['sky-deep']} /> : <FittedModel id={cast.player} w={w} h={h} d={d} fallback={brand['sky-deep']} character rim />);
  // P30B T4: nota rytmu a díl věže z popisku („lily pads“, „pancakes“); díl vyplní kvádr, šířku mu mění jádro.
  const { note, block } = cast.props;
  const noteModel: BodyModel | undefined = note === undefined ? undefined : (w, h, d) => <FittedModel id={note} w={w} h={h} d={d} fallback={look.tint[0]} />;
  const blockModel: BodyModel | undefined = block === undefined ? undefined : (w, h, d) => <FittedModel id={block} w={w} h={h} d={d} fallback={look.tint[0]} fill />;
  const world = { session, cast, surface, scene: look, enabled, heroAction, ghost };
  return (
    // Stíny slunce rigu (P32A T1); PCF s poloměrem – měkký PCFSoft three 0.185 odmítá.
    <HostedCanvas host={host} frameloop={live ? 'always' : 'demand'}>
      <RedrawOnChange session={session} />
      <FrameProbe control={control} />
      {names !== undefined && <NameAnchor surface={surface} control={control} bodies={names} />}
      <RenderProbe />
      {keepFrame !== undefined && <KeepFrame versionId={keepFrame} />}
      {/* Fotopanorama tu není (P32A T6): prostředí z věty vybírá paletu a kulisy, obloha je rigu. Zůstává mřížce (`GridScenery`). */}
      {/* Rig svítí všem scénám: načasování a rytmus od P32A T10, souboj od P37B T3. */}
      <StyleRig look={look} lookId={lookId} control={control} surface={surface} />
      <Fragment key={sceneKey}>
      {sceneKey !== undefined && <FreshCamera />}
      {sceneKey !== undefined && sceneKey !== firstScene && <DrawWhenCompiled />}
      {stage.scene === 'duel' ? (
        <DuelScene session={session} look={look} heroModel={castHero} rivalModel={rivalModel} heroAction={heroAction} ghost={ghost} />
      ) : (
        <>
          {/* Souboj (P32E T3) je režim arény: stejná plocha, kamera i pohyb, úder přidává `ActionButton`. */}
          {stage.scene === 'timing' ? (
            <TimingScene session={session} look={look} blockModel={blockModel} heroModel={castHero} heroAction={heroAction} ghost={ghost} />
          ) : stage.scene === 'rhythm' ? (
            <RhythmScene session={session} look={look} heroModel={castHero} noteModel={noteModel} surface={surface} heroAction={heroAction} ghost={ghost} />
          ) : stage.scene === 'arena' ? (
            <ArenaWorld session={session} half={Number(base.params.half)} surface={surface} look={look} cast={cast} heroAction={heroAction} ghost={ghost} />
          ) : stage.scene === 'runner' ? (
            <RunnerWorld {...world} />
          ) : stage.scene === 'platform' ? (
            <PlatformWorld {...world} />
          ) : stage.scene === 'lanes' ? (
            <LaneStage {...world} />
          ) : stage.scene === 'hop' ? (
            <HopScene {...world} />
          ) : stage.scene === 'crowd' ? (
            <CrowdScene {...world} />
          ) : stage.scene === 'merge' ? (
            <MergeScene {...world} />
          ) : stage.scene === 'push' ? (
            <PushScene {...world} />
          ) : (
            <World {...world} control={control} />
          )}
        </>
      )}
      </Fragment>
      {/* Sněží jen v zasněžené sadě (čepička na kulisách), body kolem kamery (P32A T4). */}
      {look.terrain?.cap !== undefined && <Snowfall />}
      {/* Za scénami: měřítko čitelnosti se píše až po jejich snímku (P58A T3). */}
      {/* Nepřítel věty čitelný podle vlastního podílu na plátně jen ve střílečce a aréně (P62 T5). */}
      <LegibleBodies control={control} foes={control === 'shooter' || stage.scene === 'arena'} />
      {/* Výzva na startu se měří až nakresleným snímkem – záběrem kamery, kterou scéna nakonec postavila. */}
      <PromptSpot session={session} surface={surface} />
      {/* Poslední dítě plátna: jeho snímek běží až po scéně, která kameru umístila. */}
      <Effects session={session} look={look} surface={surface} />
    </HostedCanvas>
  );
});

export default function ArcadeStage({
  session,
  cast,
  lookId = 'meadow',
  look: scene,
  enabled = true,
  heroAction = 'none',
  ghost,
  abilityWords,
  overlay,
  host,
  keepFrame,
  sceneKey,
  names,
}: {
  readonly session: ArcadeSession;
  readonly cast: Cast;
  readonly lookId?: LookId;
  /** Sada upravená místem z věty (`sceneLook`, P30B T6); bez ní sada `lookId`. */
  readonly look?: Look;
  /** Hra je na obrazovce a běží (P28B T3); jinak vstup neposlouchá – po konci patří šipky feedu a klávesy formuláři. */
  readonly enabled?: boolean;
  /** Viditelná činnost hrdiny ze specu (P37-0 T2); jde do každé scény, kreslí ji až stopa vzhledu. Jádro ji nečte. */
  readonly heroAction?: HeroAction;
  /** Duch dřívějšího běhu (P37B T8, `GhostSlot.tsx`); scéna ho kreslí ve svém slotu. */
  readonly ghost?: ArcadeGhost;
  /**
   * Sloveso věty na tlačítkách akcí (P47B T10, `spec.abilityWords`) v pořadí akcí světa – svět je staví
   * ze `spec.abilities` ve stejném pořadí. Jádro ho nečte; bez něj obecné popisky.
   */
  readonly abilityWords?: readonly string[];
  /* P29D */
  /** Vrstva nad plátnem (počasí a denní doba živé změny) – mimo scénu i hash. */
  readonly overlay?: ReactNode;
  /** Trvalé plátno feedu (P54A T5, `feed/StageHost.tsx`): scéna se kreslí do něj, vlastní `<Canvas>` nevznikne. */
  readonly host?: StageTunnel;
  /** Verze hry, jejíž snímek se po prvních snímcích uloží přes reload (P56B T12, `KeepFrame`). */
  readonly keepFrame?: string;
  /**
   * Klíč scény žánru (kolo řetězu, P56C T13a): jeho změna postaví znovu jen scénu žánru a kameru; rig, skládač,
   * obloha a efekty zůstanou i s programy shaderů. Bez klíče se scéna remountuje jen se změnou žánru.
   */
  readonly sceneKey?: string;
  /** Jména těl z věty podle slotu (`nameLines`, P58A T5) pro popisek jména; bez nich popisek nevisí nad ničím. */
  readonly names?: Readonly<Record<string, string>>;
}) {
  const surface = useRef<HTMLDivElement | null>(null);
  // Doplňky obalí ovládání (`addon_control`); kamera, scéna i vstup se řídí tím pod obalem.
  const control = baseControlOf(session.world.control).id;
  const input = stageOf(control)?.input;
  const fires = hasBlaster(session.world.rules);
  // Úder a použití (P32-0 T5) jen ve světě, který je čte.
  // Akce hrdiny (P46A T7): J/K patří tlačítkům A/B, úder a použití starých her je bez nich mají dál.
  const abilities = useMemo(() => abilitiesOf(session.world), [session]);
  // Power-up a kombo v HUD (P46C T5) jen ve světě, který je má.
  const keepers = useMemo(() => boostKeepers(session.world), [session]);
  // Díl souboje bere i úder akce (P46A T8), takže tlačítko Attack by bylo navíc.
  const actions = useMemo(() => actionsOf(session.world).filter((action) => action !== 'attack' || !abilities.includes('strike')), [session, abilities]);
  const hasAbilities = abilities.length > 0;
  // Zóna souboje svítí, když hra chce její povel (P58C T6b) – týž povel jako štítek nad soupeřem.
  const duelZoneCue = useMemo(() => {
    const hurl = duelHurlOf(session.world.control);
    return (state: Int32Array) => duelCue(state, hurl);
  }, [session]);
  // Tlačítko Shoot akce střílí týmž blasterem – druhé tlačítko střelby by bylo navíc.
  const fireButton = fires && !abilities.includes('shoot');
  const abilityBase = actions.length > 0 ? 1 + actions.length : fireButton ? 1 : 0;
  const look = scene ?? LOOKS[lookId];
  const draws = CAPABILITIES[control as ControlId]?.setting === true;
  // Hrdina se načítá s kódem scény (P62 T11), dřív než scéna požádá o podlahu a kulisy; druhé volání je z cache.
  // Bez držení prvního snímku: na Pixel 7 s CPU 4× ho čekání na rozbaleného rytíře posunulo o 0,7 s a start s ním.
  const heroRig = riggedCharacter(cast.player);
  void (heroRig === undefined ? preloadBody(cast.player) : loadRigged(heroRig.path));
  useFireInput(session, fires && enabled, hasAbilities);
  useActionInput(session, actions, enabled && !hasAbilities);
  useAbilityInput(session, abilities, enabled);
  useRunnerInput(session, surface, enabled && input === 'runner');
  usePlatformInput(session, surface, enabled && input === 'platform');
  useFlapInput(session, surface, enabled && input === 'flap');
  useSteerInput(session, surface, enabled && input === 'steer');
  useGlideInput(session, surface, enabled && input === 'glide');
  useWalkerInput(session, surface, enabled && input === 'walker');
  useBallInput(session, surface, enabled && input === 'ball');
  useArenaInput(session, surface, enabled && input === 'arena');
  useTapInput(session, surface, enabled && input === 'tap', control === 'rhythm');
  useDuelInput(session, surface, enabled && input === 'duel');
  useLanesInput(session, surface, enabled && input === 'lanes');
  // Pauza a konec běhu kreslí jen na požádání (P28E T2, F-33): hodiny stojí, obraz se nemění.
  // Po konci ale ještě END_CLIP_MS naplno – klip pádu či oslavy (P28C T3) by jinak stál na prvním snímku.
  const ticking = useSyncExternalStore(session.subscribe, () => session.snapshot().runState === 'running' && !session.paused(), () => true);
  const ended = useSyncExternalStore(session.subscribe, () => session.snapshot().runState !== 'running', () => false);
  const [settling, setSettling] = useState(false);
  useEffect(() => {
    // Nová relace bez remountu (kolo řetězu, `sceneKey`) nebo restart: úklid zrušil časovač, klip konce už neběží.
    if (!ended) {
      setSettling(false);
      return;
    }
    setSettling(true);
    const timer = window.setTimeout(() => setSettling(false), END_CLIP_MS);
    return () => window.clearTimeout(timer);
  }, [ended]);
  const live = ticking || settling;
  return (
    // `data-setting` = sada, jejíž kulisy scéna opravdu kreslí (P27A T3); scéna bez sad ho nemá.
    <div ref={surface} className="play-stage" data-testid="arcade-stage" data-control={control} data-look={lookId} data-setting={draws ? lookId : undefined} style={{ touchAction: 'none' }}>
      <StageCanvas session={session} cast={cast} look={look} lookId={lookId} enabled={enabled} live={live} surface={surface} heroAction={heroAction} ghost={ghost} host={host} keepFrame={keepFrame} sceneKey={sceneKey} names={names} />
      <XrGame session={session} enabled={enabled} />
      {overlay /* P29D */}
      <EventFeedback session={session} surface={surface} />
      {(keepers.powerup !== undefined || keepers.combo !== undefined) && <HudBoosts session={session} keepers={keepers} />}
      {enabled && control === 'platform' && <TouchZones session={session} zones={PLATFORM_ZONES} />}
      {enabled && control === 'duel' && <TouchZones session={session} zones={DUEL_ZONES} cue={duelZoneCue} />}
      {enabled && (control === 'move_free' || control === 'fight') && <TouchStick surface={surface} />}
      {enabled && control === 'ball' && session.world.control.id === 'assembly_control' && <div
        className="play-pause-hint" data-testid="ball-dribble-hint"
        style={{ position: 'absolute', left: 12, top: 12, maxWidth: '65%', pointerEvents: 'none' }}>
        Left side: drag to move. Right side: aim and release to shoot. Keyboard: arrows move, Q/E aim, Space shoots.
      </div>}
      {fireButton && enabled && <FireButton session={session} />}
      {enabled && actions.map((action) => <ActionButton key={action} session={session} action={action} />)}
      {enabled && abilities.map((ability, slot) => <AbilityButton key={ability} session={session} ability={ability} slot={slot} stack={abilityBase + slot} word={abilityWords?.[slot]} />)}
    </div>
  );
}
