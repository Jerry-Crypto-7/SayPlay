'use client';

/**
 * Snap feed na `/play` (P54A T6, dřív svislý pager P27B T4): karta přes celou
 * výšku feedu, tah nebo kolečko dosedne vždy na další kartu
 * (`scroll-snap-stop: always`).
 *
 * Řádky jdou po stránkách z `GET /api/play/games?recent=N&cursor=C`, detail
 * hry z `GET /api/play/games/<id>` – pro aktivní kartu a její sousedy. V DOM
 * je nejvýš 7 karet (aktivní ±3), ostatní pozice drží prázdná mezera téže
 * výšky, takže posun i dosednutí platí pro celý seznam. Plátno je jedno po
 * celou dobu feedu (`StageHost`, T7) a kreslí do něj jen aktivní karta –
 * náhled robota, po ťuku hra hráče (`ReelCard`).
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
import { reducedMotion } from '../arcade/effects/feel';
import { isTyping as typing } from '../arcade/input';
import demo from '../demo-game.json';
import { Feed, type FeedGame, type KnownGame } from '../Feed';
import type { FeedPreview } from '@/play/version/version';

import { loopEvent } from '../loop-client';
import { FeedNext } from './feed-next';
import { countCanvases, feedMode, previewFor, untaken } from './preview';
import { ReelActions } from './ReelActions';
import { type GameDetail, ReelCard } from './ReelCard';
import { cardImage, createSnapshotCache } from './snapshot-cache';
import { StageHost } from './StageHost';
import { warmGame } from './warm';

const PAGE = 12;
/** Tah kratší než tohle je ťuk, ne listování. */
const SWIPE_PX = 40;
/** Karet v DOM na každou stranu od aktivní. */
const WINDOW = 3;
/** Bez `scrollend`: tolik ms bez `scroll` znamená dosednutí. */
const SETTLE_MS = 150;
/** Plynulý posun ke kartě trvá pod sekundu; starší cíl už dosednutí nepřebije. */
const AIM_MS = 1500;
/** Kolikrát zkusit detail hry znovu po 429; okno stropu je 10 s (`RATE_WINDOW_MS`). */
const DETAIL_RETRIES = 3;
/** Jak dlouho visí poděkování za nahlášení. */
const THANKS_MS = 3000;

/** Čekání podle `retry-after` (sekundy), nejvýš okno stropu; bez hlavičky 1 s. */
function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 10) * 1000 : 1000;
}

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
  const [snapshots] = useState(() => createSnapshotCache());
  /** Nový snímek v `snapshots` – karty se překreslí. */
  const [, setShots] = useState(0);
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
        // Strop frekvence (429) chytí rychlé listování i s přednačtenými sousedy: počkat, kolik
        // řekne server, a zkusit znovu – jinak by karta zůstala „nenačtená“, dokud hráč nepřijde znovu.
        for (let attempt = 0; ; attempt += 1) {
          const response = await fetch(`/api/play/games/${versionId}`);
          if (response.status === 429 && attempt < DETAIL_RETRIES) {
            await new Promise((resolve) => window.setTimeout(resolve, retryAfterMs(response)));
            continue;
          }
          if (response.ok) detail = (await response.json()) as GameDetail;
          break;
        }
      } catch {
        // Výpadek sítě: karta řekne, že se hra nenačetla, a feed jde listovat dál.
      }
      setDetails((prev) => new Map(prev).set(versionId, detail));
    })();
  }, []);

  // Aktivní hra a sousedé předem (T8: +1, +2 a −1, `warm.ts`); blízko konce další stránka řádků.
  useEffect(() => {
    if (feed.kind !== 'ready' || current === undefined) return;
    want(current.versionId);
    for (const near of [feed.games[index + 1], feed.games[index + 2], feed.games[index - 1]]) if (near !== undefined) want(near.versionId);
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

  // Náhled robota aktivní hry: z detailu, starší hra z workeru (T4).
  const [previews, setPreviews] = useState<ReadonlyMap<string, FeedPreview | null>>(new Map());
  const currentDetail = current === undefined ? undefined : details.get(current.versionId);
  useEffect(() => {
    if (current === undefined || currentDetail === undefined || currentDetail === 'error' || currentDetail.arcade === undefined) return;
    const versionId = current.versionId;
    let live = true;
    void previewFor(versionId, currentDetail.preview, currentDetail.arcade).then((preview) => {
      if (live) setPreviews((prev) => (prev.has(versionId) ? prev : new Map(prev).set(versionId, preview)));
    });
    return () => {
      live = false;
    };
  }, [current, currentDetail]);

  // Sousedé zahřátí, jakmile mají detail: modely, panorama, Rapier, náhled z workeru, obrázek karty.
  useEffect(() => {
    const landscape = window.matchMedia('(orientation: landscape)').matches;
    for (const near of [games[index + 1], games[index + 2], games[index - 1]]) {
      const detail = near === undefined ? undefined : details.get(near.versionId);
      if (near === undefined || detail === undefined || detail === 'error') continue;
      const image = cardImage(near.versionId);
      warmGame(near.versionId, detail, snapshots.get(near.versionId) ?? (landscape ? image.landscape : image.portrait));
    }
  }, [games, index, details, snapshots]);

  // Snímky her z dřívějších návštěv (P56B T12): hraná nebo vytvořená hra nedostane `/og`.
  useEffect(() => {
    let live = true;
    void snapshots.restore().then((count) => {
      if (live && count > 0) setShots((shots) => shots + 1);
    });
    return () => {
      live = false;
    };
  }, [snapshots]);

  // Snímek scény, ze které hráč odchází (T8). `shown` drží hru, jejíž scéna je v plátně –
  // `StageHost` volá `onLeave` uprostřed commitu další karty, dřív než se `shown` přepíše.
  const shown = useRef<string | null>(null);
  useEffect(() => {
    shown.current = current?.versionId ?? null;
  });
  const onLeave = useCallback(
    (frame: Promise<Blob | null>) => {
      const versionId = shown.current;
      if (versionId === null) return;
      void frame.then((blob) => {
        if (blob === null) return;
        snapshots.put(versionId, blob);
        setShots((count) => count + 1);
      });
    },
    [snapshots],
  );

  // Sonda pro e2e a měření: aktivní hra, režim karty, tik a kolik pláten feed kdy ukázal.
  useEffect(() => {
    window.__playFeed = () => {
      const card = document.querySelector('[data-testid="feed-current"]');
      return { versionId: card?.getAttribute('data-version-id') ?? null, mode: feedMode(card), tick: window.__playShell?.tick() ?? 0, contexts: countCanvases(document) };
    };
    return () => {
      delete window.__playFeed;
    };
  }, []);
  useEffect(() => {
    countCanvases(document);
  }, [index]);

  // Adresa bez `?g=` nebo s hrou, která ve feedu není: doplnit bez nového záznamu historie.
  useEffect(() => {
    if (current !== undefined && found === -1) window.history.replaceState(null, '', `?g=${current.versionId}`);
  }, [current, found]);

  // Feed sjede k aktivní kartě: po skoku plynule, po načtení a po Back hned.
  // `aim`: kam feed jede. Výměna karet v okně ±3 během plynulého posunu přiměje
  // prohlížeč dosednout zpět na kartu, ze které jel – takové dosednutí se nepočítá.
  const hasGames = games.length > 0;
  const aim = useRef<{ readonly index: number; readonly at: number } | null>(null);
  useEffect(() => {
    const element = reel.current;
    if (element === null || !hasGames) return;
    const top = index * element.clientHeight;
    const glided = glide.current;
    glide.current = false;
    // Klávesnice a čtečka (T13): po přechodu stojí fokus na kartě; méně pohybu = bez animace.
    if (glided) element.querySelector<HTMLElement>('[data-active="true"]')?.focus({ preventScroll: true });
    if (Math.abs(element.scrollTop - top) <= 1) return;
    aim.current = { index, at: performance.now() };
    element.scrollTo({ top, behavior: glided && !reducedMotion() ? 'smooth' : 'instant' });
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

  // Remix z karty (T10): řádek hned za rodičem, feed na něj skočí, jakmile je v seznamu –
  // aktivní karta se odvozuje z `?g=`, takže dřív by skok neměl kam. Titul a cíl karty přijdou z detailu.
  const [arrived, setArrived] = useState<string | null>(null);
  const remixed = useCallback((parent: FeedGame, versionId: string) => {
    setFeed((prev) => {
      if (prev.kind !== 'ready') return prev;
      const rows = prev.games.filter((game) => game.versionId !== versionId);
      rows.splice(rows.findIndex((game) => game.versionId === parent.versionId) + 1, 0, { versionId, title: parent.title, archetype: parent.archetype, remixes: 0 });
      return { ...prev, games: rows };
    });
    setArrived(versionId);
  }, []);
  // Poděkování za nahlášení (T11) přežije přechod na další kartu, akce karty ne.
  const [thanks, setThanks] = useState(false);
  useEffect(() => {
    if (!thanks) return;
    const timer = window.setTimeout(() => setThanks(false), THANKS_MS);
    return () => window.clearTimeout(timer);
  }, [thanks]);
  // Nahlášená hra ze seznamu odejde až poté, co z ní `?g=` odjel – dřív by ji karta hledala a feed skočil na začátek.
  const [reported, setReported] = useState<string | null>(null);
  useEffect(() => {
    if (reported === null || current?.versionId === reported) return;
    setReported(null);
    setFeed((prev) => (prev.kind === 'ready' ? { ...prev, games: prev.games.filter((game) => game.versionId !== reported) } : prev));
  }, [reported, current]);
  useEffect(() => {
    if (arrived === null) return;
    const at = games.findIndex((game) => game.versionId === arrived);
    if (at === -1) return;
    setArrived(null);
    go(at);
  }, [arrived, games, go]);

  // Dosednutí po tahu nebo kolečku: aktivní je karta, na které feed stojí; adresa se jen přepíše.
  const settle = useCallback(() => {
    const element = reel.current;
    if (element === null || element.clientHeight === 0) return;
    const target = Math.round(element.scrollTop / element.clientHeight);
    const wanted = aim.current;
    if (wanted !== null && performance.now() - wanted.at < AIM_MS) {
      if (target !== wanted.index) {
        element.scrollTo({ top: wanted.index * element.clientHeight, behavior: 'instant' });
        return;
      }
      aim.current = null;
    }
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

  // Klávesy feedu. Posluchač je jeden po celou dobu feedu v zachytávací fázi okna, takže
  // běží před hrou karty (ta se připojuje později): PageUp/PageDown žádná hra nebere a
  // v náhledu robota nebo na výsledku šipky ↑/↓ patří feedu – hra je nevidí a náhled
  // nepřevezmou. Když hraje hráč, ↑/↓ listují, jen když klávesu nepoužila hra (`preventDefault`),
  // proto až po doběhnutí události.
  const keys = useRef({ go, index, onScreen });
  useEffect(() => {
    keys.current = { go, index, onScreen };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const now = keys.current;
      if (!now.onScreen || event.altKey || event.ctrlKey || event.metaKey || typing(event.target)) return;
      // Esc při hraní nebo na výsledku (T9): z hry ven na další kartu, ne pauza. Otevřený list nebo pauzu zavře jako dřív.
      if (event.key === 'Escape') {
        if (untaken(feedMode(document.querySelector('[data-testid="feed-current"]'))) || document.querySelector('[role="dialog"]') !== null) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) now.go(now.index + 1);
        return;
      }
      // Enter a mezerník na tlačítku okraje (T13) stisknou tlačítko, hru nepřevezmou.
      if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof Element && event.target.closest('.play-pager-rail') !== null) {
        event.stopImmediatePropagation();
        return;
      }
      const step = event.key === 'ArrowDown' || event.key === 'PageDown' ? 1 : event.key === 'ArrowUp' || event.key === 'PageUp' ? -1 : 0;
      if (step === 0) return;
      if (event.key.startsWith('Page') || feedMode(document.querySelector('[data-testid="feed-current"]')) !== 'play') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) now.go(now.index + step);
        return;
      }
      if (event.repeat) return;
      window.setTimeout(() => {
        if (!event.defaultPrevented) now.go(now.index + step);
      }, 0);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const next = useCallback(() => keys.current.go(keys.current.index + 1), []);

  // Ťuk, nebo tah po scéně? (T9) V náhledu robota tah posouvá feed (`touch-action: pan-y`), takže
  // stisk scény hra hned nedostane – posluchač feedu je v zachytávací fázi okna dřív než převzetí
  // v `ArcadePlay`. Puštění bez posunu je ťuk: stisk se zopakuje na scéně, převezme hru a dál
  // do hry nejde (`document` v zachytávací fázi), takže ovládání hry nevidí stisk bez puštění.
  useEffect(() => {
    let pressed: PointerEvent | null = null;
    let replay: PointerEvent | null = null;
    const onDown = (event: PointerEvent) => {
      if (event === replay || !(event.target instanceof Element) || event.target.closest('[data-testid="arcade-stage"]') === null) return;
      const card = event.target.closest('[data-testid="feed-current"]');
      if (card === null || !untaken(feedMode(card))) return;
      event.stopImmediatePropagation();
      pressed = event;
    };
    const onUp = (event: PointerEvent) => {
      const down = pressed;
      pressed = null;
      if (down === null || event.pointerId !== down.pointerId || !(down.target instanceof Element) || !down.target.isConnected) return;
      if (Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) >= SWIPE_PX) return;
      replay = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: down.clientX, clientY: down.clientY, pointerId: down.pointerId, pointerType: down.pointerType, isPrimary: true });
      down.target.dispatchEvent(replay);
      replay = null;
    };
    const onCancel = () => {
      pressed = null;
    };
    const stopReplay = (event: PointerEvent) => {
      if (event === replay) event.stopPropagation();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    document.addEventListener('pointerdown', stopReplay, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onCancel, true);
      document.removeEventListener('pointerdown', stopReplay, true);
    };
  }, []);

  const swipeFrom = useRef<number | null>(null);
  const onRailDown = (event: React.PointerEvent<HTMLDivElement>) => {
    swipeFrom.current = event.clientY;
    // Tah smí začít i na tlačítku (sloupec akcí T10 leží na okraji), jen bez zachycení –
    // to by klepnutí na tlačítko přesměrovalo na okraj a klik by se ztratil.
    if (event.target instanceof Element && event.target.closest('button') !== null) return;
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
          The feed is not available right now. You can still make your own game.
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
    // Zachytávací fáze: kolo sdílení na okraji stisk dál nepustí (`ShareButton`), tah přes něj ale platí.
    <div className="play-pager-rail" data-testid="feed-rail" onPointerDownCapture={onRailDown} onPointerUpCapture={onRailUp} onPointerCancelCapture={() => (swipeFrom.current = null)}>
      <button type="button" className="play-pager-step" data-testid="feed-prev" onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous game">
        ↑
      </button>
      <span className="play-pager-count" aria-live="polite">
        {index + 1}/{games.length}
      </span>
      <ReelActions
        key={current.versionId}
        versionId={current.versionId}
        title={current.title}
        remixes={currentDetail !== undefined && currentDetail !== 'error' ? currentDetail.children.length : current.remixes}
        onRemixed={(versionId) => remixed(current, versionId)}
        onReported={() => {
          setThanks(true);
          setReported(current.versionId);
          // Na poslední kartě zpět na předchozí.
          go(index + 1 < games.length ? index + 1 : index - 1);
        }}
      />
      <button type="button" className="play-pager-step" data-testid="feed-next" onClick={() => go(index + 1)} disabled={index >= games.length - 1} aria-label="Next game">
        ↓
      </button>
    </div>
  );
  return (
    <section ref={root} className="play-pager" aria-label="Game feed" data-testid="feed-pager">
      <StageHost onLeave={onLeave}>
        {(host) => (
          <FeedNext.Provider value={next}>
          {/* Okraj je mimo kartu: na telefonu leží přes pravý kraj feedu, od 768 px vedle plochy. */}
          <div className="play-reel-frame">
          <div ref={reel} className="play-reel" data-testid="feed-reel">
            {games.map((game, at) =>
              Math.abs(at - index) <= WINDOW ? (
                <ReelCard
                  key={game.versionId}
                  game={game}
                  index={at}
                  active={at === index}
                  detail={details.get(game.versionId)}
                  live={onScreen}
                  host={host}
                  preview={previews.get(game.versionId)}
                  shot={snapshots.get(game.versionId)}
                />
              ) : (
                <div key={game.versionId} className="play-reel-gap" aria-hidden="true" />
              ),
            )}
          </div>
          {rail}
          </div>
          </FeedNext.Provider>
        )}
      </StageHost>
      <Feed games={games} index={index} known={known} shot={(versionId) => snapshots.get(versionId)} onPick={pick} />
      {thanks && (
        <p className="sp-toast" data-testid="feed-reported" role="status">
          Thanks. We&apos;ll take a look.
        </p>
      )}
    </section>
  );
}
