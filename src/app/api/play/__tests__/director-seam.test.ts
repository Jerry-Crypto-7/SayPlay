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
import { __resetProcessVersionStore, VersionStoreUnavailable, versionStoreFromEnv } from '@/play/version';
import { resetRateWindows } from '@/server/rate-limit';
import { resetProcessSpendCap } from '@/server/spend-cap';

import { acquireSlot, resetConcurrency } from '../../worldstream/sessions/route';
import { getDirector } from '../_director';
import { POST as createGame } from '../games/route';

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
    const game = await getDirector()(SENTENCE);
    expect(game.source).toBe('draft');
    expect(fetchCalls).toBe(0);
  });

  it('vypnutý upstream: model se nevolá', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'play-director-'));
    temporary.push(dir);
    const file = join(dir, 'control.json');
    writeFileSync(file, JSON.stringify({ off: ['upstream'] }));
    stubEnv({ ...LIVE, WORLDSMITH_CONTROL_FILE: file });
    const game = await getDirector()(SENTENCE);
    expect(game.fallbackReason).toBe('MODEL_UNAVAILABLE');
    expect(fetchCalls).toBe(0);
  });

  it('strop 0 USD: rezervace odmítne, k poskytovateli nic neodejde', async () => {
    stubEnv({ ...LIVE, WORLDSMITH_SPEND_CAP_USD: '0' });
    const game = await getDirector()(SENTENCE);
    expect(game.source).toBe('draft');
    expect(fetchCalls).toBe(0);
  });

  it('volný strop: volání odejde a výpadek poskytovatele skončí návrhem', async () => {
    stubEnv(LIVE);
    const game = await getDirector()(SENTENCE);
    expect(fetchCalls).toBeGreaterThan(0);
    expect(game.source).toBe('draft');
    expect(game.fallbackReason).toBe('MODEL_UNAVAILABLE');
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
  it('bez volného slotu dveří generate se model nevolá a hra je návrh', async () => {
    stubEnv(LIVE);
    expect(acquireSlot('generate')).toBe(true);
    expect(acquireSlot('generate')).toBe(true);
    const game = await getDirector()(SENTENCE);
    expect(game.source).toBe('draft');
    expect(fetchCalls).toBe(0);
  });

  it('slot se vrací i po výpadku modelu – další věta ho dostane znovu', async () => {
    stubEnv(LIVE);
    await getDirector()(SENTENCE);
    await getDirector()(SENTENCE);
    expect(acquireSlot('generate')).toBe(true);
    expect(acquireSlot('generate')).toBe(true);
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
