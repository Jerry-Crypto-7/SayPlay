'use client';

/**
 * Feed na `/play`: od P54A T6 snap feed karet `feed/ReelFeed.tsx`. Tenhle
 * soubor zůstává jako obal pro `page.tsx` (`FeedPager`, `FeaturedGame`).
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';

import type { GameSpecV1 } from '@/play/spec';

import demo from './demo-game.json';
import { moodTone } from './Feed';
import type { GameDetail } from './feed/ReelCard';
import { feedPage, ReelFeed } from './feed/ReelFeed';
import { Icon } from './ui';

/** Od této šířky stojí doporučená hra vedle pole (kit 05-layout, `lg`). */
const FEATURED_FROM = '(min-width: 1024px)';

/**
 * Doporučená hra vpravo od pole na desktopu (P34 T3, kit 05-layout „Home“):
 * plakát 16:9 nejnovější hry feedu s titulem a cílem v tónu nálady scény;
 * klepnutí ji otevře. Bez her ve feedu je doporučená ukázka, která pod polem
 * hraje – klepnutí k ní sjede. Plakát, ne plátno: feed drží jediný WebGL
 * kontext a druhý by mu ho bral. Na užší obrazovce se nic nestahuje ani nekreslí.
 */
export function FeaturedGame() {
  const [game, setGame] = useState<{ readonly versionId: string | null; readonly title: string; readonly goal: string; readonly mood: string } | null>(null);
  useEffect(() => {
    if (!window.matchMedia(FEATURED_FROM).matches) return;
    let live = true;
    const spec = demo.spec as unknown as GameSpecV1;
    const fallback = { versionId: null, title: spec.title, goal: spec.tutorial.goalLine, mood: spec.theme.mood };
    void (async () => {
      try {
        const first = (await feedPage(null)).games[0];
        if (first === undefined) {
          if (live) setGame(fallback);
          return;
        }
        const response = await fetch(`/api/play/games/${first.versionId}`);
        const detail = response.ok ? ((await response.json()) as GameDetail).spec : null;
        if (live) setGame({ versionId: first.versionId, title: first.title, goal: detail?.tutorial.goalLine ?? '', mood: detail?.theme.mood ?? '' });
      } catch {
        if (live) setGame(fallback);
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  if (game === null) return null;
  const face = (
    <>
      <span className="play-poster-title">{game.title}</span>
      {game.goal !== '' && <span className="play-poster-goal">{game.goal}</span>}
      <span className="play-poster-cta">
        <Icon name="play" />
        Play it
      </span>
    </>
  );
  if (game.versionId === null) {
    return (
      <button
        type="button"
        className="play-poster play-featured"
        data-testid="play-featured"
        data-tone={moodTone(game.mood)}
        onClick={() => document.querySelector('.play-pager')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
      >
        {face}
      </button>
    );
  }
  return (
    <Link href={`/play/${game.versionId}`} className="play-poster play-featured" data-testid="play-featured" data-tone={moodTone(game.mood)}>
      {face}
    </Link>
  );
}

export function FeedPager() {
  return <ReelFeed />;
}
