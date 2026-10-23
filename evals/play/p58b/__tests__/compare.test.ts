/**
 * Měřidlo čteček P58B (T2) proti atrapě poskytovatele: běží bez dozoru a platí se, takže strop útraty a chybové cesty
 * mají vlastní test. Neplatná odpověď je chyba, ne slovník – jinak by model, který neodpovídá, sbíral body slovníku.
 */

import { describe, expect, it } from 'vitest';

import { classifyGenre } from '../../../../src/play/genre/classify';
import { readerSystemPrompt } from '../../../../src/play/read/prompt';
import { READING_JSON_SCHEMA, type Reading } from '../../../../src/play/read/schema';
import { costUsd } from '../../../../src/server/spend-cap';
import { compareReaders, loadSet, scoreOf, type Candidate, type ClaudeRunner, type SentenceSet } from '../compare.measure';

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
