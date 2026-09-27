/**
 * Férové srovnání modelů (P30A T7) nad nahranými odpověďmi serveru obou
 * modelů – bez sítě, bez prohlížeče, bez peněz. Připíchnuté je, co by na
 * výsledném čísle nebylo vidět: čas se měří do hratelné hry v prohlížeči, ne
 * do odpovědi POST; hra, kterou robot nepustil, se nepočítá jako hotová; cena
 * se čte z účtenek serveru toho modelu; jiný build, jiné věty nebo cizí model
 * srovnání odmítnou.
 */

import { describe, expect, it } from 'vitest';

import { billedLine } from '@/app/api/play/_director';
import { draftGameSpec } from '@/play/draft';

import { billedFromLog, compareSummary, loadSet, type MeasuredSentence, measureSentence, modelEnv, specFidelity } from '../play-fidelity.mjs';

const SENTENCES = loadSet('dev', { only: 's039,s037,s002' });

interface Recorded {
  /** Odpovědi `GET …/upgrade` po řadě. */
  readonly upgrades: readonly Record<string, unknown>[];
  /** AI verze, když ji server publikoval (`publishEligible` = robot ji pustil). */
  readonly ai?: { readonly spec: unknown; readonly publishEligible: boolean; readonly source: 'authored' | 'cached' };
}

const pending = { status: 'pending', deadlineAt: '2026-09-27T12:05:00.000Z' };
const ready = (id: string) => ({ status: 'ready', versionId: `ai-${id}` });
const aiSpec = (text: string) => ({ ...draftGameSpec(text), theme: { ...draftGameSpec(text).theme, mood: 'tense' } });

/** Nahrané odpovědi serveru s astrou a s gpt-oss-20b nad týmiž třemi větami. */
const RECORDED: Record<'astra' | 'oss20b', Record<string, Recorded>> = {
  astra: {
    s039: { upgrades: [pending, pending, ready('s039')], ai: { spec: aiSpec('zombie shooter in a mall'), publishEligible: true, source: 'authored' } },
    s037: { upgrades: [pending, ready('s037')], ai: { spec: aiSpec('A space marine shoots alien bugs in a mining colony'), publishEligible: true, source: 'authored' } },
    s002: { upgrades: [pending, pending, pending, ready('s002')], ai: { spec: aiSpec('A knight must collect three keys in a haunted castle while dodging ghosts.'), publishEligible: true, source: 'authored' } },
  },
  oss20b: {
    s039: { upgrades: [ready('s039')], ai: { spec: aiSpec('zombie shooter in a mall'), publishEligible: true, source: 'authored' } },
    // Robot hru odmítl: server vrátí konec na návrhu, ne AI verzi.
    s037: { upgrades: [pending, { status: 'draft-final', reason: 'NOT_PLAYABLE' }] },
    s002: { upgrades: [ready('s002')], ai: { spec: aiSpec('A knight must collect three keys in a haunted castle while dodging ghosts.'), publishEligible: true, source: 'authored' } },
  },
};

const BILLED_LOG = {
  astra: ['ready', billedLine('gpt-6-astra', 0.0042), billedLine('gpt-6-astra', 0.0038), '[play] something else', billedLine('gpt-6-astra', 0.0044)].join('\n'),
  oss20b: [billedLine('openai/gpt-oss-20b', 0.0002), billedLine('openai/gpt-oss-20b', 0.0003), billedLine('openai/gpt-oss-20b', 'unknown'), billedLine('openai/gpt-oss-20b', 0.0001)].join('\n'),
};

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

/** Server přehrávající nahrané odpovědi; každý dotaz posune hodiny o 100 ms. */
function recordedServer(recorded: Record<string, Recorded>, clock: { t: number }): typeof fetch {
  const games = new Map<string, unknown>();
  const upgrades = new Map<string, Record<string, unknown>[]>();
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    clock.t += 100;
    const path = new URL(String(input)).pathname;
    if (init?.method === 'POST') {
      const text = JSON.parse(String(init.body)).sentence as string;
      const id = SENTENCES.find((sentence) => sentence.text === text)!.id;
      games.set(id, { spec: draftGameSpec(text), report: { publishEligible: true }, timings: { source: 'draft' } });
      upgrades.set(id, [...recorded[id]!.upgrades]);
      const ai = recorded[id]!.ai;
      if (ai !== undefined) games.set(`ai-${id}`, { spec: ai.spec, report: { publishEligible: ai.publishEligible }, timings: { source: ai.source } });
      return json({ versionId: id });
    }
    if (path.endsWith('/upgrade')) return json(upgrades.get(path.split('/')[4]!)!.shift());
    return json({ game: games.get(path.split('/').at(-1)!) });
  }) as typeof fetch;
}

async function replay(model: 'astra' | 'oss20b'): Promise<MeasuredSentence[]> {
  const out: MeasuredSentence[] = [];
  for (const sentence of SENTENCES) {
    const clock = { t: 0 };
    out.push(
      await measureSentence(sentence, {
        base: 'http://127.0.0.1:3331',
        fetchImpl: recordedServer(RECORDED[model], clock),
        now: () => clock.t,
        wait: async (ms) => {
          clock.t += ms;
        },
        // Stránka hry je hratelná 800 ms po otevření.
        openGame: async () => {
          clock.t += 800;
        },
      }),
    );
  }
  return out;
}

describe('measureSentence', () => {
  it('times the first playable frame in the browser, not the POST answer', async () => {
    const clock = { t: 0 };
    const opened: { url: string; at: number }[] = [];
    const result = await measureSentence(SENTENCES[0]!, {
      base: 'http://127.0.0.1:3331',
      fetchImpl: recordedServer(RECORDED.astra, clock),
      now: () => clock.t,
      wait: async (ms) => {
        clock.t += ms;
      },
      openGame: async (url) => {
        clock.t += 800;
        opened.push({ url, at: clock.t });
      },
    });
    // POST odpověděl v 100 ms, hratelná byla hra až v 900 ms.
    expect(result.draft.frameMs).toBe(900);
    expect(opened.map((entry) => entry.url)).toEqual(['http://127.0.0.1:3331/play/s039', 'http://127.0.0.1:3331/play/ai-s039']);
    // AI verze: tři dotazy na upgrade, dvě čekání po 1 s, dotazy na obě hry a její vlastní otevření.
    expect(result.upgrade).toMatchObject({ status: 'ready', ms: 3200 });
    expect(result.ai).toMatchObject({ versionId: 'ai-s039', published: true, source: 'authored', frameMs: 4200 });
    expect(result.ai!.frameMs).toBe(opened[1]!.at);
  });

  it('keeps a game whose page never became playable, without a frame time', async () => {
    const clock = { t: 0 };
    const result = await measureSentence(SENTENCES[0]!, {
      base: 'http://127.0.0.1:3331',
      fetchImpl: recordedServer(RECORDED.oss20b, clock),
      now: () => clock.t,
      wait: async () => {},
      openGame: async (url) => {
        if (url.endsWith('/ai-s039')) throw new Error('waitForFunction timeout 60000ms');
      },
    });
    expect(result.ai).toMatchObject({ published: true, frameMs: null, frameError: expect.stringContaining('timeout') });
  });
});

describe('compareSummary over recorded responses of both models', () => {
  it('reports publish share, fidelity, first playable frame and cost per model', async () => {
    const astra = await replay('astra');
    const oss20b = await replay('oss20b');
    const summary = compareSummary({
      astra: { buildId: 'b1', concurrency: 5, results: astra, billed: billedFromLog(BILLED_LOG.astra) },
      oss20b: { buildId: 'b1', concurrency: 5, results: oss20b, billed: billedFromLog(BILLED_LOG.oss20b) },
    });

    expect(summary.astra!.published).toEqual({ ok: 3, of: 3, share: 1, failures: {} });
    // Hra, kterou robot odmítl, je návrh a nese důvod serveru.
    expect(summary.oss20b!.published).toEqual({ ok: 2, of: 3, share: 0.667, failures: { NOT_PLAYABLE: 1 } });
    expect(summary.oss20b!.concurrency).toBe(5);

    // Věrnost se počítá nad verzí, kterou hráč dostal: u odmítnuté hry nad návrhem.
    const finals = [aiSpec(SENTENCES[0]!.text), draftGameSpec(SENTENCES[1]!.text), aiSpec(SENTENCES[2]!.text)];
    const read = finals.map((spec, at) => specFidelity(spec, SENTENCES[at]!.checklist).score);
    expect(summary.oss20b!.fidelity.read).toBeCloseTo(read.reduce((sum, value) => sum + value, 0) / 3, 3);

    // Čas do hratelné AI verze roste s počtem čekání na model.
    expect(summary.astra!.firstPlayableFrameMs).toMatchObject({ aiP50: 4200, aiP95: 5300, draftP50: 900 });
    expect(summary.oss20b!.firstPlayableFrameMs).toMatchObject({ aiP50: 2000, draftP50: 900 });

    expect(summary.astra!.cost).toEqual({ calls: 3, unknownCalls: 0, usd: 0.0124, perSentence: 0.004133, perPublished: 0.004133 });
    expect(summary.oss20b!.cost).toEqual({ calls: 4, unknownCalls: 1, usd: 0.0006, perSentence: 0.0002, perPublished: 0.0003 });
  });

  it('refuses a comparison that is not fair', async () => {
    const astra = await replay('astra');
    const oss20b = await replay('oss20b');
    const run = (results: readonly MeasuredSentence[], log: string, buildId = 'b1') => ({ buildId, concurrency: 1, results, billed: billedFromLog(log) });

    expect(() => compareSummary({ astra: run(astra, BILLED_LOG.astra), oss20b: run(oss20b, BILLED_LOG.oss20b, 'b2') })).toThrow(/different builds/);
    expect(() => compareSummary({ astra: run(astra.slice(1), BILLED_LOG.astra), oss20b: run(oss20b, BILLED_LOG.oss20b) })).toThrow(/different sentences/);
    // Server pod jménem oss20b účtoval astru: měřil by se jiný model, než říká tabulka.
    expect(() => compareSummary({ astra: run(astra, BILLED_LOG.astra), oss20b: run(oss20b, BILLED_LOG.astra) })).toThrow(/oss20b: the server billed gpt-6-astra/);
    // Autorské hry bez jediné účtenky: cena by se četla jako nula.
    expect(() => compareSummary({ astra: run(astra, ''), oss20b: run(oss20b, BILLED_LOG.oss20b) })).toThrow(/no billed call/);
  });

  it('counts a sentence refused under load as an error, not as a model failure', async () => {
    const oss20b: (MeasuredSentence | Pick<MeasuredSentence, 'id' | 'text' | 'checklist' | 'error'>)[] = await replay('oss20b');
    oss20b[1] = { id: SENTENCES[1]!.id, text: SENTENCES[1]!.text, checklist: SENTENCES[1]!.checklist, error: 'POST 429 {"error":"RATE_LIMITED"}' };
    const summary = compareSummary({ oss20b: { buildId: 'b1', concurrency: 5, results: oss20b, billed: billedFromLog(BILLED_LOG.oss20b) } });
    expect(summary.oss20b).toMatchObject({ n: 3, errors: 1, published: { ok: 2, failures: { ERROR: 1 } } });
  });
});

describe('modelEnv', () => {
  const env = {
    WORLDSMITH_MODEL_ENDPOINT: 'openai:https://api.together.xyz',
    WORLDSMITH_MODEL: 'openai/gpt-oss-20b',
    WORLDSMITH_MODEL_KEY: 'together-key',
    WORLDSMITH_USD_PER_MTOK_IN: '0.05',
    WORLDSMITH_USD_PER_MTOK_OUT: '0.20',
    WORLDSMITH_FALLBACK_ENDPOINT: 'openai:https://api.openai.com',
    WORLDSMITH_FALLBACK_MODEL: 'gpt-6-astra',
    WORLDSMITH_FALLBACK_KEY: 'openai-key',
    WORLDSMITH_FALLBACK_EFFORT: 'medium',
    WORLDSMITH_FALLBACK_USD_PER_MTOK_IN: '1.25',
    WORLDSMITH_FALLBACK_USD_PER_MTOK_OUT: '10',
    KV_REST_API_URL: 'https://shared.upstash.io',
    KV_REST_API_TOKEN: 'shared-token',
  };

  it('runs each model alone as the primary, with its own price and no shared store', () => {
    const astra = modelEnv('astra', env, 1.5);
    expect(astra).toMatchObject({
      WORLDSMITH_BRANCH: 'live',
      WORLDSMITH_MODEL_ENDPOINT: 'openai:https://api.openai.com',
      WORLDSMITH_MODEL: 'gpt-6-astra',
      WORLDSMITH_MODEL_KEY: 'openai-key',
      WORLDSMITH_MODEL_EFFORT: 'medium',
      WORLDSMITH_USD_PER_MTOK_IN: '1.25',
      WORLDSMITH_USD_PER_MTOK_OUT: '10',
      WORLDSMITH_SPEND_CAP_USD: '1.5',
      // Bez zálohy: hru napíše jen měřený model.
      WORLDSMITH_FALLBACK_ENDPOINT: '',
      // Vlastní hry, cache a kniha v každém serveru – `''` přebije `.env.local`.
      KV_REST_API_URL: '',
      KV_REST_API_TOKEN: '',
      VERCEL_ENV: 'production',
    });
    // Proměnná, kterou záloha nemá, nesmí protéct z primáru.
    expect(astra.WORLDSMITH_MAX_OUTPUT_TOKENS).toBe('');
    expect(modelEnv('oss20b', env, 1.5)).toMatchObject({ WORLDSMITH_MODEL: 'openai/gpt-oss-20b', WORLDSMITH_MODEL_KEY: 'together-key', WORLDSMITH_USD_PER_MTOK_OUT: '0.20', WORLDSMITH_FALLBACK_ENDPOINT: '' });
  });

  it('refuses a model that is not the one named, another transport or a missing key', () => {
    expect(() => modelEnv('astra', { ...env, WORLDSMITH_FALLBACK_MODEL: 'openai/gpt-oss-20b' }, 1)).toThrow(/WORLDSMITH_FALLBACK_MODEL is "openai\/gpt-oss-20b"/);
    expect(() => modelEnv('oss20b', { ...env, WORLDSMITH_MODEL_ENDPOINT: 'codex-cli' }, 1)).toThrow(/WORLDSMITH_MODEL_ENDPOINT must be an openai: endpoint/);
    expect(() => modelEnv('astra', { ...env, WORLDSMITH_FALLBACK_KEY: '' }, 1)).toThrow(/WORLDSMITH_FALLBACK_KEY is missing/);
    expect(() => modelEnv('gemini', env, 1)).toThrow(/unknown model gemini/);
  });

  it('refuses a cap that would refuse calls under the concurrency and blame the model', () => {
    // astra: 8000 tokenů × 10 USD/Mtok = 0,08 USD na volání; pět porotců s rezervou 1,5 = 0,6 USD.
    expect(() => modelEnv('astra', env, 0.5, 5)).toThrow(/under 5 concurrent worst-case calls \(0\.600 USD\); raise --cap-usd/);
    expect(modelEnv('astra', env, 0.61, 5).WORLDSMITH_SPEND_CAP_USD).toBe('0.61');
    expect(() => modelEnv('oss20b', env, 0.011, 5)).toThrow(/raise --cap-usd/);
  });
});

describe('billedFromLog', () => {
  it("reads the director's billed line and skips everything else", () => {
    const log = ['▲ Next.js', billedLine('openai/gpt-oss-20b', 0.000123456), '[play] upgrade of x ended NOT_PLAYABLE', billedLine('gpt-6-astra', 'unknown')].join('\n');
    expect(billedFromLog(log)).toEqual([
      { model: 'openai/gpt-oss-20b', usd: 0.00012346 },
      { model: 'gpt-6-astra', usd: null },
    ]);
  });
});
