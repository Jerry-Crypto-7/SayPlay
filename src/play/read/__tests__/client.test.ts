import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { memoryAnswerStore } from '@/server/answer-cache';
import { processSpendCap, resetProcessSpendCap, type Reservation, type SpendCap } from '@/server/spend-cap';

import { DEFAULT_READER_BUDGET_MS, readBeforeDraft, readerCacheKey, readerConfigFromEnv, readerPromptVersion, readSentence } from '../client';
import { READING_JSON_SCHEMA, readingSchema, type Reading } from '../schema';

const READING: Reading = {
  control: 'runner',
  verbs: [{ word: 'runs', class: 'runner' }],
  hero: 'corgi',
  roles: [{ noun: 'bone', kind: 'collectible', count: 3 }],
  setting: 'neon city',
  mood: 'fast',
  numbers: { seconds: null, counts: [3] },
  genre: { genre: 'runner', mode: 'default' },
  foe: null,
  item: 'bone',
  world: 'city',
  title: 'Neon Bone Dash',
};

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

const servers: Server[] = [];

async function stub(handler: Handler): Promise<{ endpoint: string; hits: () => number }> {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => handler(req, body, res));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { endpoint: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, hits: () => hits };
}

const chat = (content: string) => JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] });

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => resolve());
        }),
    ),
  );
});

describe('readingSchema', () => {
  it('caps verbs at 4 and roles at 6', () => {
    const verbs = Array.from({ length: 5 }, () => ({ word: 'run', class: 'runner' }));
    const roles = Array.from({ length: 7 }, () => ({ noun: 'coin', kind: 'collectible', count: null }));
    expect(readingSchema.safeParse({ ...READING, verbs }).success).toBe(false);
    expect(readingSchema.safeParse({ ...READING, roles }).success).toBe(false);
    expect(readingSchema.safeParse(READING).success).toBe(true);
  });

  it('rejects a control the game does not have', () => {
    expect(readingSchema.safeParse({ ...READING, control: 'aim_shoot' }).success).toBe(false);
  });

  it('gives llama.cpp a schema where every field is required', () => {
    expect(READING_JSON_SCHEMA.$schema).toBeUndefined();
    expect(READING_JSON_SCHEMA.required).toEqual(['control', 'verbs', 'hero', 'roles', 'setting', 'mood', 'numbers', 'genre', 'foe', 'item', 'world', 'title']);
    expect(READING_JSON_SCHEMA.additionalProperties).toBe(false);
  });
});

describe('readSentence', () => {
  it('returns the reading the model wrote', async () => {
    let sent: Record<string, unknown> = {};
    const { endpoint } = await stub((req, body, res) => {
      sent = { url: req.url, ...(JSON.parse(body) as Record<string, unknown>) };
      res.end(chat(JSON.stringify(READING)));
    });
    await expect(readSentence('a corgi runs through a neon city', { endpoint, timeoutMs: 2000 })).resolves.toEqual(READING);
    expect(sent.url).toBe('/v1/chat/completions');
    expect(sent.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: READING_JSON_SCHEMA } });
    expect(sent.reasoning_effort).toBe('low');
    expect(JSON.stringify(sent.messages)).toContain('a corgi runs through a neon city');
  });

  it('gives up at the timeout when the server hangs', async () => {
    const { endpoint } = await stub(() => undefined);
    const started = Date.now();
    await expect(readSentence('a corgi runs', { endpoint, timeoutMs: 150 })).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('returns null on an HTTP error', async () => {
    const { endpoint } = await stub((_req, _body, res) => {
      res.statusCode = 500;
      res.end(chat(JSON.stringify(READING)));
    });
    await expect(readSentence('a corgi runs', { endpoint, timeoutMs: 2000 })).resolves.toBeNull();
  });

  it('returns null when the content is not JSON', async () => {
    const { endpoint } = await stub((_req, _body, res) => res.end(chat('{"control": "runner", ')));
    await expect(readSentence('a corgi runs', { endpoint, timeoutMs: 2000 })).resolves.toBeNull();
  });

  it('returns null when the JSON breaks the contract', async () => {
    const { endpoint } = await stub((_req, _body, res) => res.end(chat(JSON.stringify({ ...READING, control: 'fly' }))));
    await expect(readSentence('a corgi runs', { endpoint, timeoutMs: 2000 })).resolves.toBeNull();
  });

  it('returns null when the reply has no message', async () => {
    const { endpoint } = await stub((_req, _body, res) => res.end('{"choices": []}'));
    await expect(readSentence('a corgi runs', { endpoint, timeoutMs: 2000 })).resolves.toBeNull();
  });

  it('never calls the server when PLAY_READER=off', async () => {
    vi.stubEnv('PLAY_READER', 'off');
    const { endpoint, hits } = await stub((_req, _body, res) => res.end(chat(JSON.stringify(READING))));
    await expect(readSentence('a corgi runs', { endpoint, timeoutMs: 2000 })).resolves.toBeNull();
    expect(hits()).toBe(0);
  });

  it('returns null without an endpoint or when nothing listens', async () => {
    await expect(readSentence('a corgi runs', { endpoint: '', timeoutMs: 2000 })).resolves.toBeNull();
    await expect(readSentence('a corgi runs', { endpoint: 'http://127.0.0.1:1', timeoutMs: 2000 })).resolves.toBeNull();
  });
});

// --- P56A T4: transporty režiséra, rozpočet, strop, cache ---

const GROQ = {
  PLAY_READER: 'on',
  PLAY_READER_ENDPOINT: 'openai:https://api.groq.com/openai',
  PLAY_READER_KEY: 'gsk-test',
  PLAY_READER_MODEL: 'openai/gpt-oss-20b',
  PLAY_READER_USD_PER_MTOK_IN: '0.075',
  PLAY_READER_USD_PER_MTOK_OUT: '0.30',
} as const;
const LOCAL = { PLAY_READER: 'on', PLAY_READER_ENDPOINT: 'llamacpp:http://127.0.0.1:8792', PLAY_READER_MODEL: 'gpt-oss-20b' } as const;

type FetchArgs = [input: string | URL | Request, init?: RequestInit];
const VISITOR = '203.0.113.7';

const replying = (content: string, status = 200) =>
  vi.fn(async (..._args: FetchArgs) =>
    new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 300 } }), { status }),
  );

/** fetch, který odpoví až zrušením signálu – čtečka, která mlčí. */
const hanging = () =>
  vi.fn(
    (...[, init]: FetchArgs) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
  );

function bookkeeping(allow = true) {
  const reserved: number[] = [];
  const settled: (number | 'unknown')[] = [];
  const cap: Pick<SpendCap, 'reserve'> = {
    reserve: vi.fn(async (usd: number): Promise<Reservation> => {
      reserved.push(usd);
      if (!allow) return { ok: false, reason: 'CAP_EXHAUSTED', detail: 'test cap', snapshot: {} as never };
      return {
        ok: true,
        reservedUsd: usd,
        settle: async (actual) => {
          settled.push(actual);
          return actual === 'unknown' ? usd : actual;
        },
      };
    }),
  };
  return { cap, reserved, settled };
}

const tempDirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readerConfigFromEnv', () => {
  it('takes Groq with a key, a model and a price, metered', () => {
    expect(readerConfigFromEnv(GROQ)).toMatchObject({
      endpoint: 'openai:https://api.groq.com/openai',
      apiKey: 'gsk-test',
      model: 'openai/gpt-oss-20b',
      profile: 'api',
      pricing: { usdPerMTokIn: 0.075, usdPerMTokOut: 0.3 },
      timeoutMs: DEFAULT_READER_BUDGET_MS,
    });
    expect(DEFAULT_READER_BUDGET_MS).toBe(700);
  });

  it.each(['PLAY_READER_KEY', 'PLAY_READER_MODEL', 'PLAY_READER_USD_PER_MTOK_OUT'] as const)('is off for a hosted reader without %s', (name) => {
    expect(readerConfigFromEnv({ ...GROQ, [name]: '' })).toBeNull();
    expect(readerConfigFromEnv({ ...GROQ, [name]: undefined })).toBeNull();
  });

  it('is off for a hosted reader with a zero price', () => {
    expect(readerConfigFromEnv({ ...GROQ, PLAY_READER_USD_PER_MTOK_OUT: '0' })).toBeNull();
  });

  it('takes llama.cpp and a bare llama-server root for free', () => {
    expect(readerConfigFromEnv(LOCAL)).toMatchObject({ endpoint: 'llamacpp:http://127.0.0.1:8792', model: 'gpt-oss-20b', pricing: { usdPerMTokIn: 0, usdPerMTokOut: 0 } });
    expect(readerConfigFromEnv({ PLAY_READER_ENDPOINT: 'http://127.0.0.1:8791' })).toMatchObject({ endpoint: 'llamacpp:http://127.0.0.1:8791', model: 'local-reader' });
  });

  it('takes codex-cli on the subscription', () => {
    expect(readerConfigFromEnv({ PLAY_READER_ENDPOINT: 'codex-cli' })).toMatchObject({ endpoint: 'codex-cli', model: 'gpt-6-astra', profile: 'subscription', pricing: { usdPerMTokOut: 0 } });
  });

  it('refuses an unknown transport', () => {
    expect(readerConfigFromEnv({ PLAY_READER_ENDPOINT: 'ftp://reader' })).toBeNull();
  });

  it.each([['60000', 60_000], ['250', 250], ['soon', 700], ['0', 700], ['-5', 700], ['2.5', 700], ['200000', 700]] as const)('reads a budget of %s as %i ms', (raw, ms) => {
    expect(readerConfigFromEnv({ ...LOCAL, PLAY_READER_BUDGET_MS: raw })?.timeoutMs).toBe(ms);
  });
});

describe('readBeforeDraft on a hosted reader', () => {
  it('reserves the worst case in the cap, calls once and settles the receipt', async () => {
    const fetchImpl = replying(JSON.stringify(READING));
    const { cap, reserved, settled } = bookkeeping();
    await expect(readBeforeDraft('a corgi runs', GROQ, { fetchImpl, cap, store: null, caller: VISITOR })).resolves.toEqual(READING);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer gsk-test');
    expect(reserved).toHaveLength(1);
    expect(reserved[0]).toBeGreaterThan(0);
    expect(reserved[0]).toBeLessThan(0.001);
    expect(settled).toEqual([(900 * 0.075 + 300 * 0.3) / 1_000_000]);
  });

  it('never reserves nor calls without a key', async () => {
    const fetchImpl = replying(JSON.stringify(READING));
    const { cap } = bookkeeping();
    await expect(readBeforeDraft('a corgi runs', { ...GROQ, PLAY_READER_KEY: '' }, { fetchImpl, cap, store: null, caller: VISITOR })).resolves.toBeNull();
    expect(cap.reserve).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns null without a call when the cap refuses', async () => {
    const fetchImpl = replying(JSON.stringify(READING));
    const { cap, reserved } = bookkeeping(false);
    await expect(readBeforeDraft('a corgi runs', GROQ, { fetchImpl, cap, store: null, caller: VISITOR })).resolves.toBeNull();
    expect(reserved).toHaveLength(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns null without a reservation when the upstream kill switch is on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p56a-reader-kill-'));
    tempDirs.push(dir);
    const file = join(dir, 'control.json');
    writeFileSync(file, JSON.stringify({ enabled: true, capUsd: 5, off: ['upstream'] }), 'utf8');
    const fetchImpl = replying(JSON.stringify(READING));
    const { cap } = bookkeeping();
    await expect(readBeforeDraft('a corgi runs', { ...GROQ, WORLDSMITH_CONTROL_FILE: file }, { fetchImpl, cap, store: null, caller: VISITOR })).resolves.toBeNull();
    expect(cap.reserve).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['a 500', () => replying(JSON.stringify(READING), 500), 'unknown'],
    ['a 429', () => replying(JSON.stringify(READING), 429), 'unknown'],
    ['a 400', () => replying(JSON.stringify(READING), 400), 'unknown'],
    ['a dropped connection', () => vi.fn(async (..._args: FetchArgs): Promise<Response> => { throw new TypeError('fetch failed'); }), 'unknown'],
    ['a body that is not JSON', () => vi.fn(async (..._args: FetchArgs) => new Response('<html>', { status: 200 })), 'unknown'],
    ['content that is not JSON', () => replying('{"control": "runner", "verbs": ['), 'receipt'],
    ['JSON that breaks the contract', () => replying(JSON.stringify({ ...READING, control: 'fly' })), 'receipt'],
  ] as const)('returns null on %s and still settles the reservation', async (_name, make, charge) => {
    const { cap, settled } = bookkeeping();
    await expect(readBeforeDraft('a corgi runs', GROQ, { fetchImpl: make(), cap, store: null, caller: VISITOR })).resolves.toBeNull();
    expect(settled).toHaveLength(1);
    if (charge === 'unknown') expect(settled[0]).toBe('unknown');
    else expect(settled[0]).toBeGreaterThan(0);
  });
});

describe('readBeforeDraft paid limits (T4 review)', () => {
  it('never pays without a caller', async () => {
    const fetchImpl = replying(JSON.stringify(READING));
    const { cap } = bookkeeping();
    await expect(readBeforeDraft('a corgi runs', GROQ, { fetchImpl, cap, store: null })).resolves.toBeNull();
    expect(cap.reserve).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stops a caller at PLAY_READER_CALLS_PER_CALLER and releases the reservation', async () => {
    const fetchImpl = replying(JSON.stringify(READING));
    const { cap, settled } = bookkeeping();
    const env = { ...GROQ, PLAY_READER_CALLS_PER_CALLER: '1' };
    await expect(readBeforeDraft('a corgi runs', env, { fetchImpl, cap, store: null, caller: 'quota-visitor' })).resolves.toEqual(READING);
    await expect(readBeforeDraft('a pug swims', env, { fetchImpl, cap, store: null, caller: 'quota-visitor' })).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(settled.at(-1)).toBe(0);
  });

  it("pays from the reader's own cap: unset is zero and the director's cap stays untouched", async () => {
    resetProcessSpendCap();
    const fetchImpl = replying(JSON.stringify(READING));
    await expect(readBeforeDraft('a corgi runs', GROQ, { fetchImpl, store: null, caller: VISITOR })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(processSpendCap().snapshot().callsMade).toBe(0);
    resetProcessSpendCap();
  });
});

describe('readBeforeDraft budget', () => {
  it('gives up at 700 ms by default, drafts from words, and charges the cut call in full', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetchImpl = hanging();
    const { cap, settled } = bookkeeping();
    let result: Reading | null | 'pending' = 'pending';
    const pending = readBeforeDraft('a corgi runs', GROQ, { fetchImpl, cap, store: null, caller: VISITOR }).then((reading) => (result = reading));
    await vi.advanceTimersByTimeAsync(699);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(result).toBeNull();
    await vi.waitFor(() => expect(settled).toEqual(['unknown']));
  });

  it('leaves no budget timer behind after a quick read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await expect(readBeforeDraft('a corgi runs', LOCAL, { fetchImpl: replying(JSON.stringify(READING)), store: null })).resolves.toEqual(READING);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a free local reader is never reserved', async () => {
    const { cap } = bookkeeping();
    await expect(readBeforeDraft('a corgi runs', LOCAL, { fetchImpl: replying(JSON.stringify(READING)), cap, store: null, caller: VISITOR })).resolves.toEqual(READING);
    expect(cap.reserve).not.toHaveBeenCalled();
  });

  it('is null without a call when PLAY_READER is not on', async () => {
    const fetchImpl = replying(JSON.stringify(READING));
    await expect(readBeforeDraft('a corgi runs', { ...LOCAL, PLAY_READER: '' }, { fetchImpl, store: null })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('readBeforeDraft cache', () => {
  const keyFor = (model: string) => readerCacheKey({ sentence: 'a corgi runs', promptVersion: readerPromptVersion(), model, endpoint: LOCAL.PLAY_READER_ENDPOINT });

  it('reads the same normalised sentence once', async () => {
    const fetchImpl = replying(JSON.stringify(READING));
    const store = memoryAnswerStore();
    await expect(readBeforeDraft('A corgi runs', LOCAL, { fetchImpl, store })).resolves.toEqual(READING);
    await vi.waitFor(async () => expect(await store.get(keyFor('gpt-oss-20b'))).not.toBeNull());
    await expect(readBeforeDraft('  a CORGI   runs ', LOCAL, { fetchImpl, store })).resolves.toEqual(READING);
    expect(fetchImpl).toHaveBeenCalledOnce();
    await readBeforeDraft('a corgi runs', { ...LOCAL, PLAY_READER_MODEL: 'qwen3-4b' }, { fetchImpl, store });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not store a failed read', async () => {
    const store = memoryAnswerStore();
    await expect(readBeforeDraft('a corgi runs', LOCAL, { fetchImpl: replying('nope'), store })).resolves.toBeNull();
    expect(await store.get(keyFor('gpt-oss-20b'))).toBeNull();
  });

  it('keys on the prompt version, the model and the endpoint', () => {
    const base = { sentence: 'a corgi runs', promptVersion: readerPromptVersion(), model: 'gpt-oss-20b', endpoint: 'llamacpp:http://127.0.0.1:8792' };
    const key = readerCacheKey(base);
    expect(key).toMatch(/^reader:[0-9a-f]{64}$/);
    expect(readerCacheKey({ ...base, sentence: ' A  Corgi runs ' })).toBe(key);
    expect(readerCacheKey({ ...base, promptVersion: 'other-prompt' })).not.toBe(key);
    expect(readerCacheKey({ ...base, model: 'qwen3-4b' })).not.toBe(key);
    expect(readerCacheKey({ ...base, endpoint: 'codex-cli' })).not.toBe(key);
  });
});
