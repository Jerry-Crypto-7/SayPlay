'use client';

/**
 * Hrdina Plavby (P32F T4) – pohyb podle třídy, jen obraz (hash ani kolize se
 * nehnou): loď se houpe na vlně a naklání do zatáčky, kolem ní pění voda a za
 * zádí zůstává brázda; přistávač klopí podle náklonu z jádra (`aux0`), při tahu
 * mu šlehá plamen, u země víří kouř a v rychlém letu kolem něj letí šmouhy.
 *
 * Běží po `World` (připojí se až s rozvržením, o snímky později): World každý
 * snímek píše polohu a výšku těla, tady se k tomu jen přičte houpání a natočení.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { type InstancedMesh, Matrix4, type Object3D, Quaternion, Vector3 } from 'three';

import { color } from '@/brand/tokens';
import { baseControlOf } from '@/play/arcade/addons';
import { BODY, FLAG, HEADER, UNIT, bodyBase } from '@/play/arcade/contract';
import type { Look } from '@/play/arcade/look';

import { waterPalette } from '../look/rig/terrain/water';
import type { ArcadeSession } from '../session';
import type { VoyageLayout } from './voyageLayout';

const DEG = Math.PI / 180;
const TICKS_PER_S = 60;
/** Pěna leží kousek nad klidnou hladinou (0,3 m, `SteerScene.tsx`) plus vlnou. */
const FOAM_Y = 0.42;

/** Jedna částice: poloha, rychlost (m/s), věk a délka života (s), velikost a směr protažení. */
interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
  size: number;
  /** Kolikrát částice za život naroste (kouř, pěna); 0 = jen zmizí. */
  grow: number;
  /** Protažení podél směru pohybu (šmouha); 1 = kulatá. */
  stretch: number;
}

const Y = new Vector3(0, 1, 0);

/** Kruhová zásoba částic nad jedním `InstancedMesh`: nová přepíše nejstarší, mrtvé mají nulové měřítko. */
class Pool {
  private readonly items: (Particle | null)[];
  private next = 0;
  private readonly matrix = new Matrix4();
  private readonly turn = new Quaternion();
  private readonly at = new Vector3();
  private readonly scale = new Vector3();
  private readonly way = new Vector3();

  constructor(readonly size: number) {
    this.items = Array.from({ length: size }, () => null);
  }

  emit(particle: Particle): void {
    this.items[this.next] = particle;
    this.next = (this.next + 1) % this.size;
  }

  update(mesh: InstancedMesh, dt: number): void {
    for (let i = 0; i < this.size; i += 1) {
      const p = this.items[i];
      if (p !== null && p !== undefined) p.age += dt;
      if (p === null || p === undefined || p.age >= p.life) {
        this.matrix.makeScale(0, 0, 0);
        mesh.setMatrixAt(i, this.matrix);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const t = p.age / p.life;
      const s = p.size * (1 + p.grow * t) * (1 - t);
      this.way.set(p.vx, p.vy, p.vz);
      if (p.stretch !== 1 && this.way.lengthSq() > 1e-6) this.turn.setFromUnitVectors(Y, this.way.normalize());
      else this.turn.identity();
      this.matrix.compose(this.at.set(p.x, p.y, p.z), this.turn, this.scale.set(s, s * p.stretch, s));
      mesh.setMatrixAt(i, this.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
}

function usePool(size: number): Pool {
  return useMemo(() => new Pool(size), [size]);
}

/** Skupina těla hráče, kterou kreslí `World` (`userData.frame = 'hero'`). */
function findHero(scene: Object3D): Object3D | null {
  let found: Object3D | null = null;
  scene.traverse((node) => {
    if (found === null && node.userData.frame === 'hero') found = node;
  });
  return found;
}

/** Celá část zrychlení (tisíciny jednotky za tik²) na tiku `tick` – tatáž jako v `landControl`. */
const share = (milli: number, tick: number): number => Math.floor((milli * (tick + 1)) / 1000) - Math.floor((milli * tick) / 1000);

const rand = (spread: number): number => (Math.random() - 0.5) * 2 * spread;

export function VoyageHero({ session, layout, look, waveAt }: { readonly session: ArcadeSession; readonly layout: VoyageLayout; readonly look: Look; readonly waveAt: ((x: number, z: number, seconds: number) => number) | null }) {
  const scene = useThree((three) => three.scene);
  const hero = useRef<Object3D | null>(null);
  const wake = useRef<InstancedMesh>(null);
  const sparks = useRef<InstancedMesh>(null);
  const smoke = useRef<InstancedMesh>(null);
  const streaks = useRef<InstancedMesh>(null);
  const foam = useRef<Object3D>(null);
  const flame = useRef<Object3D>(null);
  const pools = { wake: usePool(28), sparks: usePool(48), smoke: usePool(36), streaks: usePool(14) };
  const motion = useRef({ roll: 0, yaw: 0, emit: 0, grounded: true });
  const gravity = useMemo(() => {
    const land = (baseControlOf(session.world.control).params as { land?: { gravity?: number } }).land;
    return land?.gravity ?? 1000;
  }, [session]);
  const foamColor = useMemo(() => waterPalette(look).foam, [look]);
  const padTop = layout.pad === null ? 0 : layout.pad.y + layout.pad.h;

  // Nová hra nebo restart: hrdinu hledat znovu (World staví skupiny podle relace).
  useEffect(() => {
    hero.current = null;
  }, [session]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    if (hero.current === null || hero.current.parent === null) hero.current = findHero(scene);
    const body = hero.current;
    const state = session.state();
    const prev = session.prev();
    const base = bodyBase(state[HEADER.player] as number);
    const vx = (state[base + BODY.vx] as number) / UNIT;
    const vz = (state[base + BODY.vz] as number) / UNIT;
    const m = motion.current;
    if (body !== null) {
      const { x, z } = body.position;
      const seconds = performance.now() / 1000;
      if (layout.motion === 'boat' && waveAt !== null) {
        // Houpání: výška vlny pod lodí, příď nahoru, když je vlna vpředu výš.
        body.position.y += waveAt(x, z, seconds);
        const slope = (waveAt(x, z + 1.2, seconds) - waveAt(x, z - 1.2, seconds)) / 2.4;
        const side = (waveAt(x + 0.8, z, seconds) - waveAt(x - 0.8, z, seconds)) / 1.6;
        // Do zatáčky: +x jádra je na obrazovce vpravo, náklon +z tam sklopí stěžeň.
        m.roll += (Math.max(-0.35, Math.min(0.35, vx * 1.6)) - m.roll) * Math.min(1, dt * 5);
        m.yaw += (Math.atan2(-vx, Math.max(0.05, vz)) * 0.7 - m.yaw) * Math.min(1, dt * 6);
        body.rotation.set(-Math.atan(slope), m.yaw, m.roll + Math.atan(side) * 0.6);
      } else if (layout.motion === 'lander') {
        body.rotation.set(0, 0, (state[base + BODY.aux0] as number) * DEG);
      }
      if (foam.current !== null && waveAt !== null) {
        // Nad vlnou pod lodí – rovná hladina by pěnu v údolí vlny překryla.
        foam.current.position.set(x, FOAM_Y + waveAt(x, z, seconds), z);
        foam.current.scale.set(1 + 0.08 * Math.sin(seconds * 5), 1.35, 1);
      }
    }

    const speed = Math.hypot(vx, vz) * TICKS_PER_S;
    m.emit += dt;
    if (layout.motion === 'boat' && body !== null && waveAt !== null && m.emit > 0.07 && speed > 1) {
      m.emit = 0;
      // Brázda: pěna za zádí, rozplývá se do stran.
      const [x, z] = [body.position.x + rand(0.4), body.position.z - 1.2];
      pools.wake.emit({ x, y: FOAM_Y + 0.05 + waveAt(x, z, performance.now() / 1000), z, vx: rand(0.6), vy: 0, vz: 0, age: 0, life: 1.4, size: 0.9, grow: 1.6, stretch: 1 });
    }

    if (layout.motion === 'lander' && body !== null) {
      const grounded = ((state[base + BODY.flags] as number) & FLAG.grounded) !== 0;
      const dvy = (state[base + BODY.vy] as number) - (prev[base + BODY.vy] as number);
      const thrust = !grounded && dvy + share(gravity, prev[HEADER.tick] as number) > 0;
      const tilt = body.rotation.z;
      const { x, y, z } = body.position;
      if (flame.current !== null) {
        flame.current.visible = thrust;
        flame.current.position.set(x + Math.sin(tilt) * 0.2, y, z);
        flame.current.rotation.set(0, 0, tilt);
        flame.current.scale.set(1, 0.8 + Math.random() * 0.5, 1);
      }
      if (thrust) {
        // Plamen tahu: jiskry z trysky proti směru tahu (náklon klopí i trysku).
        for (let i = 0; i < 2; i += 1)
          pools.sparks.emit({ x: x + rand(0.2), y: y - 0.3, z: z + rand(0.2), vx: Math.sin(tilt) * 6 + rand(1), vy: -Math.cos(tilt) * 9 + rand(1), vz: rand(1), age: 0, life: 0.35, size: 0.35, grow: 0, stretch: 1 });
        // U země tah zvedá prach a kouř.
        if (y - padTop < 6 && m.emit > 0.05) {
          m.emit = 0;
          pools.smoke.emit({ x: x + rand(1.5), y: padTop + 0.3, z: z + rand(1), vx: rand(4), vy: 0.8, vz: rand(2), age: 0, life: 1.6, size: 1.1, grow: 2.2, stretch: 1 });
        }
      }
      // Dosednutí: jeden oblak kouře kolem nohou.
      if (grounded && !m.grounded)
        for (let i = 0; i < 14; i += 1) {
          const angle = (i / 14) * Math.PI * 2;
          pools.smoke.emit({ x: x + Math.cos(angle) * 0.8, y: y + 0.2, z: z + Math.sin(angle) * 0.8, vx: Math.cos(angle) * 3, vy: 0.6, vz: Math.sin(angle) * 3, age: 0, life: 1.8, size: 1, grow: 2.5, stretch: 1 });
        }
      m.grounded = grounded;
      // Rychlý let: šmouhy kolem lodi letí proti pohybu.
      const vy = (state[base + BODY.vy] as number) / UNIT;
      const flight = Math.hypot(vx, vy) * TICKS_PER_S;
      if (!grounded && flight > 6 && Math.random() < dt * 20) {
        const [sx, sy] = [(vx * TICKS_PER_S) / flight, (vy * TICKS_PER_S) / flight];
        pools.streaks.emit({ x: x + rand(4), y: y + 1.5 + rand(4), z: z + rand(2), vx: sx * flight * 1.5, vy: -sy * flight * 1.5, vz: 0, age: 0, life: 0.3, size: 0.06, grow: 0, stretch: 40 });
      }
    }

    if (wake.current !== null) pools.wake.update(wake.current, dt);
    if (sparks.current !== null) pools.sparks.update(sparks.current, dt);
    if (smoke.current !== null) pools.smoke.update(smoke.current, dt);
    if (streaks.current !== null) pools.streaks.update(streaks.current, dt);
  });

  return (
    <>
      {layout.motion === 'boat' && (
        <>
          {/* Pěna kolem trupu: kroužek na hladině, dýchá s vlnou. Těsně u trupu (P35 T7): z blízké kamery byl širší kruh větší než loď. */}
          <mesh ref={foam} rotation={[-Math.PI / 2, 0, 0]} userData={{ rigShadow: 'none' }}>
            <ringGeometry args={[0.4, 0.6, 24]} />
            <meshBasicMaterial color={foamColor} transparent opacity={0.35} depthWrite={false} />
          </mesh>
          <instancedMesh ref={wake} args={[undefined, undefined, 28]} frustumCulled={false} userData={{ rigShadow: 'none' }}>
            <circleGeometry args={[0.5, 10]} />
            <meshBasicMaterial color={foamColor} transparent opacity={0.6} depthWrite={false} />
          </instancedMesh>
        </>
      )}
      {layout.motion === 'lander' && (
        <>
          {/* Plamen trysky: kužel špičkou dolů, září přes bloom (nad prahem, bez tone mappingu). */}
          <group ref={flame} visible={false} userData={{ rigShadow: 'none' }}>
            <mesh position={[0, -0.9, 0]} rotation={[Math.PI, 0, 0]}>
              <coneGeometry args={[0.45, 1.8, 10]} />
              <meshBasicMaterial color={color.sun} toneMapped={false} transparent opacity={0.9} />
            </mesh>
          </group>
          <instancedMesh ref={sparks} args={[undefined, undefined, 48]} frustumCulled={false} userData={{ rigShadow: 'none' }}>
            <sphereGeometry args={[0.5, 6, 4]} />
            <meshBasicMaterial color={color.tomato} toneMapped={false} />
          </instancedMesh>
          <instancedMesh ref={smoke} args={[undefined, undefined, 36]} frustumCulled={false} userData={{ rigShadow: 'none' }}>
            <sphereGeometry args={[0.5, 7, 5]} />
            <meshBasicMaterial color={color.cream} transparent opacity={0.5} depthWrite={false} />
          </instancedMesh>
          <instancedMesh ref={streaks} args={[undefined, undefined, 14]} frustumCulled={false} userData={{ rigShadow: 'none' }}>
            <boxGeometry args={[1, 1, 1]} />
            <meshBasicMaterial color={color.cream} transparent opacity={0.45} depthWrite={false} />
          </instancedMesh>
        </>
      )}
    </>
  );
}
