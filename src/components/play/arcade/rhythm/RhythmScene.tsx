'use client';

import { renderHeld } from '../effects/render-feel';

/**
 * Scéna rytmu (P25H T5): čtyři pruhy, noty jedou ke kameře a ťuká se, když
 * přejíždějí lištu. Rytmus jde přečíst i bez zvuku – lišta se rozsvítí,
 * když je nota v okně, trefa bliká zeleně, minutí červeně.
 *
 * Zvuk je ozdoba mimo stav: krátké pípnutí, když nota dorazí na lištu
 * (beat), a vyšší tón při trefě. Kontext, probuzení gestem a ztlumení M
 * jsou společné všem hrám (`@/play/audio`, P28C T2). Nic z toho nesahá do
 * relace ani do hashe.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import type { Group, MeshStandardMaterial, PerspectiveCamera } from 'three';
import { Vector3 } from 'three';

import { BODY, FLAG, HEADER, UNIT, bodyBase } from '@/play/arcade/contract';
import type { Look } from '@/play/arcade/look';
import { RHYTHM } from '@/play/arcade/pieces/rhythm';
import type { ToyPose } from '@/play/arcade/toy-motion';
import type { HeroAction } from '@/play/spec';
import { playTone } from '@/play/audio';

import { type ArcadeGhost, GhostSlot, besideHero } from '../GhostSlot';
import { UNDER_PANORAMA } from '../look/under-panorama';
import { Scenery } from '../look/Scenery';
import type { ArcadeSession } from '../session';
import { type BodyModel, beatPoseOf, initialBody } from '../timing/TimingScene';
import { applyToy, toyMotionOn, toyTickOf } from '../toy/applyToy';

const lerp = (from: number, to: number, alpha: number): number => from + (to - from) * alpha;

// Barva pruhu zleva doprava; nic fialového.
const LANE_COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#0ea5e9'];
const LANE_OF = (x: number): number => Math.round(x / RHYTHM.laneW + (RHYTHM.lanes - 1) / 2);
const FLASH_TICKS = 12;
const TRACK_M = 60;
const HERO_M = { w: 0.8, h: 1.5, d: 0.6 };
const HERO_GAP_M = 0.7;
const HERO_Z_M = 0.6;

/** Hranice mezi pruhy (0|1, 1|2, 2|3) v `x` noty, jednotky jádra; kreslí se zrcadlově (`-x`). */
const LANE_EDGES = Array.from({ length: RHYTHM.lanes - 1 }, (_, i) => (i + 1 - RHYTHM.lanes / 2) * RHYTHM.laneW);

/**
 * `noteModel` (P30B T4): nota z popisku role `note` („lily pads“) na svítící desce v barvě pruhu.
 * `surface` (P36A T11): plocha, které scéna zapíše hranice pruhů u lišty (`data-lane-edges`) – z nich ťuk pozná dráhu.
 */
export function RhythmScene({
  session,
  look: scene,
  heroModel,
  noteModel,
  surface,
  ghost,
}: {
  readonly session: ArcadeSession;
  readonly look: Look;
  /** P43 T14b: hrdina z popisku („grandma“) stojí vedle pruhů naproti duchovi, čelem ke kameře; noty nezakryje. */
  readonly heroModel?: BodyModel;
  readonly noteModel?: BodyModel;
  readonly surface?: React.RefObject<HTMLDivElement | null>;
  readonly heroAction: HeroAction;
  readonly ghost?: ArcadeGhost;
}) {
  const world = session.world;
  const count = world.initial[HEADER.bodyCount] as number;
  const notes = useMemo(() => Array.from({ length: count - 1 }, (_, i) => initialBody(world, i + 1)), [world, count]);
  const bar = initialBody(world, 0);
  // Duch stojí vedle lišty (hráčovo `z` jsou noty, ne dráha).
  const ghostSpot = useMemo(() => besideHero(0, 0, bar.w / 2, 'x'), [bar.w]);
  const groups = useRef<(Group | null)[]>([]);
  const barMaterial = useRef<MeshStandardMaterial | null>(null);
  const flash = useRef<{ tick: number; hit: boolean } | null>(null);
  // Hračková póza hrdiny (P45D T11): vnitřní skupina modelu a póza minulého snímku.
  const heroPose = useRef<Group | null>(null);
  const toyPose = useRef<ToyPose | null>(null);
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const look = useMemo(() => new Vector3(0, 0, 9), []);
  const edge = useMemo(() => new Vector3(), []);
  const hitWindow = (world.control.params as { window?: number }).window ?? RHYTHM.window;
  const reach = hitWindow * RHYTHM.noteSpeed;

  useFrame((_, delta) => {
    const alpha = session.advance(delta * 1000);
    if (renderHeld(session)) return;
    const state = session.state();
    const prev = session.prev();
    const tick = state[HEADER.tick] as number;
    let near = false;
    notes.forEach((_, i) => {
      const group = groups.current[i];
      if (group === null || group === undefined) return;
      const at = bodyBase(i + 1);
      const z = state[at + BODY.z] as number;
      const before = prev[at + BODY.z] as number;
      const alive = ((state[at + BODY.flags] as number) & FLAG.alive) !== 0;
      group.visible = alive && z / UNIT < TRACK_M;
      group.position.z = lerp(before, z, alpha) / UNIT;
      if (alive && Math.abs(z) <= reach) near = true;
      // Beat: nota právě přejela lištu (z kladného na nekladné).
      if (before > 0 && z <= 0 && tick !== 0) playTone(440, 0.05);
    });
    const p = bodyBase(state[HEADER.player] as number);
    const result = state[p + BODY.aux0] as number;
    if (result !== 0 && flash.current?.tick !== tick) {
      flash.current = { tick, hit: result > 0 };
      if (result > 0) playTone(880, 0.08);
    }
    const material = barMaterial.current;
    if (material !== null) {
      const recent = flash.current !== null && tick - flash.current.tick < FLASH_TICKS ? flash.current : null;
      material.color.set(recent !== null ? (recent.hit ? '#22c55e' : '#dc2626') : near ? '#fde047' : '#e2e8f0');
      material.emissive.set(recent !== null || near ? material.color : '#000000');
      material.emissiveIntensity = recent !== null ? 0.8 : near ? 0.4 : 0;
    }
    // Trefa = poskok se zmáčknutím, minutí = zakymácení, výhra = oslava; do taktu se hrdina sám nehýbe.
    const hero = heroPose.current;
    if (hero !== null) {
      const pose = beatPoseOf(state, prev, toyPose.current, toyTickOf(session), !toyMotionOn());
      toyPose.current = pose;
      applyToy({ group: hero }, pose, HERO_M.h);
    }
    // Na výšku (mobil) kamera ustoupí a zvedne se, ať jsou vidět všechny čtyři pruhy u lišty.
    const tan = Math.tan((camera.fov * Math.PI) / 360);
    const back = Math.max(4.5, (bar.w + 0.8) / (2 * tan * camera.aspect) - 1);
    camera.position.set(0, 3.2 * (back / 4.5), -back);
    camera.lookAt(look);
    const host = surface?.current;
    if (host != null) {
      camera.updateMatrixWorld();
      const edges = LANE_EDGES.map((x) => ((edge.set(-x / UNIT, 0, 0).project(camera).x + 1) / 2).toFixed(4)).join(',');
      if (host.dataset.laneEdges !== edges) host.dataset.laneEdges = edges;
    }
  });

  const laneW = RHYTHM.laneW / UNIT;
  return (
    <>
      {/* Obloha, mlha, světla a stíny jsou rigu (`look/rig/StyleRig.tsx`, P32A T10); tma zůstává jen pod pruhy. */}
      {/* Prostředí (P27A T4): zem sady kolem pruhů a kulisy po stranách; pod pruhy zůstává tma, ať svítící noty čtou. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.06, TRACK_M / 2 - 2]} renderOrder={UNDER_PANORAMA}>
        <planeGeometry args={[60, TRACK_M + 10]} />
        <meshStandardMaterial color={scene.ground} roughness={1} depthWrite={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.04, TRACK_M / 2 - 2]}>
        <planeGeometry args={[RHYTHM.lanes * laneW + 0.4, TRACK_M]} />
        <meshStandardMaterial color="#0f172a" roughness={1} />
      </mesh>
      <Scenery look={scene} layout="sides" inner={(RHYTHM.lanes * laneW) / 2 + 2} from={2} to={TRACK_M} />
      {LANE_COLORS.map((color, lane) => (
        <mesh key={color} rotation={[-Math.PI / 2, 0, 0]} position={[-(lane - (RHYTHM.lanes - 1) / 2) * laneW, -0.02, TRACK_M / 2 - 2]}>
          <planeGeometry args={[laneW * 0.94, TRACK_M]} />
          <meshStandardMaterial color={color} transparent opacity={0.18} />
        </mesh>
      ))}
      {/* Rytmus nemá postavu: hrdinou sondy záběru (P27A T6) je lišta, na kterou hráč ťuká, cílem noty. */}
      <mesh position={[0, bar.h / 2, 0]} userData={{ frame: 'hero' }}>
        <boxGeometry args={[bar.w, bar.h, bar.d]} />
        <meshStandardMaterial ref={barMaterial} color="#e2e8f0" />
      </mesh>
      {heroModel !== undefined && (
        <group position={[-(bar.w / 2 + HERO_GAP_M), 0, HERO_Z_M]} rotation={[0, Math.PI, 0]}>
          {/* Hrdinou sondy je lišta; hračkovou pózu postavy čte `heroToy` sondy (P45D T14). */}
          <group ref={heroPose} userData={{ toyHero: true }}>{heroModel(HERO_M.w, HERO_M.h, HERO_M.d)}</group>
        </group>
      )}
      {/* Slot ducha (P37-0 T3) vedle lišty. */}
      <GhostSlot ghost={ghost} session={session} place={ghostSpot} />
      {notes.map((note, i) => {
        const lane = LANE_OF(note.x * UNIT);
        return (
          <group key={i} ref={(group) => { groups.current[i] = group; }} position={[-note.x, 0, note.z]} userData={{ frame: 'target', item: 'note' }}>
            {noteModel !== undefined ? (
              <>
                <mesh position={[0, 0.02, 0]}>
                  <boxGeometry args={[note.w, 0.04, note.d]} />
                  <meshStandardMaterial color={LANE_COLORS[lane] ?? '#f59e0b'} emissive={LANE_COLORS[lane] ?? '#f59e0b'} emissiveIntensity={0.35} />
                </mesh>
                <group position={[0, 0.04, 0]}>{noteModel(note.w, note.h, note.d)}</group>
              </>
            ) : (
              <mesh position={[0, note.h / 2, 0]}>
                <boxGeometry args={[note.w, note.h, note.d]} />
                <meshStandardMaterial color={LANE_COLORS[lane] ?? '#f59e0b'} emissive={LANE_COLORS[lane] ?? '#f59e0b'} emissiveIntensity={0.35} />
              </mesh>
            )}
          </group>
        );
      })}
    </>
  );
}
