'use client';

/**
 * Scéna rytmu (P25H T5): čtyři pruhy, noty jedou ke kameře a ťuká se, když
 * přejíždějí lištu. Rytmus jde přečíst i bez zvuku – lišta se rozsvítí,
 * když je nota v okně, trefa bliká zeleně, minutí červeně.
 *
 * Zvuk je ozdoba mimo stav: krátké pípnutí, když nota dorazí na lištu
 * (beat), a vyšší tón při trefě. AudioContext vznikne až po prvním ťuku
 * (prohlížeč jinak zvuk nepustí), M zvuk vypne a zapne. Nic z toho
 * nesahá do relace ani do hashe.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import type { Group, MeshStandardMaterial, PerspectiveCamera } from 'three';
import { Vector3 } from 'three';

import { BODY, FLAG, HEADER, UNIT, bodyBase } from '@/play/arcade/contract';
import type { Look } from '@/play/arcade/look';
import { RHYTHM } from '@/play/arcade/pieces/rhythm';

import { Scenery } from '../look/Scenery';
import type { ArcadeSession } from '../session';
import { initialBody } from '../timing/TimingScene';

const lerp = (from: number, to: number, alpha: number): number => from + (to - from) * alpha;

// Barva pruhu zleva doprava; nic fialového.
const LANE_COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#0ea5e9'];
const LANE_OF = (x: number): number => Math.round(x / RHYTHM.laneW + (RHYTHM.lanes - 1) / 2);
const FLASH_TICKS = 12;
const TRACK_M = 60;

/** Zvuk rytmu: pípnutí na beat a tón při trefě; M přepíná. */
function useBeatSound(target: React.RefObject<HTMLDivElement | null>) {
  const audio = useRef<AudioContext | null>(null);
  const muted = useRef(false);
  useEffect(() => {
    const element = target.current;
    if (element === null) return;
    const wake = () => {
      if (audio.current === null && typeof AudioContext !== 'undefined') audio.current = new AudioContext();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'm' && !event.repeat) muted.current = !muted.current;
      else wake();
    };
    element.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', onKey);
    return () => {
      element.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', onKey);
      void audio.current?.close();
      audio.current = null;
    };
  }, [target]);
  return (frequency: number, volume: number): void => {
    const context = audio.current;
    if (context === null || muted.current) return;
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(volume, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.12);
    osc.connect(gain).connect(context.destination);
    osc.start();
    osc.stop(context.currentTime + 0.13);
  };
}

export function RhythmScene({ session, surface, look: scene }: { readonly session: ArcadeSession; readonly surface: React.RefObject<HTMLDivElement | null>; readonly look: Look }) {
  const world = session.world;
  const count = world.initial[HEADER.bodyCount] as number;
  const notes = useMemo(() => Array.from({ length: count - 1 }, (_, i) => initialBody(world, i + 1)), [world, count]);
  const bar = initialBody(world, 0);
  const groups = useRef<(Group | null)[]>([]);
  const barMaterial = useRef<MeshStandardMaterial | null>(null);
  const flash = useRef<{ tick: number; hit: boolean } | null>(null);
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const look = useMemo(() => new Vector3(0, 0, 9), []);
  const play = useBeatSound(surface);
  const hitWindow = (world.control.params as { window?: number }).window ?? RHYTHM.window;
  const reach = hitWindow * RHYTHM.noteSpeed;

  useFrame((_, delta) => {
    const alpha = session.advance(delta * 1000);
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
      if (before > 0 && z <= 0 && tick !== 0) play(440, 0.05);
    });
    const p = bodyBase(state[HEADER.player] as number);
    const result = state[p + BODY.aux0] as number;
    if (result !== 0 && flash.current?.tick !== tick) {
      flash.current = { tick, hit: result > 0 };
      if (result > 0) play(880, 0.08);
    }
    const material = barMaterial.current;
    if (material !== null) {
      const recent = flash.current !== null && tick - flash.current.tick < FLASH_TICKS ? flash.current : null;
      material.color.set(recent !== null ? (recent.hit ? '#22c55e' : '#dc2626') : near ? '#fde047' : '#e2e8f0');
      material.emissive.set(recent !== null || near ? material.color : '#000000');
      material.emissiveIntensity = recent !== null ? 0.8 : near ? 0.4 : 0;
    }
    // Na výšku (mobil) kamera ustoupí a zvedne se, ať jsou vidět všechny čtyři pruhy u lišty.
    const tan = Math.tan((camera.fov * Math.PI) / 360);
    const back = Math.max(4.5, (bar.w + 0.8) / (2 * tan * camera.aspect) - 1);
    camera.position.set(0, 3.2 * (back / 4.5), -back);
    camera.lookAt(look);
  });

  const laneW = RHYTHM.laneW / UNIT;
  return (
    <>
      <color attach="background" args={['#0f172a']} />
      <fog attach="fog" args={['#0f172a', 20, TRACK_M]} />
      <hemisphereLight args={['#e0f2fe', '#1e293b', 1.1]} />
      <directionalLight position={[2, 10, -6]} intensity={1.2} />
      {/* Prostředí (P27A T4): zem sady kolem pruhů a kulisy po stranách; pod pruhy zůstává tma, ať svítící noty čtou. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.06, TRACK_M / 2 - 2]}>
        <planeGeometry args={[60, TRACK_M + 10]} />
        <meshStandardMaterial color={scene.ground} roughness={1} />
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
      <mesh position={[0, bar.h / 2, 0]}>
        <boxGeometry args={[bar.w, bar.h, bar.d]} />
        <meshStandardMaterial ref={barMaterial} color="#e2e8f0" />
      </mesh>
      {notes.map((note, i) => {
        const lane = LANE_OF(note.x * UNIT);
        return (
          <group key={i} ref={(group) => { groups.current[i] = group; }} position={[-note.x, 0, note.z]}>
            <mesh position={[0, note.h / 2, 0]}>
              <boxGeometry args={[note.w, note.h, note.d]} />
              <meshStandardMaterial color={LANE_COLORS[lane] ?? '#f59e0b'} emissive={LANE_COLORS[lane] ?? '#f59e0b'} emissiveIntensity={0.35} />
            </mesh>
          </group>
        );
      })}
    </>
  );
}
