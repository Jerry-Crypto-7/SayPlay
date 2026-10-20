'use client';

/**
 * Scéna bouchání (P54C T6): pět děr v řadě před hrdinou, kamera za ním a nad ním. Kamera kouká
 * po +z, takže x jádra se zrcadlí jako u pruhů (`LaneScene`) – díra 0 leží vlevo. Na výšku se do
 * obrazu vejde celá řada děr, na šířku i hrdina s kladivem.
 *
 * Co jádro nevidí (vykouknutí a zasunutí cíle, zplacknutí po ráně, kladivo, kamera), je jen obraz:
 * stav ani hash nemění. Výšku cíle jádro používá jako hodiny okna (`WHACK.band`), scéna z ní
 * počítá jen, jak daleko cíl z díry kouká. Kreslí se z malé zásoby slotů: naráz koukají nejvýš
 * dva cíle (krtek a hodný soused), takže zásoba drží počet sítí i rigovaných modelů nízko.
 * Plocha dostane `data-lane-edges` (hranice děr na řadě, zleva doprava), podle kterých prst trefí
 * díru (`lanes-input.ts`), a `data-player-x` pro vyskakující body.
 * Modely jsou z knihovny podle popisku (`cast.props.target` krtek, `cast.props.hazard` hodný cíl);
 * bez modelu primitiva v barvách kitu.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useCallback, useMemo, useRef } from 'react';
import { type Group, type PerspectiveCamera, Vector3 } from 'three';

import { color } from '@/brand/tokens';
import { BODY, FLAG, HEADER, ROLE, UNIT, bodyBase } from '@/play/arcade/contract';
import { riggedCharacter } from '@/play/arcade/models';
import { LANES, laneOf, laneX } from '@/play/arcade/pieces/lanes';
import { WHACK } from '@/play/arcade/pieces/whack';

import { renderHeld } from '../../effects/render-feel';
import type { GhostPlacement } from '../../Ghost';
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
/** Kamera kouká na řadu děr shora pod tímhle úhlem (rad). */
const PITCH = 0.7;
const LOOK = new Vector3(0, 0.6, HOLE_Z / 2 + 0.2);
const LAND = { x0: -30, x1: 30, z0: -30, z1: 40 } as const;

const lerp = (from: number, to: number, alpha: number): number => from + (to - from) * alpha;
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/** Hranice mezi dírami l | l+1 v x jádra; kreslí se zrcadlově. */
const LANE_EDGES = Array.from({ length: LANES.count - 1 }, (_, lane) => laneX(lane) + LANES.width / 2);

type WhackSceneProps = Omit<WorldProps, 'control' | 'backdrop'>;

/** Slot zásoby: tělo, které kreslí (−1 = volný), a zbylé zplacknutí po ráně (s). */
interface Slot {
  body: number;
  squash: number;
}

const emptySlots = (): Slot[] => Array.from({ length: SLOTS }, () => ({ body: -1, squash: 0 }));

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
    const out: { readonly index: number; readonly good: boolean }[] = [];
    for (let index = 1; index < (world.initial[HEADER.bodyCount] as number); index += 1) {
      const role = world.initial[bodyBase(index) + BODY.role];
      if (role === ROLE.target || role === ROLE.hazard) out.push({ index, good: role === ROLE.hazard });
    }
    return out;
  }, [world]);
  const groups = useRef<{ mole: (Group | null)[]; good: (Group | null)[] }>({ mole: [], good: [] });
  const slots = useRef<{ mole: Slot[]; good: Slot[] }>({ mole: emptySlots(), good: emptySlots() });
  const seen = useRef<Uint8Array>(new Uint8Array(0));
  const hero = useRef<Group | null>(null);
  const hammer = useRef<Group | null>(null);
  const swing = useRef({ tick: -1, t: Number.POSITIVE_INFINITY, x: 0 });
  const moving = useRef(false);
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const look3 = useMemo(() => new Vector3(), []);
  const probe = useMemo(() => new Vector3(), []);
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
    const showing = { mole: [] as number[], good: [] as number[] };
    targets.forEach((target, order) => {
      const base = bodyBase(target.index);
      const alive = ((state[base + BODY.flags] as number) & FLAG.alive) !== 0;
      const pool = target.good ? slots.current.good : slots.current.mole;
      const own = pool.find((slot) => slot.body === target.index);
      if (seen.current[order] === 1 && !alive && (state[base + BODY.y] as number) < WHACK.band && own !== undefined) own.squash = SQUASH_S;
      seen.current[order] = alive ? 1 : 0;
      const y = at(target.index, BODY.y);
      const open = alive && y >= 0 && y < WHACK.band;
      if (open || (own !== undefined && own.squash > 0)) (target.good ? showing.good : showing.mole).push(target.index);
    });
    for (const kind of ['mole', 'good'] as const) {
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

    // Na výšku rozhoduje šíře řady děr, na šířku výška záběru (hrdina, díry, kladivo).
    const tan = Math.tan((camera.fov * Math.PI) / 360);
    const distance = Math.max((FIELD_HALF + 0.6) / (tan * camera.aspect), 2.8 / tan);
    camera.position.set(LOOK.x, LOOK.y + Math.sin(PITCH) * distance, LOOK.z - Math.cos(PITCH) * distance);
    camera.lookAt(look3.copy(LOOK));
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
      {(['mole', 'good'] as const).map((kind) =>
        Array.from({ length: SLOTS }, (_, index) => (
          <group
            key={`${kind}-${index}`}
            ref={(group) => {
              groups.current[kind][index] = group;
            }}
            visible={false}
            userData={{ frame: 'target', item: kind === 'good' ? 'hazard' : 'target' }}
          >
            {kind === 'good' ? <Prop id={goodModel} fallback={color.cream} primitive={<Bunny />} /> : <Prop id={moleModel} fallback={color['ink-soft']} primitive={<Mole />} />}
          </group>
        )),
      )}
    </>
  );
}
