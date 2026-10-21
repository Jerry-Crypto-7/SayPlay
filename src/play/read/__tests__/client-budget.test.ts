import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AnswerStore } from '@/server/answer-cache';
import type { Reservation, SpendCap } from '@/server/spend-cap';

import { DEFAULT_READER_BUDGET_MS, readBeforeDraft } from '../client';
import type { Reading } from '../schema';

// P56A T4-R1: kolik z 700 ms zbude na model. Každý let do úložiště (cache, vypínač, kniha stropu,
// počet volajícího) tu trvá 100 ms na falešných hodinách; vypínač a počet volajícího jdou přes
// vlastní moduly, proto jsou podvržené tady, ne v `client.test.ts`. Skutečný počet volajícího je
// při prvním čtení dne dva lety (INCR, pak EXPIRE, `version/store.ts`) – modelu pak zbude o let méně.
const FLIGHT_MS = 100;
const flight = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), FLIGHT_MS));

vi.mock('../../../server/kill-switch', async (original) => ({
  ...(await original<typeof import('../../../server/kill-switch')>()),
  killState: () => flight({ upstream: false }),
}));
vi.mock('../../version', async (original) => ({
  ...(await original<typeof import('../../version')>()),
  versionStoreFromEnv: () => ({ takeDirectorCall: () => flight(true) }),
}));

const READING: Reading = {
  control: 'runner', verbs: [{ word: 'runs', class: 'runner' }], hero: 'corgi', roles: [], setting: 'park', mood: null,
  numbers: { seconds: null, counts: [] }, genre: null, foe: null, item: null, world: null, title: null,
};
const GROQ = {
  PLAY_READER: 'on',
  PLAY_READER_ENDPOINT: 'openai:https://api.groq.com/openai',
  PLAY_READER_KEY: 'gsk-test',
  PLAY_READER_MODEL: 'openai/gpt-oss-20b',
  PLAY_READER_USD_PER_MTOK_IN: '0.075',
  PLAY_READER_USD_PER_MTOK_OUT: '0.30',
} as const;

const slowStore: AnswerStore = { id: 'slow', get: () => flight(null), set: async () => undefined };
const slowCap: Pick<SpendCap, 'reserve'> = {
  reserve: (usd) => flight<Reservation>({ ok: true, reservedUsd: usd, settle: async (actual) => (actual === 'unknown' ? usd : actual) }),
};

afterEach(() => vi.useRealTimers());

describe('the paid reader leaves the budget to the model (T4-R1)', () => {
  it('starts the model call after two store flights, not four, so 500 of 700 ms are the model’s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const started = Date.now();
    let calledAt: number | null = null;
    const modelMs = DEFAULT_READER_BUDGET_MS - 2 * FLIGHT_MS - 50;
    const fetchImpl = vi.fn(() => {
      calledAt = Date.now() - started;
      return new Promise<Response>((resolve) =>
        setTimeout(() => resolve(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(READING) }, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 300 } }))), modelMs),
      );
    });
    let result: Reading | null | 'pending' = 'pending';
    const pending = readBeforeDraft('a corgi runs', GROQ, { fetchImpl, cap: slowCap, store: slowStore, caller: '203.0.113.7' }).then((reading) => (result = reading));
    await vi.advanceTimersByTimeAsync(DEFAULT_READER_BUDGET_MS);
    await pending;
    expect(calledAt).toBe(2 * FLIGHT_MS);
    expect(result).toEqual(READING);
  });
});
