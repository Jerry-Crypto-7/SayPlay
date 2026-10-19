'use client';

/**
 * Jedna karta snap feedu (P54A T6): přesně výška feedu, dosedá po jedné.
 *
 * Aktivní karta je dnešní slide feedu – plakát „Tap to play“, po klepnutí
 * `ArcadePlay` – a nese `feed-current` a listovací okraj. Ostatní karty
 * ukazují jen plakát v tónu nálady scény (titul, cíl, když už je detail
 * stažený); plátno má jen aktivní karta.
 */

import Link from 'next/link';
import { type ReactNode, useState } from 'react';

import type { ArcadeWorld } from '@/play/arcade/contract';
import type { GameVersion } from '@/play/contracts';
import type { Par } from '@/play/score/stars';
import type { GameSpecV1 } from '@/play/spec';

import { ArcadePlay } from '../arcade/ArcadePlay';
import { WithPlayEnv } from '../arcade/look/play-env';
import { beatText, type FeedGame, moodTone } from '../Feed';
import { Icon } from '../ui';

export interface GameDetail {
  readonly spec: GameSpecV1;
  readonly arcade?: ArcadeWorld;
  readonly relation?: string;
  readonly children: readonly string[];
  readonly lineage: readonly GameVersion[];
  /** Hra publikovaná před P36B par nemá. */
  readonly report?: { readonly par?: Par };
}

/**
 * Plakát hry ve feedu (P33 T8): hra se připojí až po klepnutí. Rozběhnutá
 * sama od sebe prohrála dřív, než hráč pochopil ovládání, a první, co na
 * `/play` viděl, bylo „You lost“. `key` podle verze vrátí plakát u každé hry.
 */
export function TapToPlay({
  title,
  goal,
  mood,
  beat = null,
  children,
}: {
  readonly title: string;
  readonly goal: string;
  readonly mood: string;
  /** „N% beat this“ (P37C T5); `null` = málo pokusů, řádek chybí. */
  readonly beat?: number | null;
  readonly children: ReactNode;
}) {
  const [started, setStarted] = useState(false);
  if (started) return children;
  return (
    <button type="button" className="play-poster" data-testid="feed-poster" data-tone={moodTone(mood)} onClick={() => setStarted(true)}>
      <span className="play-poster-title">{title}</span>
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
    </button>
  );
}

function ActiveSlide({ game, detail, live }: { readonly game: FeedGame; readonly detail: GameDetail | 'error' | undefined; readonly live: boolean }) {
  if (detail === undefined) {
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
    <TapToPlay key={game.versionId} title={detail.spec.title} goal={detail.spec.tutorial.goalLine} mood={detail.spec.theme.mood} beat={game.beat ?? null}>
      <WithPlayEnv theme={detail.spec.theme} versionId={game.versionId}>
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
        />
      </WithPlayEnv>
    </TapToPlay>
  );
}

export function ReelCard({
  game,
  index,
  active,
  detail,
  live,
  rail,
}: {
  readonly game: FeedGame;
  readonly index: number;
  readonly active: boolean;
  readonly detail: GameDetail | 'error' | undefined;
  /** Feed je vidět – jen tehdy aktivní hra běží. */
  readonly live: boolean;
  /** Listovací okraj; nese ho jen aktivní karta. */
  readonly rail: ReactNode;
}) {
  const spec = detail !== undefined && detail !== 'error' ? detail.spec : null;
  return (
    <article className="play-reel-card" data-testid="feed-card" data-index={index} data-version-id={game.versionId} data-active={active} aria-label={game.title}>
      {active ? (
        <div className="play-pager-slide" data-testid="feed-current" data-version-id={game.versionId}>
          <ActiveSlide game={game} detail={detail} live={live} />
          {rail}
        </div>
      ) : (
        <div className="play-poster play-reel-poster" data-tone={moodTone(spec?.theme.mood ?? '')} aria-hidden="true">
          <span className="play-poster-title">{spec?.title ?? game.title}</span>
          {spec !== null && <span className="play-poster-goal">{spec.tutorial.goalLine}</span>}
        </div>
      )}
    </article>
  );
}
