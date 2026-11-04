/** Typy k `seed-feed.mjs` – skript jede holým Nodem, testy jsou TypeScript. */

import type { ArcadeWorld } from '../../src/play/arcade/contract';
import type { GenreId } from '../../src/play/genre/contract';
import type { PutOutcome, VersionStore } from '../../src/play/version/store';
import type { FeedPreview, PublishedGame } from '../../src/play/version/version';

export declare const PER_GENRE: number;
export declare const OLD_WALK_IN_FEED: number;
export declare function oldWalkInFeed(frozen: readonly PublishedGame[]): PublishedGame[];
export declare const FEED_SENTENCES: readonly { readonly genre: GenreId; readonly sentence: string }[];
export declare function playableGenres(): GenreId[];
export declare function previewMotion(world: ArcadeWorld, preview: FeedPreview): number;
export declare function feedGaps(games: readonly PublishedGame[]): { genre: GenreId; games: number }[];
export declare function feedSeeds(sentence: string): number[];
export declare function seedSentences(): string[];
export declare function depthOf(game: PublishedGame): number;
export declare function buildGame(sentence: string, createdAt: number, genre?: GenreId): Promise<{ ok: true; game: PublishedGame } | { ok: false; why: string }>;
export declare function seedGames(sentences: readonly string[], epoch: number, genres?: ReadonlyMap<string, GenreId>): Promise<{ games: PublishedGame[]; failed: { sentence: string; why: string }[] }>;
export declare function writeSeed(
  games: readonly PublishedGame[],
  env: Record<string, string | undefined>,
  makeStore?: (config: { url: string; token: string; prefix: string; timeoutMs: number }) => Pick<VersionStore, 'feature'>,
): Promise<Record<PutOutcome, number> | null>;
export declare function builtinFile(games: readonly PublishedGame[]): string;
