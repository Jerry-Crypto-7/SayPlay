/** Typy k `seed-feed.mjs` – skript jede holým Nodem, testy jsou TypeScript. */

import type { PutOutcome, VersionStore } from '../../src/play/version/store';
import type { PublishedGame } from '../../src/play/version/version';

export declare const BUILTIN_COUNT: number;
export declare function feedSeeds(sentence: string): number[];
export declare function seedSentences(): string[];
export declare function depthOf(game: PublishedGame): number;
export declare function buildGame(sentence: string, createdAt: number): Promise<{ ok: true; game: PublishedGame } | { ok: false; why: string }>;
export declare function seedGames(sentences: readonly string[], epoch: number): Promise<{ games: PublishedGame[]; failed: { sentence: string; why: string }[] }>;
export declare function writeSeed(
  games: readonly PublishedGame[],
  env: Record<string, string | undefined>,
  makeStore?: (config: { url: string; token: string; prefix: string; timeoutMs: number }) => Pick<VersionStore, 'feature'>,
): Promise<Record<PutOutcome, number> | null>;
export declare function builtinFile(games: readonly PublishedGame[]): string;
