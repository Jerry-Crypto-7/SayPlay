/**
 * Publikace řetězu mikroher (P56C T10) přes `POST /api/play/games`: věta, kterou `chainOrSingle` pošle do řetězu,
 * dostane hru s `chain` (bez `arcade`, kontrakt v `.claude/debate/2026-10-21-p56c-chain-contract.md`), věta s jedním
 * jasným slovesem tutéž hru jako před P56C. Řetěz, který neprojde `verifyChain`, se neuloží; AI verze ani remix
 * se pro řetěz nespustí.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadRapier } from '@/play/arcade/physics/world';
import type { ChainWorld } from '@/play/chain/contract';
import { chainReasons } from '@/play/chain/decide';
import { MICRO } from '@/play/chain/micro';
import { readForChain } from '@/play/chain/read';
import { verifyChain } from '@/play/chain/verify';
import { draftGameSpecWithMeta } from '@/play/draft';
import { classifyGenre } from '@/play/genre/classify';
import { __resetProcessVersionStore, memoryVersionStore, type PublishedGame, sealChainVersion, versionStoreFromEnv } from '@/play/version';
import { previewOf } from '@/play/version/preview';
import { resetRateWindows } from '@/server/rate-limit';

import { derivedSeeds, publishChain, publishReadSpec, seedFrom } from '../_publish';
import { POST as createGame } from '../games/route';
import { GET as readGame } from '../games/[id]/route';
import { POST as remix } from '../games/[id]/remix/route';
import { GET as upgrade } from '../games/[id]/upgrade/route';
import { freshCaller, params, post } from './dare-fixtures';

/** Dev P56C d04 (`multi_verb`): skákání a střelba. */
const MULTI = 'can u make one where a robot hops over lava cracks and shoots bubbles at grumpy clouds';
/** Dev P56C d14 (`single_verb`): bubnování do rytmu. */
const SINGLE = 'bang on the pots and pans exactly when the chef taps the beat';

async function publish(sentence: string): Promise<{ status: number; body: Record<string, unknown>; game: PublishedGame }> {
  const created = await createGame(post('/api/play/games', { sentence }, freshCaller()));
  const body = (await created.json()) as Record<string, unknown>;
  const read = await readGame(new Request(`http://play.test/api/play/games/${String(body.versionId)}`, { headers: freshCaller() }), params(String(body.versionId)));
  return { status: created.status, body, game: (await read.json()) as PublishedGame };
}

beforeEach(() => {
  __resetProcessVersionStore();
  resetRateWindows();
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetProcessVersionStore();
});

describe('POST /api/play/games publishes a chain of microgames (P56C T10)', () => {
  it('the multi-verb sentence is routed to a chain', () => {
    expect(chainReasons(MULTI, readForChain(MULTI, null), classifyGenre(MULTI, null))).toContain('multi_verb');
    expect(chainReasons(SINGLE, readForChain(SINGLE, null), classifyGenre(SINGLE, null))).toEqual([]);
  });

  it('a multi-verb sentence gets a verified chain of 3–5 rounds with different controls and no AI version', async () => {
    const { status, body, game } = await publish(MULTI);
    expect(status).toBe(201);
    // P58E T2: řetěz nese `upgrade` – dotaz skončí `CHAIN`, s hrou ze čtení, když vznikla.
    expect(body.upgrade).toBe(`/api/play/games/${String(body.versionId)}/upgrade`);
    const chain = game.chain as ChainWorld;
    expect(chain.rounds.length).toBeGreaterThanOrEqual(3);
    expect(chain.rounds.length).toBeLessThanOrEqual(5);
    expect(chain.rounds.every((round) => MICRO.some((entry) => entry.key === round.key && entry.control === round.spec.control))).toBe(true);
    expect(new Set(chain.rounds.map((round) => round.spec.control)).size).toBeGreaterThanOrEqual(3);
    // Zapomenutá cesta jedné hry má selhat viditelně, ne tiše hrát kolo 1 (debata T9).
    expect(game).not.toHaveProperty('arcade');
    expect(game.blueprint).toBeNull();
    expect(game.version.runtimeVersion).toBe('chain-v1');
    expect(game.version.seed).toBe(chain.seed);
    expect(game.spec).toEqual(chain.rounds[0]!.spec);
    expect(game.origin).toEqual({ sentence: MULTI, seed: null });

    // JSON z úložiště projde touž bránou a dá týž par a náhled kola 1.
    const verdict = verifyChain(chain);
    expect(verdict.failures).toEqual([]);
    expect(game.report.publishEligible).toBe(true);
    expect(game.report.par).toEqual(verdict.par);
    expect(game.preview).toEqual(previewOf(chain.rounds[0]!.world, verdict.rounds[0]!.bot));

    // Táž věta podruhé je táž hra.
    const again = await createGame(post('/api/play/games', { sentence: MULTI }, freshCaller()));
    expect(again.status).toBe(200);
    expect(((await again.json()) as { versionId: string }).versionId).toBe(body.versionId);
  });

  it('the version id covers the whole chain: same first round and seed, another boss → another id', async () => {
    const { game } = await publish(MULTI);
    const chain = game.chain as ChainWorld;
    const now = () => 0;
    expect(sealChainVersion(chain, null, now).versionId).toBe(game.version.versionId);
    const otherBoss: ChainWorld = { ...chain, rounds: [...chain.rounds.slice(0, -1), { ...chain.rounds.at(-1)!, card: 'Beat it!' }] };
    expect(sealChainVersion(otherBoss, null, now).versionId).not.toBe(game.version.versionId);
  });

  it('a single-verb sentence publishes the same single game as before P56C', async () => {
    const { status, body, game } = await publish(SINGLE);
    expect(status).toBe(201);
    expect(game).not.toHaveProperty('chain');
    expect(game.arcade).toBeDefined();
    expect(body.upgrade).toBe(`/api/play/games/${String(body.versionId)}/upgrade`);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await loadRapier();
    const before = await publishReadSpec(memoryVersionStore(), draftGameSpecWithMeta(SINGLE, 1, { reading: null }).spec, derivedSeeds(seedFrom(SINGLE)), null, { origin: { sentence: SINGLE, seed: null } });
    expect(before.ok && before.value.game.version.versionId).toBe(body.versionId);
  });

  it('a chain that fails verifyChain is refused and nothing is stored', async () => {
    const { game } = await publish(MULTI);
    const chain = game.chain as ChainWorld;
    // Dvě kola: pod 30 s a pod 3 ovládání.
    const short: ChainWorld = { ...chain, rounds: chain.rounds.slice(0, 2) };
    const versions = memoryVersionStore();
    const refused = await publishChain(versions, short, null, { origin: { sentence: MULTI, seed: null } });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.response.status).toBe(422);
    expect(((await refused.response.json()) as { error: { code: string } }).error.code).toBe('NOT_PUBLISHABLE');
    expect(refused.issues).toEqual(expect.arrayContaining([expect.stringMatching(/^chain_(length|controls)/)]));
    expect(await versions.recent(10)).toEqual([]);
  });

  it('a chain has no AI version and cannot be remixed', async () => {
    const { body } = await publish(MULTI);
    const id = String(body.versionId);
    const asked = await upgrade(new Request(`http://play.test/api/play/games/${id}/upgrade`, { headers: freshCaller() }), params(id));
    expect(asked.status).toBe(200);
    expect(await asked.json()).toEqual({ status: 'draft-final', reason: 'CHAIN' });
    const remixed = await remix(post(`/api/play/games/${id}/remix`, { sentence: 'add snow' }, freshCaller()), params(id));
    expect(remixed.status).toBe(422);
    // Obecné dveře s `parentId` nejsou zadní vrátka k remixu (revize T10).
    const child = await createGame(post('/api/play/games', { sentence: SINGLE, parentId: id }, freshCaller()));
    expect(child.status).toBe(422);
    expect(await versionStoreFromEnv(process.env).childrenOf(id)).toEqual([]);
  });
});
