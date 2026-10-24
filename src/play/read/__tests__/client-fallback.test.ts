/**
 * Čtečka pro AI verzi (P58B T4): astra přes OpenAI API čte p95 6,4 s (T3), takže čte jen AI verzi
 * s vlastním rozpočtem 15 s a zálohou je slovník – po chybě, vypršení i bez klíče `null` a žádné
 * další volání. Route a režisér: `create-reader.test.ts`, `director-reader.test.ts`.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ANSWER_TTL_SECONDS, type AnswerStore, memoryAnswerStore } from '@/server/answer-cache';
import type { Reservation, SpendCap } from '@/server/spend-cap';

import { DEFAULT_AI_READER_BUDGET_MS, DEFAULT_LOCAL_READER_BUDGET_MS, DEFAULT_READER_BUDGET_MS, readBeforeDraft, READER_MISS_TTL_SECONDS, readerConfigFromEnv, readerForAiVersion } from '../client';
import type { Reading } from '../schema';

const READING: Reading = {
  control: 'runner', verbs: [{ word: 'runs', class: 'runner' }], hero: 'corgi', roles: [], setting: 'park', mood: null,
  numbers: { seconds: null, counts: [] }, genre: { genre: 'runner', mode: 'default' }, sure: true, foe: null, item: null, world: null, title: null,
};

/** Produkční vzor čtečky (`scripts/cloud/env.production.example`) s testovacím klíčem. */
const ASTRA = {
  PLAY_READER: 'on',
  PLAY_READER_PATH: 'ai',
  PLAY_READER_ENDPOINT: 'openai:https://api.openai.com',
  PLAY_READER_MODEL: 'gpt-6-astra',
  PLAY_READER_KEY: 'sk-test',
  PLAY_READER_USD_PER_MTOK_IN: '10',
  PLAY_READER_USD_PER_MTOK_OUT: '50',
  PLAY_STORE_DIR: mkdtempSync(join(tmpdir(), 'p58b-reader-ai-')),
} as const;
const VISITOR = '203.0.113.7';

type FetchArgs = [input: string | URL | Request, init?: RequestInit];
const replying = (status: number) =>
  vi.fn(async (..._args: FetchArgs) =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(READING) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1900, completion_tokens: 150 } }), { status }));
const hanging = () =>
  vi.fn((...[, init]: FetchArgs) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));

function bookkeeping() {
  const settled: (number | 'unknown')[] = [];
  const cap: Pick<SpendCap, 'reserve'> = {
    reserve: vi.fn(async (usd: number): Promise<Reservation> => ({ ok: true, reservedUsd: usd, settle: async (actual) => { settled.push(actual); return actual === 'unknown' ? usd : actual; } })),
  };
  return { cap, settled };
}

function memoryStore() {
  const map = new Map<string, string>();
  const writes: { value: string; ttl: number }[] = [];
  const store: AnswerStore = {
    id: 'memory',
    get: async (key) => map.get(key) ?? null,
    set: async (key, value, ttl) => {
      writes.push({ value, ttl });
      map.set(key, value);
    },
  };
  return { store, writes };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the reader for the AI version (P58B T4)', () => {
  it('is on only with PLAY_READER=on, an endpoint and PLAY_READER_PATH=ai', () => {
    expect(readerForAiVersion(ASTRA)).toBe(true);
    expect(readerForAiVersion({ ...ASTRA, PLAY_READER_PATH: '' })).toBe(false);
    expect(readerForAiVersion({ ...ASTRA, PLAY_READER_PATH: 'fast' })).toBe(false);
    expect(readerForAiVersion({ ...ASTRA, PLAY_READER: 'off' })).toBe(false);
    expect(readerForAiVersion({ ...ASTRA, PLAY_READER_ENDPOINT: '' })).toBe(false);
  });

  it('reads astra with a 15 s budget, the fast path keeps 700 ms and an explicit budget still wins', () => {
    expect(DEFAULT_AI_READER_BUDGET_MS).toBe(15_000);
    expect(readerConfigFromEnv(ASTRA)).toMatchObject({ endpoint: 'openai:https://api.openai.com', model: 'gpt-6-astra', profile: 'api', pricing: { usdPerMTokIn: 10, usdPerMTokOut: 50 }, timeoutMs: DEFAULT_AI_READER_BUDGET_MS });
    expect(readerConfigFromEnv({ ...ASTRA, PLAY_READER_PATH: '' })?.timeoutMs).toBe(DEFAULT_READER_BUDGET_MS);
    expect(readerConfigFromEnv({ ...ASTRA, PLAY_READER_BUDGET_MS: '9000' })?.timeoutMs).toBe(9000);
    expect(readerConfigFromEnv({ ...ASTRA, PLAY_READER_ENDPOINT: 'http://127.0.0.1:8791' })?.timeoutMs).toBe(DEFAULT_LOCAL_READER_BUDGET_MS);
  });

  it('falls back to the dictionary after a 5xx: null, one call, nothing else asked', async () => {
    const fetchImpl = replying(503);
    const { cap, settled } = bookkeeping();
    await expect(readBeforeDraft('a corgi runs', ASTRA, { fetchImpl, cap, store: null, caller: VISITOR })).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('https://api.openai.com/v1/chat/completions');
    expect(settled).toEqual(['unknown']);
  });

  it('waits for astra up to 15 s, then the dictionary, and the cut call is charged in full', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetchImpl = hanging();
    const { cap, settled } = bookkeeping();
    let result: Reading | null | 'pending' = 'pending';
    const pending = readBeforeDraft('a corgi runs', ASTRA, { fetchImpl, cap, store: null, caller: VISITOR }).then((reading) => (result = reading));
    await vi.advanceTimersByTimeAsync(DEFAULT_AI_READER_BUDGET_MS - 1);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(result).toBeNull();
    await vi.waitFor(() => expect(settled).toEqual(['unknown']));
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('pays a sentence once: a paid reading that failed stays in the cache for ten minutes (T4a)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetchImpl = hanging();
    const { cap, settled } = bookkeeping();
    const { store, writes } = memoryStore();
    const first = readBeforeDraft('a corgi runs', ASTRA, { fetchImpl, cap, store, caller: VISITOR });
    await vi.advanceTimersByTimeAsync(DEFAULT_AI_READER_BUDGET_MS);
    await expect(first).resolves.toBeNull();
    await vi.waitFor(() => expect(writes).toEqual([{ value: 'null', ttl: READER_MISS_TTL_SECONDS }]));
    expect(settled).toEqual(['unknown']);
    // Druhý běh režiséra s pokynem i opakovaný upgrade: táž věta, žádné další volání ani rezervace.
    await expect(readBeforeDraft('a corgi runs', ASTRA, { fetchImpl, cap, store, caller: VISITOR })).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(cap.reserve).toHaveBeenCalledOnce();
    expect(READER_MISS_TTL_SECONDS).toBeLessThan(ANSWER_TTL_SECONDS);
  });

  // Revize T4a/T4b: dva hráči, táž věta. Čtení B odešlo první a selže až po úspěšném čtení A – jeho `null` dobré čtení nepřepíše.
  it('a failed paid reading never replaces a good one that landed first', async () => {
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let calls = 0;
    const fetchImpl = vi.fn(async (..._args: FetchArgs) => {
      calls += 1;
      const content = calls === 1 ? '{}' : JSON.stringify(READING);
      if (calls === 1) await gate;
      return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1900, completion_tokens: 150 } }));
    });
    const { cap } = bookkeeping();
    const store = memoryAnswerStore();
    const late = readBeforeDraft('a corgi runs', ASTRA, { fetchImpl, cap, store, caller: VISITOR });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    await expect(readBeforeDraft('a corgi runs', ASTRA, { fetchImpl, cap, store, caller: '198.51.100.9' })).resolves.toEqual(READING);
    open();
    await expect(late).resolves.toBeNull();
    await expect(readBeforeDraft('a corgi runs', ASTRA, { fetchImpl, cap, store, caller: VISITOR })).resolves.toEqual(READING);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // Obráceně (re-revize T4ab-2): `null` B dorazí první, čtení A, které odešlo před ním, uspěje později a značku přepíše.
  it('a good reading that lands after a failed one replaces its marker', async () => {
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let calls = 0;
    const fetchImpl = vi.fn(async (..._args: FetchArgs) => {
      calls += 1;
      const content = calls === 1 ? JSON.stringify(READING) : '{}';
      if (calls === 1) await gate;
      return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1900, completion_tokens: 150 } }));
    });
    const { cap } = bookkeeping();
    const store = memoryAnswerStore();
    const late = readBeforeDraft('a corgi runs', ASTRA, { fetchImpl, cap, store, caller: VISITOR });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    await expect(readBeforeDraft('a corgi runs', ASTRA, { fetchImpl, cap, store, caller: '198.51.100.9' })).resolves.toBeNull();
    open();
    await expect(late).resolves.toEqual(READING);
    await expect(readBeforeDraft('a corgi runs', ASTRA, { fetchImpl, cap, store, caller: VISITOR })).resolves.toEqual(READING);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('remembers nothing when no call went out: a refused cap reads again next time', async () => {
    const fetchImpl = replying(200);
    const cap: Pick<SpendCap, 'reserve'> = { reserve: vi.fn(async (): Promise<Reservation> => ({ ok: false }) as Reservation) };
    const { store, writes } = memoryStore();
    await expect(readBeforeDraft('a corgi runs', ASTRA, { fetchImpl, cap, store, caller: VISITOR })).resolves.toBeNull();
    await expect(readBeforeDraft('a corgi runs', ASTRA, { fetchImpl, cap, store, caller: VISITOR })).resolves.toBeNull();
    expect(cap.reserve).toHaveBeenCalledTimes(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  // Revize testů /ship: čtení, které neodešlo kvůli volajícímu, nesmí větu zablokovat pro ostatní značkou „nevyšlo“.
  it('a visitor over the daily limit leaves no failure marker: another visitor reads the sentence', async () => {
    const fetchImpl = replying(200);
    const { cap } = bookkeeping();
    const { store, writes } = memoryStore();
    const env = { ...ASTRA, PLAY_READER_CALLS_PER_CALLER: '1', PLAY_STORE_DIR: mkdtempSync(join(tmpdir(), 'p58b-reader-limit-')) };
    await expect(readBeforeDraft('a corgi runs', env, { fetchImpl, cap, store, caller: 'limit-visitor' })).resolves.toEqual(READING);
    await expect(readBeforeDraft('a pug swims', env, { fetchImpl, cap, store, caller: 'limit-visitor' })).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce();
    await expect(readBeforeDraft('a pug swims', env, { fetchImpl, cap, store, caller: 'other-visitor' })).resolves.toEqual(READING);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(writes.map((write) => write.value)).not.toContain('null');
  });

  it('a kill switch leaves no failure marker: the sentence reads once the switch is off', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'p58b-reader-kill-')), 'control.json');
    writeFileSync(file, JSON.stringify({ enabled: true, capUsd: 5, off: ['upstream'] }), 'utf8');
    const fetchImpl = replying(200);
    const { cap } = bookkeeping();
    const { store, writes } = memoryStore();
    await expect(readBeforeDraft('a corgi runs', { ...ASTRA, WORLDSMITH_CONTROL_FILE: file }, { fetchImpl, cap, store, caller: VISITOR })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    await expect(readBeforeDraft('a corgi runs', ASTRA, { fetchImpl, cap, store, caller: VISITOR })).resolves.toEqual(READING);
  });

  it('a good paid reading stays for the full answer life, not the ten-minute miss life', async () => {
    const { cap } = bookkeeping();
    const { store, writes } = memoryStore();
    await expect(readBeforeDraft('a corgi runs', ASTRA, { fetchImpl: replying(200), cap, store, caller: VISITOR })).resolves.toEqual(READING);
    await vi.waitFor(() => expect(writes).toEqual([{ value: JSON.stringify(READING), ttl: ANSWER_TTL_SECONDS }]));
  });

  it('asks nothing and reserves nothing without a key', async () => {
    const fetchImpl = replying(200);
    const { cap } = bookkeeping();
    await expect(readBeforeDraft('a corgi runs', { ...ASTRA, PLAY_READER_KEY: '' }, { fetchImpl, cap, store: null, caller: VISITOR })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(cap.reserve).not.toHaveBeenCalled();
  });
});
