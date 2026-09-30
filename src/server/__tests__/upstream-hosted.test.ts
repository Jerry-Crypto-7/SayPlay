/**
 * **Čtvrtý druh koncového bodu: hostovaný poskytovatel s OpenAI chat API (P30A T2).**
 *
 * `openai:<kořen API>` volá `/v1/chat/completions` sdíleného poskytovatele
 * (Together / Fireworks pro `openai/gpt-oss-20b`, OpenAI API pro astru jako
 * zálohu). Na rozdíl od llama.cpp se platí po tokenech, takže účtenka jde přes
 * týž procesní strop utrácení jako každé placené volání režiséra. Stub server
 * na náhodném portu nebo podvržený `fetch`, žádná síť ven.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { genreAnswer } from '@/play/director/__fixtures__';
import { __resetProcessVersionStore } from '@/play/version';
import { type AnswerStore, memoryAnswerStore } from '@/server/answer-cache';

// Bez sdíleného úložiště dá `directorCacheFromEnv` každé režii novou paměť;
// test cache potřebuje jednu na celý test.
const answers = vi.hoisted(() => ({ store: null as AnswerStore | null }));
vi.mock('@/play/director', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/play/director')>();
  return { ...actual, directorCacheFromEnv: () => actual.directorCache(answers.store ?? memoryAnswerStore()) };
});

import { getDirector } from '../../app/api/play/_director';
import { resetConcurrency } from '../../app/api/worldstream/sessions/route';
import type { GenerationCall } from '../pipeline';
import { resetRateWindows } from '../rate-limit';
import { costUsd, processFallbackSpendCap, processSpendCap, resetProcessSpendCap } from '../spend-cap';
import { upstreamBranch, upstreamConfigFromEnv, type UpstreamConfig } from '../upstream';

const HOSTED = {
  WORLDSMITH_BRANCH: 'live',
  WORLDSMITH_MODEL_ENDPOINT: 'openai:https://api.together.xyz',
  WORLDSMITH_MODEL: 'openai/gpt-oss-20b',
  WORLDSMITH_MODEL_PROFILE: 'metered',
  WORLDSMITH_MODEL_KEY: 'tg-test-key',
  WORLDSMITH_MODEL_EFFORT: 'medium',
  WORLDSMITH_USD_PER_MTOK_IN: '0.05',
  WORLDSMITH_USD_PER_MTOK_OUT: '0.2',
} as const;

const ASTRA_BACKUP = {
  WORLDSMITH_FALLBACK_ENDPOINT: 'openai:https://api.openai.com',
  WORLDSMITH_FALLBACK_MODEL: 'gpt-6-astra',
  WORLDSMITH_FALLBACK_KEY: 'sk-test-backup',
  WORLDSMITH_FALLBACK_EFFORT: 'low',
  WORLDSMITH_FALLBACK_USD_PER_MTOK_IN: '1.25',
  WORLDSMITH_FALLBACK_USD_PER_MTOK_OUT: '10',
  WORLDSMITH_FALLBACK_SPEND_CAP_USD: '5',
} as const;

const SCHEMA = { type: 'object', additionalProperties: false, required: ['plan'], properties: { plan: { type: 'string' } } };

const CALL: GenerationCall = {
  prompt: 'a corgi runs through a neon city',
  request: { model: 'm', system: 'answer JSON', user: 'a corgi runs through a neon city', outputSchema: SCHEMA },
};

/** Odpověď chat API s uvažováním vedle textu – tak ho gpt-oss přes API vrací. */
const chat = (content: string | null, extra: Record<string, unknown> = {}, finish = 'stop') =>
  JSON.stringify({
    choices: [{ message: { role: 'assistant', content, reasoning_content: '{"plan":"thinking"}', reasoning: '{"plan":"thinking"}', ...extra }, finish_reason: finish }],
    usage: { prompt_tokens: 2000, completion_tokens: 900 },
  });

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
const servers: Server[] = [];

async function stub(handler: Handler): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => handler(req, body, res));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

afterEach(async () => {
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

function configOf(env: Record<string, string>): UpstreamConfig {
  const config = upstreamConfigFromEnv({ ...HOSTED, ...env });
  if (config === null) throw new Error('konfigurace se měla načíst');
  return config;
}

function backupOf(env: Record<string, string> = {}): UpstreamConfig {
  const fallback = configOf({ ...ASTRA_BACKUP, ...env }).fallback;
  if (fallback === undefined) throw new Error('záloha se měla načíst');
  return fallback;
}

describe('openai: config', () => {
  it('reads the metered profile, model, effort and per-token price', () => {
    const config = configOf({});
    expect(config).toMatchObject({
      endpoint: 'openai:https://api.together.xyz',
      model: 'openai/gpt-oss-20b',
      effort: 'medium',
      profile: 'api',
      callCap: null,
      pricing: { usdPerMTokIn: 0.05, usdPerMTokOut: 0.2 },
    });
  });

  it('refuses a metered provider without an output price', () => {
    expect(upstreamConfigFromEnv({ ...HOSTED, WORLDSMITH_USD_PER_MTOK_OUT: '' })).toBeNull();
    expect(upstreamConfigFromEnv({ ...HOSTED, WORLDSMITH_MODEL_PROFILE: 'metred' })).toBeNull();
  });

  it('loads a paid openai: fallback with its own key, model and price', () => {
    expect(backupOf()).toMatchObject({
      endpoint: 'openai:https://api.openai.com',
      apiKey: 'sk-test-backup',
      model: 'gpt-6-astra',
      effort: 'low',
      profile: 'api',
      pricing: { usdPerMTokIn: 1.25, usdPerMTokOut: 10 },
    });
  });

  it('drops a paid fallback without a key, a model or an output price', () => {
    for (const missing of ['WORLDSMITH_FALLBACK_KEY', 'WORLDSMITH_FALLBACK_MODEL', 'WORLDSMITH_FALLBACK_USD_PER_MTOK_OUT'])
      expect(configOf({ ...ASTRA_BACKUP, [missing]: '' })).not.toHaveProperty('fallback');
  });
});

describe('openai: generate', () => {
  it('posts a chat request with a bearer key, the output schema and the reasoning effort', async () => {
    let sent: Record<string, unknown> = {};
    let auth: string | undefined;
    const root = await stub((req, body, res) => {
      auth = req.headers.authorization;
      sent = { url: req.url, ...(JSON.parse(body) as Record<string, unknown>) };
      res.end(chat('{"plan":"run"}'));
    });
    await upstreamBranch(configOf({ WORLDSMITH_MODEL_ENDPOINT: `openai:${root}/` })).generate(CALL);
    expect(auth).toBe('Bearer tg-test-key');
    expect(sent).toMatchObject({
      url: '/v1/chat/completions',
      model: 'openai/gpt-oss-20b',
      reasoning_effort: 'medium',
      max_tokens: 8000,
      response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: SCHEMA } },
      messages: [
        { role: 'system', content: 'answer JSON' },
        { role: 'user', content: 'a corgi runs through a neon city' },
      ],
    });
  });

  it('caps the OpenAI API with max_completion_tokens, which its reasoning models require', async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const fake = ((url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return Promise.resolve(new Response(chat('{"plan":"run"}')));
    }) as unknown as typeof fetch;
    await upstreamBranch(backupOf(), fake).generate(CALL);
    expect(seen[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(seen[0].body).toMatchObject({ model: 'gpt-6-astra', reasoning_effort: 'low', max_completion_tokens: 8000 });
    expect(seen[0].body).not.toHaveProperty('max_tokens');
    expect(seen[0].body).not.toHaveProperty('temperature');
  });

  it('lowers xhigh and max to high, the top effort hosted gpt-oss knows', async () => {
    const efforts: unknown[] = [];
    const fake = ((_url: string, init: RequestInit) => {
      efforts.push((JSON.parse(String(init.body)) as { reasoning_effort: unknown }).reasoning_effort);
      return Promise.resolve(new Response(chat('{"plan":"run"}')));
    }) as unknown as typeof fetch;
    for (const effort of ['xhigh', 'max', 'low']) await upstreamBranch(configOf({ WORLDSMITH_MODEL_EFFORT: effort }), fake).generate(CALL);
    expect(efforts).toEqual(['high', 'high', 'low']);
  });

  it('reads the answer from content only, never from the reasoning next to it', async () => {
    const root = await stub((_req, _body, res) => res.end(chat('{"plan":"run"}')));
    const outcome = await upstreamBranch(configOf({ WORLDSMITH_MODEL_ENDPOINT: `openai:${root}` })).generate(CALL);
    expect(outcome).toMatchObject({ ok: true, body: { plan: 'run' }, usage: { inputTokens: 2000, outputTokens: 900 } });
    expect(outcome.ok && outcome.provenance).toMatchObject({ source: 'hosted-http', synthetic: false, model: 'openai/gpt-oss-20b' });
  });

  it('is MALFORMED_RESPONSE when only the reasoning came back', async () => {
    const root = await stub((_req, _body, res) => res.end(chat(null, {}, 'length')));
    const outcome = await upstreamBranch(configOf({ WORLDSMITH_MODEL_ENDPOINT: `openai:${root}` })).generate(CALL);
    expect(outcome).toMatchObject({ ok: false, reason: 'MALFORMED_RESPONSE' });
  });

  it.each([
    [401, 'key'],
    [403, 'key'],
    [429, 'rate'],
    [500, '500'],
    [503, '503'],
  ])('answers HTTP %i with UPSTREAM_UNAVAILABLE and the reason', async (status, reason) => {
    const root = await stub((_req, _body, res) => {
      res.statusCode = status;
      res.end('{"error":{"message":"nope"}}');
    });
    const outcome = await upstreamBranch(configOf({ WORLDSMITH_MODEL_ENDPOINT: `openai:${root}` })).generate(CALL);
    expect(outcome).toMatchObject({ ok: false, reason: 'UPSTREAM_UNAVAILABLE', usage: null });
    expect(!outcome.ok && outcome.detail).toContain(String(status));
    expect(!outcome.ok && outcome.detail).toContain(reason);
  });

  it('keeps a plain 400 as UPSTREAM_REJECTED', async () => {
    const root = await stub((_req, _body, res) => {
      res.statusCode = 400;
      res.end('{"error":{"message":"bad schema"}}');
    });
    const outcome = await upstreamBranch(configOf({ WORLDSMITH_MODEL_ENDPOINT: `openai:${root}` })).generate(CALL);
    expect(outcome).toMatchObject({ ok: false, reason: 'UPSTREAM_REJECTED' });
  });

  it('times out as UPSTREAM_UNAVAILABLE and says so, without throwing', async () => {
    const root = await stub(() => undefined);
    const config = configOf({ WORLDSMITH_MODEL_ENDPOINT: `openai:${root}`, WORLDSMITH_UPSTREAM_TIMEOUT_MS: '150' });
    const started = Date.now();
    const outcome = await upstreamBranch(config).generate(CALL);
    expect(outcome).toMatchObject({ ok: false, reason: 'UPSTREAM_UNAVAILABLE', usage: null });
    expect(!outcome.ok && outcome.detail).toContain('timed out');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('turns a refused connection into UPSTREAM_UNAVAILABLE', async () => {
    const refused = (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
    const outcome = await upstreamBranch(configOf({}), refused).generate(CALL);
    expect(outcome).toMatchObject({ ok: false, reason: 'UPSTREAM_UNAVAILABLE', usage: null });
  });

  it('does the same on the openai: fallback', async () => {
    let status = 429;
    const root = await stub((req, _body, res) => {
      if (status !== 200) {
        res.statusCode = status;
        res.end('{}');
        return;
      }
      expect(req.headers.authorization).toBe('Bearer sk-test-backup');
      res.end(chat('{"plan":"run"}'));
    });
    const branch = upstreamBranch(backupOf({ WORLDSMITH_FALLBACK_ENDPOINT: `openai:${root}` }));
    await expect(branch.generate(CALL)).resolves.toMatchObject({ ok: false, reason: 'UPSTREAM_UNAVAILABLE', detail: expect.stringContaining('429') });
    status = 200;
    await expect(branch.generate(CALL)).resolves.toMatchObject({ ok: true, body: { plan: 'run' }, provenance: { model: 'gpt-6-astra' } });
  });
});

/** Odpověď režiséra `{plan, spec}` se žánrem, ze které modul složí hratelnou hru. */
const COMPACT = genreAnswer({ genre: 'platformer', mode: 'default', hero: 'penguin', enemy: undefined, collectible: undefined, setting: 'frozen iceberg field', palette: 'snow' });
const SENTENCE = 'a penguin jumps over icebergs';
const USAGE = { inputTokens: 2000, outputTokens: 900 };

describe('the director pays a hosted call through the process spend cap', () => {
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
  });

  function stubEnv(env: Record<string, string>): void {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    resetProcessSpendCap();
  }

  /** `fetch` podle hostitele: odpověď, nebo stavový kód; zapíše, co strop držel během volání. */
  function stubFetch(answers: Record<string, number | 'ok'>) {
    const heldDuringCall: number[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      heldDuringCall.push(processSpendCap().snapshot().reservedUsd);
      const answer = answers[new URL(url).host];
      if (answer === 'ok') return Promise.resolve(new Response(chat(JSON.stringify(COMPACT))));
      return Promise.resolve(new Response('{}', { status: answer ?? 404 }));
    });
    return heldDuringCall;
  }

  it('reserves the worst case before the call and settles the metered price after it', async () => {
    stubEnv({ ...HOSTED, WORLDSMITH_SPEND_CAP_USD: '5' });
    const held = stubFetch({ 'api.together.xyz': 'ok' });
    const game = await getDirector(Date.now(), 'hosted-caller')(SENTENCE);
    expect(game.source).toBe('authored');
    expect(game.authoredBy).toBe('openai/gpt-oss-20b');
    expect(held).toHaveLength(1);
    expect(held[0]).toBeGreaterThan(0);
    const snapshot = processSpendCap().snapshot();
    expect(snapshot).toMatchObject({ reservedUsd: 0, callsMade: 1 });
    expect(snapshot.spentUsd).toBeCloseTo(costUsd(USAGE, { usdPerMTokIn: 0.05, usdPerMTokOut: 0.2 }), 12);
  });

  it('bills the paid openai: fallback through its own cap (P30A T3)', async () => {
    stubEnv({ ...HOSTED, ...ASTRA_BACKUP, WORLDSMITH_SPEND_CAP_USD: '5' });
    const held = stubFetch({ 'api.together.xyz': 503, 'api.openai.com': 'ok' });
    const game = await getDirector(Date.now(), 'backup-caller')(SENTENCE);
    expect(game.authoredBy).toBe('gpt-6-astra');
    // Záloha startuje po selhání primáru; hlavní strop už je v tu chvíli vyrovnaný.
    expect(held).toEqual([expect.any(Number), 0]);
    // Primár bez účtenky strhne celou rezervaci z hlavního stropu; záloha svou
    // skutečnou cenu podle vlastního ceníku ze svého.
    expect(processSpendCap().snapshot()).toMatchObject({ reservedUsd: 0, callsMade: 1 });
    const backup = processFallbackSpendCap().snapshot();
    expect(backup).toMatchObject({ reservedUsd: 0, callsMade: 1 });
    expect(backup.spentUsd).toBeCloseTo(costUsd(USAGE, { usdPerMTokIn: 1.25, usdPerMTokOut: 10 }), 12);
  });

  it('never caches a game the paid fallback wrote under the primary key', async () => {
    stubEnv({ ...HOSTED, ...ASTRA_BACKUP, WORLDSMITH_SPEND_CAP_USD: '5' });
    stubFetch({ 'api.together.xyz': 503, 'api.openai.com': 'ok' });
    expect((await getDirector(Date.now(), 'cache-caller')(SENTENCE)).authoredBy).toBe('gpt-6-astra');
    // Primár je zpátky: věta se ho zeptá znovu, ne hry od zálohy z cache.
    const held = stubFetch({ 'api.together.xyz': 'ok' });
    expect(await getDirector(Date.now(), 'cache-caller')(SENTENCE)).toMatchObject({ source: 'authored', authoredBy: 'openai/gpt-oss-20b' });
    expect(held).toHaveLength(1);
    // Hra od primáru se do cache dostane – cache v testu doopravdy platí.
    expect((await getDirector(Date.now(), 'cache-caller')(SENTENCE)).source).toBe('cached');
  });

  it('does not call the paid fallback when its cap refuses it', async () => {
    // Strop zálohy nepustí její nejhorší případ (~0,08 USD).
    stubEnv({ ...HOSTED, ...ASTRA_BACKUP, WORLDSMITH_SPEND_CAP_USD: '5', WORLDSMITH_FALLBACK_SPEND_CAP_USD: '0.01' });
    const held = stubFetch({ 'api.together.xyz': 503, 'api.openai.com': 'ok' });
    const game = await getDirector(Date.now(), 'refused-caller')(SENTENCE);
    expect(held).toHaveLength(1);
    expect(game.source).toBe('draft');
  });
});
