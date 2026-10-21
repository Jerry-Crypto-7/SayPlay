import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readSentence } from '../client';
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
    expect(sent.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'reading', strict: true, schema: READING_JSON_SCHEMA } });
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
