'use client';

/**
 * Klientská polovina routy: postaví partii z rozhodnutí routeru a nechá ji
 * běžet na 20 Hz.
 *
 * `ssr: false` je povinné, ne kosmetické — `FallbackStage` uvnitř drží
 * `<Canvas>` a WebGL kontext na serveru neexistuje.
 *
 * Postup není hráč, ale **stopa od řešitele archetypu**. Je to jediný vstup,
 * který dnes existuje pro všechny tři hry stejně (T203 dělal ovládání jako
 * `Intent`, ne jako klávesnici), a je deterministický, takže z něj smoke test
 * dostane stejný průběh při každém běhu.
 */

import dynamic from 'next/dynamic';
import { useEffect, useMemo, useState } from 'react';

import { DEFAULT_MAX_TICKS, MS_PER_TICK, type GameView } from '@/fallback/loop';
import type { RouteDecision } from '@/fallback/router';
import { sessionFor } from '@/fallback/session';

const FallbackStage = dynamic(() => import('@/fallback/hud').then((mod) => mod.FallbackStage), {
  ssr: false,
});

export default function PlayView({
  decision,
  prompt,
}: {
  decision: RouteDecision;
  prompt: string;
}) {
  const session = useMemo(
    () => (decision.kind === 'archetype' ? sessionFor(decision, prompt) : null),
    [decision, prompt],
  );
  const [view, setView] = useState<GameView | null>(null);

  useEffect(() => {
    if (session === null) {
      setView(null);
      return;
    }

    const { game, seed, solution } = session;
    let state = game.create(seed);
    let tick = 0;
    setView(game.project(state));

    const timer = setInterval(() => {
      if (game.project(state).phase !== 'running' || tick >= DEFAULT_MAX_TICKS) {
        clearInterval(timer);
        return;
      }
      state = game.advance(state, solution?.[tick] ?? []);
      tick += 1;
      setView(game.project(state));
    }, MS_PER_TICK);

    return () => clearInterval(timer);
  }, [session]);

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
      <FallbackStage decision={decision} view={view} />
    </div>
  );
}
