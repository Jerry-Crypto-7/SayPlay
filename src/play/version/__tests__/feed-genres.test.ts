/**
 * Vestavěný feed podle žánrů (P70C T4, majitel 4. 11.: „feed tam je jen jeden druh her“). Kurátorská sada má
 * `PER_GENRE` her na každý hratelný žánr registru a nejvýš čtyři staré hry „choď a sbírej“; první stránka
 * feedu s prázdným úložištěm ukáže hodně žánrů a žádná osmice nemá víc než dvě hry jednoho žánru.
 * Pořadí karet na první pohled vypadá dobře i tehdy, když je špatně – proto test.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { preloadPhysics } from '@/play/arcade/compile';
import { loadRapier } from '@/play/arcade/physics/world';

import { FEED_SENTENCES, OLD_WALK_IN_FEED, PER_GENRE, playableGenres, previewMotion } from '../../../../scripts/p37c/seed-feed.mjs';
import { BUILTIN_GAMES, FEED_GAMES, withBuiltinGames } from '../builtin';
import feedBuiltin from '../builtin-feed-games.json';
import frozenBuiltin from '../builtin-games.json';
import { FEED_BLOCK, feedKindOf, MAX_PER_GENRE } from '../diversify';
import { decodeCursor, feedPage } from '../feed';
import { memoryVersionStore, RECENT_CAP, type RecentGame } from '../store';

const genreOf = new Map<string, string>(FEED_SENTENCES.map((entry) => [entry.sentence, entry.genre]));
const builtIds = new Set((feedBuiltin as { version: { versionId: string } }[]).map((game) => game.version.versionId));
const frozenIds = new Set((frozenBuiltin as { version: { versionId: string } }[]).map((game) => game.version.versionId));
const byId = new Map(BUILTIN_GAMES.map((game) => [game.version.versionId, game]));

/** Žánr karty: u hry feedu žánr její věty (rychlá cesta ho při stavbě ověřila), u staré hry její druh. */
function genreOfRow(row: RecentGame): string {
  const game = byId.get(row.versionId);
  if (game === undefined) throw new Error(`${row.title} is not a built-in game`);
  return genreOf.get(game.origin?.sentence ?? '') ?? feedKindOf(game.spec);
}

/** Celý feed prázdného úložiště po stránkách, jak ho listuje `/play` (24 karet na stránku). */
async function emptyStoreFeed(): Promise<RecentGame[]> {
  const rows = await withBuiltinGames(memoryVersionStore()).recent(RECENT_CAP);
  const out: RecentGame[] = [];
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const result = feedPage(rows, 24, cursor, new Set());
    out.push(...result.games);
    if (result.next === null) return out;
    cursor = decodeCursor(result.next);
  }
  throw new Error('feed never ended');
}

describe('vestavěný feed podle žánrů (P70C T4)', () => {
  beforeAll(async () => {
    await Promise.all(FEED_GAMES.map((game) => preloadPhysics(game.spec, loadRapier)));
  });

  it('má PER_GENRE her na každý hratelný žánr registru, každou z věty feedu toho žánru', () => {
    expect(PER_GENRE).toBe(2);
    const built = FEED_GAMES.filter((game) => builtIds.has(game.version.versionId));
    const count = new Map<string, number>();
    for (const game of built) {
      const genre = genreOf.get(game.origin?.sentence ?? '');
      expect(genre, game.version.title).toBeDefined();
      // Hra se žánrem ve specu ho má stejný jako věta; nativní sestava (plachtění, řízení, chodec) žánr nepíše.
      if (game.spec.genre !== undefined) expect(game.spec.genre.id, game.version.title).toBe(genre);
      count.set(genre as string, (count.get(genre as string) ?? 0) + 1);
    }
    const playable = playableGenres();
    expect(playable.length).toBeGreaterThanOrEqual(12);
    expect(Object.fromEntries(playable.map((genre) => [genre, count.get(genre) ?? 0]))).toEqual(Object.fromEntries(playable.map((genre) => [genre, PER_GENRE])));
    // Věta žánru, který registr nehraje (brána aktivace), by do feedu nepřistála.
    expect([...count.keys()].filter((genre) => !playable.includes(genre as never))).toEqual([]);
  });

  it('v náhledu robota každé hry feedu se něco hýbe – karta nehraje stojící obraz', () => {
    for (const game of FEED_GAMES) {
      if (game.arcade === undefined || game.preview === undefined) throw new Error(`${game.version.title} has no arcade world or preview`);
      expect(previewMotion(game.arcade, game.preview), game.version.title).toBeGreaterThan(0);
    }
  }, 120_000);

  it('ukáže nejvýš čtyři staré hry „choď a sbírej“; ostatní zmrazené hry feed neukáže, odkaz na ně platí', async () => {
    const old = FEED_GAMES.filter((game) => !builtIds.has(game.version.versionId));
    expect(OLD_WALK_IN_FEED).toBeLessThanOrEqual(4);
    expect(old.length).toBeLessThanOrEqual(OLD_WALK_IN_FEED);
    for (const game of old) {
      expect(frozenIds.has(game.version.versionId), game.version.title).toBe(true);
      expect(game.spec.control, game.version.title).toBe('move_free');
    }
    const store = withBuiltinGames(memoryVersionStore());
    const listed = new Set((await store.recent(RECENT_CAP)).map((row) => row.versionId));
    const hidden = BUILTIN_GAMES.filter((game) => !listed.has(game.version.versionId));
    expect(hidden.length).toBe(BUILTIN_GAMES.length - FEED_GAMES.length);
    for (const game of hidden) expect((await store.get(game.version.versionId))?.version.versionId).toBe(game.version.versionId);
  });

  it('první stránka s prázdným úložištěm: ≥ 6 žánrů v prvních 8, ≥ 12 v prvních 24, v každé osmici nejvýš dva stejné', async () => {
    const feed = await emptyStoreFeed();
    expect(feed.map((row) => row.versionId).sort()).toEqual(FEED_GAMES.map((game) => game.version.versionId).sort());
    const genres = feed.map(genreOfRow);
    expect(new Set(genres.slice(0, 8)).size).toBeGreaterThanOrEqual(6);
    expect(new Set(genres.slice(0, 24)).size).toBeGreaterThanOrEqual(12);
    for (let start = 0; start < feed.length; start += FEED_BLOCK) {
      const counts = new Map<string, number>();
      for (const genre of genres.slice(start, start + FEED_BLOCK)) counts.set(genre, (counts.get(genre) ?? 0) + 1);
      expect(Math.max(...counts.values()), `cards ${String(start)}–${String(start + FEED_BLOCK - 1)}: ${genres.slice(start, start + FEED_BLOCK).join(', ')}`).toBeLessThanOrEqual(MAX_PER_GENRE);
    }
  });
});
