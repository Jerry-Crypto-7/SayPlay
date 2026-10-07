/**
 * **Směrování režiséra v cloudu (P30A T3): gpt-oss-20b první, astra jako
 * záloha s vlastním stropem.**
 *
 * Primár je hostovaný gpt-oss-20b (`openai:` na Together), záloha astra přes
 * placené OpenAI API. Vyhraje první úspěšná odpověď; záloha platí z vlastního
 * stropu a vlastní knihy, takže vyčerpaná záloha nechá hru na primáru a hlavní
 * strop jí nic neubere. Mez času podle modelu: gpt-oss stačí míň než astře.
 * Vypínač `upstream` vypne obojí. Podvržený `fetch` podle hostitele, žádná síť ven.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { genreAnswer } from '@/play/director/__fixtures__';
import { __resetProcessVersionStore } from '@/play/version';
import { type AnswerStore, memoryAnswerStore } from '@/server/answer-cache';
import { resetRateWindows } from '@/server/rate-limit';
import { costUsd, fallbackSpendCapFromEnv, processFallbackSpendCap, processSpendCap, resetProcessSpendCap } from '@/server/spend-cap';
import { ledgerFromEnv, processLedger } from '@/server/spend-store';
import { upstreamConfigFromEnv } from '@/server/upstream';

const answers = vi.hoisted(() => ({ store: null as AnswerStore | null }));
vi.mock('@/play/director', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/play/director')>();
  return { ...actual, directorCacheFromEnv: () => actual.directorCache(answers.store ?? memoryAnswerStore()) };
});

import { acquireSlot, releaseSlot, resetConcurrency, slotsDetail } from '../../worldstream/sessions/route';
import { billedLine, DIRECTOR_BUDGET_MS, getDirector, MIN_CALL_MS, minCallMs, OSS_MIN_CALL_MS } from '../_director';

const OSS = {
  WORLDSMITH_BRANCH: 'live',
  WORLDSMITH_MODEL_ENDPOINT: 'openai:https://api.together.xyz',
  WORLDSMITH_MODEL: 'openai/gpt-oss-20b',
  WORLDSMITH_MODEL_PROFILE: 'metered',
  WORLDSMITH_MODEL_KEY: 'tg-test-key',
  WORLDSMITH_USD_PER_MTOK_IN: '0.05',
  WORLDSMITH_USD_PER_MTOK_OUT: '0.2',
  WORLDSMITH_SPEND_CAP_USD: '5',
} as const;

const ASTRA_BACKUP = {
  WORLDSMITH_FALLBACK_ENDPOINT: 'openai:https://api.openai.com',
  WORLDSMITH_FALLBACK_MODEL: 'gpt-6-astra',
  WORLDSMITH_FALLBACK_KEY: 'sk-test-backup',
  WORLDSMITH_FALLBACK_USD_PER_MTOK_IN: '1.25',
  WORLDSMITH_FALLBACK_USD_PER_MTOK_OUT: '10',
  WORLDSMITH_FALLBACK_SPEND_CAP_USD: '5',
} as const;

const COMPACT = genreAnswer({ genre: 'platformer', mode: 'default', hero: 'penguin', cast: undefined, setting: 'frozen iceberg field', palette: 'snow' });
const SENTENCE = 'a penguin jumps';
const USAGE = { inputTokens: 2000, outputTokens: 900 };
const ASTRA_PRICE = { usdPerMTokIn: 1.25, usdPerMTokOut: 10 };

const answer = () =>
  new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content: JSON.stringify(COMPACT) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: USAGE.inputTokens, completion_tokens: USAGE.outputTokens },
    }),
  );

type Reply = number | 'ok' | 'hang';
const temporary: string[] = [];

beforeEach(() => {
  answers.store = memoryAnswerStore();
  __resetProcessVersionStore();
  resetRateWindows();
  resetConcurrency();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetProcessSpendCap();
  resetConcurrency();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stubEnv(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  resetProcessSpendCap();
}

/** `fetch` podle hostitele; vrací hostitele v pořadí volání a zrušená volání. */
function stubFetch(replies: Record<string, Reply>) {
  const called: string[] = [];
  const aborted: string[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const host = new URL(url).host;
    called.push(host);
    const reply = replies[host] ?? 404;
    if (reply === 'ok') return Promise.resolve(answer());
    if (reply === 'hang')
      return new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => {
          aborted.push(host);
          reject(init.signal?.reason as Error);
        });
      });
    return Promise.resolve(new Response('{}', { status: reply }));
  });
  return { called, aborted };
}

/** Začátek požadavku tak, aby z rozpočtu režie zbývalo `leftMs`. */
const startedWith = (leftMs: number) => Date.now() - (DIRECTOR_BUDGET_MS - leftMs);

describe('gpt-oss-20b first, astra as capped backup', () => {
  it('the primary wins when it answers, and the backup is never asked', async () => {
    stubEnv({ ...OSS, ...ASTRA_BACKUP });
    const { called } = stubFetch({ 'api.together.xyz': 'ok', 'api.openai.com': 'ok' });
    const game = await getDirector(Date.now(), 'oss-caller')(SENTENCE);
    expect(game).toMatchObject({ source: 'authored', authoredBy: 'openai/gpt-oss-20b' });
    expect(called).toEqual(['api.together.xyz']);
    expect(processFallbackSpendCap().snapshot()).toMatchObject({ callsMade: 0, spentUsd: 0 });
  });

  it('the backup wins when it answers first, and the hanging primary is cancelled', async () => {
    stubEnv({ ...OSS, ...ASTRA_BACKUP, PLAY_DIRECTOR_HEDGE_MS: '0' });
    const { aborted } = stubFetch({ 'api.together.xyz': 'hang', 'api.openai.com': 'ok' });
    const game = await getDirector(Date.now(), 'race-caller')(SENTENCE);
    expect(game.authoredBy).toBe('gpt-6-astra');
    expect(aborted).toEqual(['api.together.xyz']);
    // Obě rezervace vyrovnané dřív, než režie vrátila hru.
    expect(processSpendCap().snapshot().reservedUsd).toBe(0);
    expect(processFallbackSpendCap().snapshot().reservedUsd).toBe(0);
  });

  it('bills the backup from its own cap, so a tight main cap still lets it play', async () => {
    // Hlavní strop pustí jen primár (nejhorší případ ~0,0016 USD), ne astru (~0,08 USD).
    stubEnv({ ...OSS, ...ASTRA_BACKUP, WORLDSMITH_SPEND_CAP_USD: '0.01' });
    stubFetch({ 'api.together.xyz': 503, 'api.openai.com': 'ok' });
    const game = await getDirector(Date.now(), 'book-caller')(SENTENCE);
    expect(game.authoredBy).toBe('gpt-6-astra');
    expect(processSpendCap().snapshot()).toMatchObject({ callsMade: 1, reservedUsd: 0 });
    const backup = processFallbackSpendCap().snapshot();
    expect(backup).toMatchObject({ callsMade: 1, reservedUsd: 0 });
    expect(backup.spentUsd).toBeCloseTo(costUsd(USAGE, ASTRA_PRICE), 12);
  });

  it('an exhausted backup cap leaves the game on the primary alone', async () => {
    stubEnv({ ...OSS, ...ASTRA_BACKUP, WORLDSMITH_FALLBACK_SPEND_CAP_USD: '0.01', PLAY_DIRECTOR_HEDGE_MS: '0' });
    const up = stubFetch({ 'api.together.xyz': 'ok', 'api.openai.com': 'ok' });
    expect(await getDirector(Date.now(), 'cap-caller')(SENTENCE)).toMatchObject({ source: 'authored', authoredBy: 'openai/gpt-oss-20b' });
    expect(up.called).toEqual(['api.together.xyz']);

    const down = stubFetch({ 'api.together.xyz': 503, 'api.openai.com': 'ok' });
    expect((await getDirector(Date.now(), 'cap-caller-2')(SENTENCE + ' fast')).source).toBe('draft');
    expect(down.called).not.toContain('api.openai.com');
  });

  it('a paid backup without its own cap never runs, whatever the main cap allows', async () => {
    stubEnv({ ...OSS, ...ASTRA_BACKUP, WORLDSMITH_FALLBACK_SPEND_CAP_USD: '', WORLDSMITH_SPEND_CAP_USD: '100' });
    const { called } = stubFetch({ 'api.together.xyz': 503, 'api.openai.com': 'ok' });
    expect((await getDirector(Date.now(), 'nocap-caller')(SENTENCE)).source).toBe('draft');
    expect(called).not.toContain('api.openai.com');
  });
});

describe('the minimum time left depends on the model', () => {
  it('gpt-oss needs 30 s, astra 75 s, a free llama.cpp backup nothing', () => {
    const oss = upstreamConfigFromEnv(OSS);
    const astra = upstreamConfigFromEnv({ ...OSS, WORLDSMITH_MODEL: 'gpt-6-astra' });
    const free = upstreamConfigFromEnv({ ...OSS, WORLDSMITH_FALLBACK_ENDPOINT: 'llamacpp:http://127.0.0.1:8792' })?.fallback;
    expect(oss && minCallMs(oss)).toBe(OSS_MIN_CALL_MS);
    expect(astra && minCallMs(astra)).toBe(MIN_CALL_MS);
    expect(free && minCallMs(free)).toBe(0);
    expect(OSS_MIN_CALL_MS).toBeLessThan(MIN_CALL_MS);
  });

  it('calls hosted gpt-oss with 40 s left, where an astra primary is skipped', async () => {
    stubEnv({ ...OSS });
    const oss = stubFetch({ 'api.together.xyz': 'ok' });
    expect((await getDirector(startedWith(40_000), 'time-caller')(SENTENCE)).authoredBy).toBe('openai/gpt-oss-20b');
    expect(oss.called).toEqual(['api.together.xyz']);

    stubEnv({ ...OSS, WORLDSMITH_MODEL: 'gpt-6-astra' });
    answers.store = memoryAnswerStore();
    const astra = stubFetch({ 'api.together.xyz': 'ok' });
    expect((await getDirector(startedWith(40_000), 'time-caller-2')(SENTENCE)).source).toBe('draft');
    expect(astra.called).toEqual([]);
  });

  it('does not start the astra backup without the time astra needs', async () => {
    stubEnv({ ...OSS, ...ASTRA_BACKUP });
    const { called } = stubFetch({ 'api.together.xyz': 503, 'api.openai.com': 'ok' });
    expect((await getDirector(startedWith(40_000), 'late-caller')(SENTENCE)).source).toBe('draft');
    expect(called).toEqual(['api.together.xyz']);
    expect(processFallbackSpendCap().snapshot().callsMade).toBe(0);
  });
});

describe('the paid backup has its own pool of slots (T2a, T2b)', () => {
  const LLAMA = { WORLDSMITH_FALLBACK_ENDPOINT: 'llamacpp:http://127.0.0.1:8792' } as const;

  /** Primár odpoví stavem `primary`; volání zálohy čekají na `open()` a zrušené odmítnou. */
  function gatedBackup(backupHost: string, primary: number) {
    const called: string[] = [];
    const waiting: (() => void)[] = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      const host = new URL(url).host;
      called.push(host);
      if (host !== backupHost) return Promise.resolve(new Response('{}', { status: primary }));
      return new Promise((resolve, reject) => {
        waiting.push(() => resolve(answer()));
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
      });
    });
    return { called, waiting, open: () => waiting.splice(0).forEach((go) => go()) };
  }

  /** Dvě režie, jejichž primár selže; vrací se, až obě zálohy visí u poskytovatele. */
  async function twoBackupsInFlight(backupHost: string) {
    const up = gatedBackup(backupHost, 503);
    const games = [getDirector(Date.now(), 'pool-a')(`${SENTENCE} one`), getDirector(Date.now(), 'pool-b')(`${SENTENCE} two`)];
    await vi.waitFor(() => expect(up.waiting).toHaveLength(2));
    return { up, games };
  }

  it('starts while two director calls hold both play slots', async () => {
    stubEnv({ ...OSS, ...ASTRA_BACKUP, WORLDSMITH_FALLBACK_TIMEOUT_MS: '3000' });
    const { up, games } = await twoBackupsInFlight('api.openai.com');
    expect(slotsDetail('play')).toContain('2 play');
    up.open();
    expect((await Promise.all(games)).map((game) => game.authoredBy)).toEqual(['gpt-6-astra', 'gpt-6-astra']);
    expect(slotsDetail('play')).toContain('0 play');
  });

  it('refuses a third paid backup while two are in flight', async () => {
    stubEnv({ ...OSS, ...ASTRA_BACKUP, WORLDSMITH_FALLBACK_TIMEOUT_MS: '3000' });
    const { up, games } = await twoBackupsInFlight('api.openai.com');
    // Dveře širší než zásoba zálohy: jeden jejich slot se půjčí třetí režii.
    releaseSlot('play');
    expect((await getDirector(Date.now(), 'pool-c')(`${SENTENCE} three`)).source).toBe('draft');
    expect(up.called.filter((host) => host === 'api.openai.com')).toHaveLength(2);
    expect(acquireSlot('play')).toBe(true);
    up.open();
    expect((await Promise.all(games)).map((game) => game.authoredBy)).toEqual(['gpt-6-astra', 'gpt-6-astra']);
    expect(processFallbackSpendCap().snapshot()).toMatchObject({ callsMade: 2, reservedUsd: 0 });
  });

  it('gives its slot back when the backup fails or times out', async () => {
    stubEnv({ ...OSS, ...ASTRA_BACKUP, WORLDSMITH_FALLBACK_TIMEOUT_MS: '300' });
    for (const reply of [503, 'hang'] as const) {
      const { called } = stubFetch({ 'api.together.xyz': 503, 'api.openai.com': reply });
      for (const n of [1, 2, 3]) expect((await getDirector(Date.now(), `back-${reply}-${n}`)(`${SENTENCE} ${reply} ${n}`)).source).toBe('draft');
      expect(called.filter((host) => host === 'api.openai.com')).toHaveLength(3);
    }
    stubEnv({ WORLDSMITH_FALLBACK_TIMEOUT_MS: '3000' });
    const { up, games } = await twoBackupsInFlight('api.openai.com');
    up.open();
    expect((await Promise.all(games)).map((game) => game.authoredBy)).toEqual(['gpt-6-astra', 'gpt-6-astra']);
  });

  it('a free llama.cpp backup takes no slot, even with two in flight', async () => {
    stubEnv({ ...OSS, ...LLAMA, WORLDSMITH_FALLBACK_TIMEOUT_MS: '3000' });
    const { up, games } = await twoBackupsInFlight('127.0.0.1:8792');
    releaseSlot('play');
    const third = getDirector(Date.now(), 'pool-c')(`${SENTENCE} three`);
    await vi.waitFor(() => expect(up.waiting).toHaveLength(3));
    up.open();
    expect((await Promise.all([...games, third])).map((game) => game.source)).toEqual(['authored', 'authored', 'authored']);
    // Půjčený slot vrátit: test ho dveřím ubral, třetí režie ho vzala a vrátila.
    expect(acquireSlot('play')).toBe(true);
    expect(slotsDetail('play')).toContain('0 play');
  });
});

describe('the billed line', () => {
  it('carries what the cap charged, the whole reservation for a call without a receipt', async () => {
    stubEnv({ ...OSS, WORLDSMITH_UPSTREAM_TIMEOUT_MS: '300' });
    stubFetch({ 'api.together.xyz': 'hang' });
    const lines: unknown[] = [];
    const info = vi.spyOn(console, 'info').mockImplementation((line: unknown) => void lines.push(line));
    expect((await getDirector(Date.now(), 'bill-caller')(SENTENCE)).source).toBe('draft');
    info.mockRestore();
    const charged = processSpendCap().snapshot().spentUsd;
    expect(charged).toBeGreaterThan(0);
    expect(lines).toEqual([billedLine('openai/gpt-oss-20b', charged)]);
  });
});

describe('the upstream kill switch', () => {
  it('turns off the primary and the backup, and the player gets a draft from the words', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p30a-kill-'));
    temporary.push(dir);
    const file = join(dir, 'control.json');
    writeFileSync(file, JSON.stringify({ off: ['upstream'] }), 'utf8');
    stubEnv({ ...OSS, ...ASTRA_BACKUP, WORLDSMITH_CONTROL_FILE: file, PLAY_DIRECTOR_HEDGE_MS: '0' });
    const { called } = stubFetch({ 'api.together.xyz': 'ok', 'api.openai.com': 'ok' });
    const game = await getDirector(Date.now(), 'kill-caller')(SENTENCE);
    expect(game.source).toBe('draft');
    expect(called).toEqual([]);
  });

  it('stops the backup when it is flipped while the primary is still out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p30a-kill-'));
    temporary.push(dir);
    const file = join(dir, 'control.json');
    stubEnv({ ...OSS, ...ASTRA_BACKUP, WORLDSMITH_CONTROL_FILE: file });
    const called: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      const host = new URL(url).host;
      called.push(host);
      // Operátor vypne model, zatímco primár ještě běží; primár pak selže.
      writeFileSync(file, JSON.stringify({ off: ['upstream'] }), 'utf8');
      return Promise.resolve(host === 'api.openai.com' ? answer() : new Response('{}', { status: 503 }));
    });
    expect((await getDirector(Date.now(), 'kill-late-caller')(SENTENCE)).source).toBe('draft');
    expect(called).toEqual(['api.together.xyz']);
    expect(processFallbackSpendCap().snapshot().callsMade).toBe(0);
  });
});

describe('the backup book', () => {
  it('keeps its own process ledger, apart from the main one', async () => {
    expect(processLedger('fallback')).not.toBe(processLedger());
    await processLedger('fallback').add(1, 1);
    expect(await processLedger().add(0, 0)).toEqual({ usd: 0, calls: 0 });
  });

  it('writes its own keys in the shared store, under the main prefix', async () => {
    const bodies: string[] = [];
    const fetchImpl = ((_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return Promise.resolve(new Response(JSON.stringify([{ result: '0' }, { result: '0' }])));
    }) as unknown as typeof fetch;
    const env = { WORLDSMITH_SPEND_STORE_URL: 'https://store.test', WORLDSMITH_SPEND_STORE_TOKEN: 't', VERCEL_ENV: 'production' };
    await ledgerFromEnv(env, fetchImpl)?.add(0, 0);
    await ledgerFromEnv(env, fetchImpl, 'fallback')?.add(0, 0);
    expect(bodies[0]).toContain('"worldsmith:spend:usd"');
    expect(bodies[1]).toContain('"worldsmith:spend:fallback:usd"');
    expect(bodies[1]).toContain('"worldsmith:spend:fallback:calls"');
  });

  it('reads only its own amount: the main cap never lends it money', async () => {
    const env = { WORLDSMITH_SPEND_CAP_USD: '100', VERCEL_ENV: 'production' };
    expect((await fallbackSpendCapFromEnv(env).reserve(0.01)).ok).toBe(false);
    expect((await fallbackSpendCapFromEnv({ ...env, WORLDSMITH_FALLBACK_SPEND_CAP_USD: 'abc' }).reserve(0.01)).ok).toBe(false);
    expect((await fallbackSpendCapFromEnv({ ...env, WORLDSMITH_FALLBACK_SPEND_CAP_USD: '1' }).reserve(0.01)).ok).toBe(true);
    // Záloha zdarma projde i nulovým stropem.
    expect((await fallbackSpendCapFromEnv(env).reserve(0)).ok).toBe(true);
  });

  it('counts its calls against its own call cap, not the main one', async () => {
    const env = { WORLDSMITH_FALLBACK_SPEND_CAP_USD: '5', VERCEL_ENV: 'production' };
    const once = fallbackSpendCapFromEnv({ ...env, WORLDSMITH_CALL_CAP: '5000', WORLDSMITH_FALLBACK_CALL_CAP: '1' });
    const first = await once.reserve(0.01);
    if (first.ok) await first.settle(0.01);
    expect(first.ok).toBe(true);
    expect(await once.reserve(0.01)).toMatchObject({ ok: false });

    resetProcessSpendCap();
    // Přitažený hlavní počet zálohu nezastaví; bez vlastní hodnoty platí výchozích 200.
    const loose = fallbackSpendCapFromEnv({ ...env, WORLDSMITH_CALL_CAP: '1' });
    for (let call = 0; call < 2; call++) expect((await loose.reserve(0.01)).ok).toBe(true);
  });
});
