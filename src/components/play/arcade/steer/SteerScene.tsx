'use client';

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
import { type Camera, Color, Frustum, type InstancedMesh, Matrix4, type Mesh, MeshBasicMaterial, MeshStandardMaterial, type Object3D, type PerspectiveCamera, PlaneGeometry, Raycaster, Vector2, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { color } from '@/brand/tokens';
import { baseControlOf } from '@/play/arcade/addons';
import { ARCADE_HZ, AXIS_MAX, BODY, BUTTON, FLAG, HEADER, UNIT, bodyBase, rampedSpeed } from '@/play/arcade/contract';
import type { Look } from '@/play/arcade/look';
import { STEER, type SteerCourse } from '@/play/arcade/pieces/steer';

import { isTyping } from '../input';
import { type IslandSpot, buildIslands, islandPalette } from '../look/rig/terrain/islands';
import { hash } from '../look/rig/terrain/valley';
import { buildWater } from '../look/rig/terrain/water';
import { UNDER_PANORAMA } from '../look/under-panorama';
import { Scenery } from '../look/Scenery';
import type { ArcadeSession } from '../session';
import { keySteer } from './key-steer';
import { VoyageHero } from './VoyageHero';
import { type VoyageLayout, centerOf, nearShotsInView, voyageLayoutOf } from './voyageLayout';

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
    placeLander(camera, look, x, voyage.hero?.position.y ?? voyage.layout.hero.y, z, voyage.layout.pad);
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

/**
 * Záběr přistání: přistávač i plocha v obraze, zboku (let jde v rovině x–y).
 * Vzdálenost ze zorného úhlu a poměru stran, na výšku strop 80 m – dál by
 * loď zmizela v mlze vesmíru.
 */
function placeLander(camera: PerspectiveCamera, look: Vector3, x: number, y: number, z: number, pad: VoyageLayout['pad']): void {
  const [padX, padW] = pad === null ? [x, 10] : [pad.x, pad.w];
  const [left, right] = [Math.min(x - 3, padX - padW / 2 - 2), Math.max(x + 3, padX + padW / 2 + 2)];
  const [bottom, top] = [-1, y + 5];
  const tan = Math.tan((camera.fov * Math.PI) / 360);
  const distance = Math.min(80, Math.max(16, (top - bottom) / 2 / tan, (right - left) / 2 / (tan * camera.aspect)) * 1.1);
  const [cx, cy] = [(left + right) / 2, (bottom + top) / 2];
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
export function SteerBackdrop({ course, length, look }: { readonly course: SteerCourse | undefined; readonly length: number; readonly look: Look }) {
  const voyage = useVoyageSession();
  if (voyage !== null) return <VoyageBackdrop session={voyage.session} layout={voyage.layout} length={length} look={look} />;
  return <RoadBackdrop course={course} length={length} look={look} />;
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
 * Asfalt úsek po úseku (střed a šířka z osy trati) + bílé okraje, zem a
 * kulisy sady prostředí (P27A T3) podél každého úseku. Kulisy jsou jen vzhled:
 * jádro o nich neví, hash světa se nehne.
 */
function RoadBackdrop({ course, length, look, sceneryFrom = 0 }: { readonly course: SteerCourse | undefined; readonly length: number; readonly look: Look; readonly sceneryFrom?: number }) {
  const span = length + 80;
  const half = (course?.halfWidth ?? 5 * UNIT) / UNIT;
  const segments = useMemo(() => segmentsOf(course), [course]);
  // Asfalt a okraje všech úseků po jedné síti: úsek po úseku to byly desítky volání kreslení na snímek (P32F T4, telefon).
  const road = useMemo(() => {
    if (segments.length === 0) return null;
    const strip = (w: number, d: number, x: number, y: number, z: number) => new PlaneGeometry(w, d).rotateX(-Math.PI / 2).translate(x, y, z);
    const mid = (segment: Segment) => (segment.near + segment.far) / 2;
    return {
      asphalt: mergeGeometries(segments.map((segment) => strip(half * 2, segment.far - segment.near + 0.05, segment.center, -0.01, mid(segment)))),
      edges: mergeGeometries(segments.flatMap((segment) => [-1, 1].map((side) => strip(0.12, segment.far - segment.near, segment.center + side * (half - 0.15), 0, mid(segment))))),
    };
  }, [segments, half]);
  useEffect(() => () => { road?.asphalt.dispose(); road?.edges.dispose(); }, [road]);
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.03, span / 2 - 30]} renderOrder={UNDER_PANORAMA}>
        <planeGeometry args={[160, span + 60]} />
        <meshStandardMaterial color={look.ground} roughness={1} depthWrite={false} />
      </mesh>
      {road !== null && (
        <>
          <mesh geometry={road.asphalt}>
            {/* Závod po řece jede po hladině (`afloat`, P30B T6), jinak po asfaltu sady. */}
            <meshStandardMaterial color={look.afloat === true ? look.water : look.track} roughness={look.afloat === true ? 0.3 : 0.9} />
          </mesh>
          <mesh geometry={road.edges}>
            <meshBasicMaterial color="#e2e8f0" />
          </mesh>
        </>
      )}
      {segments.map((segment, i) =>
        segment.far - segment.near < sceneryFrom ? null : (
          <group key={i} position={[segment.center, 0, (segment.near + segment.far) / 2]}>
            <Scenery look={look} layout="sides" inner={half + SCENERY_MARGIN} from={-(segment.far - segment.near) / 2} to={(segment.far - segment.near) / 2 - 2} />
          </group>
        ),
      )}
    </>
  );
}

interface Segment {
  readonly near: number;
  readonly far: number;
  readonly center: number;
}

/** Úseky trati ve scéně (m): od konce předchozího (první 20 m před startem) do svého konce, střed zrcadlený. */
function segmentsOf(course: SteerCourse | undefined): Segment[] {
  return (course?.ends ?? []).map((end, i) => {
    const near = i === 0 ? -20 * UNIT : (course!.ends[i - 1] as number);
    return { near: near / UNIT, far: end / UNIT, center: -(course!.centers[i] as number) / UNIT };
  });
}

/** Hladina moře (m): trup lodi (spodní stěna těla ve výšce 0) je o tolik ponořený. */
const WATER_LEVEL = 0.3;
/** Břeh kanálu: šířka desky a výška nad hladinou (m). U skal je deska vysoká jako mantinel. */
const BANK_W = 8;
const BANK_TOP = 1.1;
/** Deska ostrůvku vyčnívá bokem ven až o tolik (m, `islands.ts`) – o tolik stojí od kanálu. */
const SLAB_BULGE = 0.32;
/** Kulisa, která by stála ve vodě, se schová pod hladinu. */
const SUNK = -8;
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
function VoyageBackdrop({ session, layout, length, look }: { readonly session: ArcadeSession; readonly layout: VoyageLayout; readonly length: number; readonly look: Look }) {
  const camera = useThree((three) => three.camera);
  const scene = useThree((three) => three.scene);
  const gl = useThree((three) => three.gl);
  const far = length + look.fog[1] + 10;
  const sea = layout.terrain === 'islands';
  const islands = useMemo(() => buildIslands({ look, islands: shoreOf(layout, far), base: sea ? WATER_LEVEL : 0 }), [layout, look, far, sea]);
  const water = useMemo(
    () => (sea ? buildWater({ look, half: layout.reach + 60, from: -40, to: far, level: WATER_LEVEL, shore: islands.shoreDistance }) : null),
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
  const waterMesh = useRef<Mesh>(null);
  const landMesh = useRef<Mesh>(null);

  useFrame(() => {
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
      else body.visible = false;
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
    // Voda v záběru: paprsky pod hrdinou (střed a strany dolní třetiny) padnou na hladinu dřív než na ostrov.
    // Jednou za 60 snímků: paprsek projde celou síť vody, na telefonu se 4× CPU to je znát.
    if (water !== null && stage !== null && scratch.frame % 60 === 1 && waterMesh.current !== null && landMesh.current !== null) {
      let hits = 0;
      for (const x of [-0.6, 0, 0.6]) {
        scratch.ray.setFromCamera(scratch.ndc.set(x, -0.6), camera);
        if (scratch.ray.intersectObjects([waterMesh.current, landMesh.current], false)[0]?.object === waterMesh.current) hits += 1;
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

  return (
    <>
      {layout.terrain === 'buildings' ? (
        <RoadBackdrop course={layout.course} length={length} look={look} sceneryFrom={STRAIGHT_M} />
      ) : water !== null ? (
        <mesh ref={waterMesh} geometry={water.geometry} material={water.material} receiveShadow userData={{ rigShadow: 'receive', terrain: 'water' }} />
      ) : (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.03, far / 2 - 20]} renderOrder={UNDER_PANORAMA}>
          <planeGeometry args={[layout.reach * 2 + 220, far + 120]} />
          <meshStandardMaterial color={look.ground} roughness={1} depthWrite={false} />
        </mesh>
      )}
      {layout.terrain !== 'buildings' && (
        <>
          <mesh ref={landMesh} geometry={islands.geometry} material={landMaterial} castShadow receiveShadow userData={{ terrain: 'islands' }} />
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
        <instancedMesh key={`shots${shots.length}`} ref={shotMesh} args={[undefined, undefined, shots.length]} frustumCulled={false} castShadow>
          <sphereGeometry args={[0.5, 14, 10]} />
          <meshStandardMaterial color={color.ink} roughness={0.35} metalness={0.6} />
        </instancedMesh>
      )}
      {snags.length > 0 && (
        // Útes nebo vrak: napůl pod hladinou, hitbox jádra (2 × 1 × 2 m) celý pokryje.
        <instancedMesh key={`snags${snags.length}`} ref={snagMesh} args={[undefined, undefined, snags.length]} frustumCulled={false} castShadow>
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
          <mesh position={[0, layout.pad.h / 2, 0]} castShadow receiveShadow>
            <boxGeometry args={[layout.pad.w, layout.pad.h, layout.pad.d]} />
            <meshStandardMaterial color={look.track} roughness={0.8} />
          </mesh>
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

const BRAKE_KEYS = new Set(['arrowdown', 's']);
/** Tah přistávače (P32F T4): šipka nahoru, W nebo mezerník; na dotyku druhý prst. */
const THRUST_KEYS = new Set(['arrowup', 'w', ' ']);

/**
 * Šipky/A-D = zatáčení (osa s náběhem ~0,25 s, `key-steer.ts`), šipka dolů/S = brzda. Dotyk: první prst táhne
 * do strany (osa podle vzdálenosti od místa stisku, plná po `DRAG_PX`),
 * druhý prst kdekoli brzdí. Brzda je držené tlačítko relace – padne do
 * každého tiku, ať snímků za sekundu je kolik chce (P28B T5).
 */
const DRAG_PX = 90;

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
    // Přistávač (P32F T4): osa klopí, tah drží šipka nahoru/W/mezerník nebo druhý prst místo brzdy.
    const lands = (baseControlOf(session.world.control).params as { land?: unknown }).land !== undefined;
    const keys = new Set<'left' | 'right' | 'brake' | 'thrust'>();
    const pointers = new Map<number, { readonly x: number; axis: number }>();
    const sync = (): void => {
      const drag = [...pointers.values()][0]?.axis ?? 0;
      const second = pointers.size > 1;
      // Šipky točí volantem plynule (P36C T3); dojíždějící rejd po puštění má přednost před prstem jen do středu.
      session.hold(wheel.axis() !== 0 ? wheel.axis() : drag);
      session.holdButtons((keys.has('brake') || (second && !lands) ? BUTTON.DOWN : 0) | (keys.has('thrust') || (second && lands) ? BUTTON.UP : 0));
    };
    const wheel = keySteer(session, sync);
    const steerKeys = (): void => wheel.aim(((keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0)) * AXIS_MAX);
    const keyOf = (key: string): 'left' | 'right' | 'brake' | 'thrust' | null =>
      key === 'arrowleft' || key === 'a'
        ? 'left'
        : key === 'arrowright' || key === 'd'
          ? 'right'
          : BRAKE_KEYS.has(key)
            ? 'brake'
            : lands && THRUST_KEYS.has(key)
              ? 'thrust'
              : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return;
      const key = keyOf(event.key.toLowerCase());
      if (key === null) return;
      event.preventDefault();
      keys.add(key);
      steerKeys();
      sync();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const key = keyOf(event.key.toLowerCase());
      if (key === null) return;
      keys.delete(key);
      steerKeys();
      sync();
    };
    const onDown = (event: PointerEvent) => {
      // Tah, který vyjede z plátna, se musí pustit i venku – jinak řízení zůstane vytočené.
      element.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, axis: 0 });
      sync();
    };
    const onMove = (event: PointerEvent) => {
      const pointer = pointers.get(event.pointerId);
      if (pointer === undefined) return;
      pointer.axis = Math.round(Math.max(-1, Math.min(1, (event.clientX - pointer.x) / DRAG_PX)) * AXIS_MAX);
      sync();
    };
    const onUp = (event: PointerEvent) => {
      if (pointers.delete(event.pointerId)) sync();
    };
    const release = (): void => {
      keys.clear();
      pointers.clear();
      wheel.reset();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', release);
    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', onUp);
    return () => {
      wheel.dispose();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', release);
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onUp);
    };
  }, [session, target, active]);
}
