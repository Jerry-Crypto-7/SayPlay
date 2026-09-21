'use client';

/**
 * Feed na `/play` (P23-D T4): mřížka posledních her z `GET /api/play/games?recent=24`.
 * Karta nese titul, jednu větu archetypu, počet remixů a odkaz na hru.
 * Dokud dotaz neodpoví, nevykreslí se nic; prázdný feed řekne, že her zatím
 * není – žádné vymyšlené karty. Výpadek dveří feed tiše schová, `/play` je
 * pořád formulář.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';

interface FeedGame {
  readonly versionId: string;
  readonly title: string;
  readonly archetype: string;
  readonly remixes: number;
}

const FEED_URL = '/api/play/games?recent=24';

/**
 * `pitches` – věta archetypu podle id. Počítá je serverová stránka: registr
 * táhne zod a do klientského bundlu nepatří (stejně jako u `lab.ts`).
 */
export function Feed({ pitches }: { readonly pitches: Readonly<Record<string, string>> }) {
  const pitchOf = (archetype: string): string => (Object.hasOwn(pitches, archetype) ? pitches[archetype] : '');
  const [games, setGames] = useState<readonly FeedGame[] | null>(null);

  useEffect(() => {
    const control = new AbortController();
    void (async () => {
      try {
        const response = await fetch(FEED_URL, { signal: control.signal, cache: 'no-store' });
        if (!response.ok) return;
        const body = (await response.json()) as { games?: FeedGame[] };
        if (Array.isArray(body.games)) setGames(body.games);
      } catch {
        // Přerušený nebo neúspěšný dotaz: feed se neukáže.
      }
    })();
    return () => control.abort();
  }, []);

  if (games === null) return null;
  return (
    <section className="play-feed" aria-label="Recent games">
      <h2 className="play-starters-title">Recent games</h2>
      {games.length === 0 ? (
        <p className="play-feed-empty" data-testid="play-feed-empty">No games yet – write the first sentence.</p>
      ) : (
        <ul className="play-feed-grid">
          {games.map((game) => (
            <li key={game.versionId}>
              <Link className="play-feed-card" data-testid="play-feed-card" href={`/play/${game.versionId}`}>
                <span className="play-feed-title">{game.title}</span>
                <span className="play-feed-pitch">{pitchOf(game.archetype)}</span>
                <span className="play-feed-remixes">{game.remixes === 1 ? '1 remix' : `${String(game.remixes)} remixes`}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
