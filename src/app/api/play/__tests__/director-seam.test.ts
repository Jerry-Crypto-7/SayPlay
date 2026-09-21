/**
 * Šev režiséra (P23-D T1) platí za model, takže se drží jeho brány: bez
 * objednávky `WORLDSMITH_BRANCH=live`, s vypnutým `upstream` nebo s vyčerpaným
 * stropem se k poskytovateli nesáhne a hráč dostane návrh ze slov. S volným
 * stropem jde volání ven a vyrovná se. `fetch` je podvržený – nikam se nevolá.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import collectExit from '@/play/__fixtures__/collect_exit.json';
import { buildDirectorRequest, DIRECTOR_PROMPT_VERSION, directorCache, directorKey } from '@/play/director';
import { draftGameSpec } from '@/play/draft';
import type { GameSpecV1 } from '@/play/spec';
import { __resetProcessVersionStore, VersionStoreUnavailable, versionStoreFromEnv } from '@/play/version';
import { type AnswerStore, memoryAnswerStore } from '@/server/answer-cache';
import { resetRateWindows } from '@/server/rate-limit';
import { upstreamBranch, upstreamConfigFromEnv } from '@/server/upstream';
import { resetProcessSpendCap } from '@/server/spend-cap';

import { acquireSlot, resetConcurrency } from '../../worldstream/sessions/route';
import { DIRECTOR_BUDGET_MS, getDirector, MIN_CALL_MS } from '../_director';
import { POST as createGame } from '../games/route';

// Bez sdíleného úložiště dá `directorCacheFromEnv` každé režii novou paměť;
// test cache potřebuje jednu na celý test.
const answers = vi.hoisted(() => ({ store: null as AnswerStore | null }));
vi.mock('@/play/director', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/play/director')>();
  return { ...actual, directorCacheFromEnv: () => actual.directorCache(answers.store ?? memoryAnswerStore()) };
});

const SENTENCE = 'A hamster escapes a supermarket while a giant Roomba hunts it.';

const LIVE = {
  WORLDSMITH_BRANCH: 'live',
  WORLDSMITH_MODEL_ENDPOINT: 'https://upstream.invalid/v1/messages',
  WORLDSMITH_MODEL_KEY: 'test-key',
  WORLDSMITH_USD_PER_MTOK_OUT: '15',
  WORLDSMITH_SPEND_CAP_USD: '5',
};

const temporary: string[] = [];
let fetchCalls = 0;

beforeEach(() => {
  answers.store = memoryAnswerStore();
  fetchCalls = 0;
  __resetProcessVersionStore();
  resetRateWindows();
  resetConcurrency();
  vi.stubGlobal('fetch', () => {
    fetchCalls += 1;
    return Promise.resolve(new Response('upstream down', { status: 503 }));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetProcessSpendCap();
  resetConcurrency();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stubEnv(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  resetProcessSpendCap();
}

describe('getDirector – brány placené větve', () => {
  it('klíč bez objednávky live: model se nevolá, hra je návrh', async () => {
    stubEnv({ ...LIVE, WORLDSMITH_BRANCH: '' });
    const game = await getDirector(Date.now(), 'test-caller')(SENTENCE);
    expect(game.source).toBe('draft');
    expect(fetchCalls).toBe(0);
  });

  it('vypnutý upstream: model se nevolá', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'play-director-'));
    temporary.push(dir);
    const file = join(dir, 'control.json');
    writeFileSync(file, JSON.stringify({ off: ['upstream'] }));
    stubEnv({ ...LIVE, WORLDSMITH_CONTROL_FILE: file });
    const game = await getDirector(Date.now(), 'test-caller')(SENTENCE);
    expect(game.fallbackReason).toBe('MODEL_UNAVAILABLE');
    expect(fetchCalls).toBe(0);
  });

  it('strop 0 USD: rezervace odmítne, k poskytovateli nic neodejde', async () => {
    stubEnv({ ...LIVE, WORLDSMITH_SPEND_CAP_USD: '0' });
    const game = await getDirector(Date.now(), 'test-caller')(SENTENCE);
    expect(game.source).toBe('draft');
    expect(fetchCalls).toBe(0);
  });

  it('volný strop: volání odejde a výpadek poskytovatele skončí návrhem', async () => {
    stubEnv(LIVE);
    const game = await getDirector(Date.now(), 'test-caller')(SENTENCE);
    expect(fetchCalls).toBeGreaterThan(0);
    expect(game.source).toBe('draft');
    expect(game.fallbackReason).toBe('MODEL_UNAVAILABLE');
  });
});

describe('getDirector – rozpočet času režie (R7)', () => {
  it('nasazený timeout 285 s, delší než rozpočet, volání nezavře – zkrátí se na zbytek (revize R7)', async () => {
    stubEnv({ ...LIVE, WORLDSMITH_UPSTREAM_TIMEOUT_MS: '285000' });
    const timeouts = vi.spyOn(AbortSignal, 'timeout');
    const left = MIN_CALL_MS + 10_000;
    await getDirector(Date.now() - (DIRECTOR_BUDGET_MS - left), 'test-caller')(SENTENCE);
    expect(fetchCalls).toBeGreaterThan(0);
    const used = timeouts.mock.calls.map(([ms]) => ms);
    expect(used.length).toBeGreaterThan(0);
    for (const ms of used) {
      expect(ms).toBeLessThanOrEqual(left);
      expect(ms).toBeGreaterThan(left - 5_000);
    }
  });

  it('rozpočet běží od příchodu požadavku: pod MIN_CALL_MS zbytku volání neodejde', async () => {
    stubEnv(LIVE);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const game = await getDirector(Date.now() - (DIRECTOR_BUDGET_MS - MIN_CALL_MS + 1_000), 'test-caller')(SENTENCE);
    expect(game.source).toBe('draft');
    expect(fetchCalls).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('director call skipped'));
  });
});

describe('getDirector – kvóty a cache (R8)', () => {
  it('denní počet volání na volajícího: nad mez model nevolá, jiný volající ano', async () => {
    stubEnv({ ...LIVE, PLAY_DIRECTOR_CALLS_PER_CALLER: '1' });
    await getDirector(Date.now(), 'caller-a')(SENTENCE);
    expect(fetchCalls).toBe(1);
    const refused = await getDirector(Date.now(), 'caller-a')(SENTENCE);
    expect(refused.source).toBe('draft');
    expect(fetchCalls, 'druhé volání téhož volajícího odešlo').toBe(1);
    await getDirector(Date.now(), 'caller-b')(SENTENCE);
    expect(fetchCalls).toBe(2);
  });

  it('bez volného slotu se cache čte pod klíčem živé větve – táž věta, táž hra', async () => {
    stubEnv(LIVE);
    const request = buildDirectorRequest(SENTENCE, draftGameSpec(SENTENCE));
    const branchId = upstreamBranch(upstreamConfigFromEnv(process.env)).id;
    const key = directorKey({ sentence: SENTENCE, promptVersion: DIRECTOR_PROMPT_VERSION, model: request.model, endpoint: branchId });
    await directorCache(answers.store ?? memoryAnswerStore()).write(key, collectExit as GameSpecV1);
    expect(acquireSlot('play')).toBe(true);
    expect(acquireSlot('play')).toBe(true);
    const game = await getDirector(Date.now(), 'test-caller')(SENTENCE);
    expect(game.source).toBe('cached');
    expect(fetchCalls).toBe(0);
  });

  it('už publikovaná věta je při vyčerpané kvótě 200, ne 429', async () => {
    stubEnv({ ...LIVE, PLAY_PUBLISH_DAILY_CAP: '1' });
    __resetProcessVersionStore();
    const first = await createGame(post({ sentence: SENTENCE }));
    expect(first.status).toBe(201);
    const again = await createGame(post({ sentence: SENTENCE }));
    expect(again.status).toBe(200);
    expect((await again.json()).versionId).toBe((await first.json()).versionId);
  });
});

function post(body: unknown): Request {
  return new Request('http://play.test/api/play/games', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
    body: JSON.stringify(body),
  });
}

describe('getDirector – souběh a pořadí bran (nálezy revize T1)', () => {
  it('bez volného slotu dveří play se model nevolá a hra je návrh', async () => {
    stubEnv(LIVE);
    expect(acquireSlot('play')).toBe(true);
    expect(acquireSlot('play')).toBe(true);
    const game = await getDirector(Date.now(), 'test-caller')(SENTENCE);
    expect(game.source).toBe('draft');
    expect(fetchCalls).toBe(0);
  });

  it('režie PLAY nebere sloty /api/generate (druhé kolo revize T1)', async () => {
    stubEnv(LIVE);
    expect(acquireSlot('generate')).toBe(true);
    expect(acquireSlot('generate')).toBe(true);
    await getDirector(Date.now(), 'test-caller')(SENTENCE);
    expect(fetchCalls, 'plné dveře generate zavřely PLAY').toBeGreaterThan(0);
  });

  it('slot se vrací i po výpadku modelu – další věta ho dostane znovu', async () => {
    stubEnv(LIVE);
    await getDirector(Date.now(), 'test-caller')(SENTENCE);
    await getDirector(Date.now(), 'test-caller')(SENTENCE);
    expect(acquireSlot('play')).toBe(true);
    expect(acquireSlot('play')).toBe(true);
  });

  it('vyčerpaný denní strop publikací je 429 dřív, než se zaplatí model', async () => {
    stubEnv({ ...LIVE, PLAY_PUBLISH_DAILY_CAP: '1' });
    __resetProcessVersionStore();
    expect((await createGame(post({ spec: collectExit }))).status).toBe(201);
    const refused = await createGame(post({ sentence: SENTENCE }));
    expect(refused.status).toBe(429);
    expect((await refused.json()).error.code).toBe('PUBLISH_QUOTA');
    expect(fetchCalls).toBe(0);
  });

  it('nedostupné úložiště je 503 dřív, než se zaplatí model', async () => {
    stubEnv(LIVE);
    vi.spyOn(versionStoreFromEnv(process.env), 'canPublish').mockRejectedValueOnce(new VersionStoreUnavailable('down'));
    const refused = await createGame(post({ sentence: SENTENCE }));
    expect(refused.status).toBe(503);
    expect((await refused.json()).error.code).toBe('STORE_UNAVAILABLE');
    expect(fetchCalls).toBe(0);
  });
});
