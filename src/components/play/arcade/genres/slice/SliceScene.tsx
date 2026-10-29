'use client';

/**
 * Scéna krájení (P54C T8): pět pruhů zepředu, věci vylétají z beden pod pruhy po obloucích a hrdina
 * s čepelí je švihem rozsekne nad čárou řezu. Kamera kouká po +z, takže x jádra se zrcadlí jako
 * u pruhů (`LaneScene`) – pruh 0 leží vlevo. Na výšku se do obrazu vejde celá šíře pruhů, na šířku
 * celá výška letu.
 *
 * Co jádro nevidí (stopa čepele, půlky rozseknutého ovoce, záblesk bomby, roztočení věcí, švih čepele,
 * kamera), je jen obraz: stav ani hash nemění. Věci jsou kopie předloh za úrovní a jejich sloty se po
 * zmizení znovu použijí, takže scéna je kreslí ze zásoby a konec věci pozná sama – zmizela, nebo ve
 * slotu vyletěla nová (rychlost vzhůru skočila). Věc, která skončila nad čárou řezu, byla rozseknutá.
 * Plocha dostane `data-lane-edges` (hranice pruhů ve výšce řezu, zleva doprava), podle kterých prst
 * trefí pruh (`lanes-input.ts`), a `data-player-x` pro vyskakující body.
 * Modely jsou z knihovny podle popisku (`cast.props.coin` ovoce, `cast.props.hazard` bomba);
 * bez modelu primitiva v barvách kitu (meloun a bomba). Bonusy událostí (P55 T5, značka v HP těla) mají
 * vlastní zásobu: zlatý cíl svítí, bonus série a spěchu nese kolem ovoce svítící kroužek.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useCallback, useMemo, useRef } from 'react';
import { Box3, type Group, type Mesh, type PerspectiveCamera, Vector3 } from 'three';

import { color } from '@/brand/tokens';
import { BODY, FLAG, HEADER, ROLE, UNIT, bodyBase, bodyHp } from '@/play/arcade/contract';
import { riggedCharacter } from '@/play/arcade/models';
import { EVENT_MARK } from '@/play/arcade/pieces/lane-events';
import { LANES, laneOf, laneX, tappedIn } from '@/play/arcade/pieces/lanes';
import { SLICE, heightAfter, sliceInView } from '@/play/arcade/pieces/slice';

import { renderHeld } from '../../effects/render-feel';
import type { GhostPlacement } from '../../Ghost';
import { type PlayRect, fitTall, usePlayRectRef } from '../../portrait-frame';
import { type GhostPose, GhostSlot } from '../../GhostSlot';
import { HorizonBackdrop } from '../../look/Backdrop';
import { FieldGround } from '../../look/FieldGround';
import { RiggedModel } from '../../RiggedModel';
import { FittedModel, type WorldProps } from '../../World';
import { LaneStrips } from '../lanes/LaneStrips';

const m = (units: number): number => units / UNIT;
const LANE_M = m(LANES.width);
const FIELD_HALF = (LANES.count * LANE_M) / 2;
const HERO = { w: m(SLICE.hero.w), h: m(SLICE.hero.h), d: m(SLICE.hero.d) };
const THING = m(SLICE.thing.w);
const CUT_M = m(SLICE.cutY);
const PLANE_Z = m(SLICE.z);
/** Nejvyšší bod letu: nejrychlejší výhoz v půlce oblouku. */
const PEAK_M = m(heightAfter(SLICE.trapSpeed[1], Math.floor(SLICE.trapSpeed[1] / 8)));
const VIEW = { bottom: -0.4, top: PEAK_M + THING + 0.6 };
const LAND = { x0: -30, x1: 30, z0: -30, z1: 40 } as const;
/** Kolik volné výšky (na výšku telefonu) jde nad nejvyšší bod místo pod zem: skoro nic, let je uprostřed plátna. */
const SKY_SHARE = 0.05;
/**
 * Na výšku telefonu (P64 T3): šíři obrazu drží pět pruhů, výšku letu kamerou zvětšit nejde. Let (i čára řezu,
 * stopy čepele a půlky) se proto natáhne do výšky `playRect` – věci vylétají přes celou výšku jako na šířku, v témž
 * počtu tiků; jádro ani hash to nevidí. Nejvýš tolikrát.
 */
const TALL_STRETCH = 2.2;
/** Zásoba slotů: ovoce a bomb naráz ve vzduchu, stop čepele, rozseknutého ovoce a záblesků bomb. */
const SLOTS = { fruit: 10, bomb: 5, bonus: 6, golden: 2, trails: 3, halves: 6, blasts: 2 } as const;
/** Jak dlouho žije stopa čepele, půlky ovoce a záblesk bomby (s). */
const LIFE = { trail: 0.3, halves: 0.75, blast: 0.3 } as const;
/** Věc, která skončila výš než tohle, byla rozseknutá (propadlá zmizí až na zemi). */
const SLICED_FROM = SLICE.cutY - 400;
/** Gravitace půlek ovoce ve scéně (m/s²) – jen obraz. */
const HALF_GRAVITY = 18;

const lerp = (from: number, to: number, alpha: number): number => from + (to - from) * alpha;

/** Hranice mezi pruhy l | l+1 v x jádra; kreslí se zrcadlově. */
const LANE_EDGES = Array.from({ length: LANES.count - 1 }, (_, lane) => laneX(lane) + LANES.width / 2);

/**
 * Rámování na výšku (P64 T3): co se vejít musí – do stran celé pruhy od hrdiny po rovinu letu (`keep`), svisle od
 * země po vrchol nataženého letu; okraj za pruhy smí ven.
 */
function tallBoxes(stretch: number): { readonly box: Box3; readonly keep: Box3 } {
  const top = (PEAK_M + THING) * stretch;
  return {
    box: new Box3(new Vector3(-FIELD_HALF - 0.5, VIEW.bottom, -HERO.d / 2), new Vector3(FIELD_HALF + 0.5, top + 0.3, PLANE_Z + 0.5)),
    keep: new Box3(new Vector3(-FIELD_HALF, 0, -HERO.d / 2), new Vector3(FIELD_HALF, top, PLANE_Z)),
  };
}

/**
 * Kamera krájení na výšku: zepředu jako na šířku a přes `fitTall` do `playRect`, let natažený tak, aby ho svisle
 * nevázalo nic víc než šíře pruhů (půlením: dokud se let vejde kamerou, kterou drží pruhy, vzdálenost se nezmění).
 */
function placeTall(camera: PerspectiveCamera, rect: PlayRect): { readonly position: Vector3; readonly stretch: number } {
  // Bod pohledu uprostřed krabice: `fitTall` ho posadí doprostřed `playRect` a krabice se rozloží na obě strany.
  const fit = (stretch: number) => {
    const { box, keep } = tallBoxes(stretch);
    const y = (box.min.y + box.max.y) / 2;
    camera.position.set(0, y, -10);
    camera.lookAt(0, y, 0);
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

type SliceSceneProps = Omit<WorldProps, 'control' | 'backdrop'>;

/** Co slot těla viděl minule: žilo, kde a jak rychle stoupalo. */
interface Memory {
  alive: boolean;
  x: number;
  y: number;
  vy: number;
  role: number;
}

/** Efekt ze zásoby: kde začal a kolik času mu zbývá (≤ 0 = volný). */
interface Burst {
  x: number;
  y: number;
  left: number;
  tilt: number;
}

const bursts = (count: number): Burst[] => Array.from({ length: count }, () => ({ x: 0, y: 0, left: 0, tilt: 0 }));

/** Meloun: zelená koule s tmavými pruhy. */
function Melon() {
  return (
    <group position={[0, THING / 2, 0]}>
      <mesh castShadow scale={[1.15, 0.95, 0.95]}>
        <sphereGeometry args={[THING / 2, 16, 12]} />
        <meshStandardMaterial color={color['mint-deep']} roughness={0.5} />
      </mesh>
      {[-0.5, 0.5].map((turn) => (
        <mesh key={turn} rotation={[0, turn, 0]} scale={[1.15, 0.95, 0.95]}>
          <torusGeometry args={[THING / 2, 0.022, 6, 24]} />
          <meshStandardMaterial color={color.grass} />
        </mesh>
      ))}
    </group>
  );
}

/** Bomba: inkoustová koule s doutnákem. */
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

/** Zlatý cíl události (P55 T5): svítí, ať je z dálky vidět, že stojí za švih navíc. */
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

/** Půlka rozseknuté věci: polokoule slupky (x ≥ 0) a plocha řezu čelem k −x. */
function Half({ skin, flesh }: { readonly skin: string; readonly flesh: string }) {
  return (
    <group>
      <mesh>
        <sphereGeometry args={[THING / 2, 12, 8, Math.PI / 2, Math.PI]} />
        <meshStandardMaterial color={skin} roughness={0.5} />
      </mesh>
      <mesh rotation={[0, -Math.PI / 2, 0]}>
        <circleGeometry args={[THING / 2 - 0.02, 16]} />
        <meshStandardMaterial color={flesh} />
      </mesh>
    </group>
  );
}

export function SliceScene({ session, cast, surface, scene: look, ghost }: SliceSceneProps) {
  const world = session.world;
  const groups = useRef<{ fruit: (Group | null)[]; bomb: (Group | null)[]; bonus: (Group | null)[]; golden: (Group | null)[]; trails: (Mesh | null)[]; halves: (Group | null)[]; blasts: (Mesh | null)[] }>({
    fruit: [],
    bomb: [],
    bonus: [],
    golden: [],
    trails: [],
    halves: [],
    blasts: [],
  });
  const memory = useRef<Memory[]>([]);
  const trails = useRef(bursts(SLOTS.trails));
  const halves = useRef(bursts(SLOTS.halves));
  const blasts = useRef(bursts(SLOTS.blasts));
  const swing = useRef({ tick: -1, t: Number.POSITIVE_INFINITY, lane: 2 });
  const hero = useRef<Group | null>(null);
  const blade = useRef<Group | null>(null);
  const moving = useRef(false);
  const time = useRef(0);
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const look3 = useMemo(() => new Vector3(), []);
  const probe = useMemo(() => new Vector3(), []);
  const playRect = usePlayRectRef();
  const tallFrame = useRef<{ readonly rect: PlayRect; readonly aspect: number; readonly position: Vector3; readonly stretch: number } | null>(null);
  const cutLines = useRef<Group | null>(null);
  const heroRig = riggedCharacter(cast.player);
  // Duch dřívějšího běhu jezdí po pruzích svého běhu kousek blíž ke kameře, čelem k ní.
  const ghostSpot = useCallback((pose: GhostPose): GhostPlacement => [-pose.x / UNIT, 0, -HERO.d * 1.2, Math.PI], []);
  const fruitModel = cast.props.coin;
  const bombModel = cast.props.hazard;
  // Půlky melounu (primitiv i model `gen3d-suika`) jsou zelené s červenou dužinou, ostatní ovoce žluté se světlou.
  const melon = fruitModel === undefined || /melon|suika/.test(fruitModel);
  const skin = melon ? color['mint-deep'] : color.sun;
  const flesh = melon ? color.tomato : color.cream;

  useFrame((_, delta) => {
    const alpha = session.advance(delta * 1000);
    if (renderHeld(session)) return;
    time.current += delta;
    const state = session.state();
    const prev = session.prev();
    const count = state[HEADER.bodyCount] as number;
    const from = state[HEADER.spawnBase] as number;
    const at = (index: number, slot: number): number => lerp(prev[bodyBase(index) + slot] as number, state[bodyBase(index) + slot] as number, alpha) / UNIT;
    // Na výšku telefonu rámuje `playRect` (P64 T3); spočítá se jen při změně obdélníku nebo poměru stran.
    const rect = playRect.current;
    const cached = tallFrame.current;
    if (camera.aspect >= 1 || rect === null) tallFrame.current = null;
    else if (cached === null || cached.rect !== rect || cached.aspect !== camera.aspect) tallFrame.current = { rect, aspect: camera.aspect, ...placeTall(camera, rect) };
    const tall = tallFrame.current;
    const stretch = tall?.stretch ?? 1;
    cutLines.current?.position.set(0, CUT_M * (stretch - 1), 0);
    const player = state[HEADER.player] as number;
    const heroX = -at(player, BODY.x);
    hero.current?.position.set(heroX, 0, 0);
    moving.current = state[bodyBase(player) + BODY.x] !== prev[bodyBase(player) + BODY.x];

    // Švih: ťuk v tomhle tiku spustí stopu čepele v pruhu ťuku, šikmo ve směru od pruhu, kde hrdina stál.
    const tick = state[HEADER.tick] as number;
    const tap = tappedIn(state, player);
    if (tap !== null && swing.current.tick !== tick) {
      const free = trails.current.reduce((best, slot) => (slot.left < best.left ? slot : best));
      const before = laneOf(prev, player);
      Object.assign(free, { x: -laneX(tap) / UNIT, y: CUT_M + 0.9, left: LIFE.trail, tilt: tap === before ? (tick % 2 === 0 ? 0.45 : -0.45) : tap > before ? -0.45 : 0.45 });
      swing.current = { tick, t: 0, lane: tap };
    } else swing.current.t += delta;
    if (blade.current !== null) blade.current.rotation.set(0, 0, swing.current.t < 0.16 ? lerp(1.2, -1.4, swing.current.t / 0.16) : 1.2);

    // Věci ve vzduchu: konec věci (zmizela, nebo v jejím slotu vyletěla nová) nad čárou řezu = rozseknutá.
    const mem = memory.current;
    const fruit: number[] = [];
    const bombs: number[] = [];
    const bonus: number[] = [];
    const golden: number[] = [];
    for (let index = from; index < count; index += 1) {
      const base = bodyBase(index);
      const alive = ((state[base + BODY.flags] as number) & FLAG.alive) !== 0;
      const role = state[base + BODY.role] as number;
      const vy = state[base + BODY.vy] as number;
      const last = (mem[index] ??= { alive: false, x: 0, y: 0, vy: 0, role: 0 });
      const relaunched = alive && last.alive && vy > last.vy;
      if (last.alive && (!alive || relaunched) && last.y >= SLICED_FROM) {
        const pool = last.role === ROLE.hazard ? blasts.current : halves.current;
        const free = pool.reduce((best, slot) => (slot.left < best.left ? slot : best));
        Object.assign(free, { x: -last.x / UNIT, y: last.y / UNIT + THING / 2, left: last.role === ROLE.hazard ? LIFE.blast : LIFE.halves, tilt: index % 2 === 0 ? 1 : -1 });
      }
      Object.assign(last, { alive, x: state[base + BODY.x] as number, y: state[base + BODY.y] as number, vy, role });
      if (!alive) continue;
      if (role === ROLE.collectible && sliceInView(state, index)) (bodyHp(state, index) === EVENT_MARK.golden ? golden : bonus).push(index);
      else if (role === ROLE.collectible) fruit.push(index);
      else if (role === ROLE.hazard) bombs.push(index);
    }
    const place = (list: (Group | null)[], bodies: readonly number[]): void => {
      list.forEach((group, slot) => {
        if (group === null) return;
        const body = bodies[slot];
        group.visible = body !== undefined;
        if (body === undefined) return;
        // Čerstvě vyhozená věc ve znovu použitém slotu se nekreslí na půl cesty ze staré polohy.
        const fresh = ((prev[bodyBase(body) + BODY.flags] as number) & FLAG.alive) === 0 || (state[bodyBase(body) + BODY.vy] as number) > (prev[bodyBase(body) + BODY.vy] as number);
        const x = fresh ? -(state[bodyBase(body) + BODY.x] as number) / UNIT : -at(body, BODY.x);
        const y = fresh ? (state[bodyBase(body) + BODY.y] as number) / UNIT : at(body, BODY.y);
        group.position.set(x, y * stretch, PLANE_Z);
        group.rotation.set(time.current * 1.7 + body, time.current * 2.3 + body * 0.7, 0);
      });
    };
    place(groups.current.fruit, fruit);
    place(groups.current.bomb, bombs);
    place(groups.current.bonus, bonus);
    place(groups.current.golden, golden);

    // Stopy čepele: tenký pás přes pruh, který se ztenčuje.
    trails.current.forEach((slot, index) => {
      const mesh = groups.current.trails[index];
      slot.left -= delta;
      if (mesh === null || mesh === undefined) return;
      mesh.visible = slot.left > 0;
      if (!mesh.visible) return;
      const k = slot.left / LIFE.trail;
      mesh.position.set(slot.x, slot.y * stretch, PLANE_Z - 0.5);
      mesh.rotation.set(0, 0, slot.tilt);
      mesh.scale.set(0.7 + 0.3 * (1 - k), Math.max(0.05, k), 1);
    });
    // Půlky ovoce se rozletí do stran a padají; plochou řezu jsou natočené ke kameře (ta kouká po +z).
    halves.current.forEach((slot, index) => {
      const group = groups.current.halves[index];
      slot.left -= delta;
      if (group === null || group === undefined) return;
      group.visible = slot.left > 0;
      if (!group.visible) return;
      const t = LIFE.halves - slot.left;
      const [left, right] = group.children;
      const rise = 2.2 * t - (HALF_GRAVITY * t * t) / 2;
      const spin = slot.tilt * 4 * t;
      left?.position.set(slot.x - 2.4 * t, slot.y * stretch + rise, PLANE_Z);
      left?.rotation.set(0, Math.PI + 0.7, spin);
      right?.position.set(slot.x + 2.4 * t, slot.y * stretch + rise, PLANE_Z);
      right?.rotation.set(0, -0.7, -spin);
    });
    // Záblesk rozseknuté bomby se nafoukne a zmizí.
    blasts.current.forEach((slot, index) => {
      const mesh = groups.current.blasts[index];
      slot.left -= delta;
      if (mesh === null || mesh === undefined) return;
      mesh.visible = slot.left > 0;
      if (!mesh.visible) return;
      mesh.position.set(slot.x, slot.y * stretch, PLANE_Z - 0.3);
      mesh.scale.setScalar(0.4 + 1.4 * (1 - slot.left / LIFE.blast));
    });

    if (tall !== null) {
      camera.position.copy(tall.position);
      camera.lookAt(look3.set(tall.position.x, tall.position.y, 0));
    } else {
      // Na výšku rozhoduje šíře pruhů, na šířku výška letu; volná výška jde z větší části pod zem (pole před hrdinou).
      const tan = Math.tan((camera.fov * Math.PI) / 360);
      const needed = (VIEW.top - VIEW.bottom) / 2;
      const distance = Math.max((FIELD_HALF + 0.5) / (tan * camera.aspect), needed / tan);
      const spare = distance * tan - needed;
      const y = (VIEW.top + VIEW.bottom) / 2 + spare * SKY_SHARE;
      camera.position.set(0, y, -distance);
      camera.lookAt(look3.set(0, y, 0));
    }
    const host = surface.current;
    if (host === null) return;
    camera.updateMatrixWorld();
    const fraction = (x: number): number => (probe.set(x, CUT_M * stretch, PLANE_Z).project(camera).x + 1) / 2;
    const edges = LANE_EDGES.map((edge) => fraction(-edge / UNIT).toFixed(4)).join(',');
    if (host.dataset.laneEdges !== edges) host.dataset.laneEdges = edges;
    host.dataset.playerX = probe.set(heroX, HERO.h, 0).project(camera).x.toFixed(3);
  });

  return (
    <>
      <FieldGround look={look} area={LAND} y={-0.03} />
      <HorizonBackdrop look={look} seed={world.seed} clear={0} beyond={24} />
      {/* Pruhy z povrchu sady (P56B T11). */}
      <LaneStrips look={look} z0={-1} z1={PLANE_Z + 1} />
      {Array.from({ length: LANES.count }, (_, lane) => (
        <group key={lane} position={[-laneX(lane) / UNIT, 0, 0]}>
          {/* Bedna, ze které věci pruhu vylétají. */}
          <mesh position={[0, 0.22, PLANE_Z]} castShadow>
            <boxGeometry args={[LANE_M * 0.7, 0.44, 0.9]} />
            <meshStandardMaterial color={color['cream-deep']} roughness={0.9} />
          </mesh>
        </group>
      ))}
      {/* Čára řezu: nad ní čepel dosáhne; na výšku telefonu jede s nataženým letem nahoru. */}
      <group ref={cutLines}>
        {Array.from({ length: LANES.count }, (_, lane) => (
          <mesh key={lane} position={[-laneX(lane) / UNIT, CUT_M, PLANE_Z - 0.45]}>
            <boxGeometry args={[LANE_M * 0.72, 0.05, 0.02]} />
            <meshStandardMaterial color={color.sun} emissive={color.sun} emissiveIntensity={0.35} />
          </mesh>
        ))}
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
        {/* Čepel v ruce hrdiny; švih ji přetočí. */}
        <group ref={blade} position={[-HERO.w / 2 - 0.05, HERO.h * 0.6, -0.2]}>
          <mesh position={[0, 0.5, 0]}>
            <boxGeometry args={[0.07, 0.85, 0.03]} />
            <meshStandardMaterial color={color.paper} emissive={color.sky} emissiveIntensity={0.25} metalness={0.3} />
          </mesh>
          <mesh>
            <boxGeometry args={[0.22, 0.06, 0.06]} />
            <meshStandardMaterial color={color['sun-deep']} />
          </mesh>
        </group>
      </group>
      <GhostSlot ghost={ghost} session={session} place={ghostSpot} />
      {Array.from({ length: SLOTS.fruit }, (_, index) => (
        <group
          key={`fruit-${index}`}
          ref={(group) => {
            groups.current.fruit[index] = group;
          }}
          visible={false}
          userData={{ frame: 'target', item: 'coin' }}
        >
          {fruitModel !== undefined ? <FittedModel id={fruitModel} w={THING} h={THING} d={THING} fallback={color['mint-deep']} /> : <Melon />}
        </group>
      ))}
      {Array.from({ length: SLOTS.bomb }, (_, index) => (
        <group
          key={`bomb-${index}`}
          ref={(group) => {
            groups.current.bomb[index] = group;
          }}
          visible={false}
          userData={{ frame: 'target', item: 'hazard' }}
        >
          {bombModel !== undefined ? <FittedModel id={bombModel} w={THING} h={THING} d={THING} fallback={color.ink} /> : <Bomb />}
        </group>
      ))}
      {Array.from({ length: SLOTS.bonus }, (_, index) => (
        <group
          key={`bonus-${index}`}
          ref={(group) => {
            groups.current.bonus[index] = group;
          }}
          visible={false}
          userData={{ frame: 'target', item: 'coin', bonus: true }}
        >
          {fruitModel !== undefined ? <FittedModel id={fruitModel} w={THING} h={THING} d={THING} fallback={color['mint-deep']} /> : <Melon />}
          <BonusHalo />
        </group>
      ))}
      {Array.from({ length: SLOTS.golden }, (_, index) => (
        <group
          key={`golden-${index}`}
          ref={(group) => {
            groups.current.golden[index] = group;
          }}
          visible={false}
          userData={{ frame: 'target', item: 'coin', event: 'golden' }}
        >
          <Golden />
        </group>
      ))}
      {Array.from({ length: SLOTS.trails }, (_, index) => (
        <mesh
          key={`trail-${index}`}
          ref={(mesh) => {
            groups.current.trails[index] = mesh;
          }}
          visible={false}
        >
          <boxGeometry args={[LANE_M * 1.05, 0.18, 0.02]} />
          <meshStandardMaterial color={color.paper} emissive={color.sky} emissiveIntensity={0.6} />
        </mesh>
      ))}
      {Array.from({ length: SLOTS.halves }, (_, index) => (
        <group
          key={`halves-${index}`}
          ref={(group) => {
            groups.current.halves[index] = group;
          }}
          visible={false}
        >
          <Half skin={skin} flesh={flesh} />
          <Half skin={skin} flesh={flesh} />
        </group>
      ))}
      {Array.from({ length: SLOTS.blasts }, (_, index) => (
        <mesh
          key={`blast-${index}`}
          ref={(mesh) => {
            groups.current.blasts[index] = mesh;
          }}
          visible={false}
        >
          <sphereGeometry args={[THING / 2, 12, 8]} />
          <meshStandardMaterial color={color.tomato} emissive={color.tomato} emissiveIntensity={0.8} />
        </mesh>
      ))}
    </>
  );
}
