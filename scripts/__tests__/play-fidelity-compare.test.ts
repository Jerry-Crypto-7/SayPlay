/**
 * Férové srovnání modelů (P30A T7) nad nahranými odpověďmi serveru obou
 * modelů – bez sítě, bez prohlížeče, bez peněz. Připíchnuté je, co by na
 * výsledném čísle nebylo vidět: čas se měří do hratelné hry v prohlížeči, ne
 * do odpovědi POST; hra, kterou robot nepustil, se nepočítá jako hotová; cena
 * se čte z účtenek serveru toho modelu; jiný build, jiné věty nebo cizí model
 * srovnání odmítnou. Věta, kterou odmítly dveře nebo strop, se modelu
 * nepřipíše a běh zneplatní (T7b).
 */

import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { billedLine, getDirector } from '@/app/api/play/_director';
import { type DraftFinalReason, upgradeAttemptLine, upgradeEndedLine } from '@/app/api/play/_upgrade';
import { acquireSlot, DOOR_CEILING, resetConcurrency } from '@/app/api/worldstream/sessions/route';
import { draftGameSpec } from '@/play/draft';
import { __resetProcessVersionStore } from '@/play/version';
import { resetProcessSpendCap } from '@/server/spend-cap';

import {
  attemptsInFlight,
  billedFromLog,
  buildStamp,
  compareSummary,
  compareVerdict,
  loadSet,
  type MeasuredSentence,
  measureSentence,
  modelEnv,
  PLAY_DOOR_SLOTS,
  setSize,
  specFidelity,
  upgradeEnds,
} from '../play-fidelity.mjs';

const SENTENCES = loadSet('dev', { only: 's039,s037,s002' });

interface Recorded {
  /** Odpovědi `GET …/upgrade` po řadě. */
  readonly upgrades: readonly Record<string, unknown>[];
  /** AI verze, když ji server publikoval (`publishEligible` = robot ji pustil). */
  readonly ai?: { readonly spec: unknown; readonly publishEligible: boolean; readonly source: 'authored' | 'cached' };
  /** Proč pokus skončil návrhem – server to zapíše řádkem `ended`. */
  readonly failure?: { readonly stage: 'model' | 'publish'; readonly reason: string; readonly detail: string };
  /** Pokus, který stránka návrhu spustila těsně před koncem a který doběhne `afterMs` po poslední odpovědi. */
  readonly lingering?: { readonly afterMs: number; readonly detail: string };
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
    s037: { upgrades: [pending, { status: 'draft-final', reason: 'NOT_PLAYABLE' }], failure: { stage: 'publish', reason: 'UNWINNABLE', detail: 'the robot did not reach the goal' } },
    s002: { upgrades: [ready('s002')], ai: { spec: aiSpec('A knight must collect three keys in a haunted castle while dodging ghosts.'), publishEligible: true, source: 'authored' } },
  },
};

const BILLED_LOG = {
  astra: ['ready', billedLine('gpt-6-astra', 0.0042), billedLine('gpt-6-astra', 0.0038), '[play] something else', billedLine('gpt-6-astra', 0.0044)].join('\n'),
  // 0,0024 = volání bez účtenky: strop strhl celou rezervaci a řádek to nese.
  oss20b: [billedLine('openai/gpt-oss-20b', 0.0002), billedLine('openai/gpt-oss-20b', 0.0003), billedLine('openai/gpt-oss-20b', 0.0024), billedLine('openai/gpt-oss-20b', 0.0001)].join('\n'),
};

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

interface RecordedServer {
  readonly fetch: typeof fetch;
  /** Log serveru, jak ho skript vidí v čase `clock.t`: řádky začátku a konce pokusu, `ended` s příčinou. */
  readonly log: () => string;
}

/** Server přehrávající nahrané odpovědi; každý dotaz posune hodiny o 100 ms. */
function recordedServer(recorded: Record<string, Recorded>, clock: { t: number }): RecordedServer {
  const games = new Map<string, unknown>();
  const upgrades = new Map<string, Record<string, unknown>[]>();
  const lines: { at: number; text: string }[] = [];
  const settle = (id: string, at: number, answer: Record<string, unknown>, failure: Recorded['failure']) => {
    if (answer.status === 'draft-final' && failure !== undefined) lines.push({ at, text: upgradeEndedLine(id, answer.reason as DraftFinalReason, failure) });
    lines.push({ at, text: upgradeAttemptLine(id, 'settled') });
  };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    clock.t += 100;
    const path = new URL(String(input)).pathname;
    if (init?.method === 'POST') {
      const text = JSON.parse(String(init.body)).sentence as string;
      const id = SENTENCES.find((sentence) => sentence.text === text)!.id;
      games.set(id, { spec: draftGameSpec(text), report: { publishEligible: true }, timings: { source: 'draft' } });
      upgrades.set(id, [...recorded[id]!.upgrades]);
      lines.push({ at: clock.t, text: upgradeAttemptLine(id, 'started') });
      const ai = recorded[id]!.ai;
      if (ai !== undefined) games.set(`ai-${id}`, { spec: ai.spec, report: { publishEligible: ai.publishEligible }, timings: { source: ai.source } });
      return json({ versionId: id });
    }
    if (path.endsWith('/upgrade')) {
      const id = path.split('/')[4]!;
      const answer = upgrades.get(id)!.shift()!;
      if (answer.status !== 'pending') {
        settle(id, clock.t, answer, recorded[id]!.failure);
        const lingering = recorded[id]!.lingering;
        if (lingering !== undefined) {
          lines.push({ at: clock.t, text: upgradeAttemptLine(id, 'started') });
          settle(id, clock.t + lingering.afterMs, { status: 'draft-final', reason: 'MODEL_UNAVAILABLE' }, { stage: 'model', reason: 'UPSTREAM_REJECTED', detail: lingering.detail });
        }
      }
      return json(answer);
    }
    return json({ game: games.get(path.split('/').at(-1)!) });
  }) as typeof fetch;
  return {
    fetch: fetchImpl,
    log: () =>
      lines
        .filter((line) => line.at <= clock.t)
        .map((line) => line.text)
        .join('\n'),
  };
}

type Events = string[];

/** Jedna věta nad nahraným serverem; `events` zapisuje POST, otevření stránek a odchody na `about:blank`. */
async function measureRecorded(sentence: (typeof SENTENCES)[number], recorded: Record<string, Recorded>, events: Events = [], settleMs?: number): Promise<{ result: MeasuredSentence; clock: { t: number } }> {
  const clock = { t: 0 };
  const server = recordedServer(recorded, clock);
  const result = await measureSentence(sentence, {
    base: 'http://127.0.0.1:3331',
    fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') events.push('POST');
      return server.fetch(input, init);
    }) as typeof fetch,
    log: server.log,
    leave: async () => {
      events.push('leave');
    },
    now: () => clock.t,
    wait: async (ms) => {
      clock.t += ms;
    },
    // Stránka hry je hratelná 800 ms po otevření.
    openGame: async (url) => {
      events.push(`open ${url.split('/').at(-1)}`);
      clock.t += 800;
    },
    ...(settleMs === undefined ? {} : { settleMs }),
  });
  return { result, clock };
}

async function replay(model: 'astra' | 'oss20b', recorded: Record<string, Recorded> = RECORDED[model]): Promise<MeasuredSentence[]> {
  const out: MeasuredSentence[] = [];
  for (const sentence of SENTENCES) out.push((await measureRecorded(sentence, recorded)).result);
  return out;
}

const refusedBy = (detail: string): Recorded => ({
  upgrades: [pending, { status: 'draft-final', reason: 'MODEL_UNAVAILABLE' }],
  failure: { stage: 'model', reason: 'UPSTREAM_REJECTED', detail },
});

describe('measureSentence', () => {
  it('times the first playable frame in the browser, not the POST answer', async () => {
    const clock = { t: 0 };
    const opened: { url: string; at: number }[] = [];
    const server = recordedServer(RECORDED.astra, clock);
    const result = await measureSentence(SENTENCES[0]!, {
      base: 'http://127.0.0.1:3331',
      fetchImpl: server.fetch,
      log: server.log,
      leave: async () => {},
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
    const server = recordedServer(RECORDED.oss20b, clock);
    const result = await measureSentence(SENTENCES[0]!, {
      base: 'http://127.0.0.1:3331',
      fetchImpl: server.fetch,
      log: server.log,
      leave: async () => {},
      now: () => clock.t,
      wait: async () => {},
      openGame: async (url) => {
        if (url.endsWith('/ai-s039')) throw new Error('waitForFunction timeout 60000ms');
      },
    });
    expect(result.ai).toMatchObject({ published: true, frameMs: null, frameError: expect.stringContaining('timeout') });
  });

  it('leaves the page for about:blank before the next sentence, the draft page right after the upgrade ends', async () => {
    const events: Events = [];
    await measureRecorded(SENTENCES[0]!, RECORDED.astra, events);
    await measureRecorded(SENTENCES[1]!, RECORDED.oss20b, events);
    // Stránka návrhu se ptá na upgrade každé 2 s a po přechodném konci spustí nový pokus.
    expect(events).toEqual(['POST', 'open s039', 'leave', 'open ai-s039', 'leave', 'POST', 'open s037', 'leave']);
  });

  it('waits until the attempt the draft page started has ended, and books its cause', async () => {
    // Skript vidí přechodný konec modelu; stránka mezitím spustila další pokus, který o 60 s později odmítnou dveře.
    const recorded = { ...RECORDED.oss20b, s039: { ...refusedBy('upstream answered 503'), lingering: { afterMs: 60_000, detail: 'no free play slot' } } };
    const events: Events = [];
    const { result, clock } = await measureRecorded(SENTENCES[0]!, recorded, events);
    expect(clock.t).toBeGreaterThanOrEqual(2100 + 60_000);
    expect(events.at(-1)).toBe('leave');
    // Bez čekání by věta šla na vrub modelu.
    expect(result.cause).toBe('door');
  });

  it('stops waiting for an attempt that never ends after settleMs', async () => {
    const recorded = { ...RECORDED.oss20b, s039: { ...refusedBy('upstream answered 503'), lingering: { afterMs: Number.POSITIVE_INFINITY, detail: 'never' } } };
    const { result, clock } = await measureRecorded(SENTENCES[0]!, recorded, [], 30_000);
    expect(clock.t).toBeGreaterThanOrEqual(2100 + 30_000);
    expect(clock.t).toBeLessThan(2100 + 32_000);
    expect(result.cause).toBe('model');
  });
});

describe('the cause of a sentence without an AI version', () => {
  it('books a door refusal as door: not a model failure, out of fidelity, and the run is invalid', async () => {
    const results = await replay('oss20b', { ...RECORDED.oss20b, s002: refusedBy('no free play slot') });
    expect(results.map((result) => result.cause)).toEqual([null, 'model', 'door']);
    const summary = compareSummary({ oss20b: { buildId: 'b1', concurrency: 2, results, billed: billedFromLog(BILLED_LOG.oss20b) } }, 'b1');
    expect(summary.oss20b).toMatchObject({ n: 3, refused: { door: 1, cap: 0 }, published: { ok: 1, of: 2, share: 0.5, failures: { NOT_PLAYABLE: 1 } } });
    const scored = [aiSpec(SENTENCES[0]!.text), draftGameSpec(SENTENCES[1]!.text)].map((spec, at) => specFidelity(spec, SENTENCES[at]!.checklist).score);
    expect(summary.oss20b!.fidelity.read).toBeCloseTo((scored[0]! + scored[1]!) / 2, 3);
    const verdict = compareVerdict(summary);
    expect(verdict).toMatchObject({ valid: false, exitCode: 1 });
    expect(verdict.reason).toMatch(/oss20b: 1 sentences refused by the play door, 0 by the spend or call cap/);
  });

  it('books a spend-cap refusal, also in a repair round, as cap, and the run is invalid', async () => {
    const results = await replay('oss20b', { ...RECORDED.oss20b, s002: refusedBy('repair round 1: spend cap refused the call') });
    expect(results.at(-1)!.cause).toBe('cap');
    const summary = compareSummary({ oss20b: { buildId: 'b1', concurrency: 1, results, billed: billedFromLog(BILLED_LOG.oss20b) } }, 'b1');
    expect(summary.oss20b).toMatchObject({ refused: { door: 0, cap: 1 }, published: { failures: { NOT_PLAYABLE: 1 } } });
    expect(compareVerdict(summary)).toMatchObject({ valid: false, exitCode: 1, reason: expect.stringMatching(/0 sentences refused by the play door, 1 by the spend or call cap/) });
  });

  it('books MODEL_UNAVAILABLE without a door or cap line as the model, and the run stays valid', async () => {
    const results = await replay('oss20b', { ...RECORDED.oss20b, s002: refusedBy('upstream answered 503') });
    expect(results.at(-1)!.cause).toBe('model');
    const summary = compareSummary({ oss20b: { buildId: 'b1', concurrency: 1, results, billed: billedFromLog(BILLED_LOG.oss20b) } }, 'b1');
    expect(summary.oss20b).toMatchObject({ refused: { door: 0, cap: 0 }, published: { ok: 1, of: 3, failures: { NOT_PLAYABLE: 1, MODEL_UNAVAILABLE: 1 } } });
    expect(compareVerdict(summary)).toEqual({ valid: true, reason: null, exitCode: 0 });
  });

  it('counts only the attempts of its own draft', () => {
    const log = [upgradeAttemptLine('a', 'started'), upgradeAttemptLine('b', 'started'), upgradeEndedLine('b', 'MODEL_UNAVAILABLE', { stage: 'model', reason: 'UPSTREAM_REJECTED', detail: 'no free play slot' }), upgradeAttemptLine('b', 'settled')].join('\n');
    expect(attemptsInFlight(log, 'a')).toBe(1);
    expect(attemptsInFlight(log, 'b')).toBe(0);
    expect(upgradeEnds(log, 'a')).toEqual([]);
    expect(upgradeEnds(log, 'b')).toEqual(['door']);
  });
});

describe("the director's own refusal details", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetConcurrency();
    resetProcessSpendCap();
  });

  it('are what the comparison books as door, cap and model', async () => {
    const live = { WORLDSMITH_BRANCH: 'live', WORLDSMITH_MODEL_ENDPOINT: 'https://upstream.invalid/v1/messages', WORLDSMITH_MODEL_KEY: 'test-key', WORLDSMITH_USD_PER_MTOK_OUT: '15', WORLDSMITH_SPEND_CAP_USD: '5', PLAY_DIRECTOR_CALLS_PER_CALLER: '1' };
    for (const [key, value] of Object.entries(live)) vi.stubEnv(key, value);
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('upstream down', { status: 503 })));
    __resetProcessVersionStore();
    resetProcessSpendCap();
    const causeOf = async (caller: string) => {
      const game = await getDirector(Date.now(), caller)('A hamster escapes a supermarket while a giant Roomba hunts it.');
      expect(game.source).toBe('draft');
      return upgradeEnds(upgradeEndedLine('d', game.fallbackReason as DraftFinalReason, game.failure!), 'd');
    };

    expect(await causeOf('caller-a')).toEqual(['model']);
    // Druhé volání téhož volajícího: vyčerpaný denní počet je strop volání.
    expect(await causeOf('caller-a')).toEqual(['cap']);
    for (let slot = 0; slot < DOOR_CEILING.play; slot += 1) expect(acquireSlot('play')).toBe(true);
    expect(await causeOf('caller-b')).toEqual(['door']);
    resetConcurrency();
    vi.stubEnv('WORLDSMITH_SPEND_CAP_USD', '0');
    resetProcessSpendCap();
    expect(await causeOf('caller-c')).toEqual(['cap']);
  });
});

describe('compareSummary over recorded responses of both models', () => {
  it('reports publish share, fidelity, first playable frame and cost per model', async () => {
    const astra = await replay('astra');
    const oss20b = await replay('oss20b');
    const summary = compareSummary({
      astra: { buildId: 'b1', concurrency: 5, results: astra, billed: billedFromLog(BILLED_LOG.astra) },
      oss20b: { buildId: 'b1', concurrency: 5, results: oss20b, billed: billedFromLog(BILLED_LOG.oss20b) },
    }, 'b1');

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

    expect(summary.astra!.cost).toEqual({ calls: 3, usd: 0.0124, perSentence: 0.004133, perPublished: 0.004133 });
    // Volání bez účtenky se počítá tím, co strhl strop – model, který víc padá, nevyjde levnější.
    expect(summary.oss20b!.cost).toEqual({ calls: 4, usd: 0.003, perSentence: 0.001, perPublished: 0.0015 });
  });

  it('refuses a comparison that is not fair', async () => {
    const astra = await replay('astra');
    const oss20b = await replay('oss20b');
    const run = (results: readonly MeasuredSentence[], log: string, buildId = 'b1') => ({ buildId, concurrency: 1, results, billed: billedFromLog(log) });

    expect(() => compareSummary({ astra: run(astra, BILLED_LOG.astra), oss20b: run(oss20b, BILLED_LOG.oss20b, 'b2') }, 'b1')).toThrow(/different builds/);
    // Přestavba během prvního modelu: oba modely nesou totéž nové razítko, liší se jen od hlavičky před během.
    expect(() => compareSummary({ astra: run(astra, BILLED_LOG.astra, 'b2'), oss20b: run(oss20b, BILLED_LOG.oss20b, 'b2') }, 'b1')).toThrow(/different builds: b1, b2/);
    expect(() => compareSummary({ astra: run(astra.slice(1), BILLED_LOG.astra), oss20b: run(oss20b, BILLED_LOG.oss20b) }, 'b1')).toThrow(/different sentences/);
    // Server pod jménem oss20b účtoval astru: měřil by se jiný model, než říká tabulka.
    expect(() => compareSummary({ astra: run(astra, BILLED_LOG.astra), oss20b: run(oss20b, BILLED_LOG.astra) }, 'b1')).toThrow(/oss20b: the server billed gpt-6-astra/);
    // Autorské hry bez jediné účtenky: cena by se četla jako nula.
    expect(() => compareSummary({ astra: run(astra, ''), oss20b: run(oss20b, BILLED_LOG.oss20b) }, 'b1')).toThrow(/no billed call/);
  });

  it('counts a sentence refused under load as an error, not as a model failure', async () => {
    const oss20b: (MeasuredSentence | Pick<MeasuredSentence, 'id' | 'text' | 'checklist' | 'error'>)[] = await replay('oss20b');
    oss20b[1] = { id: SENTENCES[1]!.id, text: SENTENCES[1]!.text, checklist: SENTENCES[1]!.checklist, error: 'POST 429 {"error":"RATE_LIMITED"}' };
    const summary = compareSummary({ oss20b: { buildId: 'b1', concurrency: 5, results: oss20b, billed: billedFromLog(BILLED_LOG.oss20b) } }, 'b1');
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
    // astra: 8000 tokenů × 10 USD/Mtok = 0,08 USD na volání; dva porotci s rezervou 1,5 = 0,24 USD.
    expect(() => modelEnv('astra', env, 0.2, 2)).toThrow(/under 2 concurrent worst-case calls \(0\.240 USD\); raise --cap-usd/);
    expect(modelEnv('astra', env, 0.25, 2).WORLDSMITH_SPEND_CAP_USD).toBe('0.25');
    expect(() => modelEnv('oss20b', env, 0.004, 2)).toThrow(/raise --cap-usd/);
  });

  it('refuses a cap under the whole run – sentences × one worst-case call × 1.5 – before anything is paid', () => {
    // astra: 60 vět × 0,08 USD × 1,5 = 7,2 USD; strop 1,5 USD by vyčerpala uprostřed a zbytek by šel na vrub modelu.
    expect(() => modelEnv('astra', env, 1.5, 1, 60)).toThrow(/under 60 sentences × one worst-case call \(7\.200 USD\); raise --cap-usd or lower WORLDSMITH_FALLBACK_MAX_OUTPUT_TOKENS/);
    expect(modelEnv('astra', env, 7.2, 1, 60).WORLDSMITH_SPEND_CAP_USD).toBe('7.2');
    // Menší výstup: 60 × 1000 tokenů × 10 USD/Mtok × 1,5 = 0,9 USD.
    expect(modelEnv('astra', { ...env, WORLDSMITH_FALLBACK_MAX_OUTPUT_TOKENS: '1000' }, 1.5, 1, 60).WORLDSMITH_SPEND_CAP_USD).toBe('1.5');
  });

  it('counts the sentences of a run without opening the sealed test set', () => {
    const seal = join(process.cwd(), 'evals', 'play', 'p30', 'test-opened.json');
    const sealed = existsSync(seal);
    expect(setSize('dev')).toBe(loadSet('dev').length);
    expect(setSize('dev', 's039,s037')).toBe(2);
    expect(setSize('test')).toBe(200);
    expect(existsSync(seal)).toBe(sealed);
  });

  it('refuses more judges than the play door of one instance serves', () => {
    // Třetí porotce by dostal návrh od dveří a souhrn by ho připsal modelu.
    expect(PLAY_DOOR_SLOTS).toBe(DOOR_CEILING.play);
    expect(modelEnv('oss20b', env, 100, PLAY_DOOR_SLOTS).WORLDSMITH_SPEND_CAP_USD).toBe('100');
    for (const judges of [PLAY_DOOR_SLOTS + 1, 5, 0, 1.5]) expect(() => modelEnv('oss20b', env, 100, judges)).toThrow(/--concurrency must be an integer 1–2: .*measure the door, not the model/);
  });
});

describe('billedFromLog', () => {
  it("reads the director's billed line and skips everything else", () => {
    const log = ['▲ Next.js', billedLine('openai/gpt-oss-20b', 0.000123456), '[play] upgrade of x ended NOT_PLAYABLE', billedLine('gpt-6-astra', 0.12)].join('\n');
    expect(billedFromLog(log)).toEqual([
      { model: 'openai/gpt-oss-20b', usd: 0.00012346 },
      { model: 'gpt-6-astra', usd: 0.12 },
    ]);
  });
});

describe('buildStamp', () => {
  it('tells two builds apart although BUILD_ID says unbuilt, and refuses one older than the last commit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p30a-build-'));
    try {
      expect(() => buildStamp(dir, 0)).toThrow(/no \.next build/);
      const file = join(dir, 'BUILD_ID');
      writeFileSync(file, 'unbuilt');
      utimesSync(file, new Date('2026-09-27T10:00:00Z'), new Date('2026-09-27T10:00:00Z'));
      const first = buildStamp(dir, Date.parse('2026-09-27T09:00:00Z'));
      expect(first).toBe('unbuilt@2026-09-27T10:00:00.000Z');
      // Commit po buildu: měřil by se starý kód pod hlavičkou nového commitu.
      expect(() => buildStamp(dir, Date.parse('2026-09-27T11:00:00Z'))).toThrow(/older than the last commit/);
      // Přestavba mezi modely: týž obsah, jiné razítko, souhrn ho odmítne jako jiný build.
      utimesSync(file, new Date('2026-09-27T12:00:00Z'), new Date('2026-09-27T12:00:00Z'));
      expect(buildStamp(dir, 0)).not.toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
