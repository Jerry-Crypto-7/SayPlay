import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetProcessSpendCap } from '@/server/spend-cap';
import { readBeforeDraft } from '../../read/client';
import { fakeBranch } from '../__fixtures__/branch';
import { direct } from '../index';

// P56A T4-R2: čtení v route vypršelo → režisér na pozadí (`_upgrade.ts` → `direct()`) tutéž větu placeně
// nečte znovu. Strop čtečky je tu kladný a cache vypnutá, takže volání zastaví jen chybějící volající.
const READING = {
  control: 'runner', verbs: [{ word: 'runs', class: 'runner' }], hero: 'corgi', roles: [], setting: 'park', mood: null,
  numbers: { seconds: null, counts: [] }, genre: null, foe: null, item: null, world: null, title: null,
};
const SENTENCE = 'a corgi runs through a park grabbing sausages';

let readerCalls = 0;

beforeEach(() => {
  readerCalls = 0;
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
    if (!url.startsWith('https://api.groq.com/')) return real(input, init);
    readerCalls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(READING) }, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 300 } }));
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetProcessSpendCap();
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
});
