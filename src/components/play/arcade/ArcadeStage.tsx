'use client';

/**
 * Plátno arkády (P25A T6, P25C T6, P25F T6). Smyčka `useFrame` posouvá hodiny relace
 * (pevný krok v `session.ts`) a kreslí těla interpolovaná mezi posledními
 * dvěma tiky. Scéna podle ovládání: běžec a závod (`steer/`) mají kameru za
 * a nad hráčem, plošinovka a poletování boční kameru (trať jde zleva
 * doprava), aréna (`arena/`) vlastní svět s kamerou shora, střelnice
 * a hřiště hodu vlastní scénu s kamerou a vstupem (`shooter/`, `throw/`,
 * P25G). Vstup se
 * jen zapíše do relace – padne do nejbližšího tiku, takže záznam jde přehrát.
 *
 * Modely: `/assets/worldstream/game/<id>-lod1.glb` podle id těla (`hurdle`,
 * `coin`, …); když katalog id nemá (404), kreslí se barevný kvádr. Tělesa,
 * pro která model v katalogu není (plošiny, hroty, trubky, ptáček), se
 * kreslí rovnou primitivem a nestahují se.
 */

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { type ReactNode, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box3, type Camera, type Group, type Mesh, type Object3D, type PerspectiveCamera, type SkinnedMesh, Vector3 } from 'three';

import { baseControlOf } from '@/play/arcade/addons';
import { AXIS_MAX, BODY, BUTTON, FLAG, HEADER, ROLE, UNIT, bodyBase } from '@/play/arcade/contract';
import { LOOKS, type Look, type LookId } from '@/play/arcade/look';
import { type PropRole, fitScale, riggedCharacter } from '@/play/arcade/models';
import { type ClipState, type Pose, clipOf, posesOf, viewOf } from '@/play/arcade/motion';
import { FLAP } from '@/play/arcade/pieces/flap';
import { PLATFORM } from '@/play/arcade/pieces/platform';
import { RUNNER } from '@/play/arcade/pieces/runner';
import { type SteerCourse, centerAt } from '@/play/arcade/pieces/steer';
import { CAPABILITIES } from '@/play/capabilities';
import type { ControlId } from '@/play/spec';

import { ArenaWorld, useArenaInput } from './arena/ArenaScene';
import { type BodyView, bodiesOf, bodiesStale } from './bodies';
import { UNDER_PANORAMA } from './look/under-panorama';
import { applyIntro, introLeft, useIntroClock } from './look/intro';
import { loadModel } from './look/load';
import { Panorama } from './look/Panorama';
import { PlayEnv } from './look/play-env';
import { Scenery } from './look/Scenery';
import { DuelScene, type RivalModel, useDuelInput } from './duel/DuelScene';
import { isTyping, runnerGesture } from './input';
import { RhythmScene } from './rhythm/RhythmScene';
import { RiggedModel } from './RiggedModel';
import type { ArcadeSession } from './session';
import { SHOT_PRIMITIVES, ShotPrimitive } from './shooter/primitives';
import { ShooterRig } from './shooter/ShooterRig';
import { SteerBackdrop, placeChase, useSteerInput } from './steer/SteerScene';
import { ThrowRig } from './throw/ThrowRig';
import { type BodyModel, TimingScene, useTapInput } from './timing/TimingScene';

/** Barva náhradního kvádru podle id těla; nic fialového. */
const FALLBACK_COLOR: Readonly<Record<string, string>> = {
  player: '#2563eb',
  hurdle: '#f59e0b',
  'slide-bar': '#ea580c',
  cone: '#f97316',
  crate: '#a16207',
  coin: '#facc15',
  finish: '#14b8a6',
  checkpoint: '#0ea5e9',
  turbo: '#22d3ee',
  enemy: '#dc2626',
  chaser: '#b91c1c',
};

/** Jména rolí podle čísla – scéna je zapíše do `data-drawn`, ať e2e vidí, co kreslí. */
const ROLE_NAMES: Readonly<Record<number, string>> = Object.fromEntries(Object.entries(ROLE).map(([name, code]) => [code, name]));

/** Id modelu, který katalog nemá – kreslí se primitivem (objednávka modelů pro P25F je ve Findings plánu). */
const PRIMITIVE = new Set(['platform', 'platform-moving', 'spikes', 'pipe', 'ceiling', 'bird', ...SHOT_PRIMITIVES]);

/** Modely z popisků rolí (`@/play/arcade/models`): hrdina, nepřítel střelnice a rekvizity. */
export interface Cast {
  readonly player: string;
  readonly enemy: string;
  /** Pronásledovatel doplňku `+chaser`. */
  readonly chaser: string;
  readonly props: Partial<Record<PropRole, string>>;
}

/** Překážky běžce, které smí nést model z popisku; skluzová laťka tvarem říká „podlez“, tu ne. */
const SWAPPABLE_OBSTACLES: ReadonlySet<string> = new Set(['hurdle', 'cone', 'crate']);

/** Id těla → id modelu v katalogu. Hráč, nepřítel, mince, překážka a terč berou model z popisku role, když ho katalog má. */
function modelIdOf(view: BodyView, cast: Cast): string {
  if (view.role === ROLE.player) return cast.player;
  if (view.kind === 'finish') return 'finish-flag';
  if (view.kind === 'enemy') return cast.enemy;
  // Soupeř závodu (P27A T4): vozidlo z popisku role `rival`, jinak auto soupeře.
  if (view.kind === 'rival-car') return cast.props.rival ?? view.kind;
  if (view.role === ROLE.chaser) return cast.chaser;
  if (view.role === ROLE.collectible && view.kind === 'coin') return cast.props.coin ?? view.kind;
  if (view.role === ROLE.obstacle && SWAPPABLE_OBSTACLES.has(view.kind)) return cast.props.obstacle ?? view.kind;
  // P30B T4: mantinel závodu z popisku role `barrier` („crocodiles“ podél řeky).
  if (view.role === ROLE.obstacle && view.kind === 'tire-barrier') return cast.props.barrier ?? view.kind;
  // P28D T3: kostky věže hodu jsou terč – „cardboard boxes“ postaví věž z krabic.
  if (view.role === ROLE.target && (view.kind === 'target' || view.kind === 'wood-block')) return cast.props.target ?? view.kind;
  return view.kind;
}

/**
 * Model vepsaný do kvádru těla (metry), postavený na zem, střed v ose; postava výškou těla (`fitScale`).
 * `fill` kvádr vyplní v každé ose zvlášť – díl věže, kterému jádro mění šířku (P30B T4).
 */
function FittedModel({ id, w, h, d, fallback, character = false, fill = false }: { readonly id: string; readonly w: number; readonly h: number; readonly d: number; readonly fallback: string; readonly character?: boolean; readonly fill?: boolean }) {
  const [model, setModel] = useState<Object3D | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void loadModel(id).then((loaded) => {
      if (live) setModel(loaded);
    });
    return () => {
      live = false;
    };
  }, [id]);
  const fitted = useMemo(() => {
    if (model === null || model === undefined) return null;
    const copy = model.clone(true);
    const box = new Box3().setFromObject(copy);
    const size = box.getSize(new Vector3());
    const along = (length: number): number => Math.max(length, 1e-3);
    const uniform = fitScale(size, { x: w, y: h, z: d }, character);
    const scale = fill ? new Vector3(w / along(size.x), h / along(size.y), d / along(size.z)) : new Vector3(uniform, uniform, uniform);
    copy.scale.copy(scale);
    const center = box.getCenter(new Vector3());
    copy.position.set(-center.x * scale.x, -box.min.y * scale.y, -center.z * scale.z);
    return copy;
  }, [model, w, h, d, character, fill]);
  if (fitted !== null) return <primitive object={fitted} />;
  return (
    <mesh position={[0, h / 2, 0]}>
      <boxGeometry args={[w, h, d]} />
      <meshStandardMaterial color={fallback} roughness={0.6} />
    </mesh>
  );
}

/**
 * Tělesa bez modelu: plošina (hlína + tráva, nebo hmota sady), řada hrotů,
 * trubka, strop, ptáček. Pohyblivá plošina si barvu nechává: hráč z ní čte pohyb.
 */
function Primitive({ id, w, h, d, block }: { readonly id: string; readonly w: number; readonly h: number; readonly d: number; readonly block?: Look['block'] }) {
  if (SHOT_PRIMITIVES.has(id)) return <ShotPrimitive id={id} w={w} h={h} d={d} block={block?.[1]} />;
  if (id === 'platform' || id === 'platform-moving') {
    const top = Math.min(0.25, h / 3);
    const [side, surface] = id === 'platform' ? (block ?? ['#92400e', '#16a34a']) : ['#475569', '#f59e0b'];
    return (
      <>
        <mesh position={[0, (h - top) / 2, 0]}>
          <boxGeometry args={[w, h - top, d]} />
          <meshStandardMaterial color={side} roughness={0.9} />
        </mesh>
        <mesh position={[0, h - top / 2, 0]}>
          <boxGeometry args={[w, top, d]} />
          <meshStandardMaterial color={surface} roughness={0.8} />
        </mesh>
      </>
    );
  }
  if (id === 'spikes') {
    const count = Math.max(1, Math.round(d / 0.45));
    const radius = d / count / 2;
    return (
      <>
        {Array.from({ length: count }, (_, i) => (
          <mesh key={i} position={[0, h / 2, -d / 2 + radius * (2 * i + 1)]}>
            <coneGeometry args={[radius, h, 8]} />
            <meshStandardMaterial color="#dc2626" roughness={0.4} metalness={0.3} />
          </mesh>
        ))}
      </>
    );
  }
  if (id === 'bird') {
    const r = Math.min(w, h, d) / 2;
    return (
      <>
        <mesh position={[0, r, 0]}>
          <sphereGeometry args={[r, 16, 12]} />
          <meshStandardMaterial color="#facc15" roughness={0.5} />
        </mesh>
        <mesh position={[0, r, r * 1.1]} rotation={[Math.PI / 2, 0, 0]}>
          <coneGeometry args={[r * 0.35, r * 0.7, 8]} />
          <meshStandardMaterial color="#ea580c" />
        </mesh>
        <mesh position={[-r * 0.8, r * 1.3, r * 0.45]}>
          <sphereGeometry args={[r * 0.18, 8, 6]} />
          <meshBasicMaterial color="#0f172a" />
        </mesh>
      </>
    );
  }
  return (
    <mesh position={[0, h / 2, 0]}>
      <boxGeometry args={[w, h, d]} />
      <meshStandardMaterial color={id === 'pipe' ? '#16a34a' : '#334155'} roughness={0.6} />
    </mesh>
  );
}

function lerp(from: number, to: number, alpha: number): number {
  return from + (to - from) * alpha;
}

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));

/**
 * Boční kamera: stojí na −x a kouká po +x, takže +z jádra jde na obrazovce
 * doprava. Vzdálenost se řídí poměrem stran – na výšku (mobil) ustoupí,
 * aby bylo vidět aspoň `ahead` metrů trati. `lead` = o kolik poloviny šířky
 * obrazu je hráč vlevo od středu (0,4 → levá třetina).
 */
function placeSide(camera: PerspectiveCamera, look: Vector3, z: number, y: number, ahead: number, tall: number, far: number, lead: number): void {
  const tan = Math.tan((camera.fov * Math.PI) / 360);
  const dist = clamp(Math.max(ahead / (2 * tan * camera.aspect), tall / (2 * tan)), 10, far);
  const shift = dist * tan * camera.aspect * lead;
  camera.position.set(-dist, y, z + shift);
  look.set(0, y, z + shift);
  camera.lookAt(look);
}

/**
 * Boční kamera na výšku (P30B T5): kolmý záběr je úzký – hrdina přes 4 % výšky
 * a zároveň ~11 m trati před ním se do něj nevejdou. Kamera se proto natočí
 * o `yaw` po trati: hrdina je jí blíž (větší), trať před ním se zkrátí
 * perspektivou. `dist` = vzdálenost k bodu pohledu, `lead` = o kolik metrů
 * před hrdinou kamera míří.
 */
function placeAngled(camera: PerspectiveCamera, look: Vector3, z: number, y: number, dist: number, yaw: number, lead: number): void {
  look.set(0, y, z + lead);
  camera.position.set(-dist * Math.cos(yaw), y, z + lead - dist * Math.sin(yaw));
  camera.lookAt(look);
}

const DEG = Math.PI / 180;

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
  readonly target: FrameBox | null;
  /** Kolik viditelných kandidátů na cíl scéna má. */
  readonly targets: number;
  /** Cíl minus hrdina ve světě (m) – podklad, když cíl vyjde mimo záběr. */
  readonly offset: { readonly x: number; readonly y: number; readonly z: number } | null;
  /**
   * Položky z věty (P30B T5) podle role, jejíž popisek tělo kreslí (`userData.item`):
   * kolik jich je vidět a obdélník té, která je v záběru nejvíc.
   */
  readonly items: Readonly<Record<string, { readonly count: number; readonly box: FrameBox | null }>>;
}

/** Jak daleko od středu obrazu obdélník leží (NDC); za kamerou nekonečno. */
const offCenter = (box: FrameBox): number => (box.behind ? Infinity : Math.max(Math.abs(box.x), Math.abs(box.y)));

/** Sonda kreslení (P28B T2, T6): draw cally posledního snímku a živé zdroje GPU. */
export interface RenderReport {
  readonly calls: number;
  readonly triangles: number;
  readonly geometries: number;
  readonly textures: number;
}

declare global {
  interface Window {
    __playFrame?: () => FrameReport;
    __playRender?: () => RenderReport;
  }
}

function RenderProbe() {
  const gl = useThree((three) => three.gl);
  useEffect(() => {
    const probe = (): RenderReport => ({ calls: gl.info.render.calls, triangles: gl.info.render.triangles, geometries: gl.info.memory.geometries, textures: gl.info.memory.textures });
    window.__playRender = probe;
    return () => {
      if (window.__playRender === probe) delete window.__playRender;
    };
  }, [gl]);
  return null;
}

/** Tratě jedou po +z: cílem je nejbližší kandidát před hrdinou, ne ten, který už minul. */
const TRACK_CONTROLS: ReadonlySet<string> = new Set(['runner', 'platform', 'flap', 'steer']);

const shown = (object: Object3D): boolean => {
  for (let node: Object3D | null = object; node !== null; node = node.parent) if (!node.visible) return false;
  return true;
};

const cornerOf = new Vector3();
const inView = new Vector3();

/** Rohy kvádru každého viditelného meshe promítnuté kamerou; obdélník kolem nich. */
function frameOf(object: Object3D, camera: Camera, width: number, height: number): FrameBox | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let behind = false;
  object.traverseVisible((node) => {
    const mesh = node as Mesh;
    if (mesh.isMesh !== true) return;
    let box: Box3;
    if ((mesh as SkinnedMesh).isSkinnedMesh === true) {
      // Riggovaná postava: kvádr s pózou kostí, ne klidová geometrie.
      (mesh as SkinnedMesh).computeBoundingBox();
      box = (mesh as SkinnedMesh).boundingBox!;
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
 * Kamera končí tam, kde mlha (P28E-R1). Za koncem mlhy má každý pixel barvu oblohy,
 * takže to, co ořízne vzdálená rovina, by vypadalo stejně – jen se to nekreslí.
 * Běžec tak nekreslí celou trať (Moto G Power emulace: 416 volání na snímek, 10 fps).
 * Mlha i vzdálená rovina měří hloubku v prostoru kamery, hranice sedí přesně.
 */
/** Rezerva k vzdálené rovině: kamera se dorovná až po tělech a největší tělo je kolem 10 m. */
const FAR_MARGIN_M = 12;

function FarAtFog({ far }: { readonly far: number }) {
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  useEffect(() => {
    camera.far = far;
    camera.updateProjectionMatrix();
  }, [camera, far]);
  return null;
}

/** Při kreslení na požádání překreslí scénu po každé změně relace – restart, konec běhu, pauza. */
function RedrawOnChange({ session }: { readonly session: ArcadeSession }) {
  const invalidate = useThree((three) => three.invalidate);
  useEffect(() => session.subscribe(() => invalidate()), [session, invalidate]);
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
        else if (node.userData.frame === 'target' && shown(node)) candidates.push(node);
      });
      const heroAt = hero === null ? null : (hero as Object3D).getWorldPosition(new Vector3());
      let target: { node: Object3D; pos: Vector3 } | null = null;
      if (heroAt !== null && candidates.length > 0) {
        const at = candidates.map((node) => ({ node, pos: node.getWorldPosition(new Vector3()) }));
        const ahead = TRACK_CONTROLS.has(control) ? at.filter((c) => c.pos.z > heroAt.z) : [];
        const pool = ahead.length > 0 ? ahead : at;
        target = pool.reduce((best, c) => (c.pos.distanceTo(heroAt) < best.pos.distanceTo(heroAt) ? c : best));
      }
      return {
        control,
        width: size.width,
        height: size.height,
        hero: hero === null ? null : frameOf(hero, camera, size.width, size.height),
        target: target === null ? null : frameOf(target.node, camera, size.width, size.height),
        targets: candidates.length,
        offset: target === null || heroAt === null ? null : { x: target.pos.x - heroAt.x, y: target.pos.y - heroAt.y, z: target.pos.z - heroAt.z },
        items,
      };
    };
    // Bez podmínky, stejně jako `__playShell`: e2e ji čte na každé arkádové hře.
    window.__playFrame = probe;
    return () => {
      if (window.__playFrame === probe) delete window.__playFrame;
    };
  }, [get, control]);
  return null;
}

/** Role, které sonda záběru bere jako cíl nebo hrozbu; mantinely závodu jsou kulisa, ne cíl. */
const FRAME_TARGET_ROLES: ReadonlySet<number> = new Set([ROLE.obstacle, ROLE.collectible, ROLE.chaser, ROLE.hazard, ROLE.enemy, ROLE.target]);
const frameTagOf = (view: BodyView): 'hero' | 'target' | undefined =>
  view.role === ROLE.player ? 'hero' : FRAME_TARGET_ROLES.has(view.role) && view.kind !== 'tire-barrier' ? 'target' : undefined;

/**
 * Role věty, jejíž popisek tělo kreslí (P30B T5) – totéž rozhodnutí jako `modelIdOf`
 * a `arcadeScene` v `fidelity/chain.ts`. Nota, díl věže a soupeř souboje mají vlastní scény.
 */
function itemTagOf(view: BodyView): 'enemy' | 'chaser' | PropRole | undefined {
  if (view.role === ROLE.player) return undefined;
  if (view.kind === 'enemy') return 'enemy';
  if (view.kind === 'rival-car') return 'rival';
  if (view.role === ROLE.chaser) return 'chaser';
  if (view.role === ROLE.collectible && view.kind === 'coin') return 'coin';
  if (view.role === ROLE.obstacle && SWAPPABLE_OBSTACLES.has(view.kind)) return 'obstacle';
  if (view.role === ROLE.obstacle && view.kind === 'tire-barrier') return 'barrier';
  if (view.role === ROLE.target && (view.kind === 'target' || view.kind === 'wood-block')) return 'target';
  return undefined;
}

interface WorldProps {
  readonly session: ArcadeSession;
  readonly control: string;
  readonly cast: Cast;
  readonly surface: React.RefObject<HTMLDivElement | null>;
  readonly scene: Look;
  readonly enabled: boolean;
}

const PICKUP_MS = 200;
/** Jak dlouho po konci běhu plátno ještě kreslí naplno: klip pádu či oslavy a pauza výsledku (600 ms). */
const END_CLIP_MS = 1500;

/** Role, jejichž model se hýbe podle stavu těla (P26B); plošiny, auta a překážky jedou bez pózy. */
const POSED_ROLES: ReadonlySet<number> = new Set([ROLE.player, ROLE.enemy, ROLE.chaser]);

/** Póza na vnitřní skupinu modelu: poskok, předklon, zmáčknutí (objem drží), bliknutí po zásahu. */
function applyPose(group: Group, pose: Pose): void {
  group.position.y = pose.bob;
  group.rotation.x = pose.lean;
  const wide = 1 + pose.squash / 2;
  group.scale.set(wide, 1 - pose.squash, wide);
  group.visible = pose.flash === 0 || Math.floor(pose.flash * 6) % 2 === 0;
}

function World({ session, control, cast, surface, scene, enabled }: WorldProps) {
  // Střely a hody přidává jádro za běhu (`spawn`) – seznam se staví znovu, když se změní.
  const [views, setViews] = useState(() => bodiesOf(session));
  const groups = useRef<(Group | null)[]>([]);
  const posed = useRef<(Group | null)[]>([]);
  const poses = useRef<(Pose | null)[]>([]);
  /** Riggovaná postava po indexu těla (P26B T5) a klip, který jí scéna v tomhle snímku volí. */
  const rigged = useMemo(() => views.map((view) => riggedCharacter(modelIdOf(view, cast))), [views, cast]);
  const clips = useRef<ClipState[]>([]);
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const look = useMemo(() => new Vector3(), []);
  const projected = useMemo(() => new Vector3(), []);
  const followY = useRef<number | null>(null);
  // Sebrané tělo (bod + zmizení v jednom tiku) → čas sebrání; ještě PICKUP_MS se nafoukne a splaskne (P28C T3).
  const fading = useRef(new Map<number, number>());
  useEffect(
    () =>
      session.onEvents((events) => {
        if (!events.some((event) => event.kind === 'score')) return;
        const now = performance.now();
        for (const event of events) if (event.kind === 'despawn') fading.current.set(event.body, now);
      }),
    [session],
  );
  const introClock = useIntroClock();

  // Role těl, pro která scéna postavila model – doplněk, který jádro hraje a scéna nekreslí, e2e takhle pozná.
  useEffect(() => {
    if (surface.current !== null) surface.current.dataset.drawn = [...new Set(views.filter((view) => view.kind !== 'gate').map((view) => ROLE_NAMES[view.role]))].join(' ');
  }, [views, surface]);

  useFrame((_, delta) => {
    const alpha = session.advance(delta * 1000);
    if (bodiesStale(views, session)) setViews(bodiesOf(session));
    const state = session.state();
    const prev = session.prev();
    // Póza jen čte stav; tik s podílem rozběhnutého kroku, ať poskok neskáče po 1/60 s.
    const tick = (state[HEADER.tick] as number) + alpha;
    posesOf(state, prev, poses.current, tick);
    let shots = 0;
    for (const view of views) {
      const inner = posed.current[view.index];
      const pose = poses.current[view.index];
      if (inner !== null && inner !== undefined && pose !== null && pose !== undefined) applyPose(inner, pose);
      if (rigged[view.index] !== undefined && pose !== null && pose !== undefined) clips.current[view.index] = clipOf(viewOf(state, prev, view.index), pose, tick);
      const group = groups.current[view.index];
      if (group === null || group === undefined) continue;
      const base = bodyBase(view.index);
      const z = lerp(prev[base + BODY.z] as number, state[base + BODY.z] as number, alpha) / UNIT;
      // Tělo za koncem mlhy (`FarAtFog`) by kamera stejně ořízla; skryté vypadne i z přepočtu
      // matic, který jinak prochází celou trať každý snímek (P28E-R1). Kamera je ze snímku předtím.
      const inRange = Math.abs(z - camera.position.z) <= camera.far + FAR_MARGIN_M;
      group.visible = inRange && ((state[base + BODY.flags] as number) & FLAG.alive) !== 0;
      group.matrixWorldAutoUpdate = inRange;
      if (!inRange) continue;
      const fade = fading.current.get(view.index);
      if (fade !== undefined) {
        const t = (performance.now() - fade) / PICKUP_MS;
        if (t >= 1 || group.visible) {
          fading.current.delete(view.index);
          group.scale.setScalar(1);
        } else {
          group.visible = true;
          group.scale.setScalar((1 + 0.6 * Math.sin(t * Math.PI)) * (1 - t));
        }
      }
      // Kamera běžce kouká po +z, takže +x jádra by vyšlo na obrazovce vlevo a „LEFT“ (x − 1) by hráče poslal doprava.
      group.position.set(
        -lerp(prev[base + BODY.x] as number, state[base + BODY.x] as number, alpha) / UNIT,
        lerp(prev[base + BODY.y] as number, state[base + BODY.y] as number, alpha) / UNIT,
        z,
      );
      // Skluz snižuje tělo – model se přikrčí stejně.
      if (view.role === ROLE.player) group.scale.y = (state[base + BODY.h] as number) / UNIT / view.h;
      if (view.role === ROLE.collectible) group.rotation.y += delta * 3;
      if (view.role === ROLE.projectile && group.visible) shots += 1;
    }
    // Střely, které scéna opravdu kreslí (P28B T2) – e2e tak pozná střelu, kterou stav má a scéna ne.
    if (surface.current !== null && surface.current.dataset.shotsDrawn !== String(shots)) surface.current.dataset.shotsDrawn = String(shots);
    const player = groups.current[state[HEADER.player] as number];
    if (player !== null && player !== undefined) {
      const { x, y, z } = player.position;
      if (control === 'platform') {
        // Kamera za výškou hráče jen dojíždí, ať skok netřese obrazem.
        followY.current = followY.current === null ? y : lerp(followY.current, y, Math.min(1, delta * 4));
        // Na výšku mírně natočená, ať je vidět nejbližší mince či hrot ~11 m před startem
        // i vedle širokého hrdiny (P27A T6, P30B T5, `e2e/play-frame`); hrdina zůstává ~22 m od kamery.
        if (camera.aspect < 1) placeAngled(camera, look, z, followY.current + 1.2, 24, 25 * DEG, 4.5);
        else placeSide(camera, look, z, followY.current + 1.2, 16, 7, 18, 0.4);
      } else if (control === 'flap') {
        // Na počítači ptáček blíž středu (v levém horním rohu by ho zakryl HUD) a kamera
        // tak daleko, ať je vidět první trubka i mince za ní (P30B T5). Na výšku by kolmá
        // kamera ptáčka zmenšila na 3 % výšky: natočená do tří čtvrtin ho má přes 4 %
        // a první trubku i minci pořád v záběru.
        if (camera.aspect < 1) placeAngled(camera, look, z, FLAP.ceiling / UNIT / 2, 22, 50 * DEG, 5);
        else placeSide(camera, look, z, FLAP.ceiling / UNIT / 2, 30, FLAP.ceiling / UNIT + 1, 26, 0.1);
      } else if (control === 'steer') {
        // Osa trati je v jednotkách jádra a scéna ji zrcadlí (x → −x), stejně jako těla.
        const course = session.world.control.params.course as SteerCourse | undefined;
        placeChase(camera, look, x, z, course === undefined ? 0 : -centerAt(course, z * UNIT) / UNIT);
      } else if (control === 'shooter' || control === 'throw') {
        // Kameru střelnice a hřiště staví jejich scéna (`ShooterRig`, `ThrowRig`).
      } else {
        camera.position.set(x * 0.6, 3.4, z - 6.5);
        look.set(x * 0.4, 1.1, z + 9);
        camera.lookAt(look);
      }
      if (control !== 'shooter' && control !== 'throw') applyIntro(camera, look, introLeft(introClock()));
      camera.updateMatrixWorld();
      // Kde je hráč na obrazovce (−1 vlevo … 1 vpravo) – e2e tím hlídá směr, z obrázku se to nepřečte.
      if (surface.current !== null) surface.current.dataset.playerX = projected.copy(player.position).project(camera).x.toFixed(3);
    }
  });

  return (
    <>
      {control === 'steer' ? (
        <SteerBackdrop course={session.world.control.params.course as SteerCourse | undefined} length={session.world.length / UNIT} look={scene} />
      ) : (
        <Backdrop control={control} length={session.world.length / UNIT} look={scene} />
      )}
      {control === 'shooter' && <ShooterRig session={session} surface={surface} enabled={enabled} />}
      {control === 'throw' && <ThrowRig session={session} surface={surface} enabled={enabled} />}
      {views.map((view) =>
        // Branka poletování je neviditelná: jen počítá průlet mezerou.
        view.kind === 'gate' ? null : (
          <group key={view.index} ref={(group) => { groups.current[view.index] = group; }} userData={{ frame: frameTagOf(view), item: itemTagOf(view) }}>
            {PRIMITIVE.has(modelIdOf(view, cast)) ? (
              <Primitive id={modelIdOf(view, cast)} w={view.w} h={view.h} d={view.d} block={scene.block} />
            ) : rigged[view.index] !== undefined ? (
              // Riggovaná postava hraje klipy – poskok a zmáčknutí statických modelů by se s nimi praly.
              <RiggedModel
                character={rigged[view.index]!}
                h={view.h}
                clip={() => clips.current[view.index] ?? 'idle'}
                fallback={FALLBACK_COLOR[view.kind] ?? '#94a3b8'}
                // Klip hráče čte e2e z DOM – z obrázku se nepřečte.
                onClip={view.role === ROLE.player ? (state) => { if (surface.current !== null) surface.current.dataset.animClip = state; } : undefined}
              />
            ) : (
              <group ref={(group) => { posed.current[view.index] = POSED_ROLES.has(view.role) ? group : null; }}>
                {/* Terč je tenký kotouč; model z popisku (kachna) by se vepsal do jeho tloušťky – kreslí se hloubkou jako šířkou, srážky se nemění. */}
                {/* Postava stojí ve výšce těla (P30B T3); vozidlo má tělo nízké a dlouhé, to se dál vepisuje celé. */}
                <FittedModel
                  id={modelIdOf(view, cast)}
                  w={view.w}
                  h={view.h}
                  d={view.kind === 'target' ? Math.max(view.d, view.w) : view.d}
                  fallback={FALLBACK_COLOR[view.kind] ?? '#94a3b8'}
                  character={POSED_ROLES.has(view.role) && view.h >= Math.max(view.w, view.d)}
                />
              </group>
            )}
          </group>
        ),
      )}
    </>
  );
}

/** Podklad scény v barvách sady prostředí (P26 T11): dráha běžce, hladina pod plošinami, zem pod trubkami, rekvizity. */
function Backdrop({ control, length, look }: { readonly control: string; readonly length: number; readonly look: Look }) {
  const span = length + 60;
  if (control === 'platform') {
    const water = PLATFORM.fallBelowY / UNIT - 0.4;
    return (
      <>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, water, span / 2 - 30]}>
          <planeGeometry args={[80, span]} />
          <meshStandardMaterial color={look.water} roughness={0.3} />
        </mesh>
        <Scenery look={look} layout="behind" inner={11} from={-20} to={length + 20} y={water} size={1.6} />
      </>
    );
  }
  if (control === 'flap') {
    // Úzký pás země: z boku je to proužek pod trubkami a za ním obloha. Široká
    // plocha by z výšky kamery zabrala spodní půlku obrazu a spolkla dolní trubky.
    return (
      <>
        <mesh position={[0, -0.4, span / 2 - 30]}>
          <boxGeometry args={[3, 0.8, span]} />
          <meshStandardMaterial color={look.ground} roughness={1} />
        </mesh>
        {/* Boční kamera vidí kulisy za tratí malé a v mlze: dvojnásobná velikost (P28D T6). */}
        <Scenery look={look} layout="behind" inner={12} from={-20} to={length + 20} y={-0.4} size={2} />
      </>
    );
  }
  if (control === 'shooter' || control === 'throw') {
    return (
      <>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 20]} renderOrder={UNDER_PANORAMA}>
          <planeGeometry args={[120, 120]} />
          <meshStandardMaterial color={look.ground} roughness={1} depthWrite={false} />
        </mesh>
        {control === 'shooter' ? <Scenery look={look} layout="sides" inner={14} from={-4} to={60} size={1.5} /> : <Scenery look={look} layout="behind" inner={13} from={-10} to={45} size={1.5} />}
      </>
    );
  }
  const trackLength = length + 20;
  const trackWidth = (RUNNER.lanes * RUNNER.laneWidth) / UNIT;
  const laneWidth = RUNNER.laneWidth / UNIT;
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, trackLength / 2 - 10]}>
        <planeGeometry args={[trackWidth + 0.6, trackLength]} />
        <meshStandardMaterial color={look.track} roughness={0.9} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.03, trackLength / 2 - 10]} renderOrder={UNDER_PANORAMA}>
        <planeGeometry args={[80, trackLength + 80]} />
        <meshStandardMaterial color={look.ground} roughness={1} depthWrite={false} />
      </mesh>
      <Scenery look={look} layout="sides" inner={trackWidth / 2 + 2.5} from={-10} to={trackLength - 10} />
      {[-0.5, 0.5].map((edge) => (
        <mesh key={edge} rotation={[-Math.PI / 2, 0, 0]} position={[edge * laneWidth, 0, trackLength / 2 - 10]}>
          <planeGeometry args={[0.08, trackLength]} />
          <meshBasicMaterial color="#e2e8f0" />
        </mesh>
      ))}
    </>
  );
}

const JUMP_KEYS = new Set([' ', 'arrowup', 'w']);

/** Běžec: ťuk/klik/mezerník = skok (hned při stisku), šipky/A-D a swipe = pruh, šipka dolů / swipe dolů = skluz. */
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
    const onEnd = () => gesture.end();
    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerup', onEnd);
    element.addEventListener('pointercancel', onEnd);
    return () => {
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onEnd);
      element.removeEventListener('pointercancel', onEnd);
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
      const at = (event.clientX - box.left) / Math.max(1, box.width);
      if (at >= 0.5) session.press(BUTTON.TAP);
      else {
        pointers.set(event.pointerId, at < 0.25 ? 'left' : 'right');
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

/** Střelba doplňku `+shoot` (P26D): F/J/Enter, na dotyku tlačítko ve scéně – skok a skluz zůstávají, kde byly. */
function useFireInput(session: ArcadeSession, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat || isTyping(event.target) || !FIRE_KEYS.has(event.key.toLowerCase())) return;
      event.preventDefault();
      session.press(BUTTON.FIRE);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session, active]);
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

/** Jak dlouho visí „+1“ nad hráčem a jak dlouho třese obraz po zásahu (P28C T3). */
export const SCORE_POP_MS = 500;
const SHAKE_MS = 150;

interface ScorePop {
  readonly id: number;
  readonly amount: number;
  /** Vodorovná poloha hráče na obrazovce v % (střed, když ji scéna nehlásí). */
  readonly left: number;
}

/**
 * Odezva nad plátnem (P28C T3), společná všem scénám: „+N“ nad hráčem při
 * bodu a otřes obrazu při zásahu. Je to DOM nad plátnem – žádný draw call
 * navíc, kamera scény ani stav relace se nemění. Poloha „+N“ je `data-player-x`,
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
      if (amount > 0) {
        const x = Number(surface.current?.dataset.playerX ?? 0);
        const pop = { id: (next += 1), amount, left: 50 + Math.max(-0.9, Math.min(0.9, Number.isFinite(x) ? x : 0)) * 50 };
        setPops((current) => [...current, pop]);
        later(SCORE_POP_MS, () => setPops((current) => current.filter((entry) => entry.id !== pop.id)));
      }
      const element = surface.current;
      if (element !== null && events.some((event) => event.kind === 'damage')) {
        // Znovu spustit animaci i při zásahu v jejím průběhu: bez přepočtu stylu by třída jen zůstala.
        element.classList.remove('play-stage-shake');
        void element.offsetWidth;
        element.classList.add('play-stage-shake');
        later(SHAKE_MS, () => element.classList.remove('play-stage-shake'));
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
        <span key={pop.id} className="play-score-pop" data-testid="score-pop" style={{ left: `${pop.left}%` }} aria-hidden="true">
          +{pop.amount}
        </span>
      ))}
    </>
  );
}

export default function ArcadeStage({
  session,
  cast,
  lookId = 'meadow',
  look: scene,
  enabled = true,
  overlay,
}: {
  readonly session: ArcadeSession;
  readonly cast: Cast;
  readonly lookId?: LookId;
  /** Sada upravená místem z věty (`sceneLook`, P30B T6); bez ní sada `lookId`. */
  readonly look?: Look;
  /** Hra je na obrazovce a běží (P28B T3); jinak vstup neposlouchá – po konci patří šipky feedu a klávesy formuláři. */
  readonly enabled?: boolean;
  /* P29D */
  /** Vrstva nad plátnem (počasí a denní doba živé změny) – mimo scénu i hash. */
  readonly overlay?: ReactNode;
}) {
  const surface = useRef<HTMLDivElement | null>(null);
  // Doplňky obalí ovládání (`addon_control`); kamera, scéna i vstup se řídí tím pod obalem.
  const base = baseControlOf(session.world.control);
  const control = base.id;
  const fires = session.world.rules.some((rule) => rule.id === 'blaster');
  const look = scene ?? LOOKS[lookId];
  const env = useContext(PlayEnv);
  const draws = CAPABILITIES[control as ControlId]?.setting === true;
  // Soupeř souboje z popisku (P27A T4): riggovaná postava stojí, model katalogu se vepíše do těla.
  const rival = cast.props.rival;
  const character = rival === undefined ? undefined : riggedCharacter(rival);
  const rivalModel: RivalModel | undefined =
    rival === undefined
      ? undefined
      : (w, h, d) => (character !== undefined ? <RiggedModel character={character} h={h} clip={() => 'idle'} fallback="#64748b" /> : <FittedModel id={rival} w={w} h={h} d={d} fallback="#64748b" />);
  // P30B T4: nota rytmu a díl věže z popisku („lily pads“, „pancakes“); díl vyplní kvádr, šířku mu mění jádro.
  const { note, block } = cast.props;
  const noteModel: BodyModel | undefined = note === undefined ? undefined : (w, h, d) => <FittedModel id={note} w={w} h={h} d={d} fallback="#0ea5e9" />;
  const blockModel: BodyModel | undefined = block === undefined ? undefined : (w, h, d) => <FittedModel id={block} w={w} h={h} d={d} fallback="#0ea5e9" fill />;
  useFireInput(session, fires && enabled);
  useRunnerInput(session, surface, enabled && control === 'runner');
  usePlatformInput(session, surface, enabled && control === 'platform');
  useFlapInput(session, surface, enabled && control === 'flap');
  useSteerInput(session, surface, enabled && control === 'steer');
  useArenaInput(session, surface, enabled && control === 'move_free');
  useTapInput(session, surface, enabled && (control === 'timing' || control === 'rhythm'));
  useDuelInput(session, surface, enabled && control === 'duel');
  // Pauza a konec běhu kreslí jen na požádání (P28E T2, F-33): hodiny stojí, obraz se nemění.
  // Po konci ale ještě END_CLIP_MS naplno – klip pádu či oslavy (P28C T3) by jinak stál na prvním snímku.
  const ticking = useSyncExternalStore(session.subscribe, () => session.snapshot().runState === 'running' && !session.paused(), () => true);
  const ended = useSyncExternalStore(session.subscribe, () => session.snapshot().runState !== 'running', () => false);
  const [settling, setSettling] = useState(false);
  useEffect(() => {
    if (!ended) return;
    setSettling(true);
    const timer = window.setTimeout(() => setSettling(false), END_CLIP_MS);
    return () => window.clearTimeout(timer);
  }, [ended]);
  const live = ticking || settling;
  return (
    // `data-setting` = sada, jejíž kulisy scéna opravdu kreslí (P27A T3); scéna bez sad ho nemá.
    <div ref={surface} className="play-stage" data-testid="arcade-stage" data-control={control} data-look={lookId} data-setting={draws ? lookId : undefined} style={{ touchAction: 'none' }}>
      <Canvas camera={{ position: [0, 3.4, -6.5], fov: 60 }} dpr={[1, 2]} frameloop={live ? 'always' : 'demand'}>
        <RedrawOnChange session={session} />
        <FrameProbe control={control} />
        <RenderProbe />
        {/* Panorama prostředí z věty (P29C T5) za každou scénou; do prvního snímku jen barva oblohy. */}
        {env !== null && <Panorama env={env} />}
        {/* Načasování, rytmus a souboj (P25H) mají vlastní scénu se světly i pozadím. */}
        {control === 'timing' ? (
          <TimingScene session={session} look={look} blockModel={blockModel} />
        ) : control === 'rhythm' ? (
          <RhythmScene session={session} look={look} noteModel={noteModel} />
        ) : control === 'duel' ? (
          <DuelScene session={session} look={look} rivalModel={rivalModel} />
        ) : (
          <>
            <color attach="background" args={[look.sky]} />
            <fog attach="fog" args={[look.sky, ...look.fog]} />
            <FarAtFog far={look.fog[1]} />
            <hemisphereLight args={[...look.light]} />
            {/* Boční scény svítí ze strany kamery (−x). */}
            <directionalLight position={[control === 'runner' || control === 'shooter' ? 6 : -6, 12, -4]} intensity={look.sun} />
            {control === 'move_free' ? (
              <ArenaWorld session={session} half={Number(base.params.half)} surface={surface} look={look} />
            ) : (
              <World session={session} control={control} cast={cast} surface={surface} scene={look} enabled={enabled} />
            )}
          </>
        )}
      </Canvas>
      {overlay /* P29D */}
      <EventFeedback session={session} surface={surface} />
      {fires && enabled && <FireButton session={session} />}
    </div>
  );
}
