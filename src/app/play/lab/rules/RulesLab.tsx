'use client';

import { useEffect, useMemo } from 'react';

import { usePhysicsReady } from '@/components/play/arcade/ArcadePlay';
import ArcadeStage from '@/components/play/arcade/ArcadeStage';
import { createArcadeSession } from '@/components/play/arcade/session';
import type { ArcadeWorld, InputEvent } from '@/play/arcade/contract';
import { replay, worldHasPhysics } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';

const NO_CAST = { player: '', enemy: '', chaser: '', props: {} } as const;

/** Hraje svět ruční hry pravidel a pustí ukázku robota v reálném čase (P29A T6); s fyzikou až po načtení Rapieru (T13). */
export function RulesLab({ fixture, world }: { readonly fixture: string; readonly world: ArcadeWorld }) {
  const ready = usePhysicsReady(world);
  return ready ? <RulesLabStage fixture={fixture} world={world} /> : <div data-testid="arcade-physics-loading" aria-busy="true" />;
}

/**
 * Přehraje robotův záznam z Node v prohlížeči (P29A R4) a vedle hashe z Node
 * ukáže hash z Chromia; kontrolní záznam posunutý o tik musí dát jiný hash.
 */
export function RulesReplay({ world, inputs, nodeHash }: { readonly world: ArcadeWorld; readonly inputs: readonly InputEvent[]; readonly nodeHash: string }) {
  const ready = usePhysicsReady(world);
  const result = useMemo(() => {
    if (!ready) return null;
    const real = replay(world, inputs, ARCADE_LIBRARY);
    const shifted = replay(
      world,
      inputs.map((event) => ({ ...event, tick: event.tick + 1 })),
      ARCADE_LIBRARY,
    );
    return { real, shifted };
  }, [ready, world, inputs]);
  if (result === null) return <div data-testid="rules-replay" data-state="loading" />;
  return (
    <div
      data-testid="rules-replay"
      data-state="done"
      data-physics={String(worldHasPhysics(world))}
      data-node-hash={nodeHash}
      data-hash={result.real.hash}
      data-outcome={result.real.outcome}
      data-shifted-hash={result.shifted.hash}
    />
  );
}

function RulesLabStage({ fixture, world }: { readonly fixture: string; readonly world: ArcadeWorld }) {
  const session = useMemo(() => createArcadeSession(world), [world]);
  useEffect(() => session.startDemo(), [session]);
  return (
    <div data-testid="rules-lab" data-fixture={fixture} style={{ position: 'fixed', inset: 0 }}>
      <ArcadeStage session={session} cast={NO_CAST} />
    </div>
  );
}
