'use client';

/**
 * Svislý feed na `/play` (P27B T4): jedna hra přes obrazovku, další hned za ní.
 *
 * Řádky jdou po stránkách z `GET /api/play/games?recent=N&cursor=C`, detail
 * hry (spec a svět) z `GET /api/play/games/<id>` – pro aktuální i následující
 * hru předem, plátno se ale připojí až při přechodu. V DOM je vždy jen jeden
 * `ArcadePlay` (jeden WebGL kontext); `key` podle verze zajistí, že opuštěná
 * hra se odpojí celá a nová dostane čistou relaci.
 *
 * `?g=<versionId>` drží aktuální hru: první načtení ji jen doplní
 * (`replaceState`), přechod přidá záznam (`pushState`), takže zpět v prohlížeči
 * vrátí předchozí hru. Next tyhle volání propojí s `useSearchParams`.
 *
 * Listuje se tlačítky, šipkami ↑/↓ (jen když je hra sama nepoužila – každé
 * ovládání má jiné klávesy) a svislým tahem **jen na okraji** `feed-rail`,
 * aby tah nekradl skok ani míření. Hra mimo obrazovku dostane `active={false}`.
 */

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import type { ArcadeWorld } from '@/play/arcade/contract';
import type { GameVersion } from '@/play/contracts';
import type { GameSpecV1 } from '@/play/spec';

import { ArcadePlay } from './arcade/ArcadePlay';
import { WithPlayEnv } from './arcade/look/play-env';
import { isTyping as typing } from './arcade/input';
import demo from './demo-game.json';
import { Feed, type FeedGame, type KnownGame, moodTone } from './Feed';
import { loopEvent } from './loop-client';
import { Icon } from './ui';

const PAGE = 12;
/** Tah kratší než tohle je ťuk, ne listování. */
const SWIPE_PX = 40;

interface GameDetail {
  readonly spec: GameSpecV1;
  readonly arcade?: ArcadeWorld;
  readonly relation?: string;
  readonly children: readonly string[];
  readonly lineage: readonly GameVersion[];
}

type FeedState = { readonly kind: 'loading' } | { readonly kind: 'error' } | { readonly kind: 'ready'; readonly games: readonly FeedGame[]; readonly next: string | null };

async function feedPage(cursor: string | null): Promise<{ games: FeedGame[]; next: string | null }> {
  const response = await fetch(`/api/play/games?recent=${String(PAGE)}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`feed ${String(response.status)}`);
  const body = (await response.json()) as { games?: FeedGame[]; next?: string | null };
  if (!Array.isArray(body.games)) throw new Error('feed without games');
  return { games: body.games, next: typeof body.next === 'string' ? body.next : null };
}

/**
 * Plakát hry ve feedu (P33 T8): hra se připojí až po klepnutí. Rozběhnutá
 * sama od sebe prohrála dřív, než hráč pochopil ovládání, a první, co na
 * `/play` viděl, bylo „You lost“. `key` podle verze vrátí plakát u každé hry.
 */
export function TapToPlay({ title, goal, mood, children }: { readonly title: string; readonly goal: string; readonly mood: string; readonly children: ReactNode }) {
  const [started, setStarted] = useState(false);
  if (started) return children;
  return (
    <button type="button" className="play-poster" data-testid="feed-poster" data-tone={moodTone(mood)} onClick={() => setStarted(true)}>
      <span className="play-poster-title">{title}</span>
      <span className="play-poster-goal">{goal}</span>
      <span className="play-poster-cta">
        <Icon name="play" />
        Tap to play
      </span>
    </button>
  );
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

export function FeedPager() {
  const wanted = useSearchParams().get('g');
  const [feed, setFeed] = useState<FeedState>({ kind: 'loading' });
  const [details, setDetails] = useState<ReadonlyMap<string, GameDetail | 'error'>>(new Map());
  const requested = useRef(new Set<string>());
  const loadingMore = useRef(false);
  const root = useRef<HTMLElement | null>(null);
  const [onScreen, setOnScreen] = useState(true);

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
        // Výpadek sítě: slide řekne, že se hra nenačetla, a feed jde listovat dál.
      }
      setDetails((prev) => new Map(prev).set(versionId, detail));
    })();
  }, []);

  // Aktuální a následující hra předem; blízko konce další stránka řádků.
  useEffect(() => {
    if (feed.kind !== 'ready' || current === undefined) return;
    want(current.versionId);
    const following = feed.games[index + 1];
    if (following !== undefined) want(following.versionId);
    if (index >= feed.games.length - 3 && feed.next !== null && !loadingMore.current) {
      loadingMore.current = true;
      const cursor = feed.next;
      feedPage(cursor).then(
        (page) => {
          loadingMore.current = false;
          setFeed((prev) => (prev.kind === 'ready' && prev.next === cursor ? { kind: 'ready', games: [...prev.games, ...page.games], next: page.next } : prev));
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

  const go = useCallback(
    (target: number) => {
      const game = games[target];
      if (game === undefined || target === index) return;
      // Další hra (P27D T4) se počítá za tu, kterou hráč opouští.
      if (current !== undefined) loopEvent('next_game', current.versionId);
      window.history.pushState(null, '', `?g=${game.versionId}`);
    },
    [games, index, current],
  );
  const pick = useCallback((versionId: string) => go(games.findIndex((game) => game.versionId === versionId)), [games, go]);

  // Hra hraje, jen když je feed aspoň z poloviny vidět (pod ním je formulář).
  useEffect(() => {
    const element = root.current;
    if (element === null || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setOnScreen((entry?.intersectionRatio ?? 0) >= 0.5), { threshold: [0, 0.5, 1] });
    observer.observe(element);
    return () => observer.disconnect();
  }, [feed.kind]);

  // ↑/↓ listují, jen když klávesu nepoužila hra (ta volá `preventDefault`).
  // Hra se připojuje líně a její posluchače mohou přijít po tomhle, proto až po doběhnutí události.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!onScreen || event.repeat || event.altKey || event.ctrlKey || event.metaKey || typing(event.target)) return;
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
          No games yet – write the first sentence.
        </p>
      </DemoGame>
    );
  }

  const detail = details.get(current.versionId);
  const known = new Map<string, KnownGame>();
  for (const [versionId, entry] of details) if (entry !== 'error') known.set(versionId, { goal: entry.spec.tutorial.goalLine, mood: entry.spec.theme.mood });
  return (
    <section ref={root} className="play-pager" aria-label="Game feed" data-testid="feed-pager">
      <div className="play-pager-slide" data-testid="feed-current" data-version-id={current.versionId}>
        {detail === undefined ? (
          <p className="play-pager-note" role="status">
            Loading {current.title}…
          </p>
        ) : detail === 'error' ? (
          <p className="play-pager-note" role="status">
            This game could not be loaded. Try the next one.
          </p>
        ) : detail.arcade === undefined ? (
          // Starší hry běží v jiném runtime (mřížka); feed je nehraje, jen na ně odkáže.
          <p className="play-pager-note">
            {detail.spec.title} plays on its own page. <Link href={`/play/${current.versionId}`}>Open the game</Link>
          </p>
        ) : (
          <TapToPlay key={current.versionId} title={detail.spec.title} goal={detail.spec.tutorial.goalLine} mood={detail.spec.theme.mood}>
            <WithPlayEnv theme={detail.spec.theme} versionId={current.versionId}>
              <ArcadePlay
                versionId={current.versionId}
                spec={detail.spec}
                arcade={detail.arcade}
                lineage={detail.lineage}
                remixes={detail.children.length}
                aiVersion={detail.relation === 'upgrade'}
                upgrade={null}
                active={onScreen}
                inFeed
              />
            </WithPlayEnv>
          </TapToPlay>
        )}
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
      </div>
      <Feed games={games} current={current.versionId} known={known} onPick={pick} />
    </section>
  );
}
