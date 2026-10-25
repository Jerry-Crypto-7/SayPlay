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
import { directorCache, directorKey } from '@/play/director';
import { buildCompactRequest, COMPACT_PROMPT_VERSION } from '@/play/director/compact';
import { draftGameSpecWithMeta } from '@/play/draft';
import type { GameSpecV1 } from '@/play/spec';
import { __resetProcessVersionStore, VersionStoreUnavailable, versionStoreFromEnv } from '@/play/version';
import { vocabVersion } from '@/play/vocab';
import { type AnswerStore, memoryAnswerStore } from '@/server/answer-cache';
import { resetRateWindows } from '@/server/rate-limit';
import { upstreamBranch, upstreamConfigFromEnv } from '@/server/upstream';
import { resetProcessSpendCap } from '@/server/spend-cap';

import { acquireSlot, resetConcurrency } from '@/server/paid-slots';
import { DIRECTOR_BUDGET_MS, directorQueueState, getDirector, MIN_CALL_MS, resetDirectorQueue } from '../_director';
import { POST as createGame } from '../games/route';
import { GET as readUpgrade } from '../games/[id]/upgrade/route';
import { directorCallerOf, UNTRUSTED_DIRECTOR_CALLER } from '../_publish';
import { __resetUpgrades } from '../_upgrade';

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
  __resetUpgrades();
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
  resetDirectorQueue();
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

  // R9: most codex-shim pouští dva běhy naráz a třetí hned odmítne 429 `busy`
  // (`scripts/__tests__/codex-shim.test.ts`), nic nečeká ve frontě. Strop
  // osmi slotů proto nevede k timeoutu, jen k rychlému návrhu.
  it('plný most (429 busy) skončí návrhem hned, ne po timeoutu volání', async () => {
    stubEnv(LIVE);
    vi.stubGlobal('fetch', () => {
      fetchCalls += 1;
      return Promise.resolve(Response.json({ type: 'error', error: { type: 'rate_limit_error', message: 'busy' } }, { status: 429 }));
    });
    const started = performance.now();
    const game = await getDirector(Date.now(), 'test-caller')(SENTENCE);
    expect(fetchCalls).toBe(1);
    expect(game.source).toBe('draft');
    expect(game.fallbackReason).toBe('MODEL_UNAVAILABLE');
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

// P58D T1: návrh ze čtení jde z režie ven přes `onDraft` – s placenou větví i bez ní.
describe('getDirector – návrh ze čtení', () => {
  const READ = { control: 'move_free', verbs: [{ word: 'escapes', class: 'move_free' }], hero: 'hamster', roles: [{ noun: 'roomba', kind: 'threat', count: null }], setting: 'supermarket', mood: null, numbers: { seconds: null, counts: [] }, genre: { genre: 'quest', mode: 'spatial' }, sure: true, foe: 'roomba', item: null, world: null, title: null };

  it.each([['bez placené větve', { ...LIVE, WORLDSMITH_BRANCH: '' }], ['s placenou větví', LIVE]])('%s předá návrh ze čtení', async (_label, env) => {
    stubEnv({ ...env, PLAY_READER: 'on', PLAY_READER_ENDPOINT: 'http://reader.test' });
    vi.stubGlobal('fetch', (url: string) => {
      if (String(url).startsWith('http://reader.test')) return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(READ) } }] })));
      fetchCalls += 1;
      return Promise.resolve(new Response('upstream down', { status: 503 }));
    });
    const drafts: GameSpecV1[] = [];
    await getDirector(Date.now(), 'test-caller', undefined, undefined, undefined, true, (spec) => drafts.push(spec))(SENTENCE);
    expect(drafts).toEqual([draftGameSpecWithMeta(SENTENCE, 1, { reading: READ as never }).spec]);
    expect(drafts[0]!.genre).toMatchObject({ id: 'quest', mode: 'spatial' });
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

  it('volání odmítnuté stropem utrácení volajícímu počet neubere (revize R8)', async () => {
    stubEnv({ ...LIVE, WORLDSMITH_SPEND_CAP_USD: '0', PLAY_DIRECTOR_CALLS_PER_CALLER: '1' });
    await getDirector(Date.now(), 'caller-a')(SENTENCE);
    expect(fetchCalls).toBe(0);
    stubEnv({ ...LIVE, PLAY_DIRECTOR_CALLS_PER_CALLER: '1' });
    const game = await getDirector(Date.now(), 'caller-a')(SENTENCE);
    expect(fetchCalls).toBe(1);
    expect(game.callerLimited).toBe(false);
  });

  it('vyčerpaný počet je v režii vidět jako callerLimited', async () => {
    stubEnv({ ...LIVE, PLAY_DIRECTOR_CALLS_PER_CALLER: '1' });
    await getDirector(Date.now(), 'caller-a')(SENTENCE);
    const limited = await getDirector(Date.now(), 'caller-a')(SENTENCE);
    expect(limited.callerLimited).toBe(true);
  });

  it('bez volného slotu se cache čte pod klíčem živé větve – táž věta, táž hra', async () => {
    const cachedSentence = 'a penguin jumps';
    stubEnv(LIVE);
    // Klíč, pod který píše živá větev: kompaktní odpověď je výchozí (P27D T2). Do P53 T2 četly
    // plné dveře pod klíčem celého GameSpec, tedy jinou hru, než by táž věta dostala s volným slotem.
    const request = buildCompactRequest(cachedSentence, draftGameSpecWithMeta(cachedSentence).genre);
    const branchId = upstreamBranch(upstreamConfigFromEnv(process.env)).id;
    // Klíč nese i verzi tabulky sloves P44C (jiná tabulka = jiná hra).
    const key = directorKey({ sentence: cachedSentence, promptVersion: `${COMPACT_PROMPT_VERSION}+vocab:${vocabVersion()}`, model: request.model, endpoint: branchId });
    await directorCache(answers.store ?? memoryAnswerStore()).write(key, draftGameSpecWithMeta(cachedSentence).spec);
    expect(acquireSlot('play')).toBe(true);
    expect(acquireSlot('play')).toBe(true);
    const game = await getDirector(Date.now(), 'test-caller')(cachedSentence);
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

describe('denní počet volání režiséra – klíč z důvěryhodného konce (R12)', () => {
  const OTHER = 'A cat delivers a fragile cake across a busy kitchen.';

  async function sentenceFrom(sentence: string, headers: Record<string, string>): Promise<void> {
    const created = await createGame(
      new Request('http://play.test/api/play/games', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ sentence }) }),
    );
    expect(created.status).toBe(201);
    const { versionId } = await created.json();
    // Práce spuštěná POSTem běží na pozadí; upgrade vrací `pending`, dokud nedoběhne.
    await vi.waitFor(async () => {
      const outcome = await readUpgrade(new Request(`http://play.test/api/play/games/${versionId}/upgrade`, { headers }), { params: Promise.resolve({ id: versionId }) });
      expect((await outcome.json()).status).toBe('draft-final');
    });
  }

  it('mimo Vercel nový x-forwarded-for počet neobnoví – bez důvěryhodného klíče sdílí volající jeden', async () => {
    stubEnv({ ...LIVE, PLAY_DIRECTOR_CALLS_PER_CALLER: '1' });
    await sentenceFrom(SENTENCE, { 'x-forwarded-for': '198.51.100.1' });
    expect(fetchCalls).toBe(1);
    await sentenceFrom(OTHER, { 'x-forwarded-for': '198.51.100.2' });
    expect(fetchCalls, 'podvržená hlavička dala nový počet').toBe(1);
  });

  // Přes routu to změřit nejde: na `VERCEL` bez sdíleného úložiště strop
  // utrácení placenou cestu zavře dřív, než se počet čte.
  it('na Vercelu má každý volající z platformní hlavičky vlastní počet', () => {
    vi.stubEnv('VERCEL', '1');
    const from = (address: string) => directorCallerOf(new Request('http://play.test/', { headers: { 'x-vercel-forwarded-for': address } }));
    expect(from('198.51.100.1')).not.toBe(UNTRUSTED_DIRECTOR_CALLER);
    expect(from('198.51.100.1')).not.toBe(from('198.51.100.2'));
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
    await vi.waitFor(() => expect(directorQueueState(), 'odmítnutí si nechalo místo ve frontě').toEqual({ running: 0, queued: 0 }));
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
