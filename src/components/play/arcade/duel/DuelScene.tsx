'use client';

/**
 * Scéna souboje zblízka (P25H T5): pohled z boku, hráč vlevo, soupeř
 * vpravo. Fáze soupeře (`aux0`) je vidět na barvě i póze – nápřah je
 * jantarový s rukou nahoře (uhni), mezera zelená s pokleslou rukou (udeř),
 * úder soupeře ruku švihne dolů. Hráč se při úhybu přikrčí (výška z jádra)
 * a při úderu natáhne ruku. `z` hráče je počítadlo zásahů, kreslí se na místě.
 *
 * Vstup: mezerník / Enter / šipka nahoru nebo ťuk do pravé půlky = úder;
 * šipka dolů / S nebo ťuk do levé půlky = úhyb.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import type { Group, MeshStandardMaterial, PerspectiveCamera } from 'three';
import { Vector3 } from 'three';

import { BODY, BUTTON, HEADER, UNIT, bodyBase } from '@/play/arcade/contract';
import type { Look } from '@/play/arcade/look';
import { DUEL, DUEL_FOE, DUEL_PHASE } from '@/play/arcade/pieces/duel';

import { isTyping } from '../input';
import { UNDER_PANORAMA } from '../look/under-panorama';
import { InkOutline } from '../look/rig/InkOutline';
import { Scenery } from '../look/Scenery';
import type { ArcadeSession } from '../session';
import { DUEL_ZONES, zoneAt } from '../touch-zones';
import { initialBody } from '../timing/TimingScene';

const STRIKE_KEYS = new Set([' ', 'enter', 'arrowup', 'w']);
const DODGE_KEYS = new Set(['arrowdown', 's']);
const STRIKE_TICKS = 10;

export function useDuelInput(session: ArcadeSession, target: React.RefObject<HTMLDivElement | null>, active: boolean): void {
  useEffect(() => {
    const element = target.current;
    if (!active || element === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat || isTyping(event.target)) return;
      const key = event.key.toLowerCase();
      const button = STRIKE_KEYS.has(key) ? BUTTON.TAP : DODGE_KEYS.has(key) ? BUTTON.DOWN : 0;
      if (button === 0) return;
      event.preventDefault();
      session.press(button);
    };
    const onDown = (event: PointerEvent) => {
      const box = element.getBoundingClientRect();
      session.press(zoneAt(DUEL_ZONES, (event.clientX - box.left) / Math.max(1, box.width)) === 1 ? BUTTON.TAP : BUTTON.DOWN);
    };
    window.addEventListener('keydown', onKey);
    element.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      element.removeEventListener('pointerdown', onDown);
    };
  }, [session, target, active]);
}

// Barva soupeře podle fáze; nic fialového.
const PHASE_COLOR: Readonly<Record<number, string>> = {
  [DUEL_PHASE.ready]: '#64748b',
  [DUEL_PHASE.windup]: '#f59e0b',
  [DUEL_PHASE.open]: '#16a34a',
  [DUEL_PHASE.struck]: '#dc2626',
};

interface Fighter {
  readonly body: React.RefObject<Group | null>;
  readonly arm: React.RefObject<Group | null>;
  readonly material: React.RefObject<MeshStandardMaterial | null>;
}

/**
 * Postava z primitiv: trup, hlava a jedna ruka, která míří k soupeři (`facing` ±1 po z).
 * S modelem z popisku (P27A T4) stojí místo trupu a hlavy model; fázi pak nese barva ruky.
 */
function Figure({ fighter, color, facing, w, h, model }: { readonly fighter: Fighter; readonly color: string; readonly facing: 1 | -1; readonly w: number; readonly h: number; readonly model?: React.ReactNode }) {
  const torso = h * 0.62;
  const head = h * 0.14;
  return (
    <group ref={fighter.body}>
      {model ?? (
        <>
          <mesh position={[0, torso / 2, 0]}>
            <boxGeometry args={[w * 0.7, torso, w * 0.55]} />
            <meshStandardMaterial ref={fighter.material} color={color} roughness={0.6} />
          </mesh>
          <mesh position={[0, torso + head * 1.1, 0]}>
            <sphereGeometry args={[head, 16, 12]} />
            <meshStandardMaterial color="#fcd34d" roughness={0.7} />
          </mesh>
        </>
      )}
      {/* Rameno je kloub: ruka visí dolů a otáčí se k soupeři. */}
      <group ref={fighter.arm} position={[0, torso * 0.9, (facing * w * 0.3)]}>
        <mesh position={[0, -torso * 0.35, 0]}>
          <boxGeometry args={[w * 0.2, torso * 0.7, w * 0.2]} />
          <meshStandardMaterial ref={model === undefined ? undefined : fighter.material} color={color} roughness={0.6} />
        </mesh>
        <mesh position={[0, -torso * 0.72, 0]}>
          <sphereGeometry args={[w * 0.16, 12, 8]} />
          <meshStandardMaterial color="#f8fafc" roughness={0.5} />
        </mesh>
      </group>
    </group>
  );
}

/** Model soupeře vepsaný do jeho těla (m); scéna arkády ho dodá, když popisek model jmenuje. */
export type RivalModel = (w: number, h: number, d: number) => React.ReactNode;

export function DuelScene({ session, look: scene, rivalModel }: { readonly session: ArcadeSession; readonly look: Look; readonly rivalModel?: RivalModel }) {
  const world = session.world;
  const hero = initialBody(world, 0);
  const rival = initialBody(world, DUEL_FOE);
  const player: Fighter = { body: useRef(null), arm: useRef(null), material: useRef(null) };
  const foe: Fighter = { body: useRef(null), arm: useRef(null), material: useRef(null) };
  const lastStrike = useRef(-STRIKE_TICKS);
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const look = useMemo(() => new Vector3(), []);
  const midZ = rival.z / 2;

  useFrame((_, delta) => {
    session.advance(delta * 1000);
    const state = session.state();
    const tick = state[HEADER.tick] as number;
    const p = bodyBase(state[HEADER.player] as number);
    const f = bodyBase(DUEL_FOE);
    const phase = state[f + BODY.aux0] as number;
    const left = state[f + BODY.aux1] as number;
    if ((state[p + BODY.aux0] as number) > 0) lastStrike.current = tick;

    // Hráč: přikrčení z výšky jádra, natažená ruka chvíli po úderu, potácení = náklon dozadu.
    const crouch = (state[p + BODY.h] as number) / UNIT / hero.h;
    const timer = state[p + BODY.aux1] as number;
    if (player.body.current !== null) {
      player.body.current.scale.y = crouch;
      player.body.current.rotation.x = timer < -DUEL.cooldown ? 0.25 : 0;
    }
    if (player.arm.current !== null) player.arm.current.rotation.x = tick - lastStrike.current < STRIKE_TICKS ? -Math.PI / 2 : -0.2;

    // Soupeř: nápřah zvedá ruku dozadu nad hlavu, úder ji švihne k hráči, mezera ji nechá viset.
    if (foe.arm.current !== null) foe.arm.current.rotation.x = phase === DUEL_PHASE.windup ? (left <= 4 ? Math.PI / 2 : -Math.PI * 0.8) : phase === DUEL_PHASE.open ? 0.1 : 0;
    if (foe.body.current !== null) foe.body.current.rotation.x = phase === DUEL_PHASE.open ? -0.2 : phase === DUEL_PHASE.windup ? 0.12 : 0;
    foe.material.current?.color.set(PHASE_COLOR[phase] ?? '#64748b');

    const tan = Math.tan((camera.fov * Math.PI) / 360);
    const dist = Math.max(6 / (2 * tan * camera.aspect), 3.2 / (2 * tan), 5);
    camera.position.set(-dist, 1.4, midZ);
    look.set(0, 1.1, midZ);
    camera.lookAt(look);
  });

  return (
    <>
      <color attach="background" args={[scene.sky]} />
      <hemisphereLight args={['#e2e8f0', '#0f172a', 1]} />
      <directionalLight position={[-6, 10, -2]} intensity={1.5} />
      {/* Prostředí (P27A T4): zem sady a kulisy za ringem – boční kamera na −x je vidí za soupeři. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.12, midZ]} renderOrder={UNDER_PANORAMA}>
        <planeGeometry args={[60, 60]} />
        <meshStandardMaterial color={scene.ground} roughness={1} depthWrite={false} />
      </mesh>
      <Scenery look={scene} layout="behind" inner={4} from={midZ - 12} to={midZ + 12} />
      <mesh position={[0, -0.1, midZ]}>
        <boxGeometry args={[4, 0.2, 9]} />
        <meshStandardMaterial color="#78716c" roughness={0.95} />
      </mesh>
      {/* Sonda záběru (P27A T6): hráč je hrdina, soupeř cíl. */}
      <group position={[0, 0, hero.z]} userData={{ frame: 'hero' }}>
        <InkOutline ink="hero" />
        <Figure fighter={player} color="#2563eb" facing={1} w={hero.w} h={hero.h} />
      </group>
      <group position={[0, 0, rival.z]} userData={{ frame: 'target', item: 'rival' }}>
        <InkOutline ink="foe" />
        {/* Model hledí k hráči (−z). */}
        <Figure fighter={foe} color={PHASE_COLOR[DUEL_PHASE.ready]!} facing={-1} w={rival.w} h={rival.h} model={rivalModel === undefined ? undefined : <group rotation={[0, Math.PI, 0]}>{rivalModel(rival.w, rival.h, rival.d)}</group>} />
      </group>
    </>
  );
}
