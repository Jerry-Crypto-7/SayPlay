'use client';

/**
 * Seznam feedu vedle hrající hry na široké obrazovce (P23-D T4, P27B T4).
 * Karta nese titul, jednu větu archetypu a počet remixů; klepnutí přepne hru
 * ve feedu. Na úzkém displeji ho CSS schová – listuje se tlačítky a okrajem.
 */

export interface FeedGame {
  readonly versionId: string;
  readonly title: string;
  readonly archetype: string;
  readonly remixes: number;
}

/**
 * `pitches` – věta archetypu podle id. Počítá je serverová stránka: registr
 * táhne zod a do klientského bundlu nepatří (stejně jako u `lab.ts`).
 */
export function Feed({
  games,
  current,
  pitches,
  onPick,
}: {
  readonly games: readonly FeedGame[];
  readonly current: string;
  readonly pitches: Readonly<Record<string, string>>;
  readonly onPick: (versionId: string) => void;
}) {
  const pitchOf = (archetype: string): string => (Object.hasOwn(pitches, archetype) ? pitches[archetype] : '');
  return (
    <nav className="play-feed" aria-label="More games">
      <h2 className="play-starters-title">More games</h2>
      <ul className="play-feed-list">
        {games.map((game) => (
          <li key={game.versionId}>
            <button
              type="button"
              className="play-feed-card"
              data-testid="play-feed-card"
              aria-current={game.versionId === current ? 'true' : undefined}
              onClick={() => onPick(game.versionId)}
            >
              <span className="play-feed-title">{game.title}</span>
              <span className="play-feed-pitch">{pitchOf(game.archetype)}</span>
              <span className="play-feed-remixes">{game.remixes === 1 ? '1 remix' : `${String(game.remixes)} remixes`}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
