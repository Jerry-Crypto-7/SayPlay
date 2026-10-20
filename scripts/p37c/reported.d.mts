/** Typy k `reported.mjs` – skript jede holým Nodem, testy jsou TypeScript. */

import type { VersionStore } from '../../src/play/version/store';

export declare function reportedRows(store: Pick<VersionStore, 'reportedGames' | 'get'>): Promise<{ versionId: string; votes: number; title: string | null }[]>;
export declare function storeFrom(argv: readonly string[], env: Record<string, string | undefined>): { store: VersionStore; where: string };
