/**
 * **Cache odpovědí modelu pro doslova stejnou větu** (P16 T6).
 *
 * Čtyři vlastnosti, kvůli kterým tenhle soubor existuje, a každá má svůj
 * test níž: zásah vrátí obě odpovědi, změna verze promptu je jiný klíč,
 * `WORLDSMITH_ANSWER_CACHE=off` cache vůbec nepostaví, a rozbitý záznam je
 * miss, nikdy pád. Síťový adaptér se soudí přes `fetch` double — táž
 * doktrína jako u `spend-store.test.ts`: ověřený je port, ne živý Upstash.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  ANSWER_CACHE_TIMEOUT_MS,
  ANSWER_TTL_SECONDS,
  answerCache,
  answerCacheFromEnv,
  answerKey,
  httpAnswerStore,
  memoryAnswerStore,
  normalizeSentence,
  processAnswerStore,
  resetProcessAnswerStore,
  type AnswerStore,
} from '../answer-cache';

const KEY_INPUT = { sentence: 'A cabin with a table', promptVersion: 'v-1', model: 'gpt-5.6-sol', effort: 'high' };
const ANSWERS = { planner: { intent: { setting: 'a cabin' } }, compiler: { geometry: { nodes: [] } } };

describe('klíč', () => {
  it('normalizace: trim, jedna mezera, malá písmena', () => {
    expect(normalizeSentence('  A   Cabin\twith\n a table  ')).toBe('a cabin with a table');
  });

  it('dvě věty lišící se jen mezerami a velikostí písmen dají týž klíč', () => {
    expect(answerKey({ ...KEY_INPUT, sentence: '  a CABIN  with a table ' })).toBe(answerKey(KEY_INPUT));
  });

  it('jiná verze promptu, model nebo úsilí je jiný klíč', () => {
    const base = answerKey(KEY_INPUT);
    expect(answerKey({ ...KEY_INPUT, promptVersion: 'v-2' })).not.toBe(base);
    expect(answerKey({ ...KEY_INPUT, model: 'gpt-5.6-terra' })).not.toBe(base);
    expect(answerKey({ ...KEY_INPUT, effort: 'low' })).not.toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('cache nad úložištěm v paměti', () => {
  it('zásah vrátí obě odpovědi a razítko uložení', async () => {
    const cache = answerCache(memoryAnswerStore(() => 1_000));
    const key = answerKey(KEY_INPUT);
    expect(await cache.read(key)).toBeNull();
    await cache.write(key, ANSWERS);
    const hit = await cache.read(key);
    expect(hit?.planner).toEqual(ANSWERS.planner);
    expect(hit?.compiler).toEqual(ANSWERS.compiler);
    expect(typeof hit?.storedAt).toBe('string');
  });

  it('po změně verze promptu je táž věta miss', async () => {
    const cache = answerCache(memoryAnswerStore(() => 1_000));
    await cache.write(answerKey(KEY_INPUT), ANSWERS);
    expect(await cache.read(answerKey({ ...KEY_INPUT, promptVersion: 'v-2' }))).toBeNull();
  });

  it('záznam po sedmi dnech vyprší', async () => {
    let now = 1_000;
    const cache = answerCache(memoryAnswerStore(() => now));
    const key = answerKey(KEY_INPUT);
    await cache.write(key, ANSWERS);
    now += ANSWER_TTL_SECONDS * 1000 - 1;
    expect(await cache.read(key)).not.toBeNull();
    now += 1;
    expect(await cache.read(key)).toBeNull();
  });

  it('poškozený JSON i záznam špatného tvaru je miss, ne pád', async () => {
    const store = memoryAnswerStore(() => 1_000);
    const log = vi.fn();
    const cache = answerCache(store, log);
    await store.set('broken', '{not json', ANSWER_TTL_SECONDS);
    await store.set('shape', JSON.stringify({ planner: {} }), ANSWER_TTL_SECONDS);
    await store.set('null', 'null', ANSWER_TTL_SECONDS);
    expect(await cache.read('broken')).toBeNull();
    expect(await cache.read('shape')).toBeNull();
    expect(await cache.read('null')).toBeNull();
    expect(log).toHaveBeenCalledTimes(3);
  });

  it('úložiště, které vyhazuje, je miss při čtení a ticho při zápisu — nikdy pád', async () => {
    const failing: AnswerStore = {
      id: 'failing',
      get: () => Promise.reject(new Error('store down')),
      set: () => Promise.reject(new Error('store down')),
    };
    const log = vi.fn();
    const cache = answerCache(failing, log);
    expect(await cache.read('k')).toBeNull();
    await expect(cache.write('k', ANSWERS)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('procesové úložiště je jedno na proces a jde vynulovat jen pro testy', async () => {
    resetProcessAnswerStore();
    await processAnswerStore().set('k', 'v', ANSWER_TTL_SECONDS);
    expect(await processAnswerStore().get('k')).toBe('v');
    resetProcessAnswerStore();
    expect(await processAnswerStore().get('k')).toBeNull();
  });
});

describe('síťový adaptér (REST protokol Upstash)', () => {
  const config = { url: 'https://cache.example.com', token: 'tok', prefix: 'worldsmith:spend', timeoutMs: ANSWER_CACHE_TIMEOUT_MS };

  it('zápis je SET s EX na klíč pod předponou knihy, čtení je GET', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ result: calls.length === 1 ? 'OK' : '{"planner":1,"compiler":2,"storedAt":"t"}' }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const store = httpAnswerStore(config, fetchImpl);
    await store.set('abc', 'value', ANSWER_TTL_SECONDS);
    expect(calls[0].url).toBe('https://cache.example.com/');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual(['SET', 'worldsmith:spend:answer:abc', 'value', 'EX', String(ANSWER_TTL_SECONDS)]);
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe('Bearer tok');

    expect(await store.get('abc')).toBe('{"planner":1,"compiler":2,"storedAt":"t"}');
    expect(calls[1].url).toBe('https://cache.example.com/get/worldsmith%3Aspend%3Aanswer%3Aabc');
  });

  it('chybějící klíč je null, ne výjimka; chybový stav úložiště je výjimka', async () => {
    const missing = httpAnswerStore(config, (async () => new Response(JSON.stringify({ result: null }))) as unknown as typeof fetch);
    expect(await missing.get('abc')).toBeNull();
    const down = httpAnswerStore(config, (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch);
    await expect(down.get('abc')).rejects.toThrow('503');
    await expect(down.set('abc', 'v', 1)).rejects.toThrow('503');
  });
});

describe('podle prostředí', () => {
  it('`WORLDSMITH_ANSWER_CACHE=off` cache nepostaví vůbec, ani nad sdíleným úložištěm', () => {
    expect(answerCacheFromEnv({ WORLDSMITH_ANSWER_CACHE: 'off' })).toBeNull();
    expect(answerCacheFromEnv({ WORLDSMITH_ANSWER_CACHE: 'OFF ', KV_REST_API_URL: 'https://x.upstash.io', KV_REST_API_TOKEN: 't' })).toBeNull();
  });

  it('bez sdíleného úložiště je to procesová paměť, se sdíleným úložištěm REST', () => {
    expect(answerCacheFromEnv({})?.id).toBe('process-memory');
    expect(answerCacheFromEnv({ KV_REST_API_URL: 'https://x.upstash.io', KV_REST_API_TOKEN: 't' })?.id).toBe('http');
    expect(answerCacheFromEnv({ WORLDSMITH_SPEND_STORE_URL: 'https://y.upstash.io/', WORLDSMITH_SPEND_STORE_TOKEN: 't' })?.id).toBe('http');
  });
});
