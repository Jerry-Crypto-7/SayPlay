'use client';

import { renderHeld } from '../effects/render-feel';

/**
 * Scéna závodu (P25F T6): kamera za vozidlem a nad ním, asfalt po úsecích
 * trati mezi mantinely, tráva okolo. Vstup: šipky/A-D a tah prstem do strany
 * drží osu (zatáčení), šipka dolů/S nebo druhý prst drží brzdu.
 *
 * Kreslí se s `x` jádra zrcadleným (jako běžec): kamera kouká po +z, takže
 * +x jádra by jinak vyšlo vlevo a „vpravo“ by točilo doleva.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BoxGeometry, type Camera, Color, Frustum, type InstancedMesh, Matrix4, MeshBasicMaterial, MeshStandardMaterial, type Object3D, type PerspectiveCamera, Plane, Raycaster, Vector2, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { color } from '@/brand/tokens';
import { baseControlOf } from '@/play/arcade/addons';
import { ARCADE_HZ, type ArcadeWorld, BODY, FLAG, HEADER, UNIT, bodyBase, nativeRule, rampedSpeed } from '@/play/arcade/contract';
import { type Look, SURFACES, sparseLandmarks } from '@/play/arcade/look';
import { STEER, type SteerCourse } from '@/play/arcade/pieces/steer';
import type { HeroAction } from '@/play/spec';

import { type ArcadeGhost, GhostSlot } from '../GhostSlot';
import { isTyping } from '../input';
import { FieldGround } from '../look/FieldGround';
import { type Box, buildRoadGround } from '../look/ground';
import { Landmark } from '../look/Landmark';
import type { Volume } from '../look/landmark-places';
import { type IslandSpot, buildIslands, islandPalette } from '../look/rig/terrain/islands';
import { hash } from '../look/rig/terrain/valley';
import { BEFORE_COMPOSER } from '../look/rig/Post';
import { roadGeometry, stripCurve, windowAlongZ } from '../look/road-strip';
import { buildWater } from '../look/rig/terrain/water';
import { UNDER_PANORAMA } from '../look/under-panorama';
import { HorizonBackdrop } from '../look/Backdrop';
import { Scenery } from '../look/Scenery';
import { Vegetation } from '../look/Vegetation';
import type { ArcadeSession } from '../session';
import { FittedModel } from '../World';
import { keySteer } from './key-steer';
import { BARRIER_W, roadShapeOf } from './road-shape';
import { type DriveInputMode, driveInput } from './drive-input';
import { VoyageHero } from './VoyageHero';
import { type VoyageLayout, centerOf, nearShotsInView, voyageLayoutOf } from './voyageLayout';

/** Přistávací plochu kreslí `VoyageBackdrop` (i model z věty); `World` ji nekreslí znovu – `pad-lod1.glb` neexistuje (P56B T3). */
export const STEER_SCENE_KINDS: ReadonlySet<string> = new Set(['pad']);

/**
 * Kamera za autem: dojíždí za ním do strany, kouká kus před něj. Na výšku
 * (mobil) je nízká kamera tak úzká, že soupeř nebo turbo vedle auta (~6 m
 * do strany) leží mimo obraz – stoupne a ustoupí do strmého pohledu shora,
 * auto zůstává přes 24 px (P27A T6, `e2e/play-frame`). Vychýlení se měří od
 * středu trati `road`, ne od počátku: auto u mantinelu a soupeř u druhého
 * kraje se na výšku vejdou jen s kamerou napůl nad silnicí (P30B T5).
 */
export function placeChase(camera: PerspectiveCamera, look: Vector3, x: number, z: number, road: number): void {
  // Plavba (P32F T4): ovládání osu trati nenese, bere se z rozvržení; přistání má vlastní záběr.
  const voyage = voyageCams.get(camera);
  if (voyage?.layout.mode === 'land') {
    placeLander(camera, look, x, voyage.hero?.position.y ?? voyage.layout.hero.y, z, voyage.layout.pad, voyage.layout.hero.h);
    return;
  }
  if (voyage !== undefined) {
    placeVoyage(camera, look, x, z, centerOf(voyage.layout.course, z), voyage.layout.motion);
    return;
  }
  if (camera.aspect < 1) {
    camera.position.set(road + (x - road) * 0.5, 18, z - 18);
    look.set(road + (x - road) * 0.4, 0, z + 8);
  } else {
    camera.position.set(road + (x - road) * 0.8, 4.2, z - 8.5);
    look.set(road + (x - road) * 0.6, 0.8, z + 12);
  }
  camera.lookAt(look);
  // Small visual roll follows the car across the road, never the hashed world.
  camera.rotateZ(Math.max(-0.045, Math.min(0.045, (x - road) * 0.012)));
}

/**
 * Záběr závodu plavby (P35 T7). V přejímce byl pes hnědá kostička na silnici
 * (~4 % výšky obrazu) a loď „tiny dark boat“: kamera závodu na výšku stoupá
 * 18 m, aby viděla soupeře vedle auta – plavba soupeře nemá. Kamera jde nízko,
 * blízko a kus do strany, ať je vidět hlava i bok (u lodi stěžeň a plachta);
 * kouká kousek před hrdinu, ať trať před ním zůstane v obraze (`aheadInView`).
 * `up`/`back`/`side` = poloha kamery od hrdiny (m), `ahead` = kam kouká před něj.
 */
const VOYAGE_CAM = {
  // Na výšku víc do strany nejde: trať v zatáčce by vyjela z úzkého obrazu (−2,6 m = 1,9 s před psem).
  phone: { up: 4, back: 7, side: -1.6, ahead: 6 },
  desktop: { up: 3.6, back: 7.5, side: -3, ahead: 10 },
} as const;

/**
 * Loď je v kvádru těla řídká (stěžně, plachty, vesla): kvádr na snímku zabírá
 * ~10 % výšky, trup a plachty sotva polovinu. Kamera jde k ní blíž, kolize se nemění.
 */
const BOAT_NEAR = 0.65;

function placeVoyage(camera: PerspectiveCamera, look: Vector3, x: number, z: number, road: number, motion: VoyageLayout['motion']): void {
  const cam = camera.aspect < 1 ? VOYAGE_CAM.phone : VOYAGE_CAM.desktop;
  const near = motion === 'boat' ? BOAT_NEAR : 1;
  camera.position.set(road + (x - road) * 0.8 + cam.side * near, cam.up * near, z - cam.back * near);
  look.set(road + (x - road) * 0.6, 0.4, z + cam.ahead);
  camera.lookAt(look);
}

/** Horní okraj obrazu, kam hráč ještě vidí (NDC): nad ním leží lišta HUD s časem a cílem (~15 % výšky). */
const HUD_TOP_NDC = 0.7;

/**
 * Kolik sekund trati před hrdinou plnou rychlostí `speed` (m/s) je v záběru
 * (P35 T7): bod na ose trati jde po desetinách sekundy dopředu, dokud se
 * promítne do obrazu pod lištu HUD a blíž, než mlha všechno schová. Strop 6 s.
 */
function aheadInView(camera: Camera, course: SteerCourse | undefined, z: number, y: number, speed: number, fogFar: number, at: Vector3): number {
  let seen = 0;
  for (let step = 1; step <= 60; step += 1) {
    const ahead = z + (speed * step) / 10;
    at.set(centerOf(course, ahead), y, ahead);
    if (at.distanceTo(camera.position) > fogFar) break;
    at.project(camera);
    if (at.z > 1 || Math.abs(at.x) > 1 || Math.abs(at.y) > 1 || at.y > HUD_TOP_NDC) break;
    seen = step / 10;
  }
  return seen;
}

/** Nejmenší podíl výšky obrazu pro hrdinu přistání (P36C T5: cíl 8 %, s rezervou na náklon lodi). */
const LANDER_HERO_SHARE = 0.09;
/**
 * Jak daleko od středu obrazu smí hrdina být, když se plocha do záběru nevejde (podíl poloviny šířky / výšky).
 * Nahoru míň: horních ~15 % obrazu telefonu drží lišta HUD se štítkem cíle.
 */
const LANDER_REACH: readonly [x: number, y: number] = [0.7, 0.4];

/**
 * Záběr přistání: přistávač i plocha v obraze, zboku (let jde v rovině x–y).
 * Vzdálenost ze zorného úhlu a poměru stran, na výšku strop 80 m – dál by
 * loď zmizela v mlze vesmíru. Hrdina (`heroH` m) má ale aspoň 9 % výšky
 * obrazu (P36C T5, dřív 3,8 % na telefonu): když se loď s plochou nevejdou,
 * kamera zůstane blíž a střed záběru se posune k ploše, jen co hrdina nevyjede
 * z obrazu – plocha přijde do záběru, jak loď klesá.
 */
export function placeLander(camera: PerspectiveCamera, look: Vector3, x: number, y: number, z: number, pad: VoyageLayout['pad'], heroH: number): void {
  const [padX, padW] = pad === null ? [x, 10] : [pad.x, pad.w];
  const [left, right] = [Math.min(x - 3, padX - padW / 2 - 2), Math.max(x + 3, padX + padW / 2 + 2)];
  const [bottom, top] = [-1, y + 5];
  const tan = Math.tan((camera.fov * Math.PI) / 360);
  const fit = Math.min(80, Math.max(16, (top - bottom) / 2 / tan, (right - left) / 2 / (tan * camera.aspect)) * 1.1);
  const distance = Math.min(fit, heroH / (2 * tan * LANDER_HERO_SHARE));
  const [halfH, halfW] = [tan * distance, tan * distance * camera.aspect];
  const clamp = (value: number, at: number, reach: number): number => Math.min(at + reach, Math.max(at - reach, value));
  const cx = clamp((left + right) / 2, x, halfW * LANDER_REACH[0]);
  const cy = clamp((bottom + top) / 2, y, halfH * LANDER_REACH[1]);
  camera.position.set(cx, cy + distance * 0.12, z - distance);
  look.set(cx, cy, z);
  camera.lookAt(look);
}

/** Rozvržení plavby pro kameru (`placeChase` běží uvnitř `World`, relaci nezná) a skupina hrdiny, jejíž výšku World už nastavil. */
interface VoyageCam {
  readonly layout: VoyageLayout;
  hero: Object3D | null;
}
const voyageCams = new WeakMap<Camera, VoyageCam>();

/**
 * Relace pro scénu: `World` kreslí podklad závodu bez ní, takže ji sem
 * předá vstup (`useSteerInput`) přes plochu hry, ve které plátno leží.
 */
const steerSessions = new WeakMap<HTMLElement, ArcadeSession>();

/** Jak daleko za okrajem dráhy stojí první řada kulis (m) – mimo mantinely, na tělesa jádra nedosáhne. */
const SCENERY_MARGIN = 2.5;

/**
 * Podklad závodu. Plavba (P32F T4) místo silnice: moře s ostrovy, skály
 * nebo ulice města – pozná se z těl světa, relaci si scéna najde přes plochu
 * hry. Obyčejný závod kreslí asfalt jako dřív.
 */
export function SteerBackdrop({
  session,
  course,
  length,
  look,
  ghost,
  namedHazard = false,
  namedPad,
}: {
  readonly session: ArcadeSession;
  readonly course: SteerCourse | undefined;
  readonly length: number;
  readonly look: Look;
  readonly heroAction: HeroAction;
  readonly ghost?: ArcadeGhost;
  /** Nástraha plavby z věty (P39 T9): kreslí ji `World` modelem jejího jména, útesy a koule scény se schovají. */
  readonly namedHazard?: boolean;
  readonly namedPad?: string;
}) {
  const voyage = useVoyageSession();
  const shape = useMemo(() => roadShapeOf(session.world), [session.world]);
  // Silnice na startu (nejširší úsek a mantinel) pro orientační bod (P54B T8): bod jede s kamerou vedle ní.
  const roadArea = useMemo((): readonly Box[] => {
    const half = Math.max((course?.halfWidth ?? 5 * UNIT) / UNIT, ...shape.segments.map((segment) => segment.width / 2)) + BARRIER_W;
    const center = shape.segments[0]?.center ?? 0;
    return [{ x0: center - half, x1: center + half, z0: -Infinity, z1: Infinity }];
  }, [course, shape]);
  // Střed silnice po křivce úseků jako v `RoadBackdrop`: bod jede vedle zatáček, ne do nich.
  const roadBend = useMemo(() => {
    const segments = shape.segments.length > 0 ? shape.segments : segmentsOf(course).map((segment) => ({ ...segment, width: 0 }));
    if (segments.length === 0) return undefined;
    const curve = stripCurve(segments);
    return (z: number) => ({ x: curve(z).center });
  }, [course, shape]);
  return (
    <>
      {voyage !== null ? <VoyageBackdrop session={voyage.session} layout={voyage.layout} length={length} look={look} namedHazard={namedHazard} namedPad={namedPad} /> : <RoadBackdrop course={course} shape={shape} length={length} look={look} seed={session.world.seed} />}
      {voyage === null && <Landmark look={look} seed={session.world.seed} area={roadArea} bend={roadBend} follow="track" />}
      {/* Slot ducha (P37-0 T3) pro silnici i plavbu. */}
      <GhostSlot ghost={ghost} session={session} />
    </>
  );
}

function useVoyageSession(): { readonly session: ArcadeSession; readonly layout: VoyageLayout } | null {
  const gl = useThree((three) => three.gl);
  const [found, setFound] = useState<{ readonly session: ArcadeSession; readonly layout: VoyageLayout | null } | null>(null);
  const stage = useRef<HTMLElement | null>(null);
  // Plocha se do mostu zapíše efektem nadřazené komponenty, až po prvním snímku plátna – proto líně.
  useFrame(() => {
    stage.current ??= gl.domElement.closest<HTMLElement>('[data-testid="arcade-stage"]');
    const session = stage.current === null ? undefined : steerSessions.get(stage.current);
    if (session !== undefined && session !== found?.session) setFound({ session, layout: voyageLayoutOf(session.world) });
  });
  return found === null || found.layout === null ? null : { session: found.session, layout: found.layout };
}

/**
 * Silnice jako jeden pás po hladké křivce středů a šířek úseků (P46G T2):
 * povrch sady (asfalt se středovou čárou, hlína, písek, sníh, prkna), okraje
 * a mantinely po téže křivce, zem a kulisy sady prostředí (P27A T3) podél
 * každého úseku. Sada s vegetací (P46G T4) má místo nich vegetaci za volným
 * pásem a jednu řídkou řadu kulis po ose celé cesty.
 * Jen vzhled: jádro o nich neví, hash světa se nehne.
 */
function RoadBackdrop({ course, shape, length, look, seed, sceneryFrom = 0 }: { readonly course: SteerCourse | undefined; readonly shape?: RoadShape; readonly length: number; readonly look: Look; readonly seed: number; readonly sceneryFrom?: number }) {
  const span = length + 80;
  const half = (course?.halfWidth ?? 5 * UNIT) / UNIT;
  // Silnice z mantinelů světa ve skutečné šířce (P46D R2); bez nich z osy trati v šířce prvního úseku.
  const segments = useMemo(() => (shape !== undefined && shape.segments.length > 0 ? shape.segments : segmentsOf(course).map((segment) => ({ ...segment, width: half * 2 }))), [shape, course, half]);
  const strip = useMemo(() => (segments.length > 0 ? segments : [{ near: -60, far: span, center: 0, width: half * 2 }]), [segments, span, half]);
  const roadAt = useMemo(() => {
    const curve = stripCurve(strip);
    return (z: number) => {
      const { center, width } = curve(z);
      return { center, half: width / 2 };
    };
  }, [strip]);
  const centerAt = useMemo(() => (z: number) => ({ x: roadAt(z).center, y: 0 }), [roadAt]);
  const widest = Math.max(...strip.map((segment) => segment.width));
  const surface = SURFACES[look.surface];
  // Pás, okraje, značení a mantinely po jedné síti: úsek po úseku to byly desítky volání kreslení na snímek (P32F T4, telefon).
  const road = useMemo(() => {
    const wallH = STEER.wallH / UNIT;
    const walls = shape !== undefined && shape.barriers.length > 0;
    const built = roadGeometry(segments, surface, walls ? { height: wallH, thickness: BARRIER_W } : null);
    if (built === null) return null;
    // Ostrůvky rozcestí zůstávají kvádry jádra; s mantinely jedna síť (bez UV, které pás nemá).
    const islands = (shape?.islands ?? []).map((island) => new BoxGeometry(island.w, wallH, island.d).translate(island.x, wallH / 2, island.z).deleteAttribute('uv'));
    const barriers = built.walls === null && islands.length === 0 ? null : mergeGeometries([...(built.walls === null ? [] : [built.walls]), ...islands]);
    const windows = [built.surface, built.edges, built.marks, barriers].filter((geometry) => geometry !== null).map(windowAlongZ);
    return { ...built, barriers, windows };
  }, [segments, shape, surface]);
  useEffect(() => () => { road?.surface.dispose(); road?.edges.dispose(); road?.marks?.dispose(); road?.walls?.dispose(); road?.barriers?.dispose(); }, [road]);
  // Zem s odstíny, skvrnami, krajnicí podél cesty a tmavnutím do strany (P46G T3) – jedna síť místo roviny jedné barvy.
  const ground = useMemo(() => {
    const geometry = buildRoadGround(look, strip, -60, span);
    return { geometry, window: windowAlongZ(geometry) };
  }, [look, strip, span]);
  useEffect(() => () => ground.geometry.dispose(), [ground]);
  // Cesta, mantinely a zem jsou přes celou trať: kreslí se jen úsek kolem kamery (P54B T15d), kamera jízdy hledí po +z.
  useFrame(({ camera }) => {
    const [from, to] = [camera.position.z - ROAD_BEHIND_M, camera.position.z + (camera as PerspectiveCamera).far + ROAD_AHEAD_M];
    for (const window of [...(road?.windows ?? []), ground.window]) window(from, to);
  }, BEFORE_COMPOSER);
  const afloat = look.afloat === true;
  return (
    <>
      <mesh geometry={ground.geometry} position={[0, -0.03, 0]} renderOrder={UNDER_PANORAMA}>
        <meshStandardMaterial vertexColors roughness={1} depthWrite={false} />
      </mesh>
      {road !== null && (
        <>
          {/* Pás, okraje a značení leží na zemi: stín jen přijímají, rig by je jinak kreslil i do stínové mapy (P54B T15d). */}
          <mesh geometry={road.surface} receiveShadow userData={{ rigShadow: 'receive' }}>
            {/* Závod po řece jede po hladině (`afloat`, P30B T6), jinak po povrchu sady. */}
            <meshStandardMaterial color={afloat ? look.water : surface.color} roughness={afloat ? 0.3 : 0.9} />
          </mesh>
          <mesh geometry={road.edges} receiveShadow userData={{ rigShadow: 'receive' }}>
            <meshStandardMaterial color={surface.edge} roughness={0.9} />
          </mesh>
          {road.marks !== null && !afloat && 'marks' in surface && (
            <mesh geometry={road.marks} receiveShadow userData={{ rigShadow: 'receive' }}>
              <meshStandardMaterial color={surface.marks.color} roughness={0.9} />
            </mesh>
          )}
          {road.barriers !== null && (
            <mesh geometry={road.barriers} castShadow receiveShadow>
              <meshStandardMaterial color={color.tomato} roughness={0.7} />
            </mesh>
          )}
        </>
      )}
      {look.flora !== undefined && <Vegetation flora={look.flora} seed={seed} from={-60} to={span} road={roadAt} clear={VEGETATION_CLEAR} />}
      {sparseLandmarks(look) ? (
        // Vedle vegetace jedna řídká řada kulis po ose celé cesty: řada na úsek by na krátkých úsecích kulisy zahustila.
        <Scenery look={look} layout="sides" inner={widest / 2 + SCENERY_MARGIN} from={-10} to={span - 2} bend={centerAt} vegetation />
      ) : (
        // Hustá řada na úsek; vedle výplně (P54B T7) bez druhů výplně, ty kreslí `Vegetation`.
        segments.map((segment, i) =>
          segment.far - segment.near < sceneryFrom ? null : (
            <group key={i} position={[segment.center, 0, (segment.near + segment.far) / 2]}>
              <Scenery look={look} layout="sides" inner={segment.width / 2 + SCENERY_MARGIN} from={-(segment.far - segment.near) / 2} to={(segment.far - segment.near) / 2 - 2} vegetation={look.flora !== undefined} />
            </group>
          ),
        )
      )}
      {/* Kulisa za mlhou (P46G T6): průsek nejbližší vrstvy nad nejširším úsekem silnice. */}
      <HorizonBackdrop look={look} seed={seed} length={length} clear={widest / 2 + SCENERY_MARGIN} />
    </>
  );
}

/** Volný pás vegetace za krajem silnice (m): mantinel a kus krajnice, ať je na cestu vidět i v zatáčce. */
const VEGETATION_CLEAR = BARRIER_W + 1;
/** Okno cesty a země kolem kamery (m): za ní, a za koncem mlhy (`FarAtFog`) jako vegetace. */
const ROAD_BEHIND_M = 15;
const ROAD_AHEAD_M = 12;

interface Segment {
  readonly near: number;
  readonly far: number;
  readonly center: number;
}

type RoadShape = ReturnType<typeof roadShapeOf>;

/** Úseky trati ve scéně (m): od konce předchozího (první 20 m před startem) do svého konce, střed zrcadlený. */
function segmentsOf(course: SteerCourse | undefined): Segment[] {
  return (course?.ends ?? []).map((end, i) => {
    const near = i === 0 ? -20 * UNIT : (course!.ends[i - 1] as number);
    return { near: near / UNIT, far: end / UNIT, center: -(course!.centers[i] as number) / UNIT };
  });
}

/** Hladina moře (m): trup lodi (spodní stěna těla ve výšce 0) je o tolik ponořený. */
const WATER_LEVEL = 0.3;
const SEA_PLANE = new Plane(new Vector3(0, 1, 0), -WATER_LEVEL);
/** Voda sahá od kamery tolik zpátky (m, `buildWater`). */
const WATER_FROM = -40;
/** Břeh kanálu: šířka desky a výška nad hladinou (m). U skal je deska vysoká jako mantinel. */
const BANK_W = 8;
const BANK_TOP = 1.1;
/** Deska ostrůvku vyčnívá bokem ven až o tolik (m, `islands.ts`) – o tolik stojí od kanálu. */
const SLAB_BULGE = 0.32;
/** Kulisa, která by stála ve vodě, se schová pod hladinu. */
const SUNK = -8;
/** Kulisa za mlhou plavby po moři stojí na hladině. */
const AT_SEA = (): number => WATER_LEVEL;

/** Zem kaňonu a přistání s odstíny a skvrnami (P46G T7) – dřív jedna barva sady; do stran a za cíl jako dřívější rovina. */
function VoyageLand({ look, reach, far }: { readonly look: Look; readonly reach: number; readonly far: number }) {
  const area = useMemo(() => ({ x0: -reach - 110, x1: reach + 110, z0: -80, z1: far + 40 }), [reach, far]);
  return <FieldGround look={look} area={area} y={-0.03} under />;
}
/** Záře: barva × tolik je nad prahem bloomu (`bloomThreshold`), bez tone mappingu. */
const GLOW = 3;
/** Stopa dělové koule: kolik posledních poloh. */
const TRAIL = 8;
/** Lišta brány visí pod kamerou (4,2 m), ať nepřekryje hrdinu. */
const GATE_BAR = 3.2;

/** Úsek kratší než tohle je zatáčka (10 m): kulisy jen na rovinkách, na telefonu je každá kulisa znát. */
const STRAIGHT_M = 15;

const glowMaterial = (hex: string, scale = GLOW): MeshBasicMaterial => new MeshBasicMaterial({ color: new Color(hex).multiplyScalar(scale), toneMapped: false });

/** Barvy trámů bran: brána před hráčem září žlutě, projetá zezelená, cíl září rajčatově. */
const beamColors = {
  gate: new Color(color.sun).multiplyScalar(GLOW),
  passed: new Color(color['mint-deep']).multiplyScalar(1.4),
  goal: new Color(color.tomato).multiplyScalar(GLOW),
};

/** Jeden trám brány (m, střed a rozměry); `gate` = index brány v rozvržení, −1 = cíl. */
interface Beam {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
  readonly h: number;
  readonly d: number;
  readonly gate: number;
}

/** Brány a cíl: dva sloupy na hranách kanálu a lišta pod kamerou. */
function archesOf(layout: VoyageLayout, half: number): Beam[] {
  const arch = (x: number, z: number, w: number, gate: number): Beam[] => [
    ...[-1, 1].map((side) => ({ x: x + side * (w / 2 + 0.25), y: GATE_BAR / 2, z, w: 0.35, h: GATE_BAR + 0.2, d: 0.35, gate })),
    { x, y: GATE_BAR, z, w: w + 0.85, h: 0.22, d: 0.22, gate },
  ];
  const goal = layout.goal === null ? [] : arch(layout.goal.x, layout.goal.z, Math.max(layout.goal.w, 2 * half), -1);
  return [...layout.gates.flatMap((gate, i) => arch(gate.x, gate.z, gate.w, i)), ...goal];
}

/** Břehy kanálu z desek ostrůvků (vnitřní hrana přesně u mantinelu), za nimi kulaté ostrovy; u přistání stolové hory v poušti. */
function shoreOf(layout: VoyageLayout, far: number): IslandSpot[] {
  const spots: IslandSpot[] = layout.walls.map((wall) => ({
    x: wall.inner + wall.side * (SLAB_BULGE + BANK_W / 2),
    z: wall.z,
    w: BANK_W,
    d: wall.d,
    top: layout.terrain === 'rocks' ? wall.h : BANK_TOP,
  }));
  const half = (layout.course?.halfWidth ?? 5 * UNIT) / UNIT;
  if (layout.terrain === 'islands')
    for (let z = 12; z < far - 20; z += 26)
      for (const side of [-1, 1]) {
        const r = hash(z, side + 5);
        const size = 7 + 8 * r;
        spots.push({ x: centerOf(layout.course, z) + side * (half + BANK_W + 6 + size / 2 + 8 * hash(side + 9, z)), z: z + 10 * hash(z + 3, side), w: size, d: size * (0.8 + 0.4 * r), top: 1.4 + 2.4 * r, round: true });
      }
  if (layout.mode === 'land')
    for (let i = 0; i < 10; i += 1) {
      const r = hash(i, 41);
      spots.push({ x: -75 + i * 16 + 6 * hash(i, 7), z: 30 + 45 * hash(i, 13), w: 6 + 12 * r, d: 5 + 9 * hash(i, 17), top: 1.5 + 7 * hash(i, 23), round: true });
    }
  return spots;
}

/**
 * Plavba (P32F T4): moře s vlnami a pěnou u břehů, břehy kanálu z ostrůvků
 * (u skal skalní stěny, ve městě ulice), brány a cíl září, dělové koule mají
 * stopu, přistávací plocha svítí. Šedé kvádry, které `World` za tyto druhy
 * těl kreslí (model nemá), se schovají – běží po `World`, protože se připojí
 * až s rozvržením.
 */
function VoyageBackdrop({ session, layout, length, look, namedHazard, namedPad }: { readonly session: ArcadeSession; readonly layout: VoyageLayout; readonly length: number; readonly look: Look; readonly namedHazard: boolean; readonly namedPad?: string }) {
  const camera = useThree((three) => three.camera);
  const scene = useThree((three) => three.scene);
  const gl = useThree((three) => three.gl);
  const far = length + look.fog[1] + 10;
  const sea = layout.terrain === 'islands';
  const islands = useMemo(() => buildIslands({ look, islands: shoreOf(layout, far), base: sea ? WATER_LEVEL : 0 }), [layout, look, far, sea]);
  const water = useMemo(
    () => (sea ? buildWater({ look, half: layout.reach + 60, from: WATER_FROM, to: far, level: WATER_LEVEL, shore: islands.shoreDistance }) : null),
    [sea, look, layout, far, islands],
  );
  const landMaterial = useMemo(() => new MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }), []);
  const glow = useMemo(() => ({ gate: glowMaterial(color.sun), goal: glowMaterial(color.tomato), pad: glowMaterial(color['mint-deep']) }), []);
  const rock = useMemo(() => islandPalette(look).rock, [look]);
  useEffect(() => () => islands.geometry.dispose(), [islands]);
  useEffect(() => () => { water?.geometry.dispose(); water?.material.dispose(); }, [water]);
  useEffect(() => () => { landMaterial.dispose(); for (const material of Object.values(glow)) material.dispose(); }, [landMaterial, glow]);

  const cam = useRef<VoyageCam>({ layout, hero: null });
  useEffect(() => {
    const entry: VoyageCam = { layout, hero: null };
    cam.current = entry;
    voyageCams.set(camera, entry);
    return () => {
      if (voyageCams.get(camera) === entry) voyageCams.delete(camera);
    };
  }, [camera, layout]);
  const stage = useMemo(() => gl.domElement.closest<HTMLElement>('[data-testid="arcade-stage"]'), [gl]);
  // Třída pohybu hrdiny – e2e ji čte z DOM (z obrázku se nepozná).
  useEffect(() => {
    if (stage === null) return;
    stage.dataset.heroClass = layout.motion;
    return () => {
      delete stage.dataset.heroClass;
      delete stage.dataset.waterInView;
      delete stage.dataset.shotsInView;
      delete stage.dataset.aheadS;
    };
  }, [stage, layout]);

  const half = (layout.course?.halfWidth ?? 5 * UNIT) / UNIT;
  const segments = useMemo(() => segmentsOf(layout.course), [layout]);
  // Brány, cíl a překážky jako instance: jedno volání kreslení za druh místo desítek (telefon se 4× CPU).
  const arches = useMemo(() => archesOf(layout, half), [layout, half]);
  const beams = useRef<InstancedMesh>(null);
  const passed = useRef<boolean[]>([]);
  const shots = useMemo(() => layout.hazards.filter((hazard) => hazard.kind === 'shot'), [layout]);
  const snags = useMemo(() => layout.hazards.filter((hazard) => hazard.kind === 'snag'), [layout]);
  const shotMesh = useRef<InstancedMesh>(null);
  const snagMesh = useRef<InstancedMesh>(null);
  const shotAt = useMemo(() => shots.map(() => ({ at: new Vector3(), alive: true })), [shots]);
  const trail = useRef<InstancedMesh>(null);
  const history = useMemo(() => shots.map(() => ({ points: new Float32Array(TRAIL * 3), next: 0, filled: 0 })), [shots]);
  // Před prvním snímkem: barvy instancí musí existovat, než se materiál přeloží.
  useLayoutEffect(() => {
    const mesh = beams.current;
    if (mesh === null) return;
    const matrix = new Matrix4();
    arches.forEach((beam, i) => {
      mesh.setMatrixAt(i, matrix.makeScale(beam.w, beam.h, beam.d).setPosition(beam.x, beam.y, beam.z));
      mesh.setColorAt(i, beam.gate < 0 ? beamColors.goal : beamColors.gate);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    passed.current = [];
  }, [arches]);
  const scratch = useMemo(() => ({ matrix: new Matrix4(), ray: new Raycaster(), ndc: new Vector2(), frustum: new Frustum(), point: new Vector3(), frame: 0 }), []);
  const params = baseControlOf(session.world.control).params as { readonly topSpeed?: number; readonly ramp?: readonly number[] };
  const bodies = useRef<Object3D[]>([]);

  useFrame(() => {
    if (renderHeld(session)) return;
    const seconds = performance.now() / 1000;
    water?.setTime(seconds);
    const state = session.state();
    scratch.frame += 1;
    // Těla, která World kreslí: hrdinu nechat (a dát kameře), ostatní kreslí tahle scéna.
    // Plavba těla za běhu nepřidává; znovu hledat jen bez hrdiny (restart s novou relací).
    if (cam.current.hero?.parent == null) {
      const found: Object3D[] = [];
      scene.traverse((node) => {
        if (Object.hasOwn(node.userData, 'frame')) found.push(node);
      });
      bodies.current = found;
    }
    for (const body of bodies.current) {
      if (body.userData.frame === 'hero') cam.current.hero = body;
      else if (!namedHazard || body.userData.item !== 'hazard') body.visible = false;
    }
    const playerZ = (state[bodyBase(state[HEADER.player] as number) + BODY.z] as number) / UNIT;
    // Projetá brána zezelená (všechny tři trámy).
    const mesh = beams.current;
    if (mesh !== null && mesh.instanceColor !== null) {
      let changed = false;
      arches.forEach((beam, i) => {
        if (beam.gate < 0) return;
        const done = playerZ > layout.gates[beam.gate]!.z;
        if (passed.current[i] === done) return;
        passed.current[i] = done;
        mesh.setColorAt(i, done ? beamColors.passed : beamColors.gate);
        changed = true;
      });
      if (changed) mesh.instanceColor.needsUpdate = true;
    }
    const aliveAt = (index: number): boolean => ((state[bodyBase(index) + BODY.flags] as number) & FLAG.alive) !== 0;
    if (shotMesh.current !== null) {
      shots.forEach((shot, i) => {
        const base = bodyBase(shot.index);
        const now = shotAt[i]!;
        now.alive = aliveAt(shot.index);
        now.at.set(-(state[base + BODY.x] as number) / UNIT, (state[base + BODY.y] as number) / UNIT + WATER_LEVEL + 0.5, (state[base + BODY.z] as number) / UNIT);
        const s = now.alive ? shot.w : 0;
        shotMesh.current!.setMatrixAt(i, scratch.matrix.makeScale(s, s, s).setPosition(now.at));
      });
      shotMesh.current.instanceMatrix.needsUpdate = true;
    }
    if (snagMesh.current !== null) {
      snags.forEach((snag, i) => {
        const s = aliveAt(snag.index) ? 1 : 0;
        snagMesh.current!.setMatrixAt(i, scratch.matrix.makeScale(snag.w * s, snag.h * 1.8 * s, snag.d * s).setPosition(snag.x, sea ? WATER_LEVEL : 0, snag.z));
      });
      snagMesh.current.instanceMatrix.needsUpdate = true;
    }
    // Stopa koulí: posledních TRAIL poloh, každá menší; mrtvá koule stopu nekreslí.
    if (trail.current !== null) {
      shots.forEach((_, i) => {
        const now = shotAt[i]!;
        const track = history[i]!;
        if (now.alive && scratch.frame % 2 === 0) {
          track.points.set([now.at.x, now.at.y, now.at.z], track.next * 3);
          track.next = (track.next + 1) % TRAIL;
          track.filled = Math.min(TRAIL, track.filled + 1);
        }
        for (let k = 0; k < TRAIL; k += 1) {
          const at = (track.next - 1 - k + TRAIL) % TRAIL;
          const s = now.alive && k < track.filled ? 0.8 * (1 - k / TRAIL) : 0;
          scratch.matrix.makeScale(s, s, s).setPosition(track.points[at * 3]!, track.points[at * 3 + 1]!, track.points[at * 3 + 2]!);
          trail.current!.setMatrixAt(i * TRAIL + k, scratch.matrix);
        }
      });
      trail.current.instanceMatrix.needsUpdate = true;
    }
    // Voda v záběru: paprsky pod hrdinou (střed a strany dolní třetiny) padnou na hladinu, ne na ostrov.
    // Hladina je na CPU rovná (vlny kreslí shader): průsečík s rovinou a pata ostrova (`shoreDistance`
    // na souši záporná). Paprsek přes sítě vody a ostrovů stál pirátovi ~10 % CPU (P37B T7, Pixel 7 4×).
    if (water !== null && stage !== null && scratch.frame % 60 === 1) {
      let hits = 0;
      const half = layout.reach + 60;
      for (const x of [-0.6, 0, 0.6]) {
        scratch.ray.setFromCamera(scratch.ndc.set(x, -0.6), camera);
        const at = scratch.ray.ray.intersectPlane(SEA_PLANE, scratch.point);
        if (at !== null && Math.abs(at.x) <= half && at.z >= WATER_FROM && at.z <= far && islands.shoreDistance(at.x, at.z, 1) > 0) hits += 1;
      }
      stage.dataset.waterInView = String(hits);
    }
    // Dělové koule v záběru a blízko (dál je v mlze skoro nevidět) – e2e na ně počká a vyfotí je.
    if (stage !== null && shots.length > 0 && scratch.frame % 10 === 1) {
      scratch.frustum.setFromProjectionMatrix(scratch.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      stage.dataset.shotsInView = String(nearShotsInView(shotAt, camera.position, scratch.frustum));
    }
    // Kolik trati před sebou hráč vidí plnou rychlostí (P35 T7) – e2e hlídá, že blízká kamera nezkrátila výhled.
    if (stage !== null && layout.mode === 'race' && scratch.frame % 10 === 5) {
      const zUnits = state[bodyBase(state[HEADER.player] as number) + BODY.z] as number;
      const speed = (rampedSpeed(params.topSpeed ?? STEER.topSpeed, zUnits, params.ramp) / UNIT) * ARCADE_HZ;
      stage.dataset.aheadS = aheadInView(camera, layout.course, playerZ, sea ? WATER_LEVEL : 0, speed, look.fog[1], scratch.point).toFixed(1);
    }
  });

  const ground = layout.terrain === 'islands' ? SUNK : 0;
  // Orientační bod (P54B T8) vedle kanálu: na ostrově na jeho zemi, jinde na hladině nebo zemi kaňonu; jede s kamerou.
  const landmarkArea = useMemo((): readonly Box[] => {
    const center = centerOf(layout.course, 0);
    return [{ x0: center - half - SCENERY_MARGIN, x1: center + half + SCENERY_MARGIN, z0: -Infinity, z1: Infinity }];
  }, [layout, half]);
  const landmarkGround = useMemo(() => (x: number, z: number): number => islands.heightAt(x, z) ?? (sea ? WATER_LEVEL : 0), [islands, sea]);
  const landmarkBend = useMemo(() => (z: number) => ({ x: centerOf(layout.course, z) }), [layout]);
  // Přistání (P54B T15a): sloup nad plochou, kam loď sedá (loď samu hlídá obdélník hrdiny). Celý koridor od lodi
  // na plochu by byl obdélník přes celý záběr – kamera rámuje právě loď a plochu – a bod by nestál nikde.
  const landmarkPlay = useMemo((): readonly Volume[] => {
    const { pad, hero } = layout;
    if (pad === null) return [];
    return [{ x0: pad.x - pad.w / 2, y0: pad.y, z0: pad.z - pad.d / 2, x1: pad.x + pad.w / 2, y1: pad.y + pad.h + 3 * hero.h, z1: pad.z + pad.d / 2 }];
  }, [layout]);

  return (
    <>
      <Landmark look={look} seed={session.world.seed} area={landmarkArea} ground={landmarkGround} bend={landmarkBend} play={landmarkPlay} follow="track" />
      {layout.terrain === 'buildings' ? (
        <RoadBackdrop course={layout.course} length={length} look={look} seed={session.world.seed} sceneryFrom={STRAIGHT_M} />
      ) : water !== null ? (
        <mesh geometry={water.geometry} material={water.material} receiveShadow userData={{ rigShadow: 'receive', terrain: 'water' }} />
      ) : (
        <VoyageLand look={look} reach={layout.reach} far={far} />
      )}
      {layout.terrain !== 'buildings' && (
        <>
          {/* Kulisa za mlhou (P46G T7): na moři z hladiny, v kaňonu ze země; průsek nad kanálem. Přistání ne – kamera letí ve výšce rakety a prstenec by z ní byl zeď na zemi. */}
          {layout.mode !== 'land' && <HorizonBackdrop look={look} seed={session.world.seed} length={length} clear={half + SCENERY_MARGIN} ground={sea ? AT_SEA : undefined} />}
          <mesh geometry={islands.geometry} material={landMaterial} castShadow receiveShadow userData={{ terrain: 'islands' }} />
          {segments.map((segment, i) =>
            segment.far - segment.near < STRAIGHT_M ? null : (
            <group key={i} position={[segment.center, 0, (segment.near + segment.far) / 2]}>
              <Scenery
                look={look}
                layout="sides"
                inner={half + SCENERY_MARGIN}
                from={-(segment.far - segment.near) / 2}
                to={(segment.far - segment.near) / 2 - 2}
                ground={(x, z) => islands.heightAt(x + segment.center, z + (segment.near + segment.far) / 2) ?? ground}
              />
            </group>
            ),
          )}
        </>
      )}
      {arches.length > 0 && (
        <instancedMesh key={arches.length} ref={beams} args={[undefined, undefined, arches.length]} frustumCulled={false} userData={{ rigShadow: 'none' }}>
          <boxGeometry args={[1, 1, 1]} />
          <meshBasicMaterial toneMapped={false} />
        </instancedMesh>
      )}
      {layout.goal !== null && (
        // Poklad na břehu u cíle a nad ním zářící maják, vidět z dálky přes mlhu; kanál nechá volný.
        <group position={[layout.goal.x + half + 3.5, layout.terrain === 'rocks' ? (layout.walls[0]?.h ?? 0) : sea ? BANK_TOP : 0, layout.goal.z]} userData={{ rigShadow: 'none' }}>
          <mesh material={glow.goal} position={[0, 9, 0]} userData={{ rigShadow: 'none' }}>
            <cylinderGeometry args={[0.25, 0.6, 18, 10, 1, true]} />
          </mesh>
          <mesh material={glow.gate} position={[0, 0.45, 0]} userData={{ rigShadow: 'none' }}>
            <boxGeometry args={[1.4, 0.9, 1]} />
          </mesh>
        </group>
      )}
      {shots.length > 0 && (
        <instancedMesh key={`shots${shots.length}`} ref={shotMesh} args={[undefined, undefined, shots.length]} frustumCulled={false} castShadow visible={!namedHazard}>
          <sphereGeometry args={[0.5, 14, 10]} />
          <meshStandardMaterial color={color.ink} roughness={0.35} metalness={0.6} />
        </instancedMesh>
      )}
      {snags.length > 0 && (
        // Útes nebo vrak: napůl pod hladinou, hitbox jádra (2 × 1 × 2 m) celý pokryje.
        <instancedMesh key={`snags${snags.length}`} ref={snagMesh} args={[undefined, undefined, snags.length]} frustumCulled={false} castShadow visible={!namedHazard}>
          <dodecahedronGeometry args={[0.6, 0]} />
          <meshStandardMaterial color={rock} roughness={1} flatShading />
        </instancedMesh>
      )}
      {shots.length > 0 && (
        <instancedMesh ref={trail} args={[undefined, undefined, shots.length * TRAIL]} frustumCulled={false} userData={{ rigShadow: 'none' }}>
          <sphereGeometry args={[0.5, 8, 6]} />
          <meshBasicMaterial color={color.cream} transparent opacity={0.45} depthWrite={false} />
        </instancedMesh>
      )}
      {layout.pad !== null && (
        <group position={[layout.pad.x, layout.pad.y, layout.pad.z]}>
          {namedPad !== undefined ? <FittedModel id={namedPad} w={layout.pad.w} h={layout.pad.h} d={layout.pad.d} fallback={look.track} /> : <mesh position={[0, layout.pad.h / 2, 0]} castShadow receiveShadow>
            <boxGeometry args={[layout.pad.w, layout.pad.h, layout.pad.d]} />
            <meshStandardMaterial color={look.track} roughness={0.8} />
          </mesh>}
          {/* Svítící lem plochy: kam dosednout, je vidět i z výšky. */}
          {[-1, 1].map((side) => (
            <mesh key={`x${side}`} material={glow.pad} position={[(side * layout.pad!.w) / 2, layout.pad!.h + 0.05, 0]} userData={{ rigShadow: 'none' }}>
              <boxGeometry args={[0.3, 0.12, layout.pad!.d]} />
            </mesh>
          ))}
          {[-1, 1].map((side) => (
            <mesh key={`z${side}`} material={glow.pad} position={[0, layout.pad!.h + 0.05, (side * layout.pad!.d) / 2]} userData={{ rigShadow: 'none' }}>
              <boxGeometry args={[layout.pad!.w, 0.12, 0.3]} />
            </mesh>
          ))}
        </group>
      )}
      <VoyageHero session={session} layout={layout} look={look} waveAt={water === null ? null : (x, z, seconds) => water.heightAt(x, z, seconds) - WATER_LEVEL} />
    </>
  );
}

/** Režim vstupu jízdy. Přistávač (P32F T4): osa klopí, tah drží šipka nahoru/W/mezerník nebo druhý prst místo brzdy. */
export function driveModeOf(world: Pick<ArcadeWorld, 'control' | 'rules'>): DriveInputMode {
  if ((baseControlOf(world.control).params as { land?: unknown }).land !== undefined) return 'land';
  return nativeRule(world.rules, 'blaster') !== undefined ? 'shoot' : 'drive';
}

/**
 * Šipky/A-D = zatáčení (osa s náběhem ~0,25 s, `key-steer.ts`), šipka dolů/S = brzda. Dotyk: první prst táhne
 * do strany (osa podle vzdálenosti od místa stisku, plná po `DRAG_PX`),
 * druhý prst kdekoli brzdí, se střelbou střílí, při přistání drží tah. Tlačítko padne do
 * každého tiku, ať snímků za sekundu je kolik chce (P28B T5).
 */
export function useSteerInput(session: ArcadeSession, target: React.RefObject<HTMLDivElement | null>, active: boolean): void {
  // Most relace do scény závodu (`SteerBackdrop`), i když vstup zrovna neběží.
  useEffect(() => {
    const element = target.current;
    if (element === null) return;
    steerSessions.set(element, session);
    return () => {
      if (steerSessions.get(element) === session) steerSessions.delete(element);
    };
  }, [session, target]);
  useEffect(() => {
    const element = target.current;
    if (!active || element === null) return;
    const input = driveInput(driveModeOf(session.world));
    const sync = (): void => {
      // Šipky točí volantem plynule (P36C T3); dojíždějící rejd po puštění má přednost před prstem jen do středu.
      const held = input.snapshot(wheel.axis());
      session.hold(held.axis);
      session.holdButtons(held.buttons);
    };
    const wheel = keySteer(session, sync);
    const steerKeys = (): void => wheel.aim(input.keyAxis());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return;
      if (!input.key(event.key.toLowerCase(), true)) return;
      event.preventDefault();
      steerKeys();
      sync();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!input.key(event.key.toLowerCase(), false)) return;
      steerKeys();
      sync();
    };
    const onDown = (event: PointerEvent) => {
      // Tah, který vyjede z plátna, se musí pustit i venku – jinak řízení zůstane vytočené.
      element.setPointerCapture(event.pointerId);
      input.down(event.pointerId, event.clientX);
      sync();
    };
    const onMove = (event: PointerEvent) => {
      input.move(event.pointerId, event.clientX);
      sync();
    };
    const onUp = (event: PointerEvent) => {
      input.up(event.pointerId);
      sync();
    };
    const release = (): void => {
      input.clear();
      wheel.reset();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', release);
    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', onUp);
    element.addEventListener('lostpointercapture', onUp);
    return () => {
      release();
      wheel.dispose();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', release);
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onUp);
      element.removeEventListener('lostpointercapture', onUp);
    };
  }, [session, target, active]);
}
