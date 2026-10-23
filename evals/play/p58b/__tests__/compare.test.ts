/**
 * Měřidlo čteček P58B (T2) proti atrapě poskytovatele: běží bez dozoru a platí se, takže strop útraty a chybové cesty
 * mají vlastní test. Neplatná odpověď je chyba, ne slovník – jinak by model, který neodpovídá, sbíral body slovníku.
 */

import { describe, expect, it } from 'vitest';

import { classifyGenre } from '../../../../src/play/genre/classify';
import { readerSystemPrompt } from '../../../../src/play/read/prompt';
import { READING_JSON_SCHEMA, type Reading } from '../../../../src/play/read/schema';
import { costUsd } from '../../../../src/server/spend-cap';
import { anthropicSchema, compareReaders, loadSet, scoreOf, type Candidate, type ClaudeRunner, type SentenceSet } from '../compare.measure';

const READING: Reading = {
  control: 'runner',
  verbs: [{ word: 'catch', class: 'move_free' }],
  hero: 'basket',
  roles: [{ noun: 'apple', kind: 'collectible', count: null }],
  setting: 'orchard',
  mood: null,
  numbers: { seconds: null, counts: [] },
  genre: { genre: 'catch', mode: 'default' },
  foe: null,
  item: 'apple',
  world: 'meadow',
  title: 'Apple Drop',
};

const CATCH = 'apples drop from the tree and you catch them in a basket';
const SET: SentenceSet = {
  name: 'test/dev',
  sentences: [
    { id: 'c1', family: 'target', genre: 'catch.default', lure: null, text: CATCH, hero: null, foe: null },
    { id: 'c2', family: 'trap', genre: null, lure: 'runner.default', text: 'run a lemonade stand and set the prices every morning' },
    { id: 'c3', text: 'a robot sweeps the moon base' },
  ],
};

const hosted = (id: string, pricing = { usdPerMTokIn: 0.1, usdPerMTokOut: 0.3 }): Candidate => ({
  id, kind: 'openai', endpoint: `openai:https://${id}.test`, model: `${id}-model`, keyEnv: `${id.toUpperCase()}_KEY`, effort: 'low', pricing,
});
const CLAUDE: Candidate = { id: 'claude-cli:opus', kind: 'claude-cli', endpoint: '', model: 'claude-opus-5-5', keyEnv: null, effort: 'low', pricing: { usdPerMTokIn: 0, usdPerMTokOut: 0 } };
const ENV = { A_KEY: 'key-a', B_KEY: 'key-b' };

interface Sent { readonly host: string; readonly body: { model: string; messages: { role: string; content: string }[]; response_format: { json_schema: { schema: unknown } } } }

/** Atrapa OpenAI chat API: odpověď podle hostitele, každé volání zapsané. */
function provider(answer: (host: string) => { status?: number; content?: string; usage?: { prompt_tokens: number; completion_tokens: number } | null }) {
  const sent: Sent[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const host = new URL(String(input)).hostname.split('.')[0]!;
    sent.push({ host, body: JSON.parse(String(init?.body)) as Sent['body'] });
    const { status = 200, content = JSON.stringify(READING), usage = { prompt_tokens: 100, completion_tokens: 300 } } = answer(host);
    const payload = status === 200 ? { choices: [{ message: { content }, finish_reason: 'stop' }], ...(usage === null ? {} : { usage }) } : { error: 'boom' };
    return Promise.resolve(new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } }));
  };
  return { fetchImpl, sent };
}

const OPUS: Candidate = {
  id: 'opus', kind: 'anthropic', endpoint: 'https://anthropic.test/v1/messages', model: 'claude-opus-5-5', keyEnv: 'OPUS_KEY', effort: 'low',
  pricing: { usdPerMTokIn: 4, usdPerMTokOut: 20 }, cache: { write: 1.25, read: 0.05 },
};

interface AnthropicSent {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: { model: string; max_tokens: number; output_config: { effort: string; format: { type: string; schema: Record<string, unknown> } }; system: { type: string; text: string; cache_control: unknown }[]; messages: { role: string; content: string }[] } & Record<string, unknown>;
}
type AnthropicUsage = { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | null;

/** Atrapa Anthropic Messages API: blok uvažování (prázdný, jako u Opus 5.5) a pak text; každé volání zapsané. */
function anthropic(answer: (call: number) => { status?: number; text?: string | null; stop?: string; usage?: AnthropicUsage }) {
  const sent: AnthropicSent[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    sent.push({ url: String(input), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as AnthropicSent['body'] });
    const { status = 200, text = JSON.stringify(READING), stop = 'end_turn', usage = { input_tokens: 100, output_tokens: 300 } } = answer(sent.length);
    const content = [{ type: 'thinking', thinking: '', signature: 'x' }, ...(text === null ? [] : [{ type: 'text', text }])];
    const payload = status === 200 ? { content, stop_reason: stop, ...(usage === null ? {} : { usage }) } : { type: 'error', error: { type: 'overloaded_error' } };
    return Promise.resolve(new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } }));
  };
  return { fetchImpl, sent };
}

const keysOf = (node: unknown, found = new Set<string>()): Set<string> => {
  if (Array.isArray(node)) node.forEach((item) => keysOf(item, found));
  else if (node !== null && typeof node === 'object')
    for (const [key, value] of Object.entries(node)) {
      found.add(key);
      keysOf(value, found);
    }
  return found;
};

const claudeAnswering = (listUsd = 0.5): { runClaude: ClaudeRunner; asked: Parameters<ClaudeRunner>[0][] } => {
  const asked: Parameters<ClaudeRunner>[0][] = [];
  return { asked, runClaude: (input) => { asked.push(input); return Promise.resolve({ ok: true, body: READING, usage: { inputTokens: 2000, outputTokens: 200 }, listUsd, firstByteMs: 900 }); } };
};

describe('P58B reader comparison', () => {
  it('sends every model the same system prompt, schema and sentence', async () => {
    const { fetchImpl, sent } = provider(() => ({}));
    const { runClaude, asked } = claudeAnswering();
    await compareReaders({ models: [hosted('a'), hosted('b'), CLAUDE], sets: [SET], capUsd: 1 }, { fetchImpl, runClaude, env: ENV });
    expect(sent.map((call) => call.host)).toEqual(['a', 'b', 'a', 'b', 'a', 'b']);
    for (const { body } of sent) {
      expect(body.messages[0]).toEqual({ role: 'system', content: readerSystemPrompt() });
      expect(body.response_format.json_schema.schema).toEqual(READING_JSON_SCHEMA);
    }
    expect(sent.map(({ body }) => body.messages[1]!.content)).toEqual(SET.sentences.flatMap((s) => [s.text, s.text]));
    expect(asked.map((input) => [input.system, input.schema, input.user])).toEqual(SET.sentences.map((s) => [readerSystemPrompt(), READING_JSON_SCHEMA, s.text]));
  });

  it('counts an invalid answer as an error, never as the dictionary', async () => {
    // Bez téhle podmínky by test nic neříkal: slovník sám tu větu chytání trefí.
    expect(classifyGenre(CATCH, null).ranked[0]!.genre).toBe('catch');
    const { fetchImpl } = provider((host) => (host === 'b' ? { content: '{"genre":"catch"}' } : {}));
    const result = await compareReaders({ models: [hosted('a'), hosted('b')], sets: [SET], capUsd: 1 }, { fetchImpl, env: ENV });
    const [c1, c2] = result.rows;
    expect(c1!.models.b).toMatchObject({ error: 'invalid', reading: null, classified: null, hit: false });
    expect(c2!.models.b).toMatchObject({ error: 'invalid', hit: false });
    expect(c1!.models.a).toMatchObject({ error: null, classified: 'catch.default', hit: true, modeHit: true });
    expect(result.summary.b!.all).toMatchObject({ invalid: 3, errors: 3, targets: { of: 1, hit: 0 }, traps: { of: 1, offLure: 0 } });
    expect(result.summary.a!.all).toMatchObject({ invalid: 0, errors: 0, targets: { of: 1, hit: 1 }, traps: { of: 1, offLure: 1 } });
  });

  it('counts an HTTP 500 as an unavailable reader that misses', async () => {
    const { fetchImpl } = provider(() => ({ status: 500 }));
    const result = await compareReaders({ models: [hosted('a')], sets: [SET], capUsd: 1 }, { fetchImpl, env: ENV });
    expect(result.rows[0]!.models.a).toMatchObject({ error: 'unavailable', classified: null, hit: false });
    expect(result.summary.a!.all).toMatchObject({ errors: 3, invalid: 0, targets: { hit: 0 } });
  });

  it('stops at the spend cap before a call whose worst case would not fit', async () => {
    // Nejhorší případ ≈ 1 024 tokenů × 1 000 USD/Mtok = 1,024 USD; skutečné volání 300 tokenů = 0,3 USD.
    const { fetchImpl, sent } = provider(() => ({}));
    const result = await compareReaders({ models: [hosted('a', { usdPerMTokIn: 0, usdPerMTokOut: 1000 })], sets: [SET], capUsd: 1.2 }, { fetchImpl, env: ENV });
    expect(sent).toHaveLength(1);
    expect(result.stopped).toEqual({ by: 'cap', set: 'test/dev', id: 'c2', model: 'a' });
    expect(result.rows.map((row) => row.id)).toEqual(['c1']);
    expect(result.spentUsd).toBeCloseTo(0.3, 6);
    expect(result.spentUsd).toBeLessThanOrEqual(1.2);
  });

  it('charges an answer without a receipt its worst case', async () => {
    const { fetchImpl, sent } = provider(() => ({ usage: null }));
    const result = await compareReaders({ models: [hosted('a', { usdPerMTokIn: 0, usdPerMTokOut: 1000 })], sets: [SET], capUsd: 1.5 }, { fetchImpl, env: ENV });
    expect(sent).toHaveLength(1);
    expect(result.rows[0]!.models.a!.usd).toBeCloseTo(1.024, 6);
    expect(result.stopped?.id).toBe('c2');
  });

  it('records latency, tokens and cost of every read', async () => {
    const { fetchImpl } = provider(() => ({}));
    const pricing = { usdPerMTokIn: 0.1, usdPerMTokOut: 0.3 };
    const result = await compareReaders({ models: [hosted('a', pricing)], sets: [SET], capUsd: 1 }, { fetchImpl, env: ENV });
    for (const row of result.rows) {
      const read = row.models.a!;
      expect(read).toMatchObject({ inputTokens: 100, outputTokens: 300, listUsd: null });
      expect(read.usd).toBeCloseTo(costUsd({ inputTokens: 100, outputTokens: 300 }, pricing), 12);
      expect(read.firstByteMs).not.toBeNull();
      expect(read.firstByteMs!).toBeLessThanOrEqual(read.totalMs);
    }
    expect(result.summary.a!.all.tokens).toEqual({ input: 300, output: 900 });
    expect(result.summary.a!.all.latencyMs.p95).not.toBeNull();
  });

  it('records the list price of claude -p and never counts it against the cap', async () => {
    const { runClaude } = claudeAnswering(0.5);
    const result = await compareReaders({ models: [CLAUDE], sets: [SET], capUsd: 0 }, { runClaude, env: {} });
    expect(result.stopped).toBeNull();
    expect(result.spentUsd).toBe(0);
    expect(result.summary['claude-cli:opus']!.all).toMatchObject({ usd: 0, listUsd: 1.5, targets: { hit: 1 } });
    expect(result.rows[0]!.models['claude-cli:opus']).toMatchObject({ firstByteMs: 900, inputTokens: 2000 });
    const failing: ClaudeRunner = () => Promise.resolve({ ok: false, detail: 'limit reached', listUsd: null });
    const failed = await compareReaders({ models: [CLAUDE], sets: [SET], capUsd: 0 }, { runClaude: failing, env: {} });
    expect(failed.rows[0]!.models['claude-cli:opus']).toMatchObject({ error: 'unavailable', hit: false });
  });

  it('reads through the Anthropic API with the same prompt and a schema the API accepts', async () => {
    const { fetchImpl, sent } = anthropic(() => ({}));
    const result = await compareReaders({ models: [OPUS], sets: [SET], capUsd: 1 }, { fetchImpl, env: { OPUS_KEY: 'key-o' } });
    expect(sent).toHaveLength(3);
    const [{ url, headers, body }] = sent as [AnthropicSent];
    expect(url).toBe('https://anthropic.test/v1/messages');
    expect(headers).toMatchObject({ 'x-api-key': 'key-o', 'anthropic-version': '2023-06-01' });
    expect(Object.keys(headers)).not.toContain('anthropic-workspace-id');
    expect(body).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 1024, output_config: { effort: 'low', format: { type: 'json_schema' } } });
    expect(body.system).toEqual([{ type: 'text', text: readerSystemPrompt(), cache_control: { type: 'ephemeral' } }]);
    expect(sent.map((call) => call.body.messages)).toEqual(SET.sentences.map((s) => [{ role: 'user', content: s.text }]));
    // Opus 5.5 odmítne teplotu i vypnuté uvažování čtyřistovkou.
    expect(Object.keys(body)).not.toContain('temperature');
    expect(Object.keys(body)).not.toContain('thinking');
    const schema = body.output_config.format.schema;
    expect([...keysOf(schema)].filter((key) => ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems'].includes(key))).toEqual([]);
    expect(Object.keys(schema.properties as object)).toEqual(Object.keys(READING_JSON_SCHEMA.properties as object));
    expect(result.rows[0]!.models.opus).toMatchObject({ error: null, classified: 'catch.default', hit: true });
    expect(result.summary.opus!.all).toMatchObject({ errors: 0, targets: { of: 1, hit: 1 }, traps: { of: 1, offLure: 1 } });
  });

  it('sends the workspace of a user-linked Anthropic key when one is configured', async () => {
    const { fetchImpl, sent } = anthropic(() => ({}));
    await compareReaders({ models: [OPUS], sets: [{ name: 'one', sentences: [SET.sentences[0]!] }], capUsd: 1 }, { fetchImpl, env: { OPUS_KEY: 'k', ANTHROPIC_WORKSPACE_ID: ' wrkspc_01test ' } });
    expect(sent[0]!.headers['anthropic-workspace-id']).toBe('wrkspc_01test');
  });

  it('strips only schema keywords, never a property that shares their name', () => {
    expect(anthropicSchema({ type: 'object', properties: { minimum: { type: 'integer', minimum: 1 }, word: { type: 'string', maxLength: 4 } }, maxItems: 3 }))
      .toEqual({ type: 'object', properties: { minimum: { type: 'integer' }, word: { type: 'string' } } });
  });

  it('prices Anthropic cache writes and reads apart from fresh input', async () => {
    const { fetchImpl } = anthropic((call) => ({
      usage: call === 1 ? { input_tokens: 100, output_tokens: 300, cache_creation_input_tokens: 5000, cache_read_input_tokens: 0 } : { input_tokens: 100, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000 },
    }));
    const result = await compareReaders({ models: [OPUS], sets: [SET], capUsd: 1 }, { fetchImpl, env: { OPUS_KEY: 'k' } });
    const [first, second] = result.rows.map((row) => row.models.opus!);
    expect(first).toMatchObject({ inputTokens: 5100, outputTokens: 300 });
    expect(first!.usd).toBeCloseTo((100 * 4 + 5000 * 4 * 1.25 + 300 * 20) / 1e6, 12);
    expect(second!.usd).toBeCloseTo((100 * 4 + 5000 * 4 * 0.05 + 300 * 20) / 1e6, 12);
  });

  it('counts an Anthropic outage, refusal, cut-off or broken receipt as a miss and charges what it can prove', async () => {
    const worst = (readerSystemPrompt().length + CATCH.length) * 4 * 1.25 / 1e6 + (1024 * 20) / 1e6;
    const cases: { answer: ReturnType<Parameters<typeof anthropic>[0]>; error: string; usd: number }[] = [
      { answer: { status: 529 }, error: 'unavailable', usd: worst },
      { answer: { status: 400 }, error: 'rejected', usd: worst },
      { answer: { stop: 'refusal', text: null, usage: { input_tokens: 100, output_tokens: 5 } }, error: 'invalid', usd: (100 * 4 + 5 * 20) / 1e6 },
      { answer: { stop: 'max_tokens', text: '{"control":', usage: { input_tokens: 100, output_tokens: 1024 } }, error: 'invalid', usd: (100 * 4 + 1024 * 20) / 1e6 },
      { answer: { text: JSON.stringify({ ...READING, hero: 'x'.repeat(60) }) }, error: 'invalid', usd: (100 * 4 + 300 * 20) / 1e6 },
      { answer: { usage: { input_tokens: -1, output_tokens: 300 } }, error: 'none', usd: worst },
      { answer: { usage: null }, error: 'none', usd: worst },
    ];
    for (const { answer, error, usd } of cases) {
      const { fetchImpl } = anthropic(() => answer);
      const result = await compareReaders({ models: [OPUS], sets: [{ name: 'one', sentences: [SET.sentences[0]!] }], capUsd: 1 }, { fetchImpl, env: { OPUS_KEY: 'k' } });
      const read = result.rows[0]!.models.opus!;
      expect({ error: read.error ?? 'none', hit: read.hit }).toEqual({ error, hit: error === 'none' });
      expect(read.usd).toBeCloseTo(usd, 12);
    }
  });

  it('refuses to start without a key and calls nothing', async () => {
    const { fetchImpl, sent } = provider(() => ({}));
    await expect(compareReaders({ models: [hosted('a')], sets: [SET], capUsd: 1 }, { fetchImpl, env: {} })).rejects.toThrow(/A_KEY/);
    expect(sent).toHaveLength(0);
  });

  it('refuses a sealed holdout and reads an opened one', () => {
    expect(() => loadSet('evals/play/p58b/holdout.json')).toThrow(/sealed/);
    expect(loadSet('evals/play/p56a/holdout.json').sentences).toHaveLength(80);
  });

  it('scores targets by genre, traps by their lure and P55 distractors by the new genres', () => {
    expect(scoreOf({ id: 't', text: '', family: 'target', genre: 'catch' }, 'catch.default')).toEqual({ hit: true, modeHit: true });
    expect(scoreOf({ id: 't', text: '', family: 'target', genre: 'arena.escape' }, 'arena.collect')).toEqual({ hit: true, modeHit: false });
    expect(scoreOf({ id: 'p', text: '', family: 'trap', genre: null, lure: 'runner.default' }, 'runner.default')).toEqual({ hit: false, modeHit: false });
    expect(scoreOf({ id: 'p', text: '', family: 'trap', genre: null, lure: 'runner.default' }, 'quest.station')).toEqual({ hit: true, modeHit: true });
    expect(scoreOf({ id: 'd', text: '', family: 'distractor', genre: null }, 'catch.default').hit).toBe(false);
    expect(scoreOf({ id: 'd', text: '', family: 'distractor', genre: null }, 'voyage.race').hit).toBe(true);
    expect(scoreOf({ id: 'u', text: '' }, 'runner.default')).toEqual({ hit: null, modeHit: null });
  });
});
