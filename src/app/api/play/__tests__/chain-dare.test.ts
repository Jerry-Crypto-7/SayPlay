/**
 * Dare řetězu (P56C T10): `POST /api/play/games/:id/dare` přehraje u hry s `chain` celý řetěz na globálních
 * tikách (`replayChain`, vstupy během karty se zahodí) a uloží skóre, tiky a hash `hashChain` z přehrání.
 * Posunutý záznam, živé změny a záznam, který vyhraje jen kolo 1, server odmítne.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InputEvent } from '@/play/arcade/contract';
import type { ChainWorld } from '@/play/chain/contract';
import { replayChain } from '@/play/chain/run';
import { verifyChain } from '@/play/chain/verify';
import { packInputs, unpackInputs } from '@/play/score/dare';
import { __resetProcessVersionStore, type PublishedGame, versionStoreFromEnv } from '@/play/version';
import { resetRateWindows } from '@/server/rate-limit';

import { POST as createGame } from '../games/route';
import { GET as readGame } from '../games/[id]/route';
import { freshCaller, params, player, post, SECRET, send } from './dare-fixtures';

/** Dev P56C d04 (`multi_verb`). */
const MULTI = 'can u make one where a robot hops over lava cracks and shoots bubbles at grumpy clouds';

async function publishedChain(): Promise<{ id: string; chain: ChainWorld }> {
  const created = await createGame(post('/api/play/games', { sentence: MULTI }, freshCaller()));
  const { versionId } = (await created.json()) as { versionId: string };
  const read = await readGame(new Request(`http://play.test/api/play/games/${versionId}`, { headers: freshCaller() }), params(versionId));
  const game = (await read.json()) as PublishedGame;
  if (game.chain === undefined) throw new Error('the sentence did not publish a chain');
  return { id: versionId, chain: game.chain };
}

const stored = (dareId: string) => versionStoreFromEnv(process.env).getDare(dareId);

beforeEach(() => {
  __resetProcessVersionStore();
  resetRateWindows();
  vi.useFakeTimers({ now: 1_700_000_000_000, toFake: ['Date'] });
  vi.stubEnv('PLAY_IDENTITY_SECRET', SECRET);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  __resetProcessVersionStore();
});

describe('POST /api/play/games/:id/dare on a chain (P56C T10)', () => {
  it('the bot record of the whole chain is a dare: score, ticks and hash from replaying every round, a board place, ghost replays to the hash', async () => {
    const { id, chain } = await publishedChain();
    const { inputs } = verifyChain(chain);
    const expected = replayChain(chain, inputs);
    expect(expected.outcome).toBe('won');
    expect(expected.results.length).toBe(chain.rounds.length);

    const me = player();
    const first = await send(id, { inputs: packInputs(inputs), score: 999_999, ticks: 1, hash: 'forged' }, me.cookie);
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ dareId: expect.stringMatching(/^[a-f0-9]{32}$/), score: expected.score, ticks: expected.tick, board: { place: 1, of: 1 }, beat: null });
    const dare = await stored(first.body.dareId);
    expect(dare).toMatchObject({ versionId: id, score: expected.score, ticks: expected.tick, hash: expected.hash, liveChanges: 0, by: me.id });
    // Duch: jen spotřebované vstupy, přehrají se k témuž hashi.
    const ghost = unpackInputs(dare!.replay!.inputs) as InputEvent[];
    expect(dare!.replay!.patches).toEqual([]);
    expect(replayChain(chain, ghost).hash).toBe(expected.hash);

    // Týž běh podruhé (i se vstupem po konci řetězu) je táž výzva.
    const again = await send(id, { inputs: packInputs([...inputs, { tick: expected.tick + 5, buttons: 1, axis: 0 }]) });
    expect(again.status).toBe(200);
    expect(again.body.dareId).toBe(first.body.dareId);
  });

  it('a record that wins only round 1 is refused', async () => {
    const { id, chain } = await publishedChain();
    const verdict = verifyChain(chain);
    const firstRound = verdict.rounds[0]!.bot.inputs;
    expect(replayChain(chain, firstRound).outcome).not.toBe('won');
    const sent = await send(id, { inputs: packInputs(firstRound) });
    expect(sent.status).toBe(422);
    expect(sent.text).toContain('DARE_REJECTED');
  });

  it('a record shifted off the card timing is refused', async () => {
    const { id, chain } = await publishedChain();
    const verdict = verifyChain(chain);
    // Kola za sebou bez karet: od kola 2 je každý vstup o kartu dřív, než server kolo otevře.
    const noCards: InputEvent[] = [];
    let start = 0;
    for (const round of verdict.rounds) {
      for (const event of round.bot.inputs) noCards.push({ ...event, tick: event.tick + start });
      start += round.bot.tick;
    }
    expect(replayChain(chain, noCards).outcome).not.toBe('won');
    const sent = await send(id, { inputs: packInputs(noCards) });
    expect(sent.status).toBe(422);
    expect(sent.text).toContain('DARE_REJECTED');
  });

  it('live changes on a chain are refused', async () => {
    const { id, chain } = await publishedChain();
    const sent = await send(id, { inputs: packInputs(verifyChain(chain).inputs), patches: [{ tick: 10, patch: { kind: 'visual', weather: 'rain' } }] });
    expect(sent.status).toBe(422);
    expect(sent.text).toContain('DARE_REJECTED');
  });
});
