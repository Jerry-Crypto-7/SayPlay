/**
 * Vestavěná sada her (P37C T6): feed nikdy prázdný. Commitnutá sada musí být
 * ověřená na dnešním jádře (robot vyhraje, nečinný hráč prohraje) a obal
 * úložiště ji musí ukázat, když úložiště nic nemá, a ustoupit uloženým hrám.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { preloadPhysics } from '@/play/arcade/compile';
import { replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { loadRapier } from '@/play/arcade/physics/world';
import { runBot } from '@/play/arcade/verify';

import { BUILTIN_GAMES, withBuiltinGames } from '../builtin';
import { __resetProcessVersionStore, memoryVersionStore, type VersionStore, VersionStoreUnavailable } from '../store';
import type { PublishedGame } from '../version';

const [first, second] = BUILTIN_GAMES as [PublishedGame, PublishedGame, ...PublishedGame[]];

/** Uložená autorská verze – jediná hra, kterou `put` zařadí do feedu. */
function authored(versionId: string, createdAt: string): PublishedGame {
  return { ...first, relation: 'upgrade', version: { ...first.version, versionId, title: `Stored ${versionId.slice(0, 4)}`, createdAt } };
}

describe('commitnutá vestavěná sada', () => {
  beforeAll(async () => {
    await Promise.all(BUILTIN_GAMES.map((game) => preloadPhysics(game.spec, loadRapier)));
  });

  it('má aspoň 24 her s různým id i titulkem a víc archetypů', () => {
    expect(BUILTIN_GAMES.length).toBeGreaterThanOrEqual(24);
    expect(new Set(BUILTIN_GAMES.map((game) => game.version.versionId)).size).toBe(BUILTIN_GAMES.length);
    expect(new Set(BUILTIN_GAMES.map((game) => game.version.title.toLowerCase())).size).toBe(BUILTIN_GAMES.length);
    expect(new Set(BUILTIN_GAMES.map((game) => game.spec.archetype)).size).toBeGreaterThanOrEqual(3);
  });

  it('každou hru robot vyhraje a nečinný hráč prohraje', () => {
    for (const game of BUILTIN_GAMES) {
      const world = game.arcade;
      if (world === undefined) throw new Error(`${game.version.title} has no arcade world`);
      expect(game.report.publishEligible, game.version.title).toBe(true);
      expect(runBot(world).outcome, game.version.title).toBe('won');
      expect(replay(world, [], ARCADE_LIBRARY).outcome, game.version.title).toBe('lost');
    }
  }, 60_000);
});

describe('úložiště s vestavěnou sadou', () => {
  // Paměť hlasů smyčky je procesní: bez vynulování by hlas z jednoho testu spolkl hlas dalšího.
  beforeEach(() => {
    __resetProcessVersionStore();
  });

  it('prázdné úložiště ukáže vestavěnou sadu a hru z ní otevře', async () => {
    const store = withBuiltinGames(memoryVersionStore());
    const rows = await store.recent(200);
    expect(rows.map((row) => row.versionId)).toEqual(BUILTIN_GAMES.map((game) => game.version.versionId));
    expect(rows[0]).toMatchObject({ title: first.version.title, archetype: first.spec.archetype, goal: first.spec.tutorial.goalLine, mood: first.spec.theme.mood, curated: true });
    expect(rows[0]).not.toHaveProperty('relation');
    expect(await store.get(first.version.versionId)).toEqual(first);
    expect(await store.lineageOf(first.version.versionId)).toEqual([first.version]);
    expect(await store.get('f'.repeat(32))).toBeNull();
    expect(await store.lineageOf('f'.repeat(32))).toEqual([]);
  });

  it('uložené hry jdou první, vestavěná sada je doplní do limitu bez opakování', async () => {
    const store = withBuiltinGames(memoryVersionStore());
    expect(await store.put(authored('a'.repeat(32), '2026-10-04T10:00:00.000Z'))).toBe('stored');
    const ids = (await store.recent(5)).map((row) => row.versionId);
    expect(ids).toEqual(['a'.repeat(32), ...BUILTIN_GAMES.slice(0, 4).map((game) => game.version.versionId)]);
    // Vestavěná hra, která se dostala do úložiště, se neukáže dvakrát.
    expect(await store.feature(second)).toBe('stored');
    const again = (await store.recent(200)).map((row) => row.versionId);
    expect(again.filter((id) => id === second.version.versionId)).toHaveLength(1);
    expect(again).toHaveLength(BUILTIN_GAMES.length + 1);
  });

  it('remixy jdou až za vestavěnou sadou: do limitu ji nevytlačí (nález revize T10-1 #2)', async () => {
    const store = withBuiltinGames(memoryVersionStore());
    const remix: PublishedGame = { ...authored('b'.repeat(32), '2026-10-05T10:00:00.000Z'), relation: 'remix' };
    expect(await store.put(remix)).toBe('stored');
    expect(await store.put(authored('a'.repeat(32), '2026-10-04T10:00:00.000Z'))).toBe('stored');
    const ids = (await store.recent(200)).map((row) => row.versionId);
    expect(ids).toEqual(['a'.repeat(32), ...BUILTIN_GAMES.map((game) => game.version.versionId), 'b'.repeat(32)]);
    expect((await store.recent(BUILTIN_GAMES.length + 1)).map((row) => row.versionId)).not.toContain('b'.repeat(32));
  });

  // Nález revize T6-1 #1: `put` skládá rodokmen z rodokmenu rodiče v úložišti.
  it('remix i autorská verze vestavěné hry dostanou celý rodokmen', async () => {
    const store = withBuiltinGames(memoryVersionStore());
    const remix: PublishedGame = { ...second, version: { ...second.version, versionId: 'd'.repeat(32), parentId: first.version.versionId } };
    expect(await store.put(remix)).toBe('stored');
    expect(await store.lineageOf(remix.version.versionId)).toEqual([first.version, remix.version]);
    expect(await store.childrenOf(first.version.versionId)).toEqual([remix.version.versionId]);
  });

  // Nález revize T6-1 #2: vestavěná hra nebere z denního stropu publikací návštěvníků.
  it('uložení vestavěných her denní strop publikací neubírá', async () => {
    const store = withBuiltinGames(memoryVersionStore({ ttlSeconds: 3600, dailyCap: 1 }));
    await store.countLoop(first.version.versionId, ['start'], 'voter-1');
    await store.countLoop(second.version.versionId, ['start'], 'voter-1');
    expect(await store.canPublish()).toBe(true);
    const heat = await store.loopHeat([first.version.versionId, second.version.versionId]);
    expect([heat.get(first.version.versionId)?.starts, heat.get(second.version.versionId)?.starts]).toEqual([1, 1]);
  });

  it('čítače smyčky se vestavěné hře počítají jako uložené', async () => {
    const inner = memoryVersionStore();
    const store = withBuiltinGames(inner);
    await store.countLoop(first.version.versionId, ['start', 'finish'], 'voter-1');
    const heat = await store.loopHeat([first.version.versionId]);
    expect(heat.get(first.version.versionId)).toMatchObject({ starts: 1, finishes: 1 });
    expect(await inner.get(first.version.versionId)).not.toBeNull();
  });

  // R4 (a), nález revize T6-2 #1: výpadek při ukládání rodiče se nesmí spolknout.
  it('výpadek úložiště u rodiče: remix vestavěné hry selže celý, ne s useknutým rodokmenem', async () => {
    const inner = memoryVersionStore();
    let failures = 1;
    const flaky: VersionStore = { ...inner, put: (game) => (failures-- > 0 ? Promise.reject(new VersionStoreUnavailable(new Error('down'))) : inner.put(game)) };
    const store = withBuiltinGames(flaky);
    const remix: PublishedGame = { ...second, version: { ...second.version, versionId: 'e'.repeat(32), parentId: first.version.versionId } };
    await expect(store.put(remix)).rejects.toBeInstanceOf(VersionStoreUnavailable);
    expect(await inner.get(remix.version.versionId)).toBeNull();
    expect(await store.put(remix)).toBe('stored');
    expect(await store.lineageOf(remix.version.versionId)).toEqual([first.version, remix.version]);
  });

  // R4 (b), nález revize T6-2 #2: hra v úložišti vyprší a obal o tom musí vědět.
  it('vestavěná hra, která v úložišti vypršela, se při další události uloží znovu a čítač se započte', async () => {
    let now = Date.parse('2026-10-04T10:00:00Z');
    const inner = memoryVersionStore({ ttlSeconds: 60, dailyCap: 500 }, () => now);
    const store = withBuiltinGames(inner);
    await store.countLoop(first.version.versionId, ['start'], 'voter-r4-1');
    now += 61_000;
    expect(await inner.get(first.version.versionId)).toBeNull();
    await store.countLoop(first.version.versionId, ['start'], 'voter-r4-2');
    expect(await inner.get(first.version.versionId)).not.toBeNull();
    // Starý čítač vypršel s hrou (TTL od prvního zvýšení jako v Upstash, P40 T3b); nová událost se započte.
    expect((await store.loopHeat([first.version.versionId])).get(first.version.versionId)?.starts).toBe(1);
  });
});
