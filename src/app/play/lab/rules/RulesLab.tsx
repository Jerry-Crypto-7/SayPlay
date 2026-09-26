'use client';

import { useEffect, useMemo } from 'react';

import ArcadeStage from '@/components/play/arcade/ArcadeStage';
import { createArcadeSession } from '@/components/play/arcade/session';
import type { ArcadeWorld } from '@/play/arcade/contract';

const NO_CAST = { player: '', enemy: '', chaser: '', props: {} } as const;

/** Hraje svět ruční hry pravidel a pustí ukázku robota v reálném čase (P29A T6). */
export function RulesLab({ fixture, world }: { readonly fixture: string; readonly world: ArcadeWorld }) {
  const session = useMemo(() => createArcadeSession(world), [world]);
  useEffect(() => session.startDemo(), [session]);
  return (
    <div data-testid="rules-lab" data-fixture={fixture} style={{ position: 'fixed', inset: 0 }}>
      <ArcadeStage session={session} cast={NO_CAST} />
    </div>
  );
}
