/**
 * Duch nejlepšího běhu z props stránky (P50 T6): první načtení ducha se na
 * detail hry `GET /api/play/games/:id` neptá – id výzvy poslala stránka v HTML –,
 * každé další ano. Id z HTML je staré jako stránka; kdyby se už nikdy neobnovilo,
 * duch by dál hrál starý rekord a vypadalo by to správně, dokud ho někdo nepřekoná.
 */

import { describe, expect, it } from 'vitest';

import type { ArcadeWorld } from '@/play/arcade/contract';

import { bestOnce, loadGhost } from '../GhostSlot';

const GAME = 'a'.repeat(32);
const DETAIL = `/api/play/games/${GAME}`;
/** Výzvy odpovídají 404, takže `fetchGhost` svět nikdy nepřehraje. */
const WORLD = {} as ArcadeWorld;

/** Úložiště, kde je nejlepší běh `stored`; zapisuje každou adresu, na kterou se duch zeptal. */
function store(stored: string | null) {
  const asked: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    if (url === DETAIL) return Response.json({ bestDare: stored === null ? null : { dareId: stored, score: 1, ticks: 1 } });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { asked, fetcher };
}

describe('ghost slot – best dare sent with the page (P50 T6)', () => {
  it('loads the dare the page sent without asking for the game detail', async () => {
    const { asked, fetcher } = store('newer');
    await loadGhost(GAME, null, WORLD, fetcher, 'from-page');
    expect(asked).toEqual([`${DETAIL}/dare/from-page`]);
  });

  it('asks nothing when the page knows the game has no best run', async () => {
    const { asked, fetcher } = store('newer');
    expect(await loadGhost(GAME, null, WORLD, fetcher, null)).toBeNull();
    expect(asked).toEqual([]);
  });

  it('asks the game detail when nobody sent the best run (feed, grid)', async () => {
    const { asked, fetcher } = store('newer');
    await loadGhost(GAME, null, WORLD, fetcher, undefined);
    expect(asked).toEqual([DETAIL, `${DETAIL}/dare/newer`]);
  });

  it('hands the page id out once; the next load asks the store for a fresh best', async () => {
    const next = bestOnce('old');
    const { asked, fetcher } = store('newer');
    await loadGhost(GAME, null, WORLD, fetcher, next());
    await loadGhost(GAME, null, WORLD, fetcher, next());
    expect(asked).toEqual([`${DETAIL}/dare/old`, DETAIL, `${DETAIL}/dare/newer`]);
  });

  it('a page that knew of no best run still asks on the next load', async () => {
    const next = bestOnce(null);
    const { asked, fetcher } = store('newer');
    await loadGhost(GAME, null, WORLD, fetcher, next());
    expect(asked).toEqual([]);
    await loadGhost(GAME, null, WORLD, fetcher, next());
    expect(asked).toEqual([DETAIL, `${DETAIL}/dare/newer`]);
  });

  it('a friend dare without a run does not reload the same dare as the best', async () => {
    const { asked, fetcher } = store('friend');
    expect(await loadGhost(GAME, 'friend', WORLD, fetcher, 'friend')).toBeNull();
    expect(asked).toEqual([`${DETAIL}/dare/friend`]);
  });
});
