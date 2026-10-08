/**
 * Přiznání přiblížení (P44C T9). Hra, která „stab“ hraje jako rvačku a mlčí, vypadá správně a lže –
 * proto se pinuje `kind: 'played_as'`, slovo z věty v hlášce a že přiznání nikde nenahradí štítek P42.
 * Dveře `POST /api/play/games` běží skutečné (návrh, bez režiséra), úložiště verzí v paměti.
 */
import { readFileSync } from 'node:fs';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST as createGame } from '@/app/api/play/games/route';
import collectExit from '@/play/__fixtures__/collect_exit.json';
import { readGameSpec } from '@/play/spec';
import { loadRapier } from '@/play/arcade/physics/world';
import { draftGameSpecWithMeta } from '@/play/draft';
import { honestyForSpec } from '@/play/draft/unsupported';
import { __resetProcessVersionStore } from '@/play/version';
import { resetRateWindows } from '@/server/rate-limit';

const STAB = 'a knight stabs the goblins';

beforeAll(async () => {
  await loadRapier();
});
beforeEach(() => {
  vi.stubEnv('PLAY_DIRECTOR', 'off');
  __resetProcessVersionStore();
  resetRateWindows();
});
afterEach(() => vi.unstubAllEnvs());

const honestyOfSentence = (sentence: string) => honestyForSpec(sentence, draftGameSpecWithMeta(sentence, 1).spec, 1);

describe('played_as honesty', () => {
  it('admits a mapped verb the game plays', async () => {
    expect(await honestyOfSentence(STAB)).toMatchObject({ kind: 'played_as', reason: 'Stab plays as a fight.' });
  });

  it('names an unmet mapped verb by the word of the sentence', async () => {
    // Hra sběru („collect and exit“) rvačku nehraje: přiznání jmenuje „stabbing“, ne „fighting“.
    const read = readGameSpec(collectExit);
    if (!read.ok) throw new Error('fixture');
    const honesty = await honestyForSpec(STAB, read.value, 1);
    expect(honesty?.kind).toBe('actions');
    expect(honesty?.reason).toMatch(/^Stabbing isn't here yet – here's /);
  });

  it('says nothing for a verb the hand table knows', async () => {
    expect(await honestyOfSentence('a knight fights the goblins')).toBeNull();
  });

  it('is silent with PLAY_VOCAB=off', async () => {
    vi.stubEnv('PLAY_VOCAB', 'off');
    expect((await honestyOfSentence(STAB))?.kind).not.toBe('played_as');
  });

  it('does not serve an answer cached under the other table setting for the same spec', async () => {
    const spec = draftGameSpecWithMeta(STAB, 1).spec;
    expect((await honestyForSpec(STAB, spec, 1))?.kind).toBe('played_as');
    vi.stubEnv('PLAY_VOCAB', 'off');
    expect((await honestyForSpec(STAB, spec, 1))?.kind).not.toBe('played_as');
  });

  it('reaches the response of POST /api/play/games', async () => {
    const response = await createGame(
      new Request('http://play.test/api/play/games', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.44' },
        body: JSON.stringify({ sentence: STAB, seed: 1 }),
      }),
    );
    expect(response.status).toBe(201);
    expect((await response.json()).honesty).toMatchObject({ kind: 'played_as', reason: 'Stab plays as a fight.' });
  });

  it('never turns an unsupported P42 label into preserved by a played_as admission alone', async () => {
    const baseline = JSON.parse(readFileSync('evals/play/p44c/baseline.json', 'utf8')) as {
      sets: { p42: readonly { id: string; sentence: string; unsupported: boolean; preserved: boolean }[] };
    };
    const lost = baseline.sets.p42.filter((row) => row.unsupported && !row.preserved);
    for (const row of lost) expect((await honestyOfSentence(row.sentence))?.kind, row.id).not.toBe('played_as');
  });
});
