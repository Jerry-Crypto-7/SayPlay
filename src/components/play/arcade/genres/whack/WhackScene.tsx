'use client';

/**
 * Scéna bouchání (P54C T6): pět děr v řadě před hrdinou, kamera za ním a nad ním. Kamera kouká
 * po +z, takže x jádra se zrcadlí jako u pruhů (`LaneScene`) – díra 0 leží vlevo. Na výšku se do
 * obrazu vejde celá řada děr, na šířku i hrdina s kladivem.
 *
 * Co jádro nevidí (vykouknutí a zasunutí cíle, zplacknutí po ráně, kladivo, kamera), je jen obraz:
 * stav ani hash nemění. Výšku cíle jádro používá jako hodiny okna (`WHACK.band`), scéna z ní
 * počítá jen, jak daleko cíl z díry kouká. Kreslí se z malé zásoby slotů pro každý druh (krtek, hodný
 * soused, bonus série a spěchu s kroužkem, zlatý cíl – P55 T5), takže počet sítí i rigovaných modelů zůstane nízký.
 * Plocha dostane `data-lane-edges` (hranice děr na řadě, zleva doprava), podle kterých prst trefí
 * díru (`lanes-input.ts`), a `data-player-x` pro vyskakující body.
 * Modely jsou z knihovny podle popisku (`cast.props.target` krtek, `cast.props.hazard` hodný cíl);
 * bez modelu primitiva v barvách kitu.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useCallback, useMemo, useRef } from 'react';
import { Box3, type Group, type PerspectiveCamera, Vector3 } from 'three';

import { color } from '@/brand/tokens';
import { BODY, FLAG, HEADER, ROLE, UNIT, bodyBase, bodyHp } from '@/play/arcade/contract';
import { riggedCharacter } from '@/play/arcade/models';
import { type LaneEventKind, eventOfMark } from '@/play/arcade/pieces/lane-events';
import { LANES, laneOf, laneX } from '@/play/arcade/pieces/lanes';
import { WHACK } from '@/play/arcade/pieces/whack';

import { renderHeld } from '../../effects/render-feel';
import type { GhostPlacement } from '../../Ghost';
import { type PlayRect, fitTall, usePlayRectRef } from '../../portrait-frame';
import { type GhostPose, GhostSlot } from '../../GhostSlot';
import { HorizonBackdrop } from '../../look/Backdrop';
import { FieldGround } from '../../look/FieldGround';
import { RiggedModel } from '../../RiggedModel';
import { FittedModel, type WorldProps } from '../../World';

const m = (units: number): number => units / UNIT;
const FIELD_HALF = (LANES.count * m(LANES.width)) / 2;
const HERO = { w: m(WHACK.hero.w), h: m(WHACK.hero.h), d: m(WHACK.hero.d) };
const HOLE_Z = m(WHACK.holeZ);
/** Cíl se kreslí o kus větší než jeho tělo, ať je na telefonu vidět. */
const TARGET = 1.15;
/** Za kolik tiků cíl z díry vyjede a zase zajede (jen obraz). */
const RISE_TICKS = 4;
/** Zplacknutí po ráně (s). */
const SQUASH_S = 0.18;
/** Úder kladiva: dolů a zpátky nahoru (s); kladivo visí nad dírou zdvižené (rad kolem x). */
const SWING = { down: 0.07, up: 0.18, raised: -0.6, struck: 0.5 } as const;
/** Slotů zásoby na krtky a na hodné cíle: naráz koukají nejvýš dva, přechod třetin a zplacknutí přidají pár. */
const SLOTS = 4;
/** Druhy cílů, každý s vlastní zásobou slotů: bonusy událostí (P55 T5) koukají až z pěti děr naráz. */
const KINDS = ['mole', 'good', 'bonus', 'golden'] as const;
type Kind = (typeof KINDS)[number];
const POOL: Readonly<Record<Kind, number>> = { mole: SLOTS, good: SLOTS, bonus: LANES.count + 1, golden: 2 };
/** Kamera kouká na řadu děr shora pod tímhle úhlem (rad). */
const PITCH = 0.7;
const LOOK = new Vector3(0, 0.6, HOLE_Z / 2 + 0.2);
/**
 * Hrdina v krajním pruhu stojí blíž kameře než díry, takže na šířku vyčníval ke kraji obrazu (NDC 0,95, P58A T4).
 * Jeho střed musí zůstat do `HERO_FIT` NDC; `HERO_GAP` je, o kolik metrů blíž kameře než bod pohledu stojí.
 */
const HERO_FIT = 0.8;
const HERO_LANE = FIELD_HALF - m(LANES.width) / 2;
const HERO_GAP = LOOK.z * Math.cos(PITCH) - (LOOK.y - HERO.h / 2) * Math.sin(PITCH);
const LAND = { x0: -30, x1: 30, z0: -30, z1: 40 } as const;
/**
 * Na výšku telefonu (P64 T3): řada pěti děr je 10 m široká a jen 2,4 m hluboká, zepředu by ji držela šíře obrazu
 * a hrdina by zůstal malý (P61: 0,41 plochy na šířku). Kamera se proto natočí kolem svislé osy: řada běží šikmo
 * nahoru po obrazovce, blízký konec dole, vzdálený nahoře, a do šíře obrazu jde jen průmět řady. Pořadí děr zleva
 * doprava zůstává, takže prst je trefí podle `data-lane-edges` jako dřív (při 1,1 rad má díra na prst ~50 px).
 * `hero` = vizuální měřítko hrdiny na výšku: i natočená řada drží kameru tak daleko, že hrdina by se stropem
 * čitelnosti (2×, P58A) zůstal pod její podlahou (20 % výšky). Cíle se hrdiny nikdy nedotknou (kladivo míří do
 * díry), takže větší postava nic neklame. Víc nepomáhá: nad podlahou ji čitelnost už nezvětšuje a větší krabice
 * odsune kameru – 2,0 dalo na iPhonu 15 menší podíl (0,048) než 1,8 (0,054). README T3 má zkoušené kombinace.
 */
const TALL = { pitch: 0.9, yaw: 1.1, hero: 1.8 } as const;

const lerp = (from: number, to: number, alpha: number): number => from + (to - from) * alpha;

/**
 * Na výšku do `playRect` (`fitTall`): hrdina (zvětšený `TALL.hero` a čitelností až 2×) a vykouknutý cíl svisle; do
 * stran jen řada hrdiny a řada děr od krajní díry po krajní díru – natočená krabice s hloubkou by ji jinak zbytečně
 * rozšířila.
 */
const HOLE_RIM = 0.9;
const TALL_BOX = new Box3(new Vector3(-HERO_LANE - HOLE_RIM, 0, -0.75 * HERO.d), new Vector3(HERO_LANE + HOLE_RIM, HERO.h * 2 * TALL.hero, HOLE_Z + HOLE_RIM));
const TALL_KEEP = new Box3(new Vector3(-HERO_LANE - HOLE_RIM, 0, 0), new Vector3(HERO_LANE + HOLE_RIM, TARGET, HOLE_Z));
const TALL_LOOK = new Vector3(0, TARGET / 2, HOLE_Z / 2);
const TALL_DIR = new Vector3(Math.sin(TALL.yaw) * Math.cos(TALL.pitch), Math.sin(TALL.pitch), -Math.cos(TALL.yaw) * Math.cos(TALL.pitch));

/** Kamera bouchání na výšku: šikmo shora na střed řady, pak přes `fitTall` co nejblíž do `playRect`. */
function placeTall(camera: PerspectiveCamera, rect: PlayRect): Vector3 {
  camera.position.copy(TALL_LOOK).addScaledVector(TALL_DIR, 20);
  camera.lookAt(TALL_LOOK);
  return fitTall(camera, TALL_BOX, rect, { keep: TALL_KEEP }).position;
}
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/** Hranice mezi dírami l | l+1 v x jádra; kreslí se zrcadlově. */
const LANE_EDGES = Array.from({ length: LANES.count - 1 }, (_, lane) => laneX(lane) + LANES.width / 2);

type WhackSceneProps = Omit<WorldProps, 'control' | 'backdrop'>;

/** Slot zásoby: tělo, které kreslí (−1 = volný), a zbylé zplacknutí po ráně (s). */
interface Slot {
  body: number;
  squash: number;
}

const emptySlots = (kind: Kind): Slot[] => Array.from({ length: POOL[kind] }, () => ({ body: -1, squash: 0 }));
const perKind = <T,>(make: (kind: Kind) => T): Record<Kind, T> => ({ mole: make('mole'), good: make('good'), bonus: make('bonus'), golden: make('golden') });

function kindOf(role: number, event: LaneEventKind | null): Kind {
  if (role === ROLE.hazard) return 'good';
  return event === null ? 'mole' : event === 'golden' ? 'golden' : 'bonus';
}

function Mole() {
  return (
    <group>
      <mesh position={[0, 0.35, 0]} castShadow>
        <cylinderGeometry args={[0.4, 0.46, 0.7, 14]} />
        <meshStandardMaterial color={color['ink-soft']} roughness={0.8} />
      </mesh>
      <mesh position={[0, 0.72, 0]} castShadow>
        <sphereGeometry args={[0.4, 16, 12]} />
        <meshStandardMaterial color={color['ink-soft']} roughness={0.8} />
      </mesh>
      {/* Čenich a oči míří ke kameře (−z). */}
      <mesh position={[0, 0.66, -0.4]}>
        <sphereGeometry args={[0.11, 10, 8]} />
        <meshStandardMaterial color={color.bubblegum} />
      </mesh>
      {[-0.16, 0.16].map((x) => (
        <mesh key={x} position={[x, 0.86, -0.33]}>
          <sphereGeometry args={[0.07, 8, 6]} />
          <meshStandardMaterial color={color.ink} />
        </mesh>
      ))}
    </group>
  );
}

function Bunny() {
  return (
    <group>
      <mesh position={[0, 0.34, 0]} castShadow>
        <sphereGeometry args={[0.38, 16, 12]} />
        <meshStandardMaterial color={color.cream} roughness={0.7} />
      </mesh>
      <mesh position={[0, 0.74, -0.05]} castShadow>
        <sphereGeometry args={[0.28, 14, 10]} />
        <meshStandardMaterial color={color.cream} roughness={0.7} />
      </mesh>
      {[-0.12, 0.12].map((x) => (
        <mesh key={x} position={[x, 1.12, -0.02]} rotation={[0, 0, x > 0 ? -0.15 : 0.15]}>
          <capsuleGeometry args={[0.06, 0.34, 4, 8]} />
          <meshStandardMaterial color={color.bubblegum} />
        </mesh>
      ))}
    </group>
  );
}

/** Zlatý cíl události (P55 T5): svítí, ať je hned vidět, že stojí za ránu navíc. */
function Golden() {
  return (
    <mesh position={[0, 0.55, 0]} castShadow>
      <icosahedronGeometry args={[0.48, 0]} />
      <meshStandardMaterial color={color['sun-deep']} emissive={color.sun} emissiveIntensity={0.7} roughness={0.3} metalness={0.4} />
    </mesh>
  );
}

/** Kroužek kolem bonusu série a spěchu: krtek navíc, který se do cíle nepočítá. */
function BonusHalo() {
  return (
    <mesh position={[0, 0.55, 0]} rotation={[Math.PI / 2, 0, 0]}>
      <torusGeometry args={[0.62, 0.05, 6, 20]} />
      <meshStandardMaterial color={color['sun-soft']} emissive={color.sun} emissiveIntensity={0.8} />
    </mesh>
  );
}

/** Model z knihovny podle id, rigovaný přes `RiggedModel`, jinak vepsaný; bez id primitivum. */
function Prop({ id, fallback, primitive }: { readonly id: string | undefined; readonly fallback: string; readonly primitive: React.ReactNode }) {
  if (id === undefined) return <>{primitive}</>;
  const rig = riggedCharacter(id);
  // Cíl kouká z díry ke kameře (−z).
  return (
    <group rotation={[0, Math.PI, 0]}>
      {rig !== undefined ? <RiggedModel character={rig} h={TARGET} clip={() => 'idle'} fallback={fallback} /> : <FittedModel id={id} w={TARGET} h={TARGET} d={TARGET} fallback={fallback} />}
    </group>
  );
}

export function WhackScene({ session, cast, surface, scene: look, ghost }: WhackSceneProps) {
  const world = session.world;
  const targets = useMemo(() => {
    const out: { readonly index: number; readonly kind: Kind }[] = [];
    const initial = Int32Array.from(world.initial);
    for (let index = 1; index < (world.initial[HEADER.bodyCount] as number); index += 1) {
      const role = world.initial[bodyBase(index) + BODY.role] as number;
      if (role === ROLE.target || role === ROLE.hazard) out.push({ index, kind: kindOf(role, eventOfMark(bodyHp(initial, index))) });
    }
    return out;
  }, [world]);
  const groups = useRef<Record<Kind, (Group | null)[]>>(perKind(() => []));
  const slots = useRef<Record<Kind, Slot[]>>(perKind(emptySlots));
  const seen = useRef<Uint8Array>(new Uint8Array(0));
  const hero = useRef<Group | null>(null);
  const hammer = useRef<Group | null>(null);
  const swing = useRef({ tick: -1, t: Number.POSITIVE_INFINITY, x: 0 });
  const moving = useRef(false);
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const look3 = useMemo(() => new Vector3(), []);
  const probe = useMemo(() => new Vector3(), []);
  const playRect = usePlayRectRef();
  const tallFrame = useRef<{ readonly rect: PlayRect; readonly aspect: number; readonly position: Vector3 } | null>(null);
  const heroScaled = useRef(1);
  const heroRig = riggedCharacter(cast.player);
  // Duch dřívějšího běhu jezdí po pruzích svého běhu kousek za hrdinou (blíž ke kameře), čelem k dírám.
  const ghostSpot = useCallback((pose: GhostPose): GhostPlacement => [-pose.x / UNIT, 0, -HERO.d * 1.2, 0], []);

  useFrame((_, delta) => {
    const alpha = session.advance(delta * 1000);
    if (renderHeld(session)) return;
    const state = session.state();
    const prev = session.prev();
    const at = (index: number, slot: number): number => lerp(prev[bodyBase(index) + slot] as number, state[bodyBase(index) + slot] as number, alpha);
    const player = state[HEADER.player] as number;
    const heroX = -at(player, BODY.x) / UNIT;
    hero.current?.position.set(heroX, 0, 0);
    // Na výšku telefonu `playRect` (P64 T3), jinak `null`.
    const rect = camera.aspect < 1 ? playRect.current : null;
    // Měřítko hrdiny na výšku (`TALL.hero`) se zapíše jen při změně: čitelnost (`LegibleBodies`) ho vezme za nový základ.
    const heroScale = rect !== null ? TALL.hero : 1;
    if (hero.current !== null && heroScaled.current !== heroScale) {
      hero.current.scale.setScalar(heroScale);
      heroScaled.current = heroScale;
    }
    moving.current = state[bodyBase(player) + BODY.x] !== prev[bodyBase(player) + BODY.x];

    // Kladivo visí nad dírou pruhu, který hráč zvolil (ťuk platí hned, hrdina dojde za ním); ťuk ho spustí.
    const tick = state[HEADER.tick] as number;
    const hit = swing.current;
    if ((state[bodyBase(player) + BODY.aux1] as number) === -1 && hit.tick !== tick) {
      hit.tick = tick;
      hit.t = 0;
    } else hit.t += delta;
    hit.x = lerp(hit.x, -laneX(laneOf(state, player)) / UNIT, hit.t === 0 ? 1 : Math.min(1, delta * 18));
    const angle = hit.t < SWING.down ? lerp(SWING.raised, SWING.struck, hit.t / SWING.down) : hit.t < SWING.down + SWING.up ? lerp(SWING.struck, SWING.raised, (hit.t - SWING.down) / SWING.up) : SWING.raised;
    hammer.current?.position.set(hit.x, 1.25, HOLE_Z - 1.3);
    hammer.current?.rotation.set(angle, 0, 0);

    // Kdo kouká z díry, dostane slot; cíl zasažený v okně se ještě chvíli zplackává.
    if (seen.current.length !== targets.length) seen.current = new Uint8Array(targets.length);
    const showing = perKind((): number[] => []);
    targets.forEach((target, order) => {
      const base = bodyBase(target.index);
      const alive = ((state[base + BODY.flags] as number) & FLAG.alive) !== 0;
      const own = slots.current[target.kind].find((slot) => slot.body === target.index);
      if (seen.current[order] === 1 && !alive && (state[base + BODY.y] as number) < WHACK.band && own !== undefined) own.squash = SQUASH_S;
      seen.current[order] = alive ? 1 : 0;
      const y = at(target.index, BODY.y);
      const open = alive && y >= 0 && y < WHACK.band;
      if (open || (own !== undefined && own.squash > 0)) showing[target.kind].push(target.index);
    });
    for (const kind of KINDS) {
      const pool = slots.current[kind];
      const wanted = showing[kind];
      // Sloty, jejichž cíl už nekouká, se uvolní; nový cíl dostane první volný (pořadí slotů zůstane, model se nepřestaví).
      for (const slot of pool) {
        if (!wanted.includes(slot.body)) {
          slot.body = -1;
          slot.squash = 0;
        }
      }
      for (const body of wanted) {
        if (pool.some((slot) => slot.body === body)) continue;
        const free = pool.find((slot) => slot.body < 0);
        if (free !== undefined) free.body = body;
      }
      pool.forEach((slot, index) => {
        const group = groups.current[kind][index];
        if (group === null || group === undefined) return;
        group.visible = slot.body >= 0;
        if (!group.visible) return;
        const base = bodyBase(slot.body);
        const vy = state[base + BODY.vy] as number;
        const y = at(slot.body, BODY.y);
        const up = slot.squash > 0 ? 1 : clamp01(Math.min(y / vy, (WHACK.band - y) / vy) / RISE_TICKS);
        group.position.set(-(state[base + BODY.x] as number) / UNIT, -TARGET * (1 - up), HOLE_Z);
        group.scale.set(1, slot.squash > 0 ? 0.25 + (0.75 * slot.squash) / SQUASH_S : 1, 1);
        if (slot.squash > 0) slot.squash = Math.max(0, slot.squash - delta);
      });
    }

    if (rect !== null) {
      // Na výšku telefonu (P64 T3) šikmo do `playRect`; spočítá se jen při změně obdélníku nebo poměru stran.
      const cached = tallFrame.current;
      if (cached === null || cached.rect !== rect || cached.aspect !== camera.aspect) tallFrame.current = { rect, aspect: camera.aspect, position: placeTall(camera, rect) };
      camera.position.copy(tallFrame.current!.position);
      camera.lookAt(look3.copy(tallFrame.current!.position).sub(TALL_DIR));
    } else {
      // Jako dřív (na šířku a dokud `playRect` není změřený): na výšku rozhoduje šíře řady děr, na šířku výška
      // záběru (hrdina, díry, kladivo).
      const tan = Math.tan((camera.fov * Math.PI) / 360);
      const distance = Math.max((FIELD_HALF + 0.6) / (tan * camera.aspect), 2.8 / tan, HERO_LANE / (HERO_FIT * tan * camera.aspect) + HERO_GAP);
      camera.position.set(LOOK.x, LOOK.y + Math.sin(PITCH) * distance, LOOK.z - Math.cos(PITCH) * distance);
      camera.lookAt(look3.copy(LOOK));
    }
    const host = surface.current;
    if (host === null) return;
    camera.updateMatrixWorld();
    const fraction = (x: number): number => (probe.set(x, 0, HOLE_Z).project(camera).x + 1) / 2;
    const edges = LANE_EDGES.map((edge) => fraction(-edge / UNIT).toFixed(4)).join(',');
    if (host.dataset.laneEdges !== edges) host.dataset.laneEdges = edges;
    host.dataset.playerX = probe.set(heroX, HERO.h, 0).project(camera).x.toFixed(3);
  });

  const moleModel = cast.props.target;
  const goodModel = cast.props.hazard;
  return (
    <>
      <FieldGround look={look} area={LAND} y={-0.03} />
      <HorizonBackdrop look={look} seed={world.seed} clear={0} beyond={24} />
      {Array.from({ length: LANES.count }, (_, lane) => (
        <group key={lane} position={[-laneX(lane) / UNIT, 0, HOLE_Z]}>
          <mesh position={[0, -0.01, 0]} receiveShadow>
            <cylinderGeometry args={[0.85, 0.9, 0.06, 24]} />
            <meshStandardMaterial color={color['cream-deep']} roughness={0.9} />
          </mesh>
          <mesh position={[0, 0.005, 0]}>
            <cylinderGeometry args={[0.6, 0.6, 0.06, 24]} />
            <meshStandardMaterial color={color.ink} roughness={1} />
          </mesh>
        </group>
      ))}
      <group ref={hero} userData={{ frame: 'hero' }}>
        {heroRig !== undefined ? (
          <RiggedModel character={heroRig} h={HERO.h} clip={() => (moving.current ? 'run' : 'idle')} fallback={color['sky-deep']} />
        ) : (
          <FittedModel id={cast.player} w={HERO.w} h={HERO.h} d={HERO.d} fallback={color['sky-deep']} character />
        )}
      </group>
      {/* Kladivo: násada od hrdiny k díře, hlava nad ní. */}
      <group ref={hammer} position={[0, 1.25, HOLE_Z - 1.3]}>
        <mesh position={[0, 0, 0.65]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.06, 0.06, 1.3, 8]} />
          <meshStandardMaterial color={color['sun-deep']} />
        </mesh>
        <mesh position={[0, 0, 1.3]} castShadow>
          <boxGeometry args={[0.7, 0.42, 0.42]} />
          <meshStandardMaterial color={color.tomato} />
        </mesh>
      </group>
      <GhostSlot ghost={ghost} session={session} place={ghostSpot} />
      {KINDS.map((kind) =>
        Array.from({ length: POOL[kind] }, (_, index) => (
          <group
            key={`${kind}-${index}`}
            ref={(group) => {
              groups.current[kind][index] = group;
            }}
            visible={false}
            userData={{ frame: 'target', item: kind === 'good' ? 'hazard' : 'target', ...(kind === 'golden' ? { event: 'golden' } : kind === 'bonus' ? { event: 'bonus' } : {}) }}
          >
            {kind === 'good' ? (
              <Prop id={goodModel} fallback={color.cream} primitive={<Bunny />} />
            ) : kind === 'golden' ? (
              <Golden />
            ) : (
              <Prop id={moleModel} fallback={color['ink-soft']} primitive={<Mole />} />
            )}
            {kind === 'bonus' ? <BonusHalo /> : null}
          </group>
        )),
      )}
    </>
  );
}
