/**
 * Poctivá hláška u uložené hry (P25E R1, R2): `/play/[id]` ji počítá přes
 * `honestyOf` a musí dojít k téže větě jako odpověď dveří – i u hry, kterou
 * publikoval rovnou režisér, i u autorské verze, která větu má jen u rodiče.
 * Návrh ze slov je podvržený rozbitým specem, aby věta šla cestou režiséra.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import switchPuzzle from '@/play/__fixtures__/switch_puzzle.json';
import { honestyOf } from '@/play/draft/unsupported';
import { readGameSpec } from '@/play/spec';
import { __resetProcessVersionStore, fileVersionStore, versionStoreFromEnv } from '@/play/version';
import { resetRateWindows } from '@/server/rate-limit';

import { derivedSeeds, publishReadSpec, seedFrom } from '../_publish';

const MATCH3 = 'a match 3 game with fruits';

function puzzle(required: readonly string[]) {
  const spec = structuredClone(switchPuzzle) as { mechanics: { id: string; params: Record<string, unknown> }[] };
  spec.mechanics.find((mechanic) => mechanic.id === 'switch')!.params.required = [...required];
  const read = readGameSpec(spec);
  if (!read.ok) throw new Error('fixture');
  return read.value;
}

// Tři spínače, keypoint neprojde → návrh je 422 a věta čeká na režiséra.
// Route staví draft přes `draftGameSpecWithMeta` (P29B T5), režisér taky – podvrhují se obě.
vi.mock('@/play/draft', async (original) => ({
  ...(await original<object>()),
  draftGameSpec: () => puzzle(['red', 'blue', 'green']),
  draftGameSpecWithMeta: () => ({ spec: puzzle(['red', 'blue', 'green']) }),
}));
vi.mock('../_director', () => ({
  getDirector: () => async () => ({ ok: true, spec: puzzle(['red', 'blue']), source: 'authored', repairRounds: 0, fallbackReason: null, warnings: [], ms: 1, calls: 1 }),
}));

const { POST: createGame } = await import('../games/route');
const { GET: readUpgrade } = await import('../games/[id]/upgrade/route');

beforeEach(() => {
  __resetProcessVersionStore();
  resetRateWindows();
});

describe('honestyOf – uložená hra', () => {
  it('POST, repeated POST and a file-store restart retain the final game action admission', async () => {
    const sentence = 'game in a car with shooting and racing';
    const request = () => new Request('http://play.test/api/play/games', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.11' },
      body: JSON.stringify({ sentence, seed: 7 }),
    });
    const first = await createGame(request());
    expect(first.status).toBe(201);
    const initial = await first.json() as { versionId: string; honesty: { reason: string; closest: string; unmet: unknown[] } };
    expect(initial.honesty.unmet).toEqual([
      { actor: 'car', verb: 'drive', object: null },
      { actor: 'car', verb: 'shoot', object: null },
      { actor: 'car', verb: 'race', object: null },
    ]);

    const repeated = await createGame(request());
    expect(repeated.status).toBe(200);
    const again = await repeated.json() as typeof initial;
    expect(again.versionId).toBe(initial.versionId);
    expect(again.honesty).toEqual(initial.honesty);

    const versions = versionStoreFromEnv(process.env);
    const game = await versions.get(initial.versionId);
    expect(game).not.toBeNull();
    expect(await honestyOf(versions, game!)).toMatchObject(initial.honesty);
    const dir = mkdtempSync(join(tmpdir(), 'p41-honesty-store-'));
    try {
      expect(await fileVersionStore(dir).put(game!)).toBe('stored');
      __resetProcessVersionStore();
      const restarted = fileVersionStore(dir);
      const restored = await restarted.get(initial.versionId);
      expect(restored).not.toBeNull();
      expect(restored!.version.seed).toBe(game!.version.seed);
      expect(await honestyOf(restarted, restored!)).toMatchObject(initial.honesty);
    } finally {
      // Only the exact temporary directory created by this test may be removed.
      expect(dirname(resolve(dir))).toBe(resolve(tmpdir()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hra od režiséra bez návrhu nese větu a hlášku ukáže, upgrade ne', async () => {
    const response = await createGame(
      new Request('http://play.test/api/play/games', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
        body: JSON.stringify({ sentence: MATCH3 }),
      }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { versionId: string; honesty?: unknown; upgrade?: unknown };
    expect(body.upgrade).toBeUndefined();
    expect(body.honesty).toEqual({
      kind: 'manipulate',
      reason: 'Swapping, sorting and sliding pieces around is not something we can build yet.',
      closest: 'a switch puzzle',
    });

    const versions = versionStoreFromEnv(process.env);
    const game = (await versions.get(body.versionId))!;
    expect(game.origin).toBeUndefined();
    expect(await honestyOf(versions, game)).toMatchObject(body.honesty as object);
    // Uložená věta upgrade nezapne – režisér by jinak tutéž hru platil podruhé.
    const upgrade = await readUpgrade(new Request(`http://play.test/api/play/games/${body.versionId}/upgrade`, { headers: { 'x-forwarded-for': '203.0.113.9' } }), {
      params: Promise.resolve({ id: body.versionId }),
    });
    expect(await upgrade.json()).toEqual({ status: 'draft-final', reason: 'NOT_FROM_SENTENCE' });
  });

  it('autorská verze vezme větu od rodiče', async () => {
    const versions = versionStoreFromEnv(process.env);
    const draftSpec = puzzle(['red', 'blue']);
    const draft = await publishReadSpec(versions, draftSpec, derivedSeeds(seedFrom(draftSpec)), null, { origin: { sentence: MATCH3, seed: null } });
    if (!draft.ok) throw new Error('draft');
    const childSpec = { ...draftSpec, title: 'Not Green Upgraded' };
    const child = await publishReadSpec(versions, childSpec, derivedSeeds(seedFrom(childSpec)), draft.value.game.version.versionId, { relation: 'upgrade' });
    if (!child.ok) throw new Error('child');

    expect(child.value.game.origin).toBeUndefined();
    expect(await honestyOf(versions, child.value.game)).toMatchObject({ kind: 'manipulate', closest: 'a switch puzzle' });
  });
});
