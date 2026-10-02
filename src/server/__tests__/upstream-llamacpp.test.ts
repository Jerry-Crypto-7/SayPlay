/**
 * **Třetí druh koncového bodu: lokální llama.cpp (P29B T7).**
 *
 * Záloha režiséra běží na RTX 3090 jako `llama-server` s OpenAI chat API.
 * Konfiguruje se `WORLDSMITH_FALLBACK_ENDPOINT=llamacpp:<kořen serveru>` vedle
 * primární konfigurace; `generate` pošle `response_format.json_schema`
 * z `outputSchema` a vrátí text ve stejném tvaru jako cesta Messages. Stub
 * server na náhodném portu, žádná síť ven.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { GenerationCall } from '../pipeline';
import { upstreamBranch, upstreamConfigFromEnv, type UpstreamConfig } from '../upstream';

const LIVE_ENV = {
  WORLDSMITH_BRANCH: 'live',
  WORLDSMITH_MODEL_ENDPOINT: 'codex-cli',
  WORLDSMITH_MODEL_KEY: 'test-key',
  WORLDSMITH_MODEL_PROFILE: 'subscription',
  WORLDSMITH_CALL_CAP: '40',
  WORLDSMITH_USD_PER_MTOK_OUT: '25',
} as const;

const SCHEMA = { type: 'object', additionalProperties: false, required: ['plan'], properties: { plan: { type: 'string' } } };

const CALL: GenerationCall = {
  prompt: 'a corgi runs through a neon city',
  request: { model: 'm', system: 'answer JSON', user: 'a corgi runs through a neon city', outputSchema: SCHEMA },
};

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

const chat = (content: string, finish = 'stop') =>
  JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: finish }], usage: { prompt_tokens: 120, completion_tokens: 30 } });

function fallbackOf(env: Record<string, string>): UpstreamConfig {
  const fallback = upstreamConfigFromEnv({ ...LIVE_ENV, ...env })?.fallback;
  if (fallback === undefined) throw new Error('záloha se měla načíst');
  return fallback;
}

describe('WORLDSMITH_FALLBACK_ENDPOINT', () => {
  it('loads a llama.cpp fallback next to the primary config', () => {
    const fallback = fallbackOf({ WORLDSMITH_FALLBACK_ENDPOINT: 'llamacpp:http://127.0.0.1:8792', WORLDSMITH_FALLBACK_MODEL: 'gpt-oss-20b' });
    expect(fallback.endpoint).toBe('llamacpp:http://127.0.0.1:8792');
    expect(fallback.model).toBe('gpt-oss-20b');
    // Lokální model je zdarma a strop volání patří primáru.
    expect(fallback.pricing).toEqual({ usdPerMTokIn: 0, usdPerMTokOut: 0 });
    expect(fallback.callCap).toBeNull();
    expect(fallback.fallback).toBeUndefined();
  });

  it('leaves the config unchanged without it or with another kind', () => {
    expect(upstreamConfigFromEnv(LIVE_ENV)).not.toHaveProperty('fallback');
    expect(upstreamConfigFromEnv({ ...LIVE_ENV, WORLDSMITH_FALLBACK_ENDPOINT: 'http://127.0.0.1:8792' })).not.toHaveProperty('fallback');
    expect(upstreamConfigFromEnv({ ...LIVE_ENV, WORLDSMITH_FALLBACK_ENDPOINT: 'llamacpp:' })).not.toHaveProperty('fallback');
  });
});

describe('codex-cli cancel', () => {
  it('kills a hanging codex process when the caller cancels', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-codex-hang-'));
    const file = join(dir, 'hang.cjs');
    writeFileSync(file, 'setInterval(() => undefined, 1000);');
    const previous = process.env.WORLDSMITH_CODEX_JS;
    process.env.WORLDSMITH_CODEX_JS = file;
    try {
      const config = upstreamConfigFromEnv(LIVE_ENV);
      if (config === null) throw new Error('konfigurace se měla načíst');
      const ctl = new AbortController();
      const outcome = upstreamBranch(config).generate(CALL, ctl.signal);
      setTimeout(() => ctl.abort(), 300);
      await expect(outcome).resolves.toMatchObject({ ok: false, reason: 'UPSTREAM_UNAVAILABLE', detail: expect.stringContaining('cancelled') });
    } finally {
      if (previous === undefined) delete process.env.WORLDSMITH_CODEX_JS;
      else process.env.WORLDSMITH_CODEX_JS = previous;
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 15_000);
});

describe('llama.cpp generate', () => {
  it('sends an OpenAI chat request with the output schema and returns the parsed body', async () => {
    let sent: Record<string, unknown> = {};
    const root = await stub((req, body, res) => {
      sent = { url: req.url, ...(JSON.parse(body) as Record<string, unknown>) };
      res.end(chat('{"plan":"run"}'));
    });
    const outcome = await upstreamBranch(fallbackOf({ WORLDSMITH_FALLBACK_ENDPOINT: `llamacpp:${root}/` })).generate(CALL);
    expect(outcome).toMatchObject({ ok: true, body: { plan: 'run' }, usage: { inputTokens: 120, outputTokens: 30 } });
    expect(outcome.ok && outcome.provenance).toMatchObject({ source: 'llamacpp-http', synthetic: false });
    expect(sent.url).toBe('/v1/chat/completions');
    expect(sent.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: SCHEMA } });
    expect(sent.messages).toEqual([
      { role: 'system', content: 'answer JSON' },
      { role: 'user', content: 'a corgi runs through a neon city' },
    ]);
  });

  // P36A F4: bez `reasoning_effort` lokální gpt-oss přemýšlel výchozí úrovní a 12/30 odpovědí skončilo prázdných na max_tokens.
  it('sends the reasoning effort of the config, low by default and capped at high', async () => {
    const sent: unknown[] = [];
    const root = await stub((_req, body, res) => {
      sent.push((JSON.parse(body) as { reasoning_effort?: unknown }).reasoning_effort);
      res.end(chat('{"plan":"run"}'));
    });
    const config = fallbackOf({ WORLDSMITH_FALLBACK_ENDPOINT: `llamacpp:${root}` });
    for (const effort of [undefined, 'medium', 'max'] as const) {
      await upstreamBranch(effort === undefined ? config : { ...config, effort }).generate(CALL);
    }
    expect(sent).toEqual(['low', 'medium', 'high']);
  });

  it('sends WORLDSMITH_FALLBACK_KEY as a bearer token, and no authorization without it', async () => {
    const seen: (string | undefined)[] = [];
    const root = await stub((req, _body, res) => {
      seen.push(req.headers.authorization);
      res.end(chat('{"plan":"run"}'));
    });
    await upstreamBranch(fallbackOf({ WORLDSMITH_FALLBACK_ENDPOINT: `llamacpp:${root}`, WORLDSMITH_FALLBACK_KEY: 'gpu-key' })).generate(CALL);
    await upstreamBranch(fallbackOf({ WORLDSMITH_FALLBACK_ENDPOINT: `llamacpp:${root}` })).generate(CALL);
    expect(seen).toEqual(['Bearer gpu-key', undefined]);
  });

  it('asks for a JSON object when the call has no schema', async () => {
    let format: unknown;
    const root = await stub((_req, body, res) => {
      format = (JSON.parse(body) as { response_format: unknown }).response_format;
      res.end(chat('{"plan":"run"}'));
    });
    const { outputSchema: _drop, ...request } = CALL.request;
    await upstreamBranch(fallbackOf({ WORLDSMITH_FALLBACK_ENDPOINT: `llamacpp:${root}` })).generate({ ...CALL, request });
    expect(format).toEqual({ type: 'json_object' });
  });

  it('times out as UPSTREAM_UNAVAILABLE', async () => {
    const root = await stub(() => undefined);
    const config = fallbackOf({ WORLDSMITH_FALLBACK_ENDPOINT: `llamacpp:${root}`, WORLDSMITH_FALLBACK_TIMEOUT_MS: '150' });
    expect(config.timeoutMs).toBe(150);
    const started = Date.now();
    const outcome = await upstreamBranch(config).generate(CALL);
    expect(outcome).toMatchObject({ ok: false, reason: 'UPSTREAM_UNAVAILABLE' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('maps HTTP 5xx to UPSTREAM_UNAVAILABLE and 4xx to UPSTREAM_REJECTED', async () => {
    let status = 503;
    const root = await stub((_req, _body, res) => {
      res.statusCode = status;
      res.end('{"error":"loading model"}');
    });
    const branch = upstreamBranch(fallbackOf({ WORLDSMITH_FALLBACK_ENDPOINT: `llamacpp:${root}` }));
    await expect(branch.generate(CALL)).resolves.toMatchObject({ ok: false, reason: 'UPSTREAM_UNAVAILABLE', detail: 'upstream answered 503' });
    status = 400;
    await expect(branch.generate(CALL)).resolves.toMatchObject({ ok: false, reason: 'UPSTREAM_REJECTED' });
  });

  it('reports broken JSON as MALFORMED_RESPONSE with the raw text', async () => {
    const root = await stub((_req, _body, res) => res.end(chat('{"plan": oops}')));
    const outcome = await upstreamBranch(fallbackOf({ WORLDSMITH_FALLBACK_ENDPOINT: `llamacpp:${root}` })).generate(CALL);
    expect(outcome).toMatchObject({ ok: false, reason: 'MALFORMED_RESPONSE', raw: '{"plan": oops}' });
  });

  it('does not repair an answer cut at the token limit', async () => {
    const root = await stub((_req, _body, res) => res.end(chat('{"plan":"run"', 'length')));
    const outcome = await upstreamBranch(fallbackOf({ WORLDSMITH_FALLBACK_ENDPOINT: `llamacpp:${root}` })).generate(CALL);
    expect(outcome).toMatchObject({ ok: false, reason: 'MALFORMED_RESPONSE' });
  });

  it('stops when the caller cancels (T8: the losing side of the hedge)', async () => {
    const root = await stub(() => undefined);
    const ctl = new AbortController();
    const outcome = upstreamBranch(fallbackOf({ WORLDSMITH_FALLBACK_ENDPOINT: `llamacpp:${root}` })).generate(CALL, ctl.signal);
    setTimeout(() => ctl.abort(), 50);
    await expect(outcome).resolves.toMatchObject({ ok: false, reason: 'UPSTREAM_UNAVAILABLE' });
  });

  it('reports a reply without a message as MALFORMED_RESPONSE', async () => {
    const root = await stub((_req, _body, res) => res.end('{"choices":[]}'));
    const outcome = await upstreamBranch(fallbackOf({ WORLDSMITH_FALLBACK_ENDPOINT: `llamacpp:${root}` })).generate(CALL);
    expect(outcome).toMatchObject({ ok: false, reason: 'MALFORMED_RESPONSE' });
  });
});
