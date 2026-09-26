/**
 * Věta uprostřed hry (P29D T8): 40 ručně psaných vět → živá změna, poctivý
 * remix, nebo „nerozumím“. Špatně zařazená věta by vypadala jako funkční
 * odpověď – proto tabulka, ne pár ukázek.
 */

import { describe, expect, it } from 'vitest';

import runnerFixture from '@/play/arcade/__fixtures__/runner.json';
import arenaFixture from '@/play/arcade/__fixtures__/arena.json';
import duelFixture from '@/play/arcade/__fixtures__/duel.json';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { hostileRole, patchProblem, startLive } from '@/play/arcade/live';
import { REMIX_MESSAGE, UNKNOWN_MESSAGE, liveIntentOf, resolveWish } from '@/play/director/live-intent';
import { type GameSpecV1, readGameSpec } from '@/play/spec';

import table from '../director/__fixtures__/live-intent.json';

function specOf(fixture: unknown): GameSpecV1 {
  const spec = readGameSpec(fixture);
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  return spec.value;
}

const runner = specOf(runnerFixture);

describe('a mid-game sentence', () => {
  it('the table has 40 sentences across all three outcomes', () => {
    expect(table.cases).toHaveLength(40);
    expect(new Set(table.cases.map((c) => c.kind))).toEqual(new Set(['live', 'needsRemix', 'unknown']));
  });

  for (const row of table.cases) {
    it(`“${row.sentence}” → ${row.kind}`, () => {
      const intent = liveIntentOf(row.sentence, runner);
      expect(intent.kind).toBe(row.kind);
      if (intent.kind === 'live') expect(intent.wishes).toEqual(row.wishes);
      if (intent.kind === 'needsRemix') expect(intent.message).toBe(REMIX_MESSAGE);
      if (intent.kind === 'unknown') expect(intent.message).toBe(UNKNOWN_MESSAGE);
    });
  }

  it('the remix keeps the class the remix route would give it', () => {
    const intent = liveIntentOf('turn it into a maze', runner);
    expect(intent).toMatchObject({ kind: 'needsRemix', remixClass: 'topology' });
  });
});

describe('a wish on a running game', () => {
  const worldOf = (fixture: unknown) => {
    const built = arcadeWorldOf(specOf(fixture), 1);
    if (!built.ok) throw new Error(built.issues.join('; '));
    return built.world;
  };

  it('“more enemies” becomes the game’s own threat, whatever its role is', () => {
    const roles = new Set<string>();
    for (const fixture of [runnerFixture, arenaFixture, duelFixture]) {
      const world = worldOf(fixture);
      const state = startLive(world).state;
      const role = hostileRole(state);
      if (role === null) continue;
      roles.add(role);
      const patch = resolveWish({ kind: 'spawn', target: 'hostile', count: 3 }, state);
      expect(patch).toEqual({ kind: 'spawn', role, count: 3 });
      // Role, kterou hra nemá, by běh odmítl – přání by vypadalo splněné a nic by nepřibylo.
      expect(patchProblem(world, state, patch!)).toBeNull();
    }
    // Aspoň dvě různé hrozby, jinak konstanta projde stejně jako čtení stavu.
    expect(roles.size).toBeGreaterThanOrEqual(2);
  });

  it('“more coins” adds coins where the game has them, and is null where it has none', () => {
    const coins = { kind: 'spawn', target: 'collectible', count: 3 } as const;
    expect(resolveWish(coins, startLive(worldOf(runnerFixture)).state)).toEqual({ kind: 'spawn', role: 'collectible', count: 3 });
    expect(resolveWish(coins, startLive(worldOf(duelFixture)).state)).toBeNull();
  });

  it('counters and visuals pass through unchanged', () => {
    const state = startLive(worldOf(arenaFixture)).state;
    expect(resolveWish({ kind: 'visual', weather: 'rain' }, state)).toEqual({ kind: 'visual', weather: 'rain' });
    expect(resolveWish({ kind: 'count', counter: 'time', amount: 10 }, state)).toEqual({ kind: 'count', counter: 'time', amount: 10 });
  });
});
