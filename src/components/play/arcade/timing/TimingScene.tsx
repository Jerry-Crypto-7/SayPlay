'use client';

/**
 * Scéna načasování (P25H T5): pohled zepředu na věž, můstek nebo lištu.
 *
 * `z` hráče je v jádře počítadlo kol, ne poloha – základna se kreslí na
 * místě. Jezdec kyvuje po x, zelený sloupec ukazuje toleranci kolem středu,
 * položené díly (předlohy kol) se objeví, když je jádro oživí. Kamera jede
 * za výškou jezdce, ať je u vysoké věže vidět vršek. Modely zatím nejsou
 * (dodá P25F), všechno je primitivum.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import type { Group, Mesh, PerspectiveCamera } from 'three';
import { Vector3 } from 'three';

import { BODY, BUTTON, FLAG, HEADER, UNIT, bodyBase } from '@/play/arcade/contract';
import type { Look } from '@/play/arcade/look';
import { TIMING, TIMING_SLOTS } from '@/play/arcade/pieces/timing';

import { isTyping } from '../input';
import { UNDER_PANORAMA } from '../look/under-panorama';
import { Scenery } from '../look/Scenery';
import type { ArcadeSession } from '../session';

const TAP_KEYS = new Set([' ', 'enter', 'arrowup', 'w']);

/** Ťuk kamkoli nebo mezerník/Enter/šipka nahoru = TAP (hned při stisku). Sdílí rytmus. */
export function useTapInput(session: ArcadeSession, target: React.RefObject<HTMLDivElement | null>, active: boolean): void {
  useEffect(() => {
    const element = target.current;
    if (!active || element === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat || isTyping(event.target) || !TAP_KEYS.has(event.key.toLowerCase())) return;
      event.preventDefault();
      session.press(BUTTON.TAP);
    };
    const onDown = () => session.press(BUTTON.TAP);
    window.addEventListener('keydown', onKey);
    element.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      element.removeEventListener('pointerdown', onDown);
    };
  }, [session, target, active]);
}

const lerp = (from: number, to: number, alpha: number): number => from + (to - from) * alpha;

// Položené díly střídají dvě barvy, ať jsou vrstvy věže vidět; nic fialového.
const MARK_COLORS = ['#0ea5e9', '#14b8a6'];
const SLIDER_COLOR: Readonly<Record<string, string>> = { block: '#f59e0b', needle: '#dc2626', plank: '#a16207' };
const BASE_COLOR: Readonly<Record<string, string>> = { base: '#475569', bar: '#334155', pillar: '#57534e' };

/** Počáteční rozměry těla `index` v metrech a jeho druh – ze stavu, který svět začíná. */
export function initialBody(world: ArcadeSession['world'], index: number) {
  const at = bodyBase(index);
  const read = (slot: number): number => (world.initial[at + slot] as number) / UNIT;
  return { x: read(BODY.x), y: read(BODY.y), z: read(BODY.z), w: read(BODY.w), h: read(BODY.h), d: read(BODY.d), kind: world.kinds[world.initial[at + BODY.kind] as number] ?? '' };
}

/** Jak daleko za hrací plochou (m po +z) stojí řada kulis – za zemí hrací plochy. */
const SCENERY_BEHIND = 7;

export function TimingScene({ session, look: scene }: { readonly session: ArcadeSession; readonly look: Look }) {
  const world = session.world;
  const base = initialBody(world, 0);
  const sliderInit = initialBody(world, TIMING_SLOTS.slider);
  const target = initialBody(world, TIMING_SLOTS.target);
  const marks = (world.initial[HEADER.bodyCount] as number) - TIMING_SLOTS.marks;
  const baseKind = base.kind;
  const sliderKind = sliderInit.kind;
  const slider = useRef<Group | null>(null);
  const placed = useRef<(Mesh | null)[]>([]);
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const look = useMemo(() => new Vector3(), []);
  const followY = useRef<number | null>(null);
  const top = (TIMING.baseH + marks * (baseKind === 'base' ? TIMING.blockH : 0)) / UNIT;

  useFrame((_, delta) => {
    const alpha = session.advance(delta * 1000);
    const state = session.state();
    const prev = session.prev();
    const s = bodyBase(TIMING_SLOTS.slider);
    const group = slider.current;
    if (group !== null) {
      // Kamera kouká po +z, takže +x jádra jde na obrazovce vlevo – zrcadlí se jako u běžce.
      group.position.set(-lerp(prev[s + BODY.x] as number, state[s + BODY.x] as number, alpha) / UNIT, (state[s + BODY.y] as number) / UNIT, 0);
      group.scale.x = (state[s + BODY.w] as number) / UNIT / Math.max(0.001, sliderInit.w);
      group.visible = (state[s + BODY.vx] as number) !== 0;
    }
    placed.current.forEach((mesh, round) => {
      if (mesh === null) return;
      const m = bodyBase(TIMING_SLOTS.marks + round);
      mesh.visible = ((state[m + BODY.flags] as number) & FLAG.alive) !== 0;
      const w = (state[m + BODY.w] as number) / UNIT;
      mesh.scale.x = w;
      mesh.position.set(-(state[m + BODY.x] as number) / UNIT, (state[m + BODY.y] as number) / UNIT + TIMING.blockH / UNIT / 2, 0);
    });
    const y = (state[s + BODY.y] as number) / UNIT;
    followY.current = followY.current === null ? y : lerp(followY.current, y, Math.min(1, delta * 3));
    // Vidět celý kyv (±amplituda + blok) i na výšku: vzdálenost z poměru stran.
    const tan = Math.tan((camera.fov * Math.PI) / 360);
    const dist = Math.max(10 / (2 * tan * camera.aspect), 7 / (2 * tan), 8);
    camera.position.set(0, followY.current + 1.5, -dist);
    look.set(0, followY.current, 0);
    camera.lookAt(look);
  });

  const depth = TIMING.depth / UNIT;
  const blockH = TIMING.blockH / UNIT;
  return (
    <>
      <color attach="background" args={[scene.sky]} />
      <hemisphereLight args={['#fff7ed', '#78350f', 1]} />
      <directionalLight position={[3, 12, -8]} intensity={1.4} />
      {/* Zem a základna (věž stojí na ní, můstek začíná sloupem, lišta je deska). */}
      <mesh position={[0, -0.05, 0]} renderOrder={UNDER_PANORAMA}>
        <boxGeometry args={[40, 0.1, 12]} />
        <meshStandardMaterial color={scene.ground} roughness={1} depthWrite={false} />
      </mesh>
      {/* Kulisy sady prostředí (P27A T4) v řadě za hrací plochou: otočená sada „behind“ jde přes x v hloubce +z. */}
      <group rotation={[0, -Math.PI / 2, 0]}>
        <Scenery look={scene} layout="behind" inner={SCENERY_BEHIND} from={-14} to={14} />
      </group>
      <mesh position={[0, base.h / 2, 0]}>
        <boxGeometry args={[base.w, base.h, depth]} />
        <meshStandardMaterial color={BASE_COLOR[baseKind] ?? '#475569'} roughness={0.8} />
      </mesh>
      {/* Tolerance: průsvitný sloupec nad středem – kam jezdce zastavit. */}
      {/* Pro sondu záběru (P27A T6) je tolerance cíl a jezdec hrdina. */}
      <mesh position={[-target.x, top / 2 + 0.5, -depth / 2 - 0.02]} userData={{ frame: 'target' }}>
        <boxGeometry args={[target.w, top + 1, 0.02]} />
        <meshBasicMaterial color="#16a34a" transparent opacity={0.28} />
      </mesh>
      {Array.from({ length: marks }, (_, round) => (
        <mesh key={round} ref={(mesh) => { placed.current[round] = mesh; }} visible={false}>
          <boxGeometry args={[1, blockH, depth]} />
          <meshStandardMaterial color={MARK_COLORS[round % MARK_COLORS.length]} roughness={0.6} />
        </mesh>
      ))}
      <group ref={slider} userData={{ frame: 'hero' }}>
        <mesh position={[0, blockH / 2, 0]}>
          <boxGeometry args={[sliderInit.w, blockH, depth]} />
          <meshStandardMaterial color={SLIDER_COLOR[sliderKind] ?? '#f59e0b'} roughness={0.5} />
        </mesh>
      </group>
    </>
  );
}
