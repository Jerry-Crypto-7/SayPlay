'use client';

/**
 * Seznam feedu vedle hrající hry na široké obrazovce (P23-D T4, P27B T4).
 * Karta nese barevný pruh podle nálady scény, titul, cíl hry a počet remixů
 * (jen když nějaký je); klepnutí přepne hru ve feedu. Na úzkém displeji ho
 * CSS schová – listuje se tlačítky a okrajem.
 *
 * Cíl a náladu nese detail hry, který feed stahuje jen pro aktuální a další
 * hru (`known`); ostatní karty mají titul a neutrální pruh. Věta archetypu z
 * registru tu od P33 T8 není: byla stejná u tučňáka i hasiče.
 */

export interface FeedGame {
  readonly versionId: string;
  readonly title: string;
  readonly archetype: string;
  readonly remixes: number;
}

/** Co feed ví o hře z jejího detailu (`spec.tutorial.goalLine`, `spec.theme.mood`). */
export interface KnownGame {
  readonly goal: string;
  readonly mood: string;
}

export type MoodTone = 'calm' | 'warm' | 'dark' | 'danger';

const TONES: readonly (readonly [MoodTone, RegExp])[] = [
  ['danger', /tense|danger|chase|angry|fierce|panic|fire|storm|war|battle/i],
  ['dark', /dark|night|spooky|creepy|scary|eerie|haunt|gloom|mysterious/i],
  ['warm', /cheer|happy|sunny|bright|fun|playful|joy|warm|festive|silly/i],
];

/** Nálada je volný text modelu; tón je jedna ze čtyř barev plakátu a pruhu. */
export function moodTone(mood: string): MoodTone {
  return TONES.find(([, words]) => words.test(mood))?.[0] ?? 'calm';
}

export function Feed({
  games,
  current,
  known,
  onPick,
}: {
  readonly games: readonly FeedGame[];
  readonly current: string;
  readonly known: ReadonlyMap<string, KnownGame>;
  readonly onPick: (versionId: string) => void;
}) {
  return (
    <nav className="play-feed" aria-label="More games">
      <h2 className="play-starters-title">More games</h2>
      <ul className="play-feed-list">
        {games.map((game) => {
          const facts = known.get(game.versionId);
          return (
            <li key={game.versionId}>
              <button
                type="button"
                className="play-feed-card"
                data-testid="play-feed-card"
                data-tone={facts === undefined ? undefined : moodTone(facts.mood)}
                aria-current={game.versionId === current ? 'true' : undefined}
                onClick={() => onPick(game.versionId)}
              >
                <span className="play-feed-title">{game.title}</span>
                {facts !== undefined && <span className="play-feed-pitch">{facts.goal}</span>}
                {game.remixes > 0 && <span className="play-feed-remixes">{game.remixes === 1 ? '1 remix' : `${String(game.remixes)} remixes`}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
