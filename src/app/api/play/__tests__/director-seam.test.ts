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

import { resetProcessSpendCap } from '@/server/spend-cap';

import { getDirector } from '../_director';

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
  vi.stubGlobal('fetch', () => {
    fetchCalls += 1;
    return Promise.resolve(new Response('upstream down', { status: 503 }));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetProcessSpendCap();
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
