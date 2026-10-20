'use client';

/**
 * Jedna karta snap feedu (P54A T6): přesně výška feedu, dosedá po jedné.
 *
 * Aktivní karta (T7) připojí hru do trvalého plátna feedu (`StageHost`) a
 * robot v ní ztlumeně hraje náhled z publikace; ťuk na scénu nebo klávesa
 * hru převezme. Nese `feed-current` a listovací okraj. Ostatní karty ukazují
 * plakát v tónu nálady scény (titul, cíl, když už je detail stažený) s obrázkem
 * hry (T8, `CardImage`).
 */

import Link from 'next/link';
import { type RefObject, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { ArcadeWorld } from '@/play/arcade/contract';
import type { GameVersion } from '@/play/contracts';
import type { Par } from '@/play/score/stars';
import type { GameSpecV1 } from '@/play/spec';
import type { FeedPreview } from '@/play/version/version';

import { ArcadePlay } from '../arcade/ArcadePlay';
import { WithPlayEnv } from '../arcade/look/play-env';
import { beatText, type FeedGame, moodTone } from '../Feed';
import { Lineage } from '../Lineage';
import { Icon } from '../ui';
import { feedMode } from './preview';
import { cardImage } from './snapshot-cache';
import type { StageTunnel } from './stage-tunnel';

export interface GameDetail {
  readonly spec: GameSpecV1;
  readonly arcade?: ArcadeWorld;
  readonly relation?: string;
  readonly children: readonly string[];
  readonly lineage: readonly GameVersion[];
  /** Hra publikovaná před P36B par nemá. */
  readonly report?: { readonly par?: Par };
  /** Náhled robota z publikace (P54A T2); starší hra ho nemá. */
  readonly preview?: FeedPreview;
}

/**
 * „Tap to play“ nad náhledem robota (P54A T7, dřív plakát P33 T8 – hra bez
 * hráče prohrála dřív, než pochopil ovládání; náhled robota neprohrává).
 * Ťuk projde skrz na scénu, kde ho převezme `take()` v `ArcadePlay`. Zmizí,
 * jakmile hraje hráč (`play-demo` v kartě chybí).
 */
export function TapHint({ goal, beat = null }: { readonly goal: string; readonly beat?: number | null }) {
  return (
    <div className="play-reel-hint" data-testid="feed-hint" aria-hidden="true">
      <span className="play-poster-goal">{goal}</span>
      {beat !== null && (
        <span className="sp-label play-poster-beat" data-testid="feed-poster-beat">
          {beatText(beat)}
        </span>
      )}
      <span className="play-poster-cta">
        <Icon name="play" />
        Tap to play
      </span>
    </div>
  );
}

const REDUCE = '(prefers-reduced-motion: reduce)';

/** Méně pohybu (T13): karta nepřehrává robota, hra stojí na tiku 0 a čeká na ťuk. */
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (change) => {
      const query = window.matchMedia(REDUCE);
      query.addEventListener('change', change);
      return () => query.removeEventListener('change', change);
    },
    () => window.matchMedia(REDUCE).matches,
    () => false,
  );
}

/** Výsledek běhu bez vstupu tak dlouho vrátí kartu do náhledu robota (T9). */
const RESULT_IDLE_MS = 10_000;

/**
 * Kolikrát se karta vrátila z výsledku do náhledu (T9): po `RESULT_IDLE_MS` na
 * výsledku bez stisku nebo klávesy se číslo zvedne a hra se připojí znovu – nová
 * relace začíná náhledem robota. Režim čte z DOM jako sonda (`feedMode`).
 */
function useResultIdle(slide: RefObject<HTMLElement | null>, enabled: boolean): number {
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let since: number | null = null;
    const input = () => {
      if (since !== null) since = performance.now();
    };
    const timer = window.setInterval(() => {
      if (feedMode(slide.current) !== 'result') {
        since = null;
        return;
      }
      since ??= performance.now();
      if (performance.now() - since >= RESULT_IDLE_MS) {
        since = null;
        setRound((count) => count + 1);
      }
    }, 250);
    window.addEventListener('pointerdown', input, true);
    window.addEventListener('keydown', input, true);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('pointerdown', input, true);
      window.removeEventListener('keydown', input, true);
    };
  }, [slide, enabled]);
  return round;
}

function ActiveSlide({
  game,
  detail,
  live,
  host,
  preview,
  round,
}: {
  /** Návrat z výsledku do náhledu – nový klíč hry (`useResultIdle`). */
  readonly round: number;
  readonly game: FeedGame;
  readonly detail: GameDetail | 'error' | undefined;
  readonly live: boolean;
  readonly host: StageTunnel;
  /** `undefined` = náhled se ještě počítá, `null` = hra hraje bez něj. */
  readonly preview: FeedPreview | null | undefined;
}) {
  const still = useReducedMotion();
  if (detail === undefined || (detail !== 'error' && detail.arcade !== undefined && preview === undefined && !still)) {
    return (
      <p className="play-pager-note" role="status">
        Loading {game.title}…
      </p>
    );
  }
  if (detail === 'error') {
    return (
      <p className="play-pager-note" role="status">
        This game could not be loaded. Try the next one.
      </p>
    );
  }
  if (detail.arcade === undefined) {
    // Starší hry běží v jiném runtime (mřížka); feed je nehraje, jen na ně odkáže.
    return (
      <p className="play-pager-note">
        {detail.spec.title} plays on its own page. <Link href={`/play/${game.versionId}`}>Open the game</Link>
      </p>
    );
  }
  return (
    <>
      <WithPlayEnv key={`${game.versionId}-${String(round)}-${String(still)}`} theme={detail.spec.theme} versionId={game.versionId}>
        <ArcadePlay
          versionId={game.versionId}
          spec={detail.spec}
          arcade={detail.arcade}
          lineage={detail.lineage}
          remixes={detail.children.length}
          aiVersion={detail.relation === 'upgrade'}
          upgrade={null}
          active={live}
          inFeed
          par={detail.report?.par ?? null}
          preview={still ? undefined : (preview ?? undefined)}
          host={host}
        />
      </WithPlayEnv>
      {(still || preview !== null) && <TapHint goal={detail.spec.tutorial.goalLine} beat={game.beat ?? null} />}
      {/* Rodokmen remixu nebo AI verze pod náhledem (T10); počet remixů nese sloupec akcí. */}
      {detail.lineage.length >= 2 && (
        <div className="play-reel-lineage">
          <Lineage lineage={detail.lineage} remixes={0} aiVersion={detail.relation === 'upgrade'} />
        </div>
      )}
    </>
  );
}

/**
 * Obrázek karty, která nehraje (T8): snímek scény z posledního odchodu, jinak
 * kurátorský snímek na výšku/na šířku nebo obrázek odkazu. Nenačtený obrázek
 * (prázdné `alt`) nekreslí nic a zůstane plakát v tónu nálady pod ním.
 */
function CardImage({ versionId, shot }: { readonly versionId: string; readonly shot: string | undefined }) {
  if (shot !== undefined) return <img className="play-reel-shot" data-testid="feed-shot" src={shot} alt="" />;
  const image = cardImage(versionId);
  return (
    <picture>
      <source media="(orientation: landscape)" srcSet={image.landscape} />
      <img className="play-reel-shot" src={image.portrait} alt="" loading="lazy" decoding="async" />
    </picture>
  );
}

export function ReelCard({
  game,
  index,
  active,
  detail,
  live,
  host,
  preview,
  shot,
}: {
  readonly game: FeedGame;
  readonly index: number;
  readonly active: boolean;
  readonly detail: GameDetail | 'error' | undefined;
  /** Feed je vidět – jen tehdy aktivní hra běží. */
  readonly live: boolean;
  /** Trvalé plátno feedu – aktivní karta do něj kreslí svou scénu. */
  readonly host: StageTunnel;
  readonly preview: FeedPreview | null | undefined;
  /** Snímek scény z posledního odchodu z karty (`snapshot-cache.ts`). */
  readonly shot: string | undefined;
}) {
  const spec = detail !== undefined && detail !== 'error' ? detail.spec : null;
  const slide = useRef<HTMLDivElement | null>(null);
  const round = useResultIdle(slide, active && preview !== null && preview !== undefined);
  // Hra bez náhledu (méně pohybu, nebo worker náhled nespočítal) stojí na tiku 0 a čeká na hráče:
  // feed se dál posouvá a akce karty zůstanou vidět (revize /ship P54A).
  const still = useReducedMotion() || preview === null;
  return (
    <article tabIndex={-1} className="play-reel-card" data-testid="feed-card" data-index={index} data-version-id={game.versionId} data-active={active} aria-label={game.title}>
      {active ? (
        <div ref={slide} className="play-pager-slide" data-testid="feed-current" data-version-id={game.versionId} data-still={still}>
          <ActiveSlide game={game} detail={detail} live={live} host={host} preview={preview} round={round} />
        </div>
      ) : (
        <div className="play-poster play-reel-poster" data-tone={moodTone(spec?.theme.mood ?? '')} aria-hidden="true">
          <CardImage versionId={game.versionId} shot={shot} />
          <span className="play-poster-title">{spec?.title ?? game.title}</span>
          {spec !== null && <span className="play-poster-goal">{spec.tutorial.goalLine}</span>}
        </div>
      )}
    </article>
  );
}
