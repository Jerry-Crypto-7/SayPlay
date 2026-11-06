'use client';

/**
 * Scéna chytání (P54C T5): pět pruhů zepředu, věci padají z koruny nad nimi a hrdina je
 * chytá košem. Kamera kouká po +z, takže x jádra se zrcadlí jako u pruhů (`LaneScene`) –
 * pruh 0 leží vlevo. Na výšku se do obrazu vejde celá šíře pruhů, na šířku celá výška pádu.
 *
 * Co jádro nevidí (koruna, koš, póza hrdiny, kamera), je jen obraz: stav ani hash nemění.
 * Plocha dostane `data-lane-edges` (hranice pruhů u koše, zleva doprava), podle kterých
 * prst trefí pruh (`lanes-input.ts`), a `data-player-x` pro vyskakující body.
 * Modely jsou z knihovny podle popisku (`cast.props.coin` ovoce, `cast.props.hazard` bomba);
 * bez modelu primitiva v barvách kitu.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Box3, type Group, IcosahedronGeometry, MathUtils, type PerspectiveCamera, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { color } from '@/brand/tokens';
import { BODY, FLAG, HEADER, ROLE, UNIT, bodyBase, bodyHp } from '@/play/arcade/contract';
import { riggedCharacter } from '@/play/arcade/models';
import { CATCH, catchInView } from '@/play/arcade/pieces/catch-fall';
import { type LaneEventKind, eventOfMark } from '@/play/arcade/pieces/lane-events';
import { LANES, laneX } from '@/play/arcade/pieces/lanes';

import { renderHeld } from '../../effects/render-feel';
import type { GhostPlacement } from '../../Ghost';
import { type PlayRect, fitTall, usePlayRectRef } from '../../portrait-frame';
import { type GhostPose, GhostSlot } from '../../GhostSlot';
import { HorizonBackdrop } from '../../look/Backdrop';
import { FieldGround } from '../../look/FieldGround';
import { DIORAMA_FRAMING } from '../../look/framing';
import { hash } from '../../look/ground';
import { RiggedModel } from '../../RiggedModel';
import { FittedModel, type WorldProps } from '../../World';
import { LaneStrips } from '../lanes/LaneStrips';

const m = (units: number): number => units / UNIT;
const LANE_M = m(LANES.width);
const FIELD_HALF = (LANES.count * LANE_M) / 2;
const HERO = { w: m(CATCH.hero.w), h: m(CATCH.hero.h), d: m(CATCH.hero.d) };
const THING = m(CATCH.thing.w);
const CATCH_M = m(CATCH.catchY);
/** Koruna, ze které věci padají: spodní hrana nad nejvyšším místem, kde je věc vidět. */
const CANOPY = { bottom: m(CATCH.viewTop) + THING, h: 1.2 };
const VIEW = { bottom: -0.4, top: CANOPY.bottom + CANOPY.h + 0.4 };
const LAND = { x0: -30, x1: 30, z0: -30, z1: 40 } as const;
/** Kolik volné výšky (na výšku telefonu) jde nad korunu místo pod zem. */
const SKY_SHARE = 0.25;
/**
 * Na výšku telefonu (P64 T3): šíři obrazu drží pět pruhů, takže výšku pádu nejde zvětšit kamerou. Pád nad lapací
 * čárou se proto natáhne do výšky `playRect` – ovoce padá od horní hrany jako na šířku, v témž počtu tiků; jádro
 * ani hash to nevidí. Nejvýš tolikrát.
 */
const TALL_STRETCH = 2.6;

const lerp = (from: number, to: number, alpha: number): number => from + (to - from) * alpha;

/** Hranice mezi pruhy l | l+1 v x jádra; kreslí se zrcadlově. */
const LANE_EDGES = Array.from({ length: LANES.count - 1 }, (_, lane) => laneX(lane) + LANES.width / 2);

/** Výška pádu nad lapací čárou až po spodek koruny (m). */
const FALL = CANOPY.bottom - CATCH_M;
/** Kolik natažení pádu jde do zrychlení: na výšku věc nahoře padá pomaleji a k hrdinovi rychleji, jako volný pád. */
const BEND = 0.5;

/**
 * Výška ve scéně z výšky jádra: nad lapací čárou natažená o `stretch` (na šířku 1 = beze změny), pod ní beze změny.
 * Natažený pád se ohne (`BEND`, nejvýš 0,5): věc je dál nahoře déle a zrychluje k hrdinovi, horní a dolní kraj pádu
 * i počet tiků zůstávají.
 */
function lifted(y: number, stretch: number): number {
  if (y <= CATCH_M || stretch === 1) return y;
  const u = Math.min(1, (y - CATCH_M) / FALL);
  const bend = Math.min(BEND, (stretch - 1) * BEND);
  return CATCH_M + (y - CATCH_M) * stretch + FALL * stretch * bend * u * (1 - u);
}

/**
 * Rámování na výšku (P64 T3): co se vejít musí – do stran celé pruhy (`keep`), svisle od nohou hrdiny po spodek
 * koruny nataženého pádu (nejvyšší místo, kde je věc vidět); okraj za pruhy, zem pod nohama a koruna smějí ven.
 */
function tallBoxes(stretch: number): { readonly box: Box3; readonly keep: Box3 } {
  const top = lifted(CANOPY.bottom, stretch);
  return {
    box: new Box3(new Vector3(-FIELD_HALF - 0.5, -0.1, -HERO.d / 2), new Vector3(FIELD_HALF + 0.5, top, HERO.d / 2)),
    keep: new Box3(new Vector3(-FIELD_HALF, 0, -HERO.d / 2), new Vector3(FIELD_HALF, top, HERO.d / 2)),
  };
}

/** Sklon kamery chytání (P73D T2): dřív kolmo zepředu (0°) a obzor v mlze, teď 3/4 shora s obzorem nad korunami. */
export const CATCH_PITCH = MathUtils.degToRad(DIORAMA_FRAMING.lanes.pitch);

/** Kamera `distance` m od bodu (0, `y`, 0) ve sklonu `CATCH_PITCH`, kouká na něj. */
export function tiltCatch(camera: PerspectiveCamera, y: number, distance: number): void {
  camera.position.set(0, y + distance * Math.sin(CATCH_PITCH), -distance * Math.cos(CATCH_PITCH));
  camera.lookAt(0, y, 0);
}

/** Kamera chytání na šířku: rozhoduje šíře pruhů nebo výška pádu; volná výška jde z větší části pod zem (pole před hrdinou). */
export function placeCatchWide(camera: PerspectiveCamera): void {
  const tan = Math.tan((camera.fov * Math.PI) / 360);
  const needed = (VIEW.top - VIEW.bottom) / 2;
  const distance = Math.max((FIELD_HALF + 0.5) / (tan * camera.aspect), needed / tan);
  const spare = distance * tan - needed;
  tiltCatch(camera, (VIEW.top + VIEW.bottom) / 2 + spare * SKY_SHARE, distance);
}

/** Bod pohledu kamery chytání posunuté fitem: táž orientace, kterou postavil `tiltCatch`. */
function catchLook(position: Vector3, out: Vector3): Vector3 {
  return out.set(position.x, position.y - Math.sin(CATCH_PITCH), position.z + Math.cos(CATCH_PITCH));
}

/**
 * Kamera chytání na výšku: zepředu jako na šířku a přes `fitTall` do `playRect`, pád natažený tak, aby ho svisle
 * nevázalo nic víc než šíře pruhů. Největší natažení hledá půlením: dokud se pád vejde kamerou, kterou drží
 * pruhy, vzdálenost se nezmění.
 */
function placeTall(camera: PerspectiveCamera, rect: PlayRect): { readonly position: Vector3; readonly stretch: number } {
  // Bod pohledu uprostřed krabice: `fitTall` ho posadí doprostřed `playRect` a krabice se rozloží na obě strany.
  const fit = (stretch: number) => {
    const { box, keep } = tallBoxes(stretch);
    const y = (box.min.y + box.max.y) / 2;
    tiltCatch(camera, y, 10);
    return fitTall(camera, box, rect, { keep });
  };
  const lanes = fit(1);
  let low = 1;
  let high = TALL_STRETCH;
  if (fit(high).distance <= lanes.distance + 1e-6) low = high;
  else {
    for (let step = 0; step < 12; step += 1) {
      const mid = (low + high) / 2;
      if (fit(mid).distance <= lanes.distance + 1e-6) low = mid;
      else high = mid;
    }
  }
  return { position: fit(low).position, stretch: low };
}

type CatchSceneProps = Omit<WorldProps, 'control' | 'backdrop'>;

/**
 * Deska chytání (P56B T11): výplň zůstává světlá deska P55 – v povrchu sady by žluté ovoce proti ní ztratilo
 * kontrast (README T11) –, lem a spáry dává povrch sady zesvětlený o `BOARD_LIGHT` k papíru.
 */
const BOARD: readonly [string, string] = [color.paper, color['cream-deep']];
const BOARD_LIGHT = 0.3;

/**
 * Koruna, ze které věci padají (P56B T11): dvě řady kulatých chomáčů listí s ploškami místo zeleného
 * kvádru, velikost a výška z hashe pořadí (stejná hra, stejná koruna). Spodek chomáčů drží `CANOPY.bottom`
 * až na pár centimetrů – pod ním je věc vidět. Jedna síť, jedno volání jako kvádr.
 */
function Canopy({ tint }: { readonly tint: string }) {
  const geometry = useMemo(() => {
    const width = FIELD_HALF * 2 + 1;
    const radius = CANOPY.h * 0.55;
    const puffs = [0, 1].flatMap((row) => {
      const count = Math.round(width / (radius * 1.5)) - row;
      return Array.from({ length: count }, (_, k) => {
        const size = radius * (0.85 + 0.3 * hash(k, row + 3));
        return new IcosahedronGeometry(size, 1).translate(-width / 2 + (width * (k + 0.5)) / count, CANOPY.bottom + size * 0.9 + 0.12 * hash(k, row + 9), row);
      });
    });
    const merged = mergeGeometries(puffs);
    for (const puff of puffs) puff.dispose();
    return merged;
  }, []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial color={tint} roughness={0.9} flatShading />
    </mesh>
  );
}

function Fruit() {
  return (
    <group position={[0, THING / 2, 0]}>
      <mesh castShadow>
        <sphereGeometry args={[THING / 2, 16, 12]} />
        <meshStandardMaterial color={color.sun} roughness={0.5} />
      </mesh>
      <mesh position={[0.08, THING / 2, 0]} rotation={[0, 0, -0.6]}>
        <boxGeometry args={[0.18, 0.06, 0.1]} />
        <meshStandardMaterial color={color['mint-deep']} />
      </mesh>
    </group>
  );
}

function Bomb() {
  return (
    <group position={[0, THING / 2, 0]}>
      <mesh castShadow>
        <sphereGeometry args={[THING / 2, 16, 12]} />
        <meshStandardMaterial color={color.ink} roughness={0.4} />
      </mesh>
      <mesh position={[0, THING / 2 + 0.06, 0]}>
        <cylinderGeometry args={[0.04, 0.04, 0.16, 6]} />
        <meshStandardMaterial color={color.tomato} emissive={color.tomato} emissiveIntensity={0.6} />
      </mesh>
    </group>
  );
}

/** Zlatý cíl události (P55 T5): svítí, ať je z dálky vidět, že stojí za odbočku. */
function Golden() {
  return (
    <mesh position={[0, THING / 2, 0]} castShadow>
      <icosahedronGeometry args={[THING / 2, 0]} />
      <meshStandardMaterial color={color['sun-deep']} emissive={color.sun} emissiveIntensity={0.7} roughness={0.3} metalness={0.4} />
    </mesh>
  );
}

/** Kroužek kolem bonusu série a spěchu: ovoce navíc, které se do cíle nepočítá. */
function BonusHalo() {
  return (
    <mesh position={[0, THING / 2, 0]}>
      <torusGeometry args={[THING * 0.62, 0.05, 6, 20]} />
      <meshStandardMaterial color={color['sun-soft']} emissive={color.sun} emissiveIntensity={0.8} />
    </mesh>
  );
}

export function CatchScene({ session, cast, surface, scene: look, ghost }: CatchSceneProps) {
  const world = session.world;
  const things = useMemo(() => {
    const out: { readonly index: number; readonly bomb: boolean; readonly event: LaneEventKind | null }[] = [];
    const initial = Int32Array.from(world.initial);
    for (let index = 1; index < (world.initial[HEADER.bodyCount] as number); index += 1) {
      const role = world.initial[bodyBase(index) + BODY.role];
      if (role === ROLE.collectible || role === ROLE.hazard) out.push({ index, bomb: role === ROLE.hazard, event: eventOfMark(bodyHp(initial, index)) });
    }
    return out;
  }, [world]);
  const groups = useRef<(Group | null)[]>([]);
  const hero = useRef<Group | null>(null);
  const moving = useRef(false);
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const look3 = useMemo(() => new Vector3(), []);
  const probe = useMemo(() => new Vector3(), []);
  const playRect = usePlayRectRef();
  const tallFrame = useRef<{ readonly rect: PlayRect; readonly aspect: number; readonly position: Vector3; readonly stretch: number } | null>(null);
  const canopy = useRef<Group | null>(null);
  const heroRig = riggedCharacter(cast.player);
  // Duch dřívějšího běhu jezdí po pruzích svého běhu kousek za rovinou hrdiny (dál od kamery), čelem ke kameře.
  const ghostSpot = useCallback((pose: GhostPose): GhostPlacement => [-pose.x / UNIT, 0, HERO.d, Math.PI], []);
  const fruitModel = cast.props.coin;
  const bombModel = cast.props.hazard;

  useFrame((_, delta) => {
    const alpha = session.advance(delta * 1000);
    if (renderHeld(session)) return;
    const state = session.state();
    const prev = session.prev();
    const at = (index: number, slot: number): number => lerp(prev[bodyBase(index) + slot] as number, state[bodyBase(index) + slot] as number, alpha) / UNIT;
    const player = state[HEADER.player] as number;
    const heroX = -at(player, BODY.x);
    hero.current?.position.set(heroX, 0, 0);
    moving.current = state[bodyBase(player) + BODY.x] !== prev[bodyBase(player) + BODY.x];
    // Na výšku telefonu rámuje `playRect` (P64 T3); spočítá se jen při změně obdélníku nebo poměru stran.
    const rect = playRect.current;
    const cached = tallFrame.current;
    if (camera.aspect >= 1 || rect === null) tallFrame.current = null;
    else if (cached === null || cached.rect !== rect || cached.aspect !== camera.aspect) tallFrame.current = { rect, aspect: camera.aspect, ...placeTall(camera, rect) };
    const tall = tallFrame.current;
    const stretch = tall?.stretch ?? 1;
    for (const thing of things) {
      const group = groups.current[thing.index];
      if (group === null || group === undefined) continue;
      const base = bodyBase(thing.index);
      group.visible = ((state[base + BODY.flags] as number) & FLAG.alive) !== 0 && catchInView(state, thing.index);
      if (group.visible) group.position.set(-at(thing.index, BODY.x), lifted(at(thing.index, BODY.y), stretch), 0);
    }
    canopy.current?.position.set(0, lifted(CANOPY.bottom, stretch) - CANOPY.bottom, 0);
    if (tall !== null) {
      camera.position.copy(tall.position);
      camera.lookAt(catchLook(tall.position, look3));
    } else placeCatchWide(camera);
    const host = surface.current;
    if (host === null) return;
    camera.updateMatrixWorld();
    const fraction = (x: number): number => (probe.set(x, CATCH_M, 0).project(camera).x + 1) / 2;
    const edges = LANE_EDGES.map((edge) => fraction(-edge / UNIT).toFixed(4)).join(',');
    if (host.dataset.laneEdges !== edges) host.dataset.laneEdges = edges;
    host.dataset.playerX = probe.set(heroX, HERO.h, 0).project(camera).x.toFixed(3);
  });

  return (
    <>
      <FieldGround look={look} area={LAND} y={-0.03} />
      <HorizonBackdrop look={look} seed={world.seed} clear={0} beyond={24} />
      {/* Světlá deska (P55 T5) s lemem a spárami povrchu sady (P56B T11): ovoce, bomby i bonusy na ní čtou dál než na zelené. */}
      <LaneStrips look={look} z0={-1.5} z1={1.5} light={BOARD_LIGHT} fill={BOARD} />
      <group ref={canopy}>
        <Canopy tint={look.flora?.leaf ?? look.tint[0]} />
      </group>
      <group ref={hero} userData={{ frame: 'hero' }}>
        {/* Kamera kouká po +z: hrdina se otočí čelem k ní. */}
        <group rotation={[0, Math.PI, 0]}>
          {heroRig !== undefined ? (
            <RiggedModel character={heroRig} h={HERO.h} clip={() => (moving.current ? 'run' : 'idle')} fallback={color['sky-deep']} />
          ) : (
            <FittedModel id={cast.player} w={HERO.w} h={HERO.h} d={HERO.d} fallback={color['sky-deep']} character />
          )}
        </group>
        {/* Koš na lapací čáře před hrdinou. */}
        <mesh position={[0, CATCH_M - 0.12, -HERO.d / 2 - 0.1]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[HERO.w / 2, 0.07, 8, 20]} />
          <meshStandardMaterial color={color['sun-deep']} />
        </mesh>
      </group>
      <GhostSlot ghost={ghost} session={session} place={ghostSpot} />
      {things.map((thing) => (
        <group
          key={thing.index}
          ref={(group) => {
            groups.current[thing.index] = group;
          }}
          visible={false}
          userData={{ frame: 'target', item: thing.bomb ? 'hazard' : 'coin', ...(thing.event === null ? {} : { event: thing.event }) }}
        >
          {thing.bomb ? (
            bombModel !== undefined ? <FittedModel id={bombModel} w={THING} h={THING} d={THING} fallback={color.ink} /> : <Bomb />
          ) : thing.event === 'golden' ? (
            <Golden />
          ) : fruitModel !== undefined ? (
            <FittedModel id={fruitModel} w={THING} h={THING} d={THING} fallback={color.sun} />
          ) : (
            <Fruit />
          )}
          {thing.event === 'series' || thing.event === 'rush' ? <BonusHalo /> : null}
        </group>
      ))}
    </>
  );
}
