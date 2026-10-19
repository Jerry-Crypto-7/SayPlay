'use client';

/**
 * Snap feed na `/play` (P54A T6, dřív svislý pager P27B T4): karta přes celou
 * výšku feedu, tah nebo kolečko dosedne vždy na další kartu
 * (`scroll-snap-stop: always`).
 *
 * Řádky jdou po stránkách z `GET /api/play/games?recent=N&cursor=C`, detail
 * hry z `GET /api/play/games/<id>` – pro aktivní kartu a její sousedy. V DOM
 * je nejvýš 7 karet (aktivní ±3), ostatní pozice drží prázdná mezera téže
 * výšky, takže posun i dosednutí platí pro celý seznam. Plátno má jen aktivní
 * karta (`ReelCard`).
 *
 * `?g=<versionId>` drží aktivní hru. Dosednutí po tahu ji jen přepíše
 * (`replaceState`), skok – šipky, PageUp/PageDown, tlačítko, tah po okraji,
 * klik do seznamu – přidá záznam (`pushState`), takže zpět v prohlížeči vrátí
 * předchozí hru a feed k ní sjede. Next tyhle volání propojí s
 * `useSearchParams`. Aktivní kartu určuje poloha posunu při `scrollend`
 * (bez něj 150 ms klidu po posledním `scroll`), ne pořadí zpětných volání IO.
 */

import { useSearchParams } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import type { ArcadeWorld } from '@/play/arcade/contract';
import type { GameSpecV1 } from '@/play/spec';

import { ArcadePlay } from '../arcade/ArcadePlay';
import { WithPlayEnv } from '../arcade/look/play-env';
import { isTyping as typing } from '../arcade/input';
import demo from '../demo-game.json';
import { Feed, type FeedGame, type KnownGame } from '../Feed';
import { loopEvent } from '../loop-client';
import { type GameDetail, ReelCard } from './ReelCard';

const PAGE = 12;
/** Tah kratší než tohle je ťuk, ne listování. */
const SWIPE_PX = 40;
/** Karet v DOM na každou stranu od aktivní. */
const WINDOW = 3;
/** Bez `scrollend`: tolik ms bez `scroll` znamená dosednutí. */
const SETTLE_MS = 150;

type FeedState = { readonly kind: 'loading' } | { readonly kind: 'error' } | { readonly kind: 'ready'; readonly games: readonly FeedGame[]; readonly next: string | null };

export async function feedPage(cursor: string | null): Promise<{ games: FeedGame[]; next: string | null }> {
  const response = await fetch(`/api/play/games?recent=${String(PAGE)}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`feed ${String(response.status)}`);
  const body = (await response.json()) as { games?: FeedGame[]; next?: string | null };
  if (!Array.isArray(body.games)) throw new Error('feed without games');
  return { games: body.games, next: typeof body.next === 'string' ? body.next : null };
}

/** Ukázková hra z `demo-game.json` – návrh z pevné věty, commitnutý (`__tests__/demo-game.test.ts`). */
function DemoGame({ children }: { readonly children: ReactNode }) {
  return (
    <section className="play-pager" aria-label="Game feed" data-testid="feed-demo">
      <div className="play-pager-slide">
        <WithPlayEnv theme={(demo.spec as unknown as GameSpecV1).theme} versionId="demo">
          <ArcadePlay versionId="demo" spec={demo.spec as unknown as GameSpecV1} arcade={demo.arcade as unknown as ArcadeWorld} lineage={[]} remixes={0} upgrade={null} offline />
        </WithPlayEnv>
      </div>
      {children}
    </section>
  );
}

export function ReelFeed() {
  const wanted = useSearchParams().get('g');
  const [feed, setFeed] = useState<FeedState>({ kind: 'loading' });
  const [details, setDetails] = useState<ReadonlyMap<string, GameDetail | 'error'>>(new Map());
  const requested = useRef(new Set<string>());
  const loadingMore = useRef(false);
  const root = useRef<HTMLElement | null>(null);
  const reel = useRef<HTMLDivElement | null>(null);
  const [onScreen, setOnScreen] = useState(true);
  /** Příští posun k aktivní kartě je skok tlačítkem nebo klávesou – plynule. */
  const glide = useRef(false);

  useEffect(() => {
    let live = true;
    feedPage(null).then(
      (page) => live && setFeed({ kind: 'ready', ...page }),
      () => live && setFeed({ kind: 'error' }),
    );
    return () => {
      live = false;
    };
  }, []);

  const games = feed.kind === 'ready' ? feed.games : [];
  const found = wanted === null ? -1 : games.findIndex((game) => game.versionId === wanted);
  const index = Math.max(0, found);
  const current = games[index];

  const want = useCallback((versionId: string) => {
    if (requested.current.has(versionId)) return;
    requested.current.add(versionId);
    void (async () => {
      let detail: GameDetail | 'error' = 'error';
      try {
        const response = await fetch(`/api/play/games/${versionId}`);
        if (response.ok) detail = (await response.json()) as GameDetail;
      } catch {
        // Výpadek sítě: karta řekne, že se hra nenačetla, a feed jde listovat dál.
      }
      setDetails((prev) => new Map(prev).set(versionId, detail));
    })();
  }, []);

  // Aktivní hra a sousedé předem (plakát sousedů ukáže cíl); blízko konce další stránka řádků.
  useEffect(() => {
    if (feed.kind !== 'ready' || current === undefined) return;
    want(current.versionId);
    for (const near of [feed.games[index + 1], feed.games[index - 1]]) if (near !== undefined) want(near.versionId);
    if (index >= feed.games.length - 3 && feed.next !== null && !loadingMore.current) {
      loadingMore.current = true;
      const cursor = feed.next;
      feedPage(cursor).then(
        (page) => {
          loadingMore.current = false;
          setFeed((prev) => {
            if (prev.kind !== 'ready' || prev.next !== cursor) return prev;
            // Feed řazený podle smyčky se mezi stránkami smí pohnout (P36B T9): hra, která už v seznamu je, se nepřidá podruhé.
            const had = new Set(prev.games.map((game) => game.versionId));
            return { kind: 'ready', games: [...prev.games, ...page.games.filter((game) => !had.has(game.versionId))], next: page.next };
          });
        },
        () => {
          // Další stránka nepřišla: feed končí tím, co už má.
          setFeed((prev) => (prev.kind === 'ready' && prev.next === cursor ? { ...prev, next: null } : prev));
        },
      );
    }
  }, [feed, current, index, want]);

  // Adresa bez `?g=` nebo s hrou, která ve feedu není: doplnit bez nového záznamu historie.
  useEffect(() => {
    if (current !== undefined && found === -1) window.history.replaceState(null, '', `?g=${current.versionId}`);
  }, [current, found]);

  // Feed sjede k aktivní kartě: po skoku plynule, po načtení a po Back hned.
  const hasGames = games.length > 0;
  useEffect(() => {
    const element = reel.current;
    if (element === null || !hasGames) return;
    const top = index * element.clientHeight;
    const behavior = glide.current ? 'smooth' : 'instant';
    glide.current = false;
    if (Math.abs(element.scrollTop - top) > 1) element.scrollTo({ top, behavior });
  }, [index, hasGames]);

  const go = useCallback(
    (target: number) => {
      const game = games[target];
      if (game === undefined || target === index) return;
      // Další hra (P27D T4) se počítá za tu, kterou hráč opouští.
      if (current !== undefined) loopEvent('next_game', current.versionId);
      glide.current = true;
      window.history.pushState(null, '', `?g=${game.versionId}`);
    },
    [games, index, current],
  );
  const pick = useCallback((versionId: string) => go(games.findIndex((game) => game.versionId === versionId)), [games, go]);

  // Dosednutí po tahu nebo kolečku: aktivní je karta, na které feed stojí; adresa se jen přepíše.
  const settle = useCallback(() => {
    const element = reel.current;
    if (element === null || element.clientHeight === 0) return;
    const target = Math.round(element.scrollTop / element.clientHeight);
    const game = games[target];
    if (game === undefined || target === index) return;
    if (current !== undefined) loopEvent('next_game', current.versionId);
    window.history.replaceState(null, '', `?g=${game.versionId}`);
  }, [games, index, current]);

  useEffect(() => {
    const element = reel.current;
    if (element === null) return;
    if ('onscrollend' in window) {
      element.addEventListener('scrollend', settle);
      return () => element.removeEventListener('scrollend', settle);
    }
    let timer = 0;
    const onScroll = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(settle, SETTLE_MS);
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.clearTimeout(timer);
      element.removeEventListener('scroll', onScroll);
    };
  }, [settle, hasGames]);

  // Hra hraje, jen když je feed aspoň z poloviny vidět (nad ním je formulář).
  useEffect(() => {
    const element = root.current;
    if (element === null || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setOnScreen((entry?.intersectionRatio ?? 0) >= 0.5), { threshold: [0, 0.5, 1] });
    observer.observe(element);
    return () => observer.disconnect();
  }, [feed.kind, hasGames]);

  // ↑/↓ listují, jen když klávesu nepoužila hra (ta volá `preventDefault`).
  // Hra se připojuje líně a její posluchače mohou přijít po tomhle, proto až po doběhnutí události.
  // PageUp/PageDown žádná hra nebere: listují hned a stránku pod feedem neposunou.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!onScreen || event.repeat || event.altKey || event.ctrlKey || event.metaKey || typing(event.target)) return;
      if (event.key === 'PageDown' || event.key === 'PageUp') {
        event.preventDefault();
        go(index + (event.key === 'PageDown' ? 1 : -1));
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
      if (step === 0) return;
      window.setTimeout(() => {
        if (!event.defaultPrevented) go(index + step);
      }, 0);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, index, onScreen]);

  const swipeFrom = useRef<number | null>(null);
  const onRailDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // Zachycení by klepnutí na tlačítko přesměrovalo na okraj a klik by se ztratil.
    if (event.target instanceof Element && event.target.closest('button') !== null) return;
    swipeFrom.current = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onRailUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const from = swipeFrom.current;
    swipeFrom.current = null;
    if (from === null) return;
    const dy = event.clientY - from;
    if (Math.abs(dy) >= SWIPE_PX) go(index + (dy < 0 ? 1 : -1));
  };

  // Bez hry z feedu hraje pevná ukázka (P28D T7): první obrazovka je hra, ne prázdný stav.
  if (feed.kind === 'loading') {
    return (
      <DemoGame>
        <p className="play-feed-empty" data-testid="feed-loading" role="status">
          Loading games…
        </p>
      </DemoGame>
    );
  }
  if (feed.kind === 'error') {
    return (
      <DemoGame>
        <p className="play-feed-empty" data-testid="feed-error" role="status">
          The feed is not available right now. You can still make a game above.
        </p>
      </DemoGame>
    );
  }
  if (current === undefined) {
    return (
      <DemoGame>
        <p className="play-feed-empty" data-testid="play-feed-empty">
          No games yet. Make the first one.
        </p>
      </DemoGame>
    );
  }

  const known = new Map<string, KnownGame>();
  for (const [versionId, entry] of details) if (entry !== 'error') known.set(versionId, { goal: entry.spec.tutorial.goalLine, mood: entry.spec.theme.mood });
  const rail = (
    <div className="play-pager-rail" data-testid="feed-rail" onPointerDown={onRailDown} onPointerUp={onRailUp} onPointerCancel={() => (swipeFrom.current = null)}>
      <button type="button" className="play-pager-step" data-testid="feed-prev" onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous game">
        ↑
      </button>
      <span className="play-pager-count" aria-live="polite">
        {index + 1}/{games.length}
      </span>
      <button type="button" className="play-pager-step" data-testid="feed-next" onClick={() => go(index + 1)} disabled={index >= games.length - 1} aria-label="Next game">
        ↓
      </button>
    </div>
  );
  return (
    <section ref={root} className="play-pager" aria-label="Game feed" data-testid="feed-pager">
      <div ref={reel} className="play-reel" data-testid="feed-reel">
        {games.map((game, at) =>
          Math.abs(at - index) <= WINDOW ? (
            <ReelCard key={game.versionId} game={game} index={at} active={at === index} detail={details.get(game.versionId)} live={onScreen} rail={at === index ? rail : null} />
          ) : (
            <div key={game.versionId} className="play-reel-gap" aria-hidden="true" />
          ),
        )}
      </div>
      <Feed games={games} current={current.versionId} known={known} onPick={pick} />
    </section>
  );
}
