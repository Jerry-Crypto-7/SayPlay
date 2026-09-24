/**
 * Jednorázové prodloužení expirace (`scripts/play-extend-ttl.mjs`): hra uložená
 * se starým 60denním TTL dostane `createdAt + 180 dní` na všech třech klíčích;
 * bez `--apply` se nic nezapíše; cizí předpona zůstane netknutá.
 */

import { describe, expect, it } from 'vitest';

import { extendPlayTtl } from '../play-extend-ttl.mjs';

const DAY = 24 * 3600;

function fakeStore(kv: Map<string, string>, expireAt: Map<string, number>): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const parts = JSON.parse(String(init?.body)) as string[];
    let result: unknown = null;
    if (parts[0] === 'SCAN') {
      const pattern = parts[3].replace(/\*$/, '');
      const keys = [...kv.keys()].filter((key) => key.startsWith(pattern));
      // Dvě dávky, aby skript musel pokračovat kurzorem.
      result = parts[1] === '0' ? ['7', keys.slice(0, 1)] : ['0', keys.slice(1)];
    } else if (parts[0] === 'GET') result = kv.get(parts[1]) ?? null;
    else if (parts[0] === 'EXPIREAT') expireAt.set(parts[1], Number(parts[2]));
    return new Response(JSON.stringify({ result }));
  }) as typeof fetch;
}

const game = (createdAt: string): string => JSON.stringify({ version: { createdAt } });

describe('extendPlayTtl', () => {
  const published = Date.UTC(2026, 8, 20) / 1000;
  const now = Date.UTC(2026, 8, 24);

  function seeded(): Map<string, string> {
    return new Map([
      ['p:play:v:aaaaaaaa', game(new Date(published * 1000).toISOString())],
      ['p:play:v:bbbbbbbb', game('2026-01-01T00:00:00.000Z')],
      ['p:play:v:cccccccc', 'not json'],
      ['other:play:v:dddddddd', game(new Date(published * 1000).toISOString())],
    ]);
  }

  it('sets createdAt + ttl on the game, lineage and children keys', async () => {
    const expireAt = new Map<string, number>();
    const report = await extendPlayTtl({ url: 'https://x', token: 't', prefix: 'p', ttlSeconds: 180 * DAY, apply: true, now }, fakeStore(seeded(), expireAt));
    expect(report).toEqual({ games: 3, extended: 1, expired: 1, unreadable: 1 });
    const at = published + 180 * DAY;
    // Seznam feedu (`play:recent`) obnovuje jen publikace – bez prodloužení by feed k 25. 11. zmizel celý.
    expect(Object.fromEntries(expireAt)).toEqual({ 'p:play:v:aaaaaaaa': at, 'p:play:lineage:aaaaaaaa': at, 'p:play:children:aaaaaaaa': at, 'p:play:recent': at });
    // 20. 9. + 180 dní je po vyhlášení 25. 11. 2026.
    expect(at * 1000).toBeGreaterThan(Date.UTC(2026, 10, 25));
  });

  it('writes nothing without --apply', async () => {
    const expireAt = new Map<string, number>();
    const report = await extendPlayTtl({ url: 'https://x', token: 't', prefix: 'p', ttlSeconds: 180 * DAY, apply: false, now }, fakeStore(seeded(), expireAt));
    expect(report.extended).toBe(1);
    expect(expireAt.size).toBe(0);
  });
});
