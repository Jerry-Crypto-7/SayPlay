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
import { useCallback, useMemo, useRef } from 'react';
import { type Group, type PerspectiveCamera, Vector3 } from 'three';

import { color } from '@/brand/tokens';
import { BODY, FLAG, HEADER, ROLE, UNIT, bodyBase, bodyHp } from '@/play/arcade/contract';
import { riggedCharacter } from '@/play/arcade/models';
import { CATCH, catchInView } from '@/play/arcade/pieces/catch-fall';
import { type LaneEventKind, eventOfMark } from '@/play/arcade/pieces/lane-events';
import { LANES, laneX } from '@/play/arcade/pieces/lanes';

import { renderHeld } from '../../effects/render-feel';
import type { GhostPlacement } from '../../Ghost';
import { type GhostPose, GhostSlot } from '../../GhostSlot';
import { HorizonBackdrop } from '../../look/Backdrop';
import { FieldGround } from '../../look/FieldGround';
import { RiggedModel } from '../../RiggedModel';
import { FittedModel, type WorldProps } from '../../World';

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

const lerp = (from: number, to: number, alpha: number): number => from + (to - from) * alpha;

/** Hranice mezi pruhy l | l+1 v x jádra; kreslí se zrcadlově. */
const LANE_EDGES = Array.from({ length: LANES.count - 1 }, (_, lane) => laneX(lane) + LANES.width / 2);

type CatchSceneProps = Omit<WorldProps, 'control' | 'backdrop'>;

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
    for (const thing of things) {
      const group = groups.current[thing.index];
      if (group === null || group === undefined) continue;
      const base = bodyBase(thing.index);
      group.visible = ((state[base + BODY.flags] as number) & FLAG.alive) !== 0 && catchInView(state, thing.index);
      if (group.visible) group.position.set(-at(thing.index, BODY.x), at(thing.index, BODY.y), 0);
    }
    // Na výšku rozhoduje šíře pruhů, na šířku výška pádu; volná výška jde z větší části pod zem (pole před hrdinou).
    const tan = Math.tan((camera.fov * Math.PI) / 360);
    const needed = (VIEW.top - VIEW.bottom) / 2;
    const distance = Math.max((FIELD_HALF + 0.5) / (tan * camera.aspect), needed / tan);
    const spare = distance * tan - needed;
    const y = (VIEW.top + VIEW.bottom) / 2 + spare * SKY_SHARE;
    camera.position.set(0, y, -distance);
    camera.lookAt(look3.set(0, y, 0));
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
      {Array.from({ length: LANES.count }, (_, lane) => (
        <mesh key={lane} position={[-laneX(lane) / UNIT, -0.01, 0]} receiveShadow>
          <boxGeometry args={[LANE_M * 0.94, 0.04, 3]} />
          {/* Světlá deska (P55 T5): ovoce, bomby i bonusy na ní čtou dál než na zelené. */}
          <meshStandardMaterial color={lane % 2 === 0 ? color.paper : color['cream-deep']} />
        </mesh>
      ))}
      <mesh position={[0, CANOPY.bottom + CANOPY.h / 2, 0.6]}>
        <boxGeometry args={[FIELD_HALF * 2 + 1, CANOPY.h, 2.2]} />
        <meshStandardMaterial color={color.grass} roughness={0.9} />
      </mesh>
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
