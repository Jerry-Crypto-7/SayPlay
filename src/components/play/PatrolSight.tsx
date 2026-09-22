'use client';

/**
 * Výhled stráže ve scéně (P25E T3). Nález P25B: hráč viděl stráž chodit, ale
 * ne úsek, po kterém vidí, a prohra pak vypadala jako náhoda. Každý úsek
 * (`readSight`) je světlý pruh na zemi; ten, na kterém stráž právě stojí –
 * a tedy hlídá –, svítí jantarově naplno.
 *
 * Kreslí se uvnitř `<Canvas>`; buňka → svět stejně jako objekty blueprintu
 * (`cellToWorld`). Sonda `window.__playSight` říká e2e, kolik pruhů scéna
 * doopravdy nakreslila.
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { cellToWorld } from '@/components/viewer/projection';
import type { RuntimeController } from '@/worldstream/runtime-controller';

import { onBeat, readSight, type Sight, type SightBeat } from './sight';

declare global {
  interface Window {
    __playSight?: () => { readonly beats: number; readonly watched: number };
  }
}

const LIFT = 0.03;
const WATCHED = { color: '#f59e0b', opacity: 0.5 };
const IDLE = { color: '#fef3c7', opacity: 0.28 };

export function PatrolSight({ sim, controller }: { readonly sim: Parameters<typeof readSight>[0]; readonly controller: RuntimeController }) {
  const { grid, beats } = useMemo(() => readSight(sim), [sim]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const watched = beats.map((beat) => {
    const guard = snapshot.entities.find((entity) => entity.stableId === beat.guard);
    return guard !== undefined && onBeat(beat, guard.x, guard.y);
  });

  const watchedCount = watched.filter(Boolean).length;
  useEffect(() => {
    const probe = () => ({ beats: beats.length, watched: watchedCount });
    window.__playSight = probe;
    return () => {
      if (window.__playSight === probe) delete window.__playSight;
    };
  }, [beats.length, watchedCount]);

  if (beats.length === 0) return null;
  return (
    <group name="patrol-sight">
      {beats.map((beat, index) => (
        <Beat key={beat.zone} beat={beat} grid={grid} look={watched[index] ? WATCHED : IDLE} />
      ))}
    </group>
  );
}

function Beat({ beat, grid, look }: { readonly beat: SightBeat; readonly grid: Sight['grid']; readonly look: typeof WATCHED }) {
  return (
    <>
      {beat.rects.map(([x, y, w, h]) => {
        const centre = cellToWorld([x + (w - 1) / 2, y + (h - 1) / 2], grid, LIFT);
        return (
          <mesh key={`${x},${y},${w},${h}`} position={[centre.x, centre.y, centre.z]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[w, h]} />
            <meshBasicMaterial color={look.color} transparent opacity={look.opacity} depthWrite={false} />
          </mesh>
        );
      })}
    </>
  );
}
