'use client';

import { useEffect, useState } from 'react';

import { runScene } from '@/play/arcade/physics/scene';
import { loadRapier } from '@/play/arcade/physics/world';

type LabState = { readonly state: 'running' } | { readonly state: 'done'; readonly hash: string; readonly initMs: number } | { readonly state: 'failed'; readonly error: string };

/** Spočítá zkušební scénu Rapieru v prohlížeči a hash vystaví e2e sadě (P29A T11). */
export function PhysicsLab() {
  const [lab, setLab] = useState<LabState>({ state: 'running' });
  useEffect(() => {
    const started = performance.now();
    loadRapier()
      .then((rapier) => {
        const initMs = Math.round(performance.now() - started);
        setLab({ state: 'done', hash: runScene(rapier).hash, initMs });
      })
      .catch((error: unknown) => setLab({ state: 'failed', error: String(error) }));
  }, []);
  return (
    <main data-testid="physics-lab" data-state={lab.state} data-hash={lab.state === 'done' ? lab.hash : undefined} data-init-ms={lab.state === 'done' ? lab.initMs : undefined}>
      {lab.state === 'done' ? `Rapier scene hash ${lab.hash}` : lab.state === 'failed' ? lab.error : 'Running the physics scene…'}
    </main>
  );
}
