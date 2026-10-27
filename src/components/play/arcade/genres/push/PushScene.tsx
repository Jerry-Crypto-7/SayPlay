'use client';

/**
 * Scéna vytlačování z ringu (P54C T12): kulatý ring (dohyó) shora zezadu, hrdina a soupeři z popisku věty stojí tam,
 * kde jsou jejich koule Rapieru (poloha interpolovaná mezi tiky, natočení čelem po směru, ne valení koule). x jádra
 * se zrcadlí jako v aréně: kamera kouká po +z, takže +x je na obrazovce vpravo a tah prstem doprava jde doprava.
 *
 * Jen obraz, mimo stav i hash: šipka směru výpadu u nohou hrdiny (slunečná = výpad připravený), předklon ve výpadu
 * a v náběhu soupeře, štítek „Charge!“ nad soupeřem, který se napřahuje, pád vystrčeného soupeře přes okraj,
 * štítek kola o přestávce, ve třetím kole rajčatový okraj zmenšujícího se ringu a štítek „Ring shrinks!“.
 *
 * Soupeři se kreslí ze zásoby `POOL` skupin (víc soupeřů naráz kolo nepřivede) – strop sítí telefonu (p35-perf, 200)
 * tak nezávisí na počtu kol. Vstup je vstup arény (`STAGES.push`, tah = směr, ťuk = výpad, šipky a mezerník).
 */

import { Html } from '@react-three/drei/web/Html';
import { useFrame, useThree } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import type { Group, Mesh, MeshStandardMaterial, PerspectiveCamera } from 'three';
import { Vector3 } from 'three';

import { color } from '@/brand/tokens';
import { BODY, FLAG, HEADER, UNIT, bodyBase } from '@/play/arcade/contract';
import { riggedCharacter } from '@/play/arcade/models';
import { DIRECTIONS } from '@/play/arcade/pieces/arena';
import { behaviourPhaseOf } from '@/play/arcade/pieces/behaviours';
import { PUSH, PUSH_BODIES, PUSH_ROUNDS, breakOf, facingOf, lungeOf, mindOf, ringAt, rivalsOf, roundOf } from '@/play/arcade/pieces/push-ring';

import { renderHeld } from '../../effects/render-feel';
import { worldPlacement } from '../../Ghost';
import { GhostSlot } from '../../GhostSlot';
import { HorizonBackdrop } from '../../look/Backdrop';
import { FieldGround } from '../../look/FieldGround';
import { RiggedModel } from '../../RiggedModel';
import { FittedModel, type WorldProps } from '../../World';

const m = (units: number): number => units / UNIT;
const RING = m(PUSH.radius);
/** Hrdina a soupeř jako postavy (m): koule jádra jsou jen kolize, postava stojí na zemi. */
const HERO = { w: 0.9, h: 1.15, d: 0.8 } as const;
const RIVAL = { w: 1.1, h: 1.3, d: 1.0 } as const;
/** Kolik soupeřů scéna kreslí naráz (nejvíc, kolik kolo přivede) a kolik jich naráz padá přes okraj. */
const POOL = 3;
const FALLERS = 3;
/** Pád přes okraj (s) a štítek „Ring shrinks!“ na začátku třetího kola (s). */
const FALL_S = 0.7;
const SHRINK_TAG_S = 2.2;
/** Skok dál než tohle (m) mezi tiky je návrat nebo odstavení, ne pohyb – neinterpoluje se. */
const JUMP = 2.5;
/**
 * Kamera: náklon, kolik kolem ringu se musí vejít (m) nad a pod ním a do stran. Do stran jen `side` (P61 T6): na
 * výšku telefonu rozhoduje šíře ringu a s 1,3 m měl hrdina na Pixelu 7 1,2 % plochy obrazu proti 1,5 % na šířku;
 * 0,6 m drží střed soupeře na kraji ringu ve 0,9 šířky obrazu (bezpečná zóna `e2e/p58a-framing`).
 */
const CAMERA = { elevation: (58 * Math.PI) / 180, margin: 1.3, side: 0.6 } as const;
/** Výchozí soupeř, když popisek model nemá: rozzlobený býk z katalogu. */
const DEFAULT_RIVAL = 'gen3d-angry-bull';

type PushSceneProps = Omit<WorldProps, 'control' | 'backdrop'>;

interface Faller {
  x: number;
  z: number;
  /** Směr ven (jednotkový, ve scéně). */
  dx: number;
  dz: number;
  yaw: number;
  age: number;
}

/** Natočení postavy čelem po směru jádra (`dx`, `dz`): x scény je zrcadlené, model kouká po +z. */
const yawOf = (dx: number, dz: number): number => Math.atan2(-dx, dz);

/** Postava z popisku: riggovaná, nebo model vepsaný do kvádru. */
function Figure({ model, size, tint }: { readonly model: string; readonly size: { readonly w: number; readonly h: number; readonly d: number }; readonly tint: string }) {
  const rig = riggedCharacter(model);
  return rig !== undefined ? <RiggedModel character={rig} h={size.h} clip={() => 'idle'} fallback={tint} /> : <FittedModel id={model} w={size.w} h={size.h} d={size.d} fallback={tint} character />;
}

export function PushScene({ session, cast, surface, scene: look, ghost }: PushSceneProps) {
  const world = session.world;
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const rivalModel = cast.props.rival ?? cast.things?.rival ?? DEFAULT_RIVAL;

  const hero = useRef<Group | null>(null);
  const heroBody = useRef<Group | null>(null);
  const arrow = useRef<Mesh | null>(null);
  const arrowMaterial = useRef<MeshStandardMaterial | null>(null);
  const ring = useRef<Group | null>(null);
  const rimMaterial = useRef<MeshStandardMaterial | null>(null);
  const danger = useRef<Mesh | null>(null);
  const rivals = useRef<(Group | null)[]>([]);
  const leaners = useRef<(Group | null)[]>([]);
  const charges = useRef<(HTMLSpanElement | null)[]>([]);
  const fallers = useRef<(Group | null)[]>([]);
  const roundTag = useRef<HTMLSpanElement | null>(null);
  const clock = useRef(0);
  const memory = useRef({ seen: new Map<number, { x: number; z: number; yaw: number }>(), falling: [] as Faller[], round: 1, shrinkAt: -1 });
  const scratch = useMemo(() => ({ look: new Vector3(), probe: new Vector3() }), []);

  useFrame((_, delta) => {
    const alpha = session.advance(delta * 1000);
    if (renderHeld(session)) return;
    clock.current += delta;
    const state = session.state();
    const prev = session.prev();
    const player = state[HEADER.player] as number;
    /** Poloha těla ve scéně (m), interpolovaná; skok (návrat doprostřed, odstavení) se neinterpoluje. */
    const place = (body: number): { x: number; z: number } => {
      const base = bodyBase(body);
      const nx = state[base + BODY.x] as number;
      const nz = state[base + BODY.z] as number;
      const px = prev[base + BODY.x] as number;
      const pz = prev[base + BODY.z] as number;
      const fresh = ((prev[base + BODY.flags] as number) & FLAG.alive) === 0 || Math.hypot(m(nx - px), m(nz - pz)) > JUMP;
      return fresh ? { x: -m(nx), z: m(nz) } : { x: -m(px + (nx - px) * alpha), z: m(pz + (nz - pz) * alpha) };
    };

    // Ring: ve třetím kole se zmenšuje, okraj zrudne a pod ním prosvítá rajčatový pás, odkud už se spadne.
    const radius = m(ringAt(state));
    const round = roundOf(state);
    ring.current?.scale.set(radius / RING, 1, radius / RING);
    const shrinking = round >= PUSH_ROUNDS;
    rimMaterial.current?.color.set(shrinking ? color.tomato : color.ink);
    if (danger.current !== null) danger.current.visible = shrinking && radius < RING - 0.01;

    // Hrdina: čelem po směru; ve výpadu předklon, šipka výpadu slunečná, když je výpad připravený.
    const facing = DIRECTIONS[facingOf(state, player)] as { dx: number; dz: number };
    const yaw = yawOf(facing.dx, facing.dz);
    const lunge = lungeOf(state, player);
    const heroAt = place(PUSH_BODIES.hero);
    if (hero.current !== null) {
      hero.current.visible = ((state[bodyBase(PUSH_BODIES.hero) + BODY.flags] as number) & FLAG.alive) !== 0;
      hero.current.position.set(heroAt.x, 0, heroAt.z);
      hero.current.rotation.y = yaw;
    }
    if (heroBody.current !== null) heroBody.current.rotation.x = lunge > 0 ? 0.35 : 0;
    arrowMaterial.current?.color.set(lunge === 0 ? color.sun : color['ink-faint']);
    if (arrow.current !== null) arrow.current.visible = state[HEADER.runState] === 0;

    // Soupeři ve hře ze zásoby skupin; kdo z ní zmizel, padá přes okraj.
    const live = rivalsOf(state);
    const seen = memory.current.seen;
    const now = new Set(live);
    for (const [body, last] of seen) {
      if (now.has(body)) continue;
      const out = Math.hypot(last.x, last.z) || 1;
      memory.current.falling.push({ x: last.x, z: last.z, dx: last.x / out, dz: last.z / out, yaw: last.yaw, age: 0 });
      seen.delete(body);
    }
    if (memory.current.falling.length > FALLERS) memory.current.falling.splice(0, memory.current.falling.length - FALLERS);
    live.slice(0, POOL).forEach((body, slot) => {
      const group = rivals.current[slot];
      if (group === null || group === undefined) return;
      const at = place(body);
      // Čelem k hrdinovi.
      const turn = Math.atan2(heroAt.x - at.x, heroAt.z - at.z);
      group.visible = true;
      group.position.set(at.x, 0, at.z);
      group.rotation.y = turn;
      const phase = behaviourPhaseOf(state, mindOf(body));
      const leaner = leaners.current[slot];
      if (leaner !== null && leaner !== undefined) leaner.rotation.x = phase === 'act' ? 0.4 : phase === 'telegraph' ? -0.15 + Math.sin(clock.current * 24) * 0.05 : 0;
      const tag = charges.current[slot];
      if (tag !== null && tag !== undefined) tag.style.visibility = phase === 'telegraph' && state[HEADER.runState] === 0 ? 'visible' : 'hidden';
      seen.set(body, { x: at.x, z: at.z, yaw: turn });
    });
    for (let slot = Math.min(POOL, live.length); slot < POOL; slot += 1) {
      const group = rivals.current[slot];
      if (group !== null && group !== undefined) group.visible = false;
      const tag = charges.current[slot];
      if (tag !== null && tag !== undefined) tag.style.visibility = 'hidden';
    }
    const falling = memory.current.falling;
    for (const faller of falling) faller.age += delta;
    memory.current.falling = falling.filter((faller) => faller.age < FALL_S);
    for (let slot = 0; slot < FALLERS; slot += 1) {
      const group = fallers.current[slot];
      if (group === null || group === undefined) continue;
      const faller = memory.current.falling[slot];
      group.visible = faller !== undefined;
      if (faller === undefined) continue;
      const t = faller.age;
      group.position.set(faller.x + faller.dx * t * 2.5, -9 * t * t, faller.z + faller.dz * t * 2.5);
      group.rotation.set(t * 2.2, faller.yaw, 0);
    }

    // Štítek kola: o přestávce další kolo, na začátku třetího kola varování.
    if (round !== memory.current.round) {
      if (round === PUSH_ROUNDS) memory.current.shrinkAt = clock.current;
      memory.current.round = round;
    }
    const tag = roundTag.current;
    if (tag !== null) {
      const resting = breakOf(state) > 0 && state[HEADER.runState] === 0;
      const warning = memory.current.shrinkAt >= 0 && clock.current - memory.current.shrinkAt < SHRINK_TAG_S && state[HEADER.runState] === 0;
      const text = resting ? (round + 1 === PUSH_ROUNDS ? 'Final round!' : `Round ${String(round + 1)}`) : warning ? 'Ring shrinks!' : '';
      if (tag.textContent !== text) tag.textContent = text;
      tag.className = resting ? 'sp-world-tag sp-world-tag--goal' : 'sp-world-tag';
      tag.style.visibility = text === '' ? 'hidden' : 'visible';
    }

    // Kamera: celý ring shora zezadu; na výšku telefonu rozhoduje šíře ringu.
    const tan = Math.tan((camera.fov * Math.PI) / 360);
    const distance = Math.max((RING + CAMERA.side) / (tan * camera.aspect), ((RING + CAMERA.margin) * 0.9) / tan);
    camera.position.set(0, distance * Math.sin(CAMERA.elevation), -distance * Math.cos(CAMERA.elevation) - 0.6);
    camera.lookAt(scratch.look.set(0, 0, 0.4));
    const host = surface.current;
    if (host === null) return;
    camera.updateMatrixWorld();
    host.dataset.playerX = scratch.probe.set(heroAt.x, HERO.h, heroAt.z).project(camera).x.toFixed(3);
  });

  return (
    <>
      <FieldGround look={look} area={{ x0: -40, x1: 40, z0: -40, z1: 50 }} y={-0.32} />
      <HorizonBackdrop look={look} seed={world.seed} clear={0} beyond={20} />
      {/* Pás, odkud se ve třetím kole už padá (původní ring), pod zmenšujícím se ringem. */}
      <mesh ref={danger} position={[0, -0.17, 0]} visible={false} receiveShadow>
        <cylinderGeometry args={[RING, RING + 0.15, 0.28, 64]} />
        <meshStandardMaterial color={color['tomato-deep']} roughness={0.9} />
      </mesh>
      {/* Ring: krémová hlína, inkoustové lano po obvodu, dvě čáry startu uprostřed. */}
      <group ref={ring} userData={{ item: 'ring' }}>
        <mesh position={[0, -0.15, 0]} receiveShadow>
          <cylinderGeometry args={[RING, RING + 0.25, 0.3, 64]} />
          <meshStandardMaterial color={color['cream-deep']} roughness={0.95} />
        </mesh>
        <mesh position={[0, 0.02, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[RING - 0.12, 0.11, 8, 64]} />
          <meshStandardMaterial ref={rimMaterial} color={color.ink} roughness={0.7} />
        </mesh>
        {[-1, 1].map((side) => (
          <mesh key={side} position={[0, 0.006, side * 0.9]}>
            <boxGeometry args={[1.0, 0.01, 0.1]} />
            <meshStandardMaterial color={color.paper} roughness={0.8} />
          </mesh>
        ))}
      </group>
      <group ref={hero} userData={{ frame: 'hero' }}>
        <group ref={heroBody}>
          <Figure model={cast.player} size={HERO} tint={color['sky-deep']} />
        </group>
        {/* Šipka směru výpadu u nohou. */}
        <mesh ref={arrow} position={[0, 0.03, 0.85]} rotation={[Math.PI / 2, 0, 0]}>
          <coneGeometry args={[0.22, 0.42, 3]} />
          <meshStandardMaterial ref={arrowMaterial} color={color.sun} roughness={0.6} />
        </mesh>
      </group>
      {Array.from({ length: POOL }, (_, slot) => (
        <group
          key={`rival-${String(slot)}`}
          ref={(group) => {
            rivals.current[slot] = group;
          }}
          visible={false}
          userData={{ frame: 'target', item: 'rival' }}
        >
          <group
            ref={(group) => {
              leaners.current[slot] = group;
            }}
          >
            <Figure model={rivalModel} size={RIVAL} tint={color.tomato} />
          </group>
          <Html position={[0, RIVAL.h + 0.5, 0]} center pointerEvents="none" zIndexRange={[10, 0]}>
            <span
              ref={(span) => {
                charges.current[slot] = span;
              }}
              className="sp-world-tag"
              data-testid="push-charge"
              style={{ visibility: 'hidden' }}
            >
              Charge!
            </span>
          </Html>
        </group>
      ))}
      {Array.from({ length: FALLERS }, (_, slot) => (
        <group
          key={`faller-${String(slot)}`}
          ref={(group) => {
            fallers.current[slot] = group;
          }}
          visible={false}
        >
          <Figure model={rivalModel} size={RIVAL} tint={color.tomato} />
        </group>
      ))}
      <group position={[0, 2.4, RING * 0.55]}>
        <Html center pointerEvents="none" zIndexRange={[10, 0]}>
          <span ref={roundTag} className="sp-world-tag" data-testid="push-round" style={{ visibility: 'hidden' }} />
        </Html>
      </group>
      <GhostSlot ghost={ghost} session={session} place={worldPlacement} />
    </>
  );
}
