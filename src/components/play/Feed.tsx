'use client';

/**
 * „Up next“ pod plochou feedu od `lg` (P54A T12; dřív celý seznam vedle hry,
 * P23-D T4, P27B T4): tři další karty jako náhledy – snímek scény z posledního
 * odchodu, jinak obrázek karty (`cardImage`) na podkladu v tónu nálady – s titulem,
 * „N% beat this“ (od deseti pokusů, P37C T5) a počtem remixů (jen když nějaký je);
 * klepnutí přepne hru ve feedu. Pod `lg` ho CSS schová – listuje se tahem a okrajem.
 *
 * Náladu nese detail hry, který feed stahuje pro aktuální hru a sousedy
 * (`known`); ostatní náhledy mají neutrální podklad.
 */

import { cardImage } from './feed/snapshot-cache';

/** Kolik dalších karet „Up next“ ukáže. */
const UP_NEXT = 3;

export interface FeedGame {
  readonly versionId: string;
  readonly title: string;
  readonly archetype: string;
  readonly remixes: number;
  /** „Clear rate“ (P37C T5): celé procento výher z pokusů; `null` pod deseti pokusy. */
  readonly beat?: number | null;
}

/** Řádek „clear rate“ na kartě, plakátu i výsledku (P37C T5). */
export function beatText(percent: number): string {
  return `${String(percent)}% beat this`;
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
  index,
  known,
  shot,
  onPick,
}: {
  readonly games: readonly FeedGame[];
  /** Pořadí aktivní karty; „Up next“ jsou karty za ní. */
  readonly index: number;
  readonly known: ReadonlyMap<string, KnownGame>;
  /** Snímek scény z posledního odchodu z karty (`snapshot-cache.ts`). */
  readonly shot: (versionId: string) => string | undefined;
  readonly onPick: (versionId: string) => void;
}) {
  const next = games.slice(index + 1, index + 1 + UP_NEXT);
  if (next.length === 0) return null;
  return (
    <nav className="play-feed" aria-label="Up next">
      <h2 className="play-starters-title">Up next</h2>
      <ul className="play-feed-list">
        {next.map((game) => {
          const facts = known.get(game.versionId);
          return (
            <li key={game.versionId}>
              <button
                type="button"
                className="play-feed-card"
                data-testid="play-feed-card"
                data-tone={facts === undefined ? undefined : moodTone(facts.mood)}
                onClick={() => onPick(game.versionId)}
              >
                <img className="play-feed-thumb" src={shot(game.versionId) ?? cardImage(game.versionId).landscape} alt="" loading="lazy" decoding="async" />
                <span className="play-feed-title">{game.title}</span>
                {typeof game.beat === 'number' && (
                  <span className="sp-label sp-muted play-feed-beat" data-testid="play-feed-beat">
                    {beatText(game.beat)}
                  </span>
                )}
                {game.remixes > 0 && <span className="play-feed-remixes">{game.remixes === 1 ? '1 remix' : `${String(game.remixes)} remixes`}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
