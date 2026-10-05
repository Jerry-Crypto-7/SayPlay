/**
 * Seed feedu (`scripts/p37c/seed-feed.mjs`, P37C T6): do úložiště píše jen
 * s `PLAY_SEED_STORE_PREFIX` – stažené produkční `KV_REST_API_*` samy nic
 * nezapíšou – a nejhlubší hru zapíše poslední (navrch seznamu).
 */

import { describe, expect, it, vi } from 'vitest';

import { BUILTIN_GAMES } from '@/play/version/builtin';

import { writeSeed } from '../p37c/seed-feed.mjs';

const KV = { KV_REST_API_URL: 'https://store.test', KV_REST_API_TOKEN: 'token' };
const games = BUILTIN_GAMES.slice(0, 3);

describe('seed feedu', () => {
  it('bez PLAY_SEED_STORE_PREFIX nezapíše nic, ani s proměnnými úložiště v prostředí', async () => {
    const makeStore = vi.fn();
    expect(await writeSeed(games, KV, makeStore)).toBeNull();
    expect(await writeSeed(games, { ...KV, PLAY_SEED_STORE_PREFIX: '  ' }, makeStore)).toBeNull();
    expect(makeStore).not.toHaveBeenCalled();
  });

  it('s předponou bez adresy úložiště skončí chybou, ne zápisem jinam', async () => {
    await expect(writeSeed(games, { PLAY_SEED_STORE_PREFIX: 'worldsmith:spend' }, vi.fn())).rejects.toThrow(/KV_REST_API_URL/);
  });

  it('s předponou zapíše každou hru přes feature, nejhlubší poslední', async () => {
    const written: string[] = [];
    const makeStore = vi.fn(() => ({
      feature: async (game: (typeof games)[number]) => {
        written.push(game.version.versionId);
        return written.length === 1 ? ('exists' as const) : ('stored' as const);
      },
    }));
    const outcomes = await writeSeed(games, { ...KV, PLAY_SEED_STORE_PREFIX: 'worldsmith:spend' }, makeStore);
    expect(makeStore).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://store.test', token: 'token', prefix: 'worldsmith:spend' }));
    expect(written).toEqual(games.map((game) => game.version.versionId).reverse());
    expect(outcomes).toEqual({ stored: 2, exists: 1, conflict: 0, quota: 0 });
  });
});
