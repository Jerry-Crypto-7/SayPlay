'use client';

/**
 * Scéna závodu s triky (P68V T4, kategorie `vozidla-sport`): silnice mezi mantinely v místě z věty, rampy, hromady
 * věcí z věty, které se nárazem rozletí na trosky, cíl s bránou a vozidlo z věty; kamera za ním (`chase`).
 *
 * - **Silnice, zem a kulisy** kreslí `SteerBackdrop` závodu (import) z mantinelů světa a sady prostředí (`theme.look`).
 * - **Rampy** jsou klíny přesně podle jádra (`rampHeightAt`: od nuly na začátku po `h` na hraně): model `gen3d-ramp`
 *   je prkno na podpěře v poměru 0,8 × 1 × 2 m a vepsaný do klínu 3 × 1,5 × 3,5 m by byl o polovinu užší než plocha,
 *   po které auto jede – auto by vedle něj viselo ve vzduchu.
 * - **Krabice a trosky** jsou fyzikální tělesa jádra: poloha a natočení ze stavu (`unpackRotation`), model z druhu
 *   těla (věc z věty přes katalog). Trosky žijí ve slotech spawnu; slot kreslí model té předlohy, kterou nese.
 * - **Kamera** `stunt-camera.ts` (čistá póza ze stavu; na výšku `fitTall` do hracího obdélníku), **jiskry a prach**
 *   `stunt-fx.ts` ze sběrnice efektů, **palec a počítadla** `StuntTouch.tsx` jako DOM v ploše hry.
 *
 * x jádra se zrcadlí (kamera kouká po +z, „vpravo“ jde vpravo). Jen obraz: stav čte, hash se nehne.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { type RefObject, useEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { ExtrudeGeometry, type Group, type InstancedMesh, Matrix4, type PerspectiveCamera, Quaternion, Shape, Vector3 } from 'three';

import { color } from '@/brand/tokens';
import { baseControlOf } from '@/play/arcade/addons';
import { BODY, BODY_STRIDE, FLAG, HEADER, HEADER_SIZE, ROLE, UNIT, bodyBase, unpackRotation } from '@/play/arcade/contract';
import type { Look } from '@/play/arcade/look';
import type { StuntControlParams } from '@/play/arcade/pieces/stunt';
import { STUNT, type StuntRamp } from '@/play/arcade/pieces/stunt-track';

import { createEffectsBus } from '../../effects/bus';
import { reducedMotion } from '../../effects/feel';
import { renderHeld } from '../../effects/render-feel';
import { stripCurve } from '../../look/road-strip';
import { usePlayRectRef } from '../../portrait-frame';
import type { ArcadeSession } from '../../session';
import { roadShapeOf } from '../../steer/road-shape';
import { SteerBackdrop } from '../../steer/SteerScene';
import { FittedModel, type WorldProps } from '../../World';
import { stuntCameraPose, stuntCarAt } from './stunt-camera';
import { STUNT_FX, type StuntParticle, keepParticles, particleAt, stuntParticlesOf } from './stunt-fx';
import { StuntCounters, StuntTouch } from './StuntTouch';

type StuntSceneProps = Omit<WorldProps, 'control' | 'backdrop'>;

const m = (units: number): number => units / UNIT;
/** Krabice i troska (m): kvádr jádra `STUNT.pile.box`. */
const BOX = m(STUNT.pile.box);
/** Pod touhle rychlostí vpřed (jednotky za tik) se auto nenatáčí po smyku – stojící auto by se otočilo bokem. */
const HEADING_MIN = 120;
/** Skok dál než tohle (m) mezi tiky je nové tělo nebo restart, ne pohyb – neinterpoluje se. */
const JUMP_M = 2;

/** Klín rampy: náběh od `z0` (výška 0) po hranu `z1` (výška `h`), svislá zadní stěna; počátek ve středu půdorysu. */
function rampGeometry(w: number, h: number, d: number): ExtrudeGeometry {
  const profile = new Shape();
  profile.moveTo(0, 0);
  profile.lineTo(d, 0);
  profile.lineTo(d, h);
  profile.closePath();
  // Profil (z, y) vytažený po x: o −90° kolem svislé osy (profil do roviny z-y, vytažení napříč), pak do středu.
  return new ExtrudeGeometry(profile, { depth: w, bevelEnabled: false }).applyMatrix4(new Matrix4().makeRotationY(-Math.PI / 2)).translate(w / 2, 0, -d / 2);
}

function Ramps({ ramps, look }: { readonly ramps: readonly StuntRamp[]; readonly look: Look }) {
  const shapes = useMemo(() => {
    const byShape = new Map<string, ExtrudeGeometry>();
    for (const ramp of ramps) {
      const key = `${ramp.w}/${ramp.h}/${ramp.z1 - ramp.z0}`;
      if (!byShape.has(key)) byShape.set(key, rampGeometry(m(ramp.w), m(ramp.h), m(ramp.z1 - ramp.z0)));
    }
    return byShape;
  }, [ramps]);
  useEffect(() => () => shapes.forEach((geometry) => geometry.dispose()), [shapes]);
  // Boky klínu v barvě hmoty sady, plocha nájezdu světlejší (bez sady dřevo kitu: slunečná plocha, tmavší boky).
  const [side, top] = look.block ?? [color['sun-deep'], color.sun];
  return (
    <>
      {ramps.map((ramp, index) => (
        <mesh key={index} geometry={shapes.get(`${ramp.w}/${ramp.h}/${ramp.z1 - ramp.z0}`)} position={[-m(ramp.x), 0, m((ramp.z0 + ramp.z1) / 2)]} castShadow receiveShadow>
          <meshStandardMaterial attach="material-0" color={side} roughness={0.8} />
          <meshStandardMaterial attach="material-1" color={top} roughness={0.7} />
        </mesh>
      ))}
    </>
  );
}

/** Brána cíle napříč silnicí: dva sloupy, slunečný pás nahoře a světlá čára na zemi. */
function FinishGate({ x, z, width, height }: { readonly x: number; readonly z: number; readonly width: number; readonly height: number }) {
  const post = 0.35;
  return (
    <group position={[x, 0, z]} userData={{ item: 'finish' }}>
      {[-1, 1].map((side) => (
        <mesh key={side} position={[(side * (width + post)) / 2, height / 2, 0]} castShadow>
          <boxGeometry args={[post, height, post]} />
          <meshStandardMaterial color={color.ink} roughness={0.6} />
        </mesh>
      ))}
      <mesh position={[0, height - 0.35, 0]} castShadow>
        <boxGeometry args={[width + 2 * post, 0.7, 0.2]} />
        <meshStandardMaterial color={color.sun} roughness={0.5} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} receiveShadow>
        <planeGeometry args={[width, 0.8]} />
        <meshStandardMaterial color={color.paper} roughness={0.9} />
      </mesh>
    </group>
  );
}

/**
 * Krabice hromad a trosky: skupina na každé tělo od první krabice po konec kapacity světa. Krabice má jeden model,
 * slot trosky model každé předlohy hry a ukáže ten, jehož druh právě nese.
 */
function Debris({ session, kinds, first, look }: { readonly session: ArcadeSession; readonly kinds: readonly string[]; readonly first: number; readonly look: Look }) {
  const world = session.world;
  const capacity = (world.initial.length - HEADER_SIZE) / BODY_STRIDE;
  const spawnBase = world.initial[HEADER.spawnBase] as number;
  const bodies = useMemo(() => Array.from({ length: Math.max(0, capacity - first) }, (_, k) => first + k), [capacity, first]);
  const groups = useRef<(Group | null)[]>([]);
  const scratch = useMemo(() => ({ a: new Quaternion(), b: new Quaternion() }), []);

  useFrame(() => {
    if (renderHeld(session)) return;
    const state = session.state();
    const prev = session.prev();
    const alpha = session.alpha();
    const count = state[HEADER.bodyCount] as number;
    bodies.forEach((body, slot) => {
      const group = groups.current[slot];
      if (group == null) return;
      const base = bodyBase(body);
      const flags = state[base + BODY.flags] as number;
      group.visible = body < count && (flags & (FLAG.alive | FLAG.physics)) === (FLAG.alive | FLAG.physics);
      if (!group.visible) return;
      const now = (field: number): number => m(state[base + field] as number);
      const was = (field: number): number => m(prev[base + field] as number);
      const fresh = ((prev[base + BODY.flags] as number) & FLAG.alive) === 0 || Math.abs(now(BODY.x) - was(BODY.x)) + Math.abs(now(BODY.z) - was(BODY.z)) > JUMP_M;
      const at = (field: number): number => (fresh ? now(field) : was(field) + (now(field) - was(field)) * alpha);
      group.position.set(-at(BODY.x), at(BODY.y) + now(BODY.h) / 2, at(BODY.z));
      // Natočení Rapieru, x zrcadlené: složky y a z mění znaménko (jako `MergeScene`).
      const [qx, qy, qz, qw] = unpackRotation(state[base + BODY.aux0] as number, state[base + BODY.aux1] as number);
      scratch.b.set(qx, -qy, -qz, qw).normalize();
      if (!fresh) {
        const [px, py, pz, pw] = unpackRotation(prev[base + BODY.aux0] as number, prev[base + BODY.aux1] as number);
        scratch.a.set(px, -py, -pz, pw).normalize().slerp(scratch.b, alpha);
        group.quaternion.copy(scratch.a);
      } else group.quaternion.copy(scratch.b);
      // Slot trosky může nést předlohu kteréhokoli druhu: vidět jen model toho svého.
      const kind = world.kinds[state[base + BODY.kind] as number];
      for (const child of group.children[0]?.children ?? []) child.visible = child.userData.kind === kind;
    });
  });

  return (
    <>
      {bodies.map((body, slot) => {
        const own = body < spawnBase ? [world.kinds[world.initial[bodyBase(body) + BODY.kind] as number] as string] : kinds;
        return (
          <group
            key={body}
            ref={(group) => {
              groups.current[slot] = group;
            }}
            visible={false}
          >
            <group position={[0, -BOX / 2, 0]}>
              {own.map((kind) => (
                <group key={kind} userData={{ kind }}>
                  <FittedModel id={kind} w={BOX} h={BOX} d={BOX} fallback={look.tint[0]} />
                </group>
              ))}
            </group>
          </group>
        );
      })}
    </>
  );
}

/** Jiskry a prach (`stunt-fx.ts`): události sběrnice → částice, dvě sítě instancí, dohromady nejvýš `STUNT_FX.max`. */
function StuntFx({ session, look }: { readonly session: ArcadeSession; readonly look: Look }) {
  const sparks = useRef<InstancedMesh | null>(null);
  const dust = useRef<InstancedMesh | null>(null);
  const pool = useRef<StuntParticle[]>([]);
  const scratch = useMemo(() => ({ matrix: new Matrix4(), at: new Vector3(), size: new Vector3(), turn: new Quaternion() }), []);
  useEffect(() => {
    // Vlastní sběrnice jen poslouchá relaci (jako `Effects`); ukázka ani přehrání záznamu nic nevydají.
    const bus = createEffectsBus(session);
    const off = bus.subscribe((events) => {
      const state = session.state();
      pool.current = keepParticles(pool.current, stuntParticlesOf(events, state[HEADER.player] as number), state[HEADER.tick] as number);
    });
    return () => {
      off();
      bus.dispose();
      pool.current = [];
    };
  }, [session]);
  useFrame(() => {
    const [spark, cloud] = [sparks.current, dust.current];
    if (spark === null || cloud === null) return;
    const meshes = { spark, dust: cloud };
    const now = (session.state()[HEADER.tick] as number) + session.alpha();
    const used = { spark: 0, dust: 0 };
    for (const particle of pool.current) {
      const at = particleAt(particle, now);
      if (at === null) continue;
      scratch.matrix.compose(scratch.at.set(at.x, at.y, at.z), scratch.turn, scratch.size.setScalar(at.size));
      meshes[particle.kind].setMatrixAt(used[particle.kind], scratch.matrix);
      used[particle.kind] += 1;
    }
    for (const kind of ['spark', 'dust'] as const) {
      const mesh = meshes[kind];
      mesh.count = used[kind];
      mesh.instanceMatrix.needsUpdate = true;
    }
  });
  return (
    <>
      <instancedMesh ref={sparks} args={[undefined, undefined, STUNT_FX.max]} frustumCulled={false} userData={{ rigShadow: 'none' }}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color={color['sun-soft']} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={dust} args={[undefined, undefined, STUNT_FX.max]} frustumCulled={false} userData={{ rigShadow: 'none' }}>
        <icosahedronGeometry args={[0.5, 0]} />
        <meshStandardMaterial color={look.terrain?.cap ?? look.ground} roughness={1} transparent opacity={0.75} depthWrite={false} />
      </instancedMesh>
    </>
  );
}

/**
 * Palec a počítadla jako DOM v ploše hry (šev P68-I T1: `GENRE_TOUCH` montuje adaptér jen vstupu `genre`, `stunt` má
 * `steer`). Vlastní kořen Reactu v kontejneru plochy, jako `Html` z drei, bez sledování bodu ve scéně.
 */
function StageOverlay({ session, surface }: { readonly session: ArcadeSession; readonly surface: RefObject<HTMLDivElement | null> }) {
  useEffect(() => {
    const stage = surface.current;
    if (stage === null) return;
    const host = document.createElement('div');
    host.dataset.testid = 'stunt-overlay';
    host.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    stage.appendChild(host);
    const root = createRoot(host);
    root.render(
      <>
        <StuntCounters session={session} />
        <StuntTouch session={session} />
      </>,
    );
    return () => {
      // Až po potvrzení plátna: synchronní odpojení kořene uprostřed renderu jiného kořene React hlásí jako chybu.
      queueMicrotask(() => {
        root.unmount();
        host.remove();
      });
    };
  }, [session, surface]);
  return null;
}

export function StuntScene({ session, cast, surface, scene: look, enabled, heroAction, ghost }: StuntSceneProps) {
  const world = session.world;
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const playRect = usePlayRectRef();
  const { ramps, firstBox } = baseControlOf(world.control).params as StuntControlParams;

  const layout = useMemo(() => {
    const initial = world.initial;
    const player = bodyBase(initial[HEADER.player] as number);
    const kindOf = (body: number): string => world.kinds[initial[bodyBase(body) + BODY.kind] as number] as string;
    let goal: { x: number; z: number; width: number; height: number } | null = null;
    const things = new Set<string>();
    for (let body = 0; body < (initial[HEADER.bodyCount] as number); body += 1) {
      const base = bodyBase(body);
      if (initial[base + BODY.role] === ROLE.goal) goal = { x: -m(initial[base + BODY.x] as number), z: m(initial[base + BODY.z] as number), width: m(initial[base + BODY.w] as number), height: m(initial[base + BODY.h] as number) };
      if (body >= firstBox && body < (initial[HEADER.spawnBase] as number)) things.add(kindOf(body));
    }
    const vehicle = kindOf(initial[HEADER.player] as number);
    return {
      // Vozidlo z věty nese generátor jako druh hráče (`stunt_track.vehicle`); výchozí `car` modelem není – pak hrdina obsazení.
      vehicle: vehicle === STUNT.kinds.vehicle ? cast.player : vehicle,
      car: { w: m(initial[player + BODY.w] as number), h: m(initial[player + BODY.h] as number), d: m(initial[player + BODY.d] as number) },
      goal,
      things: [...things],
      road: stripCurve(roadShapeOf(world).segments),
    };
  }, [world, firstBox, cast.player]);

  const hero = useRef<Group | null>(null);
  const projected = useMemo(() => new Vector3(), []);

  // Hodiny relace před každou kresbou scény (záporná priorita kreslení nepřebírá): krabice, jiskry, auto i kamera
  // pak čtou týž tik bez ohledu na pořadí, ve kterém se jejich snímky přihlásily.
  useFrame((_, delta) => {
    session.advance(delta * 1000);
  }, -2);

  useFrame(() => {
    if (renderHeld(session)) return;
    const state = session.state();
    const prev = session.prev();
    const alpha = session.alpha();
    const car = stuntCarAt(state, prev, alpha);
    const p = bodyBase(state[HEADER.player] as number);
    if (hero.current !== null) {
      hero.current.position.set(car.x, car.y, car.z);
      // Čelem po směru jízdy (x zrcadlené), ve vzduchu a na rampě nos po svislé rychlosti.
      const vx = state[p + BODY.vx] as number;
      const vy = state[p + BODY.vy] as number;
      const vz = Math.max(HEADING_MIN, state[p + BODY.vz] as number);
      const pitch = car.y > 0.01 ? Math.max(-0.5, Math.min(0.5, -Math.atan2(vy, vz))) : 0;
      hero.current.rotation.set(pitch, Math.atan2(-vx, vz) * 0.7, 0, 'YXZ');
    }

    // Jiná scéna sdíleného plátna feedu mohla nechat posun pohledu; tahle kamera ho nepoužívá.
    if (camera.view?.enabled === true) camera.clearViewOffset();
    const pose = stuntCameraPose(state, camera.aspect, playRect.current, { prev, alpha, road: layout.road, fov: camera.fov, reduced: reducedMotion() });
    camera.position.copy(pose.position);
    camera.lookAt(pose.look);
    camera.updateMatrixWorld();
    // Kde je auto na obrazovce (−1 vlevo … 1 vpravo) – e2e tím hlídá směr řízení.
    const host = surface.current;
    if (host !== null) host.dataset.playerX = projected.set(car.x, car.y + car.h / 2, car.z).project(camera).x.toFixed(3);
  });

  return (
    <>
      <SteerBackdrop session={session} course={undefined} length={m(world.length)} look={look} heroAction={heroAction} ghost={ghost} />
      <Ramps ramps={ramps} look={look} />
      {layout.goal !== null && <FinishGate {...layout.goal} />}
      <Debris session={session} kinds={layout.things} first={firstBox} look={look} />
      <group ref={hero} userData={{ frame: 'hero' }}>
        <FittedModel id={layout.vehicle} w={layout.car.w} h={layout.car.h} d={layout.car.d} fallback={color['sky-deep']} />
      </group>
      <StuntFx session={session} look={look} />
      {enabled && <StageOverlay session={session} surface={surface} />}
    </>
  );
}
