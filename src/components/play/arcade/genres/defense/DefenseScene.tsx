'use client';

/**
 * Scéna obrany pruhů (P54C T7): pět pruhů od hradby k živému plotu, kamera za hrdinou a vysoko nad ním.
 * Kamera kouká po +z, takže x jádra se zrcadlí jako u pruhů (`LaneScene`) – pruh 0 leží vlevo. Na výšku
 * se do obrazu vejde celá šíře pruhů, na šířku celá hloubka pole.
 *
 * Nepřátelé vycházejí zpoza plotu (`DEFENSE.far` – dál je jádro má, ale hráč ani robot je nevidí) a jdou
 * k hradbě; útočníci se při běhu předklánějí. Co jádro nevidí (předklon, kývání, záblesk zásahu, ukazatel
 * držení, ukazatel HP bosse, kamera), je jen obraz: stav ani hash nemění. Nepřátelé, šípy a obránci se
 * kreslí ze zásoby slotů, ať počet sítí drží strop telefonu.
 * Plocha dostane `data-lane-edges` (hranice pruhů uprostřed pole, zleva doprava), podle kterých prst
 * trefí pruh (`lanes-input.ts`), a `data-player-x` pro vyskakující body.
 * Nepřítel nese model z popisku (`cast.chaser`); hradba, obránci a šípy jsou primitiva v barvách kitu.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useCallback, useMemo, useRef } from 'react';
import { type Group, type Mesh, type PerspectiveCamera, Vector3 } from 'three';

import { color } from '@/brand/tokens';
import { BODY, FLAG, HEADER, ROLE, UNIT, bodyBase, bodyHp, nativeRule } from '@/play/arcade/contract';
import { riggedCharacter } from '@/play/arcade/models';
import { DEFENSE } from '@/play/arcade/pieces/lane-defense';
import { LANES, heldTicks, laneOf, laneX } from '@/play/arcade/pieces/lanes';

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
const HERO = { w: m(DEFENSE.hero.w), h: m(DEFENSE.hero.h), d: m(DEFENSE.hero.d) };
const ENEMY = { w: m(DEFENSE.enemy.w), h: m(DEFENSE.enemy.h), d: m(DEFENSE.enemy.d) };
const BOSS = { w: m(DEFENSE.boss.w), h: m(DEFENSE.boss.h), d: m(DEFENSE.boss.d) };
const WALL = { z: m(DEFENSE.wall), h: m(DEFENSE.castle.h), d: m(DEFENSE.castle.d) };
const FAR = m(DEFENSE.far);
/** Živý plot těsně za čárou, odkud nepřátelé vycházejí. */
const HEDGE = { z: FAR + 0.9, h: 1.7 };
const LAND = { x0: -30, x1: 30, z0: -30, z1: 46 } as const;
/** Kamera kouká na pole shora pod tímhle úhlem (rad); míří doprostřed mezi hrdinu a plot. */
const PITCH = 0.95;
const LOOK = new Vector3(0, 0, (FAR - 1) / 2);
/** Hloubka, ve které se promítají hranice pruhů pro prst: uprostřed pole. */
const EDGE_Z = (WALL.z + FAR) / 2;
/** Slotů zásoby: pěšáků naráz v poli, obránců (jeden na pruh) a šípů ve vzduchu. */
const SLOTS = { marchers: 8, guards: LANES.count, shots: 8 } as const;
/** Útočník je rychlejší než tohle (jednotky za tik) – kreslí se předkloněný v běhu. */
const RUNNER_SPEED = 300;
/** Záblesk zásahu (s). */
const FLASH_S = 0.16;

const lerp = (from: number, to: number, alpha: number): number => from + (to - from) * alpha;

/** Hranice mezi pruhy l | l+1 v x jádra; kreslí se zrcadlově. */
const LANE_EDGES = Array.from({ length: LANES.count - 1 }, (_, lane) => laneX(lane) + LANES.width / 2);

type DefenseSceneProps = Omit<WorldProps, 'control' | 'backdrop'>;

/** Slot zásoby: tělo, které kreslí (−1 = volný), HP z minulého snímku a zbylý záblesk zásahu. */
interface Slot {
  body: number;
  hp: number;
  flash: number;
}

const emptySlots = (count: number): Slot[] => Array.from({ length: count }, () => ({ body: -1, hp: 0, flash: 0 }));

/** Model nepřítele z knihovny podle id (`cast.chaser`), rigovaný přes `RiggedModel`, jinak vepsaný. */
function Marcher({ id, size }: { readonly id: string; readonly size: { readonly w: number; readonly h: number; readonly d: number } }) {
  const rig = riggedCharacter(id);
  // Nepřítel jde ke kameře (−z).
  return (
    <group rotation={[0, Math.PI, 0]}>
      {rig !== undefined ? <RiggedModel character={rig} h={size.h} clip={() => 'run'} fallback={color['mint-deep']} /> : <FittedModel id={id} w={size.w} h={size.h} d={size.d} fallback={color['mint-deep']} character />}
    </group>
  );
}

/** Obránce na hradbě: věžička s lučištníkem. */
function Guard() {
  return (
    <group>
      <mesh position={[0, 0.35, 0]} castShadow>
        <cylinderGeometry args={[0.42, 0.48, 0.7, 12]} />
        <meshStandardMaterial color={color['cream-deep']} roughness={0.9} />
      </mesh>
      <mesh position={[0, 0.95, 0]} castShadow>
        <capsuleGeometry args={[0.18, 0.3, 4, 8]} />
        <meshStandardMaterial color={color['sky-deep']} />
      </mesh>
      <mesh position={[0, 1.4, 0]}>
        <coneGeometry args={[0.32, 0.4, 10]} />
        <meshStandardMaterial color={color.tomato} />
      </mesh>
    </group>
  );
}

export function DefenseScene({ session, cast, surface, scene: look, ghost }: DefenseSceneProps) {
  const world = session.world;
  const ids = useMemo(() => {
    const shot = nativeRule(world.rules, 'defense_shot')?.params as { readonly bolt: number; readonly arrow: number; readonly defender: number } | undefined;
    const hit = nativeRule(world.rules, 'defense_hit')?.params as { readonly boss: number } | undefined;
    const kind = (body: number | undefined): number => (body === undefined ? -1 : (world.initial[bodyBase(body) + BODY.kind] as number));
    return { bolt: kind(shot?.bolt), arrow: kind(shot?.arrow), defender: kind(shot?.defender), boss: hit?.boss ?? -1 };
  }, [world]);
  const groups = useRef<{ marchers: (Group | null)[]; guards: (Group | null)[]; shots: (Group | null)[] }>({ marchers: [], guards: [], shots: [] });
  const slots = useRef(emptySlots(SLOTS.marchers));
  const boss = useRef<Group | null>(null);
  const bossBar = useRef<Mesh | null>(null);
  const bossSlot = useRef<Slot>({ body: -1, hp: 0, flash: 0 });
  const hero = useRef<Group | null>(null);
  const holdRing = useRef<Mesh | null>(null);
  const moving = useRef(false);
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const look3 = useMemo(() => new Vector3(), []);
  const probe = useMemo(() => new Vector3(), []);
  const heroRig = riggedCharacter(cast.player);
  const enemyModel = cast.chaser;
  const time = useRef(0);
  // Duch dřívějšího běhu jezdí po pruzích svého běhu kousek za hrdinou (blíž ke kameře), čelem k poli.
  const ghostSpot = useCallback((pose: GhostPose): GhostPlacement => [-pose.x / UNIT, 0, -HERO.d * 1.2, 0], []);

  useFrame((_, delta) => {
    const alpha = session.advance(delta * 1000);
    if (renderHeld(session)) return;
    time.current += delta;
    const state = session.state();
    const prev = session.prev();
    const count = state[HEADER.bodyCount] as number;
    const at = (index: number, slot: number): number => lerp(prev[bodyBase(index) + slot] as number, state[bodyBase(index) + slot] as number, alpha) / UNIT;
    const isAlive = (index: number): boolean => ((state[bodyBase(index) + BODY.flags] as number) & FLAG.alive) !== 0;
    const player = state[HEADER.player] as number;
    const heroX = -at(player, BODY.x);
    hero.current?.position.set(heroX, 0, 0);
    moving.current = state[bodyBase(player) + BODY.x] !== prev[bodyBase(player) + BODY.x];

    // Ukazatel držení: kruh na hradbě v pruhu hrdiny se plní k obránci.
    const held = heldTicks(state, player);
    if (holdRing.current !== null) {
      holdRing.current.visible = held > 0 && held <= DEFENSE.hold;
      holdRing.current.position.set(-laneX(laneOf(state, player)) / UNIT, WALL.h + 0.05, WALL.z - WALL.d / 2);
      holdRing.current.scale.setScalar(0.25 + (0.75 * Math.min(held, DEFENSE.hold)) / DEFENSE.hold);
    }

    // Kdo vyšel zpoza plotu, dostane slot; zásah ho krátce rozsvítí.
    const visible = (index: number): boolean => isAlive(index) && state[bodyBase(index) + BODY.role] === ROLE.chaser && (state[bodyBase(index) + BODY.z] as number) - (state[bodyBase(index) + BODY.d] as number) / 2 <= DEFENSE.far + 600;
    const wanted: number[] = [];
    for (let index = 0; index < count; index += 1) if (index !== ids.boss && visible(index)) wanted.push(index);
    const pool = slots.current;
    for (const slot of pool) if (!wanted.includes(slot.body)) slot.body = -1;
    for (const body of wanted) {
      if (pool.some((slot) => slot.body === body)) continue;
      const free = pool.find((slot) => slot.body < 0);
      if (free !== undefined) Object.assign(free, { body, hp: bodyHp(state, body), flash: 0 });
    }
    const place = (group: Group | null, slot: Slot): void => {
      if (group === null) return;
      group.visible = slot.body >= 0;
      if (slot.body < 0) return;
      const hp = bodyHp(state, slot.body);
      if (hp < slot.hp) slot.flash = FLASH_S;
      slot.hp = hp;
      const runner = -(state[bodyBase(slot.body) + BODY.vz] as number) > RUNNER_SPEED;
      const bob = Math.abs(Math.sin(time.current * (runner ? 22 : 9) + slot.body)) * (runner ? 0.12 : 0.06);
      group.position.set(-at(slot.body, BODY.x), bob, at(slot.body, BODY.z));
      group.rotation.set(runner ? -0.35 : 0, 0, 0);
      group.scale.setScalar(slot.flash > 0 ? 1 + (0.25 * slot.flash) / FLASH_S : 1);
      slot.flash = Math.max(0, slot.flash - delta);
    };
    pool.forEach((slot, index) => place(groups.current.marchers[index] ?? null, slot));
    // Boss má svůj slot a nad hlavou ukazatel HP.
    const big = bossSlot.current;
    big.body = ids.boss >= 0 && visible(ids.boss) ? ids.boss : -1;
    place(boss.current, big);
    if (bossBar.current !== null && big.body >= 0) bossBar.current.scale.set(Math.max(0.001, bodyHp(state, big.body) / DEFENSE.boss.hp), 1, 1);

    // Obránci a šípy jsou kopie předloh za úrovní; kreslí se, kolik jich žije.
    const guards: number[] = [];
    const shots: number[] = [];
    for (let index = state[HEADER.spawnBase] as number; index < count; index += 1) {
      if (!isAlive(index)) continue;
      const kind = state[bodyBase(index) + BODY.kind] as number;
      if (kind === ids.defender) guards.push(index);
      else if (kind === ids.bolt || kind === ids.arrow) shots.push(index);
    }
    groups.current.guards.forEach((group, index) => {
      if (group === null) return;
      const body = guards[index];
      group.visible = body !== undefined;
      if (body !== undefined) group.position.set(-at(body, BODY.x), WALL.h, WALL.z - WALL.d / 2);
    });
    groups.current.shots.forEach((group, index) => {
      if (group === null) return;
      const body = shots[index];
      group.visible = body !== undefined;
      if (body === undefined) return;
      group.position.set(-at(body, BODY.x), at(body, BODY.y), at(body, BODY.z));
      const own = (state[bodyBase(body) + BODY.kind] as number) === ids.bolt;
      const mesh = group.children[0] as Mesh | undefined;
      if (mesh !== undefined) mesh.scale.set(own ? 1 : 0.8, own ? 1 : 0.8, own ? 1 : 0.85);
    });

    // Na výšku rozhoduje šíře pruhů v řadě hrdiny (je blíž kameře než střed pole), na šířku hloubka pole od hrdiny k plotu.
    const tan = Math.tan((camera.fov * Math.PI) / 360);
    const distance = Math.max((FIELD_HALF + 0.6) / (tan * camera.aspect) + LOOK.z * Math.cos(PITCH), (FAR / 2 + 1.5) / tan);
    camera.position.set(LOOK.x, LOOK.y + Math.sin(PITCH) * distance, LOOK.z - Math.cos(PITCH) * distance);
    camera.lookAt(look3.copy(LOOK));
    const host = surface.current;
    if (host === null) return;
    camera.updateMatrixWorld();
    const fraction = (x: number): number => (probe.set(x, 0, EDGE_Z).project(camera).x + 1) / 2;
    const edges = LANE_EDGES.map((edge) => fraction(-edge / UNIT).toFixed(4)).join(',');
    if (host.dataset.laneEdges !== edges) host.dataset.laneEdges = edges;
    host.dataset.playerX = probe.set(heroX, HERO.h, 0).project(camera).x.toFixed(3);
  });

  return (
    <>
      <FieldGround look={look} area={LAND} y={-0.03} />
      <HorizonBackdrop look={look} seed={world.seed} clear={0} beyond={30} />
      {/* Pět pruhů od hradby k plotu. */}
      {Array.from({ length: LANES.count }, (_, lane) => (
        <mesh key={lane} position={[-laneX(lane) / UNIT, -0.01, (WALL.z + FAR) / 2]} receiveShadow>
          <boxGeometry args={[LANE_M * 0.94, 0.04, FAR - WALL.z]} />
          <meshStandardMaterial color={lane % 2 === 0 ? color.mint : color['mint-deep']} />
        </mesh>
      ))}
      {/* Živý plot, zpoza kterého nepřátelé vycházejí. */}
      <mesh position={[0, HEDGE.h / 2, HEDGE.z]}>
        <boxGeometry args={[FIELD_HALF * 2 + 3, HEDGE.h, 1.2]} />
        <meshStandardMaterial color={color.grass} roughness={1} />
      </mesh>
      {/* Hradba s cimbuřím a dvěma věžemi (bráněná věc z věty). */}
      <group userData={{ frame: 'target', item: 'castle' }}>
        <mesh position={[0, WALL.h / 2, WALL.z - WALL.d / 2]} castShadow receiveShadow>
          <boxGeometry args={[FIELD_HALF * 2 + 0.4, WALL.h, WALL.d]} />
          <meshStandardMaterial color={color['cream-deep']} roughness={0.9} />
        </mesh>
        {Array.from({ length: LANES.count * 2 }, (_, k) => (
          <mesh key={k} position={[-FIELD_HALF + LANE_M / 4 + (k * LANE_M) / 2, WALL.h + 0.15, WALL.z - 0.15]}>
            <boxGeometry args={[LANE_M / 4, 0.3, 0.3]} />
            <meshStandardMaterial color={color.cream} />
          </mesh>
        ))}
        {[-1, 1].map((side) => (
          <group key={side} position={[side * (FIELD_HALF + 0.7), 0, WALL.z - WALL.d / 2]}>
            <mesh position={[0, 1.1, 0]} castShadow>
              <cylinderGeometry args={[0.7, 0.8, 2.2, 14]} />
              <meshStandardMaterial color={color['cream-deep']} roughness={0.9} />
            </mesh>
            <mesh position={[0, 2.6, 0]}>
              <coneGeometry args={[0.9, 0.9, 14]} />
              <meshStandardMaterial color={color.tomato} />
            </mesh>
          </group>
        ))}
      </group>
      <mesh ref={holdRing} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
        <torusGeometry args={[0.55, 0.08, 8, 24]} />
        <meshStandardMaterial color={color.sun} emissive={color.sun} emissiveIntensity={0.4} />
      </mesh>
      <group ref={hero} userData={{ frame: 'hero' }}>
        {heroRig !== undefined ? (
          <RiggedModel character={heroRig} h={HERO.h} clip={() => (moving.current ? 'run' : 'idle')} fallback={color['sky-deep']} />
        ) : (
          <FittedModel id={cast.player} w={HERO.w} h={HERO.h} d={HERO.d} fallback={color['sky-deep']} character />
        )}
      </group>
      <GhostSlot ghost={ghost} session={session} place={ghostSpot} />
      {Array.from({ length: SLOTS.marchers }, (_, index) => (
        <group
          key={`marcher-${index}`}
          ref={(group) => {
            groups.current.marchers[index] = group;
          }}
          visible={false}
          userData={{ frame: 'target', item: 'chaser' }}
        >
          <Marcher id={enemyModel} size={ENEMY} />
        </group>
      ))}
      <group ref={boss} visible={false} userData={{ frame: 'target', item: 'chaser' }}>
        <Marcher id={enemyModel} size={BOSS} />
        {/* Ukazatel HP bosse: rajčatový pruh na inkoustovém podkladu. */}
        <mesh position={[0, BOSS.h + 0.45, 0]}>
          <boxGeometry args={[1.6, 0.16, 0.05]} />
          <meshStandardMaterial color={color.ink} />
        </mesh>
        <mesh ref={bossBar} position={[0, BOSS.h + 0.45, -0.03]}>
          <boxGeometry args={[1.5, 0.1, 0.05]} />
          <meshStandardMaterial color={color.tomato} />
        </mesh>
      </group>
      {Array.from({ length: SLOTS.guards }, (_, index) => (
        <group
          key={`guard-${index}`}
          ref={(group) => {
            groups.current.guards[index] = group;
          }}
          visible={false}
        >
          <Guard />
        </group>
      ))}
      {Array.from({ length: SLOTS.shots }, (_, index) => (
        <group
          key={`shot-${index}`}
          ref={(group) => {
            groups.current.shots[index] = group;
          }}
          visible={false}
        >
          <mesh>
            <boxGeometry args={[0.12, 0.12, 0.8]} />
            <meshStandardMaterial color={color['sun-deep']} emissive={color.sun} emissiveIntensity={0.5} />
          </mesh>
        </group>
      ))}
    </>
  );
}
