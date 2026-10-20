'use client';

import { renderHeld } from './effects/render-feel';

/**
 * Sdílený svět tratí (P32-0 T5, přesunuto beze změny z `ArcadeStage.tsx`):
 * smyčka `useFrame` posouvá hodiny relace (pevný krok v `session.ts`) a kreslí
 * těla interpolovaná mezi posledními dvěma tiky. Běžec a závod (`steer/`) mají
 * kameru za a nad hráčem, plošinovka a poletování boční kameru (trať jde zleva
 * doprava), střelnice a hřiště hodu vlastní rig s kamerou a vstupem
 * (`shooter/`, `throw/`, P25G).
 *
 * Běžec a plošinovka ho berou přes vlastní obal (`runner/RunnerWorld.tsx`,
 * `platform/PlatformWorld.tsx`); poletování, střelnice, hod a závod ho kreslí
 * přímo.
 *
 * Modely: `/assets/worldstream/game/<id>-lod1.glb` podle id těla (`hurdle`,
 * `coin`, …); když katalog id nemá (404), kreslí se barevný kvádr. Tělesa,
 * pro která model v katalogu není (plošiny, hroty, trubky, ptáček), se
 * kreslí rovnou primitivem a nestahují se.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Box3, BoxGeometry, type BufferGeometry, type Group, type Object3D, type PerspectiveCamera, PlaneGeometry, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { ARCADE_HZ, BODY, FLAG, HEADER, ROLE, UNIT, bodyBase } from '@/play/arcade/contract';
import { baseControlOf } from '@/play/arcade/addons';
import type { Look } from '@/play/arcade/look';
import { type PropRole, fitScale, riggedCharacter } from '@/play/arcade/models';
import { type ClipState, type Pose, clipOf, posesOf, viewOf } from '@/play/arcade/motion';
import { FLAP } from '@/play/arcade/pieces/flap';
import { STRUCTURE_KINDS } from '@/play/arcade/pieces/runner-sections';
import { type SteerCourse, centerAt } from '@/play/arcade/pieces/steer';
import { type ToyPose, toyPoseOf, toyViewOf } from '@/play/arcade/toy-motion';
import type { HeroAction } from '@/play/spec';

import { type BodyView, PACING_KINDS, PACING_SHOT_KINDS, SPARK_KIND, bodiesOf, bodiesStale, drawsNothing } from './bodies';
import { headingOf, turnToward } from './characterMotion';
import { blinkHidden } from './effects/feel';
import { type ArcadeGhost, GhostSlot } from './GhostSlot';
import { applyIntro, introLeft, useIntroClock } from './look/intro';
import { loadBodyModel, rimLit, toyPartsOf } from './look/load';
import { deformBody } from './look/toy-deform';
import { HeroActionBody } from './hero-action/HeroActionBody';
import { type Ink, InkOutline } from './look/rig/InkOutline';
import { RiggedModel } from './RiggedModel';
import { type Path, bendGeometry, bridgesOverChasm, runnerPathOf, slopeAt } from './runner/path';
import type { ArcadeSession } from './session';
import { SHOT_PRIMITIVES, ShotPrimitive } from './shooter/primitives';
import { ShooterRig } from './shooter/ShooterRig';
import { GlideBackdrop, GLIDE_SCENE_KINDS, placeGlide } from './glide/GlideScene';
import { WalkerBackdrop, WALKER_SCENE_KINDS, placeWalker } from './walker/WalkerScene';
import { BallBackdrop, BALL_SCENE_KINDS, placeBall } from './ball/BallScene';
import { SteerBackdrop, placeChase } from './steer/SteerScene';
import { ThrowRig } from './throw/ThrowRig';
import { type ToyTarget, applyToy, toyIdleOf, toyMotionOn, toyTickOf } from './toy/applyToy';
import { bodyClassOf, motionOf } from './toy/body-class';
import { type Spot, chaserSpot, placeAngled, placePlatform, placeRunner, placeSide } from './track-camera';
import { WorldBackdrop } from './WorldBackdrop';

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
const PRIMITIVE = new Set(['platform', 'platform-moving', 'spikes', 'pipe', 'ceiling', 'bird', 'turbo', 'pool', ...SHOT_PRIMITIVES]);

/** Modely z popisků rolí (`@/play/arcade/models`): hrdina, nepřítel střelnice a rekvizity. */
export interface Cast {
  readonly player: string;
  readonly enemy: string;
  /** Pronásledovatel doplňku `+chaser`. */
  readonly chaser: string;
  /** Boss od režiséra (P46E T4): tělo druhu `kind` kreslí model jeho věci z obsazení místo pronásledovatele. */
  readonly boss?: { readonly kind: string; readonly model: string };
  readonly props: Partial<Record<PropRole, string>>;
  readonly things?: Readonly<Record<string, string>>;
  readonly objectives?: Readonly<Record<number, string>>;
}

/** Překážky běžce, které smí nést model z popisku; skluzová laťka tvarem říká „podlez“, tu ne. */
const SWAPPABLE_OBSTACLES: ReadonlySet<string> = new Set(['hurdle', 'cone', 'crate']);

/** Id těla → id modelu v katalogu. Hráč, nepřítel, mince, překážka a terč berou model z popisku role, když ho katalog má. */
export function modelIdOf(view: BodyView, cast: Cast): string {
  if (cast.objectives?.[view.index] !== undefined) return cast.objectives[view.index]!;
  if (view.kind.startsWith('thing:')) {
    const id = view.kind.slice(6);
    // Věc pravidel bez modelu z popisku (P46E T6, demo: `thing:turbo` auta → 404 na `thing:turbo-lod1.glb`): tvar svého jména, jinak krystal.
    return cast.things?.[id] ?? (PRIMITIVE.has(id) ? id : 'crystal');
  }
  if (view.role === ROLE.player) return cast.player;
  if (cast.boss !== undefined && view.kind === cast.boss.kind) return cast.boss.model;
  if (PACING_KINDS.has(view.kind)) return cast.chaser;
  if (PACING_SHOT_KINDS.has(view.kind)) return 'bullet';
  // P35 T3: cíl skákačky z věty („moon“, „battery“); bez modelu v katalogu vlajka.
  if (view.kind === 'finish') return cast.props.finish ?? 'finish-flag';
  if (view.kind === 'goal' && cast.props.finish !== undefined) return cast.props.finish;
  if (view.kind === 'enemy' || view.kind === 'guard' || view.kind === 'goalkeeper' || view.kind === 'opponent-forward') return cast.enemy;
  if (view.kind === 'glide-rival') return cast.props.rival ?? cast.enemy;
  // Soupeř závodu (P27A T4): vozidlo z popisku role `rival`, jinak auto soupeře.
  if (view.kind === 'rival-car') return cast.props.rival ?? view.kind;
  if (view.kind === 'turbo') return cast.props.turbo ?? view.kind;
  // P46C: power-up (`powerup_magnet` …) vlastní model nemá – krystal, ne 404 na `powerup_shield-lod1.glb`.
  // Totéž jiskra stezky finále chodce (`WALKER_FINALE`, P51 T3): `spark-lod1.glb` neleží nikde.
  if (view.role === ROLE.powerup || view.kind === SPARK_KIND) return 'crystal';
  if (view.role === ROLE.chaser) return cast.chaser;
  if (view.role === ROLE.collectible && view.kind === 'coin') return cast.props.coin ?? view.kind;
  if (view.role === ROLE.obstacle && SWAPPABLE_OBSTACLES.has(view.kind)) return cast.props.obstacle ?? view.kind;
  // P30B T4: mantinel závodu z popisku role `barrier` („crocodiles“ podél řeky).
  if (view.role === ROLE.obstacle && view.kind === 'tire-barrier') return cast.props.barrier ?? view.kind;
  // P28D T3: kostky věže hodu jsou terč – „cardboard boxes“ postaví věž z krabic.
  if (view.role === ROLE.target && (view.kind === 'target' || view.kind === 'wood-block')) return cast.props.target ?? view.kind;
  // P39 T9: nástraha z věty – bodák skákačky, trubka poletování, útes a koule plavby – nese model svého jména.
  const hazard = hazardTagOf(view);
  if (hazard !== undefined) return cast.props[hazard] ?? view.kind;
  return view.kind;
}

/** Role nástrahy, kterou tělo kreslí (`HAZARD_ROLES` v `@/play/arcade/models`). */
function hazardTagOf(view: BodyView): 'spikes' | 'pipe' | 'hazard' | undefined {
  if (view.kind === 'spikes' || view.kind === 'pipe') return view.kind;
  return view.role === ROLE.hazard && (view.kind === 'snag' || view.kind === 'shot') ? 'hazard' : undefined;
}

/**
 * Trubka poletování s modelem z věty (P39 T9): sloupec modelů po buňkách zhruba šířky trubky –
 * jeden model vepsaný do celé výšky by se zmenšil na šířku a srážka by trčela do prázdna.
 */
function ModelColumn({ id, w, h, d, fallback }: { readonly id: string; readonly w: number; readonly h: number; readonly d: number; readonly fallback: string }) {
  const cells = Math.max(1, Math.round(h / Math.max(w, d)));
  const cell = h / cells;
  return (
    <>
      {Array.from({ length: cells }, (_, index) => (
        <group key={index} position={[0, index * cell, 0]}>
          <FittedModel id={id} w={w} h={cell} d={d} fallback={fallback} />
        </group>
      ))}
    </>
  );
}

/**
 * Model vepsaný do kvádru těla (metry), postavený na zem, střed v ose; postava výškou těla (`fitScale`).
 * `fill` kvádr vyplní v každé ose zvlášť – díl věže, kterému jádro mění šířku (P30B T4).
 * Model je slitý do jedné sítě (`loadBodyModel`) a jeho matice jsou zmrazené: hýbe se
 * jen skupina těla a póza nad ním, přepočet vnitřku modelu každý snímek by byl zbytečný.
 */
interface Fit {
  readonly id: string;
  readonly w: number;
  readonly h: number;
  readonly d: number;
  readonly character?: boolean;
  readonly fill?: boolean;
  /** Role, která se hýbe (P45D T7): díly a deformace z `catalog-motion.json` pro `applyToy`. */
  readonly posed?: boolean;
  /** Postava – hrdina, nepřítel, soupeř (P54B T14): okrajový svit `rimLit`. */
  readonly rim?: boolean;
}

/** Díly a deformace vepsaného modelu, který se hýbe – smyčka `World` je najde pod vnitřní skupinou pózy. */
const toyBits = new WeakMap<Object3D, Pick<ToyTarget, 'parts' | 'deform'>>();

/** Hračkový cíl vnitřní skupiny pózy: skupina a díly a deformace modelu, který v ní leží. */
export function toyTargetOf(inner: Object3D): ToyTarget {
  const model = inner.children[0];
  return { group: inner, ...(model === undefined ? undefined : toyBits.get(model)) };
}

/** Klon modelu vepsaný do kvádru těla; tělo, které se hýbe, dostane vlastní deformaci a pivoty s živou maticí. */
export function fitModel(model: Object3D, { id, w, h, d, character = false, fill = false, posed = false, rim = false }: Fit): Object3D {
  const copy = model.clone(true);
  // Svit před deformací: kopie deformace volá úpravu shaderu zdroje, svit tak nese i ohnuté tělo.
  if (rim) rimLit(copy);
  const box = new Box3().setFromObject(copy);
  const size = box.getSize(new Vector3());
  const along = (length: number): number => Math.max(length, 1e-3);
  const uniform = fitScale(size, { x: w, y: h, z: d }, character);
  const scale = fill ? new Vector3(w / along(size.x), h / along(size.y), d / along(size.z)) : new Vector3(uniform, uniform, uniform);
  copy.scale.copy(scale);
  const center = box.getCenter(new Vector3());
  copy.position.set(-center.x * scale.x, -box.min.y * scale.y, -center.z * scale.z);
  if (posed) toyBits.set(copy, { parts: toyPartsOf(copy), deform: deformBody(copy, motionOf(id)?.regions) });
  copy.traverse((node) => {
    node.updateMatrix();
    node.matrixAutoUpdate = node.userData.toyPart !== undefined;
  });
  return copy;
}

export function FittedModel({ id, w, h, d, fallback, character = false, fill = false, posed = false, rim = false }: Fit & { readonly fallback: string }) {
  const [model, setModel] = useState<Object3D | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void loadBodyModel(id, { posed }).then((loaded) => {
      if (live) setModel(loaded);
    });
    return () => {
      live = false;
    };
  }, [id, posed]);
  const fitted = useMemo(
    () => (model === null || model === undefined ? null : fitModel(model, { id, w, h, d, character, fill, posed, rim })),
    [model, id, w, h, d, character, fill, posed, rim],
  );
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
function Primitive({ id, w, h, d, block, water }: { readonly id: string; readonly w: number; readonly h: number; readonly d: number; readonly block?: Look['block']; readonly water?: string }) {
  if (SHOT_PRIMITIVES.has(id)) return <ShotPrimitive id={id} w={w} h={h} d={d} block={block?.[1]} />;
  if (id === 'turbo') return <mesh position={[0, h / 2, 0]}>
    <boxGeometry args={[w, h, d]} />
    <meshStandardMaterial color={FALLBACK_COLOR.turbo} emissive={FALLBACK_COLOR.turbo} emissiveIntensity={0.35} roughness={0.4} />
  </mesh>;
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
  // Voda pod mezerou skákačky (P46D T5): hladina těsně pod hranou pádu.
  if (id === 'pool') return <mesh position={[0, h / 2, 0]}>
    <boxGeometry args={[w * 3, h, d]} />
    <meshStandardMaterial color={water ?? '#0284c7'} roughness={0.15} metalness={0.2} transparent opacity={0.8} />
  </mesh>;
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

const RUNNER_STRUCTURES: ReadonlySet<string> = new Set(STRUCTURE_KINDS);
const BRIDGE = { deck: '#a16207', rail: '#57534e', chasm: '#0f172a', posts: 2 } as const;
/** Žebra tunelu: rozteč a hloubka (m) – mezi nimi kamera nad stropem hrdinu pořád vidí. */
const TUNNEL = { ribEvery: 2.5, ribDepth: 0.35, wall: 0.5 } as const;

interface StructurePart {
  readonly geometry: BufferGeometry;
  readonly color: string;
}

interface StructureShape {
  readonly w: number;
  readonly h: number;
  readonly d: number;
  readonly z: number;
  readonly lift: number;
  readonly side: number;
  readonly path: Path;
  readonly look: Look;
  readonly chasm: boolean;
}

/**
 * Sítě stavby běžce (P46D T3) ohnuté po křivce trati: zeď rozcestí, půlka mostu nad vodou
 * či propastí (každé těleso vody kreslí svou stranu – hladinu ven do údolí, zábradlí a půlku
 * mostovky ke středu) a tunel ze stěn a žeber. `side` = strana tělesa ve scéně (−1, 0, 1),
 * `lift` = výška spodku tělesa nad dráhou (m).
 */
function structureParts(kind: string, { w, h, d, z, lift, side, path, look, chasm }: StructureShape): StructurePart[] {
  const segments = Math.max(1, Math.ceil(d));
  const box = (bw: number, bh: number, bd: number, x: number, y: number, at = 0): BufferGeometry =>
    bendGeometry(new BoxGeometry(bw, bh, bd, 1, 1, bd >= 1 ? segments : 1).translate(x, y, at), path, z);
  const [stone, cap] = look.block ?? ['#78716c', '#a8a29e'];
  const along = (every: number): number[] => Array.from({ length: Math.max(1, Math.floor(d / every)) }, (_, i) => -d / 2 + every / 2 + i * every);
  if (kind === 'divider') return [{ geometry: box(w, h, d, 0, h / 2), color: stone }, { geometry: box(w + 0.16, 0.12, d, 0, h + 0.06), color: cap }];
  if (kind === 'water') {
    const inner = -side * (w / 2);
    const surface = new PlaneGeometry(15, d, 1, segments).rotateX(-Math.PI / 2).translate(inner + side * 7.5, 0.03, 0);
    return [
      { geometry: bendGeometry(surface, path, z), color: chasm ? BRIDGE.chasm : look.water },
      { geometry: box(w / 2, 0.06, d, inner - (side * w) / 4, 0.03), color: BRIDGE.deck },
      { geometry: box(0.08, 0.08, d, inner, 0.95), color: BRIDGE.rail },
      { geometry: box(0.08, 0.08, d, inner, 0.5), color: BRIDGE.rail },
      ...along(BRIDGE.posts).map((at) => ({ geometry: box(0.1, 0.95, 0.1, inner, 0.475, at), color: BRIDGE.rail })),
    ];
  }
  // Strop tunelu visí ve výšce těla (`lift`): stěny sahají od dráhy po jeho vršek.
  const ground = -lift;
  return [
    ...[-1, 1].map((edge) => ({ geometry: box(TUNNEL.wall, h - ground, d, edge * (w / 2 + TUNNEL.wall / 2), (h + ground) / 2), color: stone })),
    ...along(TUNNEL.ribEvery).map((at) => ({ geometry: box(w + 2 * TUNNEL.wall, h, TUNNEL.ribDepth, 0, h / 2, at), color: cap })),
  ];
}

function RunnerStructure({ kind, w, h, d, z, lift, side, path, look, chasm }: { readonly kind: string } & StructureShape) {
  // Díly jedné barvy slité do jedné sítě: sloupky zábradlí a žebra tunelu nestojí volání kreslení každý zvlášť.
  const parts = useMemo(() => {
    const byColor = new Map<string, BufferGeometry[]>();
    for (const part of structureParts(kind, { w, h, d, z, lift, side, path, look, chasm })) byColor.set(part.color, [...(byColor.get(part.color) ?? []), part.geometry]);
    return [...byColor].map(([color, geometries]): StructurePart => {
      if (geometries.length === 1) return { color, geometry: geometries[0]! };
      const geometry = mergeGeometries(geometries)!;
      geometries.forEach((source) => source.dispose());
      return { color, geometry };
    });
  }, [kind, w, h, d, z, lift, side, path, look, chasm]);
  useEffect(() => () => parts.forEach((part) => part.geometry.dispose()), [parts]);
  return (
    <>
      {parts.map((part, index) => (
        <mesh key={index} geometry={part.geometry}>
          <meshStandardMaterial color={part.color} roughness={0.85} />
        </mesh>
      ))}
    </>
  );
}

function lerp(from: number, to: number, alpha: number): number {
  return from + (to - from) * alpha;
}

const DEG = Math.PI / 180;

/**
 * Rezerva k vzdálené rovině, kterou `FarAtFog` (`look/rig/StyleRig.tsx`) staví na konec mlhy:
 * kamera se dorovná až po tělech a největší tělo je kolem 10 m.
 */
const FAR_MARGIN_M = 12;

/** Role, které sonda záběru bere jako cíl nebo hrozbu; mantinely závodu jsou kulisa, ne cíl. */
const FRAME_TARGET_ROLES: ReadonlySet<number> = new Set([ROLE.obstacle, ROLE.collectible, ROLE.chaser, ROLE.hazard, ROLE.enemy, ROLE.target]);
const frameTagOf = (view: BodyView): 'hero' | 'target' | undefined =>
  view.role === ROLE.player ? 'hero' : (FRAME_TARGET_ROLES.has(view.role) || view.kind.startsWith('thing:part_')) && view.kind !== 'tire-barrier' ? 'target' : undefined;

/** Obrys těla (P36C T6): hrdina inkoustem, nepřítel a pronásledovatel rajčatovou, ostatní bez obrysu. */
const inkOf = (view: BodyView): Ink | undefined =>
  view.role === ROLE.player ? 'hero' : view.role === ROLE.enemy || view.role === ROLE.chaser || PACING_KINDS.has(view.kind) ? 'foe' : undefined;

/**
 * Role věty, jejíž popisek tělo kreslí (P30B T5) – totéž rozhodnutí jako `modelIdOf`
 * a `arcadeScene` v `fidelity/chain.ts`. Nota, díl věže a soupeř souboje mají vlastní scény.
 */
function itemTagOf(view: BodyView): 'enemy' | 'chaser' | PropRole | undefined {
  if (view.role === ROLE.player) return undefined;
  if (view.kind === 'enemy') return 'enemy';
  if (view.kind === 'rival-car') return 'rival';
  if (view.kind === 'turbo') return 'turbo';
  if (view.kind === 'finish') return 'finish';
  if (view.role === ROLE.chaser) return 'chaser';
  if (view.role === ROLE.collectible && view.kind === 'coin') return 'coin';
  if (view.role === ROLE.obstacle && SWAPPABLE_OBSTACLES.has(view.kind)) return 'obstacle';
  if (view.role === ROLE.obstacle && view.kind === 'tire-barrier') return 'barrier';
  if (view.role === ROLE.target && (view.kind === 'target' || view.kind === 'wood-block')) return 'target';
  return hazardTagOf(view);
}

export interface WorldProps {
  readonly session: ArcadeSession;
  readonly control: string;
  readonly cast: Cast;
  readonly surface: React.RefObject<HTMLDivElement | null>;
  readonly scene: Look;
  readonly enabled: boolean;
  /** Podklad místo výchozího (`WorldBackdrop`): údolí běžce kreslí `RunnerWorld` (P32A T3). */
  readonly backdrop?: React.ReactNode;
  /** Viditelná činnost hrdiny (P37-0 T2); `none` = dnešní hra. Jen vzhled, jádro ji nečte. */
  readonly heroAction: HeroAction;
  /** Duch dřívějšího běhu (P37B T8) pro slot scény; `undefined` = bez ducha. */
  readonly ghost?: ArcadeGhost;
}

const PICKUP_MS = 200;

/** Role, jejichž model se hýbe podle stavu těla (P26B); plošiny, auta a překážky jedou bez pózy. */
const POSED_ROLES: ReadonlySet<number> = new Set([ROLE.player, ROLE.enemy, ROLE.chaser]);

/** Pod touhle rychlostí (m/s) se postava plošinovky neotáčí – drží směr, kterým šla. */
const TURN_MIN_MPS = 0.5;
/** Jak rychle se postava dotočí po směru (1/s). */
const TURN_RATE = 12;

export function World({ session, control, cast: baseCast, surface, scene, enabled, backdrop, heroAction, ghost }: WorldProps) {
  const cast = useMemo(() => {
    const objectives: Record<number, string> = {};
    for (const rule of session.world.rules) if (rule.id === 'objective_order') {
      for (const node of rule.params.nodes as { body: number; goal: string; action: string }[]) {
        const kind = session.world.kinds[session.world.initial[bodyBase(node.body) + BODY.kind]!]!;
        objectives[node.body] = node.goal.startsWith('__item') ? kind : node.action === 'collect' ? 'key' : node.action === 'open' ? 'exit-door' : 'finish-flag';
      }
    }
    return { ...baseCast, objectives };
  }, [baseCast, session]);
  // Střely a hody přidává jádro za běhu (`spawn`) – seznam se staví znovu, když se změní.
  const [views, setViews] = useState(() => bodiesOf(session));
  const groups = useRef<(Group | null)[]>([]);
  const posed = useRef<(Group | null)[]>([]);
  const poses = useRef<(Pose | null)[]>([]);
  /** Riggovaná postava po indexu těla (P26B T5) a klip, který jí scéna v tomhle snímku volí. */
  const rigged = useMemo(() => views.map((view) => riggedCharacter(modelIdOf(view, cast))), [views, cast]);
  const clips = useRef<ClipState[]>([]);
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  // Zakřivená trať běžce (P46D T3): těla, stavby i kamera jdou po křivce; jádro dál běží rovně.
  const path = useMemo(() => (control === 'runner' ? runnerPathOf(session.world) : null), [control, session]);
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
  // Zásah hráče (P36C T7): hodiny kresby (ms) a chvíle zásahu na nich – hit-stop a blikání; tik kvůli restartu.
  const drawClock = useRef(0);
  const hurtAt = useRef(-Infinity);
  const lastTick = useRef(0);
  // Pohyb postav (P36C T8): natočení po směru (rad, po indexu těla); hračková póza (P45D T7) s pamětí minulého snímku.
  const yaws = useRef<(number | undefined)[]>([]);
  const toyPoses = useRef<(ToyPose | undefined)[]>([]);
  const bodyClasses = useMemo(() => views.map((view) => bodyClassOf(modelIdOf(view, cast))), [views, cast]);
  useEffect(
    () =>
      session.onEvents((events) => {
        if (events.some((event) => event.kind === 'damage')) hurtAt.current = drawClock.current;
      }),
    [session],
  );

  // Role těl, pro která scéna postavila model – doplněk, který jádro hraje a scéna nekreslí, e2e takhle pozná.
  useEffect(() => {
    if (surface.current !== null) surface.current.dataset.drawn = [...new Set(views.filter((view) => cast.objectives[view.index] !== undefined || !drawsNothing(view)).map((view) => ROLE_NAMES[view.role]))].join(' ');
  }, [views, surface, cast]);

  useFrame((_, delta) => {
    drawClock.current += delta * 1000;
    const alpha = session.advance(delta * 1000);
    if (bodiesStale(views, session)) setViews(bodiesOf(session));
    const state = session.state();
    const prev = session.prev();
    if ((state[HEADER.tick] as number) < lastTick.current) {
      hurtAt.current = -Infinity;
      yaws.current = [];
      toyPoses.current = [];
    }
    lastTick.current = state[HEADER.tick] as number;
    // Hit-stop (P36C T7, jako `FightFx` v aréně): jádro odtikalo, kresba i kamera 60 ms stojí.
    const sinceHurt = drawClock.current - hurtAt.current;
    if (renderHeld(session)) return;
    // Póza jen čte stav; tik s podílem rozběhnutého kroku, ať poskok neskáče po 1/60 s.
    const tick = (state[HEADER.tick] as number) + alpha;
    posesOf(state, prev, poses.current, tick);
    const reduced = !toyMotionOn();
    const toyTick = toyTickOf(session);
    const turn = 1 - Math.exp(-delta * TURN_RATE);
    // Poloha těla ve scéně (m), x zrcadlené jako níž u `group.position`.
    const spotAt = (index: number): Spot => {
      const base = bodyBase(index);
      return {
        x: -lerp(prev[base + BODY.x] as number, state[base + BODY.x] as number, alpha) / UNIT,
        y: lerp(prev[base + BODY.y] as number, state[base + BODY.y] as number, alpha) / UNIT,
        z: lerp(prev[base + BODY.z] as number, state[base + BODY.z] as number, alpha) / UNIT,
      };
    };
    let shots = 0;
    for (const view of views) {
      const inner = posed.current[view.index];
      const pose = poses.current[view.index];
      const moving = POSED_ROLES.has(view.role) ? toyViewOf(state, prev, view.index) : null;
      // P39 T16: pronásledovatel z věty v záběru – běžci v patách, plošinovce na kraji obrazu (`track-camera.ts`).
      // Útočí-li běžci zepředu, otočí se k hrdinovi čelem; jinak běží po trati jako on.
      const drawn = view.role === ROLE.chaser ? chaserSpot(control, spotAt(state[HEADER.player] as number), spotAt(view.index), camera.far, camera.aspect) : null;
      if (drawn !== null && control === 'runner') yaws.current[view.index] = turnToward(yaws.current[view.index], drawn.oncoming ? Math.PI : 0, turn);
      // Plošinovka chodí oběma směry: postava se otočí, kam jde (P36C T8). Jinde drží směr scéna – běžec a let míří po trati, plavbu točí `VoyageHero`.
      if ((control === 'platform' || control === 'walker') && moving !== null && (Math.hypot(moving.vx, moving.vz) * ARCADE_HZ) / UNIT > TURN_MIN_MPS) {
        yaws.current[view.index] = turnToward(yaws.current[view.index], headingOf(moving.vx, moving.vz), turn);
      }
      // Hračková póza (P45D T7) podle stavu a třídy těla; mrtvý se převrhne, zásah blikne, výhra slaví, stojící dýchá (P54B T6).
      if (inner !== null && inner !== undefined && moving !== null) {
        const toy = toyPoseOf(moving, bodyClasses[view.index] ?? 'prop', toyPoses.current[view.index] ?? null, toyTick, reduced, toyIdleOf(session, view.index));
        toyPoses.current[view.index] = toy;
        applyToy(toyTargetOf(inner), toy, view.h, yaws.current[view.index] ?? 0);
      }
      // Po zásahu hrdina bliká (zhasíná vnitřek, ne skupinu – sondy záběru ji dál vidí).
      if (inner !== null && inner !== undefined && view.role === ROLE.player) inner.visible = !blinkHidden(sinceHurt);
      if (rigged[view.index] !== undefined && pose !== null && pose !== undefined) clips.current[view.index] = clipOf(moving ?? viewOf(state, prev, view.index), pose, tick);
      const group = groups.current[view.index];
      if (group === null || group === undefined) continue;
      const base = bodyBase(view.index);
      const z = drawn?.spot.z ?? lerp(prev[base + BODY.z] as number, state[base + BODY.z] as number, alpha) / UNIT;
      // Tělo za koncem mlhy (`FarAtFog`) by kamera stejně ořízla; skryté vypadne i z přepočtu
      // matic, který jinak prochází celou trať každý snímek (P28E-R1). Kamera je ze snímku předtím.
      // Hráč nikdy: po restartu stojí kamera ještě u cíle, a skrytý hrdina by se už nepohnul (P32A T8-R1).
      const inRange = view.role === ROLE.player || Math.abs(z - camera.position.z) <= camera.far + FAR_MARGIN_M;
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
      if (drawn !== null) group.position.set(drawn.spot.x, drawn.spot.y, z);
      else {
        // Kamera běžce kouká po +z, takže +x jádra by vyšlo na obrazovce vlevo a „LEFT“ (x − 1) by hráče poslal doprava.
        group.position.set(
          -lerp(prev[base + BODY.x] as number, state[base + BODY.x] as number, alpha) / UNIT,
          lerp(prev[base + BODY.y] as number, state[base + BODY.y] as number, alpha) / UNIT,
          z,
        );
      }
      if (path !== null) {
        const at = path(z);
        group.position.x += at.x;
        group.position.y += at.y;
        // Překážka stojí napříč zatáčkou; stavbu ohýbá síť, minci točí scéna, hrdinu natočí `HeroPose`.
        if (view.role !== ROLE.player && view.role !== ROLE.collectible && !RUNNER_STRUCTURES.has(view.kind)) group.rotation.y = Math.atan(slopeAt(path, z).x);
      }
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
        placePlatform(camera, look, z, followY.current);
      } else if (control === 'flap') {
        // Na počítači ptáček blíž středu (v levém horním rohu by ho zakryl HUD) a kamera
        // tak daleko, ať je vidět první trubka i mince za ní (P30B T5). Na výšku by kolmá
        // kamera ptáčka zmenšila na 3 % výšky: natočená do tří čtvrtin ho má přes 4 %
        // a první trubku i minci pořád v záběru.
        if (camera.aspect < 1) placeAngled(camera, look, z, FLAP.ceiling / UNIT / 2, 22, 50 * DEG, 5);
        else placeSide(camera, look, z, FLAP.ceiling / UNIT / 2, 30, FLAP.ceiling / UNIT + 1, 26, 0.1);
      } else if (control === 'glide') {
        placeGlide(camera, look, x, y, z);
      } else if (control === 'walker') {
        placeWalker(camera, look, x, z);
      } else if (control === 'ball') {
        placeBall(camera, look);
      } else if (control === 'steer') {
        // Osa trati je v jednotkách jádra a scéna ji zrcadlí (x → −x), stejně jako těla.
        const course = baseControlOf(session.world.control).params.course as SteerCourse | undefined;
        placeChase(camera, look, x, z, course === undefined ? 0 : -centerAt(course, z * UNIT) / UNIT);
      } else if (control === 'shooter' || control === 'throw') {
        // Kameru střelnice a hřiště staví jejich scéna (`ShooterRig`, `ThrowRig`).
      } else {
        // Hrdina je už na křivce; kamera chce jeho pruh a křivku zvlášť.
        placeRunner(camera, look, path === null ? x : x - path(z).x, z, path ?? undefined);
      }
      if (control !== 'shooter' && control !== 'throw') applyIntro(camera, look, introLeft(introClock()));
      camera.updateMatrixWorld();
      // Kde je hráč na obrazovce (−1 vlevo … 1 vpravo) – e2e tím hlídá směr, z obrázku se to nepřečte.
      if (surface.current !== null) surface.current.dataset.playerX = projected.copy(player.position).project(camera).x.toFixed(3);
    }
  });

  return (
    <>
      {backdrop ??
        (control === 'glide' ? <GlideBackdrop session={session} look={scene} collectibleModel={cast.props.coin} />
        : control === 'walker' ? <WalkerBackdrop session={session} look={scene} />
        : control === 'ball' ? <BallBackdrop session={session} look={scene} />
        : control === 'steer' ? (
          <SteerBackdrop session={session} course={baseControlOf(session.world.control).params.course as SteerCourse | undefined} length={session.world.length / UNIT} look={scene} heroAction={heroAction} ghost={ghost} namedHazard={cast.props.hazard !== undefined} namedPad={cast.things?.pad} />
        ) : (
          <WorldBackdrop control={control} length={session.world.length / UNIT} look={scene} seed={session.world.seed} />
        ))}
      {control === 'shooter' && <ShooterRig session={session} surface={surface} enabled={enabled} heroAction={heroAction} ghost={ghost} />}
      {control === 'throw' && <ThrowRig session={session} surface={surface} enabled={enabled} heroAction={heroAction} ghost={ghost} />}
      {views.map((view) =>
        // Branka poletování je neviditelná: jen počítá průlet mezerou; počítadlo komba scéna nekreslí taky.
        (drawsNothing(view) && cast.objectives[view.index] === undefined) || (control === 'glide' && GLIDE_SCENE_KINDS.has(view.kind)) || (control === 'walker' && WALKER_SCENE_KINDS.has(view.kind)) || (control === 'ball' && BALL_SCENE_KINDS.has(view.kind)) ? null : (
          <group key={view.index} ref={(group) => { groups.current[view.index] = group; }} userData={{ frame: frameTagOf(view), item: itemTagOf(view) }}>
            {/* Činnost hrdiny (P37B T2): ostatní těla a `none` dostanou model beze změny stromu. */}
            <HeroActionBody action={view.role === ROLE.player ? heroAction : 'none'} session={session} h={view.h}>
            {path !== null && RUNNER_STRUCTURES.has(view.kind) ? (
              <RunnerStructure
                kind={view.kind}
                w={view.w}
                h={view.h}
                d={view.d}
                z={(session.world.initial[bodyBase(view.index) + BODY.z] as number) / UNIT}
                lift={(session.world.initial[bodyBase(view.index) + BODY.y] as number) / UNIT}
                side={-Math.sign(session.world.initial[bodyBase(view.index) + BODY.x] as number)}
                path={path}
                look={scene}
                chasm={bridgesOverChasm(session.world.seed)}
              />
            ) : PRIMITIVE.has(modelIdOf(view, cast)) ? (
              <Primitive id={modelIdOf(view, cast)} w={view.w} h={view.h} d={view.d} block={scene.block} water={scene.water} />
            ) : rigged[view.index] !== undefined ? (
              // Riggovaná postava hraje klipy – poskok a zmáčknutí statických modelů by se s nimi praly.
              <RiggedModel
                character={rigged[view.index]!}
                h={view.h}
                clip={() => clips.current[view.index] ?? 'idle'}
                fallback={FALLBACK_COLOR[view.kind] ?? '#94a3b8'}
                // Klip hráče čte e2e z DOM – z obrázku se nepřečte.
                onClip={view.role === ROLE.player ? (state) => { if (surface.current !== null) surface.current.dataset.animClip = state; } : undefined}
                yaw={control === 'platform' || control === 'walker' || view.role === ROLE.chaser ? () => yaws.current[view.index] ?? 0 : undefined}
                // Stavy bez klipu (výhra, nesení, výpad) dohraje hračkový pohyb (P45D T13).
                toy={POSED_ROLES.has(view.role) ? () => ({ view: toyViewOf(session.state(), session.prev(), view.index), tick: toyTickOf(session) }) : undefined}
              />
            ) : view.kind === 'pipe' ? (
              <ModelColumn id={modelIdOf(view, cast)} w={view.w} h={view.h} d={view.d} fallback={FALLBACK_COLOR[view.kind] ?? '#94a3b8'} />
            ) : (
              <group ref={(group) => { posed.current[view.index] = POSED_ROLES.has(view.role) ? group : null; }}>
                {/* Terč je tenký kotouč; model z popisku (kachna) by se vepsal do jeho tloušťky – kreslí se hloubkou jako šířkou, srážky se nemění. */}
                {/* Totéž cíl skákačky z věty (P35 T3): páska 0,4 m by měsíc zmenšila na kamínek; vlajka zůstává v pásce. */}
                {/* Postava stojí ve výšce těla (P30B T3); vozidlo má tělo nízké a dlouhé, to se dál vepisuje celé. */}
                <FittedModel
                  id={modelIdOf(view, cast)}
                  w={view.w}
                  h={view.h}
                  d={view.kind === 'target' || ((view.kind === 'finish' || view.kind === 'goal') && cast.props.finish !== undefined) ? Math.max(view.d, view.w) : view.d}
                  fallback={FALLBACK_COLOR[view.kind] ?? '#94a3b8'}
                  character={POSED_ROLES.has(view.role) && view.h >= Math.max(view.w, view.d)}
                  posed={POSED_ROLES.has(view.role)}
                  rim={POSED_ROLES.has(view.role)}
                />
              </group>
            )}
            </HeroActionBody>
            {/* Obrys až za modelem: běžec bere první dítě skupiny jako vnitřní pózu (`HeroPose`, poskok jízdy pryč). */}
            {inkOf(view) !== undefined && <InkOutline ink={inkOf(view)!} />}
          </group>
        ),
      )}
      {/* Slot ducha (P37-0 T3): ostatní žánry tohohle světa ho drží ve své scéně, poletování vlastní nemá. */}
      {control === 'flap' && <GhostSlot ghost={ghost} session={session} />}
    </>
  );
}
