import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DIRECTOR_BUDGET_MS, directorQueueState, getDirector, MIN_CALL_MS, resetDirectorQueue } from '@/app/api/play/_director';
import { __resetProcessVersionStore, versionStoreFromEnv } from '@/play/version';
import { DOOR_CEILING, resetConcurrency } from '@/server/paid-slots';
import { processSpendCap, resetProcessSpendCap } from '@/server/spend-cap';
import { draftGameSpecWithMeta } from '../../draft';
import { readBeforeDraft } from '../../read/client';
import type { Reading } from '../../read/schema';
import { fakeBranch } from '../__fixtures__/branch';
import { direct, type DirectorCache } from '../index';

// P56A T4-R2: čtení v route vypršelo → režisér na pozadí (`_upgrade.ts` → `direct()`) tutéž větu placeně
// nečte znovu. Strop čtečky je tu kladný a cache vypnutá, takže volání zastaví jen chybějící volající.
const READING: Reading = {
  control: 'runner', verbs: [{ word: 'runs', class: 'runner' }], hero: 'corgi', roles: [], setting: 'park', mood: null,
  numbers: { seconds: null, counts: [] }, genre: null, sure: true, foe: null, item: null, world: null, title: null,
};
const SENTENCE = 'a corgi runs through a park grabbing sausages';

let readerCalls = 0;
let upstreamCalls = 0;
/** Placený režisér odpoví až po tomhle slibu: drží slot dveří `play` obsazený. */
let hold: Promise<void> = Promise.resolve();
let answer: Reading = READING;
/** Čtečka odpoví až po tomhle slibu. */
let readHold: Promise<void> = Promise.resolve();

beforeEach(() => {
  readerCalls = 0;
  upstreamCalls = 0;
  hold = Promise.resolve();
  readHold = Promise.resolve();
  answer = READING;
  for (const [name, value] of Object.entries({
    PLAY_READER: 'on',
    PLAY_READER_ENDPOINT: 'openai:https://api.groq.com/openai',
    PLAY_READER_KEY: 'gsk-test',
    PLAY_READER_MODEL: 'openai/gpt-oss-20b',
    PLAY_READER_USD_PER_MTOK_IN: '0.075',
    PLAY_READER_USD_PER_MTOK_OUT: '0.30',
    PLAY_READER_SPEND_CAP_USD: '1',
    PLAY_STORE_DIR: mkdtempSync(join(tmpdir(), 'p56a-director-reader-')),
    WORLDSMITH_ANSWER_CACHE: 'off',
  })) vi.stubEnv(name, value);
  resetProcessSpendCap();
  const real = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // Placený režisér getDirectoru (níž) odpoví 503 a hra spadne na návrh – nikam se nevolá.
    if (url.startsWith('https://upstream.invalid/')) {
      upstreamCalls += 1;
      await hold;
      return new Response('upstream down', { status: 503 });
    }
    if (!url.startsWith('https://api.groq.com/')) return real(input, init);
    readerCalls += 1;
    await readHold;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 300 } }));
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetProcessSpendCap();
  resetConcurrency();
  resetDirectorQueue();
});

describe('the background director never pays for a second reading (T4-R2)', () => {
  it('direct() with a paid reader configured calls the reader transport zero times', async () => {
    const game = await direct(SENTENCE, { branch: fakeBranch([]), now: () => 0, seed: 1, maxRepairRounds: 0 });
    expect(game.spec.title.length).toBeGreaterThan(0);
    expect(readerCalls).toBe(0);
  });

  it('the same configuration does pay for the route, which names its caller', async () => {
    await expect(readBeforeDraft(SENTENCE, process.env, { caller: '203.0.113.7' })).resolves.toMatchObject({ hero: 'corgi' });
    expect(readerCalls).toBe(1);
  });

  it('a caller does not change that while the route reads the sentence itself', async () => {
    await direct(SENTENCE, { branch: fakeBranch([]), now: () => 0, seed: 1, maxRepairRounds: 0, caller: '203.0.113.7' });
    expect(readerCalls).toBe(0);
  });
});

// P58B T4: astra čte jen pro AI verzi (`PLAY_READER_PATH=ai`) – route se neptá, takže čte režisér, jednou a za volajícího.
describe('the director reads the sentence for the AI version (P58B T4)', () => {
  const VISITOR = '203.0.113.7';
  const CATCH: Reading = { ...READING, genre: { genre: 'catch', mode: 'default' } };

  beforeEach(() => {
    vi.stubEnv('PLAY_READER_PATH', 'ai');
    answer = CATCH;
  });

  it('pays one reading for its caller and drafts the game from it', async () => {
    const fromReading = draftGameSpecWithMeta(SENTENCE, 1, { reading: CATCH }).spec;
    expect(fromReading).not.toEqual(draftGameSpecWithMeta(SENTENCE, 1).spec);
    const game = await direct(SENTENCE, { branch: fakeBranch([]), now: () => 0, seed: 1, maxRepairRounds: 0, caller: VISITOR });
    expect(readerCalls).toBe(1);
    expect(game.spec).toEqual(fromReading);
  });

  it('pays nothing without a caller', async () => {
    await direct(SENTENCE, { branch: fakeBranch([]), now: () => 0, seed: 1, maxRepairRounds: 0 });
    expect(readerCalls).toBe(0);
  });

  it('getDirector hands the caller of the work to that reading', async () => {
    for (const [name, value] of Object.entries({
      WORLDSMITH_BRANCH: 'live',
      WORLDSMITH_MODEL_ENDPOINT: 'https://upstream.invalid/v1/messages',
      WORLDSMITH_MODEL_KEY: 'test-key',
      WORLDSMITH_USD_PER_MTOK_OUT: '15',
      WORLDSMITH_SPEND_CAP_USD: '5',
    })) vi.stubEnv(name, value);
    resetProcessSpendCap();
    const directed = await getDirector(Date.now(), VISITOR)(SENTENCE);
    expect(readerCalls).toBe(1);
    expect(directed.source).toBe('draft');
  });

  // Revize T4, nález 1: čtení se platí před prvním voláním režiséra, takže jen když by ho režisér teď pustil.
  describe('the reading is paid only when the director would call its model', () => {
    beforeEach(() => {
      for (const [name, value] of Object.entries({
        WORLDSMITH_BRANCH: 'live',
        WORLDSMITH_MODEL_ENDPOINT: 'https://upstream.invalid/v1/messages',
        WORLDSMITH_MODEL_KEY: 'test-key',
        WORLDSMITH_USD_PER_MTOK_OUT: '15',
        WORLDSMITH_SPEND_CAP_USD: '5',
        WORLDSMITH_CALL_CAP: '1',
        PLAY_DIRECTOR_CALLS_PER_CALLER: '1',
      })) vi.stubEnv(name, value);
      resetProcessSpendCap();
      // Úložiště procesu si pamatuje první `PLAY_STORE_DIR`, tedy i volání režiséra z testů výš.
      __resetProcessVersionStore();
    });

    it('asks without spending: the last director call and the last daily call still reach the model', async () => {
      const directed = await getDirector(Date.now(), VISITOR)(SENTENCE);
      expect(readerCalls).toBe(1);
      expect(upstreamCalls).toBe(1);
      expect(directed.callerLimited).toBe(false);
    });

    it("pays nothing once the caller's daily director calls are used up", async () => {
      await versionStoreFromEnv(process.env).takeDirectorCall(VISITOR, 1);
      const directed = await getDirector(Date.now(), VISITOR)(SENTENCE);
      expect(readerCalls).toBe(0);
      expect(directed.callerLimited).toBe(true);
    });

    it('pays nothing once the director spend cap is used up', async () => {
      await expect(processSpendCap().reserve(0.01)).resolves.toMatchObject({ ok: true });
      await getDirector(Date.now(), VISITOR)(SENTENCE);
      expect(readerCalls).toBe(0);
      expect(upstreamCalls).toBe(0);
    });

    it('pays nothing once the director has spent its dollar cap, with calls still left', async () => {
      vi.stubEnv('WORLDSMITH_SPEND_CAP_USD', '0.01');
      vi.stubEnv('WORLDSMITH_CALL_CAP', '10');
      resetProcessSpendCap();
      await expect(processSpendCap().reserve(0.01)).resolves.toMatchObject({ ok: true });
      await getDirector(Date.now(), VISITOR)(SENTENCE);
      expect(readerCalls).toBe(0);
      expect(upstreamCalls).toBe(0);
    });

    // Revize T4-2: `reserve()` nikdy nepustí knihu přes strop, takže skončí těsně pod ním – méně než jedno volání volna.
    it("pays nothing when less than one director call's worst case is left under the dollar cap", async () => {
      vi.stubEnv('WORLDSMITH_SPEND_CAP_USD', '0.000001');
      vi.stubEnv('WORLDSMITH_CALL_CAP', '10');
      resetProcessSpendCap();
      await getDirector(Date.now(), VISITOR)(SENTENCE);
      expect(readerCalls).toBe(0);
      expect(upstreamCalls).toBe(0);
    });

    it('pays nothing when too little of the route budget is left for a director call', async () => {
      await getDirector(Date.now() - DIRECTOR_BUDGET_MS + 1000, VISITOR)(SENTENCE);
      expect(readerCalls).toBe(0);
      expect(upstreamCalls).toBe(0);
    });

    // Revize testů /ship: čas na volání zbývá, na čtení (15 s) před ním už ne – model se zavolá, čtení se nezaplatí.
    it('pays nothing when the budget fits a director call but not the reading before it', async () => {
      await getDirector(Date.now() - DIRECTOR_BUDGET_MS + MIN_CALL_MS + 5000, VISITOR)(SENTENCE);
      expect(readerCalls).toBe(0);
      expect(upstreamCalls).toBe(1);
    });

    it('pays nothing on a path that does not wait for a slot while every play slot is busy', async () => {
      vi.stubEnv('WORLDSMITH_CALL_CAP', '10');
      resetProcessSpendCap();
      let release = () => {};
      hold = new Promise((resolve) => {
        release = resolve;
      });
      const busy = Array.from({ length: DOOR_CEILING.play }, (_, slot) => getDirector(Date.now(), `198.51.100.${String(slot)}`)(SENTENCE));
      await vi.waitFor(() => expect(directorQueueState().running).toBe(DOOR_CEILING.play), { timeout: 10_000 });
      const paidByBusy = readerCalls;
      await getDirector(Date.now(), VISITOR, undefined, undefined, undefined, false)(SENTENCE);
      expect(readerCalls).toBe(paidByBusy);
      release();
      await Promise.all(busy);
      expect(upstreamCalls).toBe(DOOR_CEILING.play);
    });

    // Revize opravy T4, nález B (T4b): cesty, kde se po zaplaceném čtení model stejně nezavolá.
    it('pays nothing when the director cache already has the game', async () => {
      const words = draftGameSpecWithMeta(SENTENCE, 1).spec;
      let readsAtLookup: number | null = null;
      const cache: DirectorCache = {
        id: 'memory',
        read: async () => {
          readsAtLookup = readerCalls;
          return { spec: words, authoredBy: null };
        },
        write: async () => {},
      };
      const game = await direct(SENTENCE, { branch: fakeBranch([]), cache, now: () => 0, seed: 1, maxRepairRounds: 0, caller: VISITOR });
      expect(readsAtLookup).toBe(0);
      expect(game.source).toBe('cached');
      expect(readerCalls).toBe(0);
    });

    it('pays nothing when the seam says the model will not be called', async () => {
      await direct(SENTENCE, { branch: fakeBranch([]), now: () => 0, seed: 1, maxRepairRounds: 0, caller: VISITOR, mayPayRead: async () => false });
      expect(readerCalls).toBe(0);
    });

    it('holds its play slot before it pays, so nobody takes it during the read', async () => {
      vi.stubEnv('WORLDSMITH_CALL_CAP', '10');
      resetProcessSpendCap();
      let release = () => {};
      readHold = new Promise((resolve) => {
        release = resolve;
      });
      const directed = getDirector(Date.now(), VISITOR, undefined, undefined, undefined, false)(SENTENCE);
      await vi.waitFor(() => expect(readerCalls).toBe(1), { timeout: 10_000 });
      expect(directorQueueState().running).toBe(1);
      release();
      await directed;
      expect(upstreamCalls).toBe(1);
    });

    it('pays nothing on the waiting path when the queue for a slot is full', async () => {
      vi.stubEnv('WORLDSMITH_CALL_CAP', '10');
      vi.stubEnv('PLAY_DIRECTOR_QUEUE', '0');
      resetProcessSpendCap();
      let release = () => {};
      hold = new Promise((resolve) => {
        release = resolve;
      });
      const busy = Array.from({ length: DOOR_CEILING.play }, (_, slot) => getDirector(Date.now(), `198.51.100.${String(slot)}`)(SENTENCE));
      await vi.waitFor(() => expect(directorQueueState().running).toBe(DOOR_CEILING.play), { timeout: 10_000 });
      const paidByBusy = readerCalls;
      await getDirector(Date.now(), VISITOR)(SENTENCE);
      expect(readerCalls).toBe(paidByBusy);
      release();
      await Promise.all(busy);
    });
  });
});
