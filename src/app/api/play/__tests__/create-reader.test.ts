/**
 * Čtení věty před draftem (P29B T5): route tvorby i režisér se nejdřív zeptají
 * lokální čtečky a draft postaví s jejím čtením. Čtečka je vypnutá ve výchozím
 * stavu (T3 rozhodl `off`, `evals/play/read/README.md`) a zapíná ji jen
 * `PLAY_READER=on` s `PLAY_READER_ENDPOINT`. Čtečka, která neodpoví, smí
 * tvorbu prodloužit nejvýš o `PLAY_READER_BUDGET_MS` – měřeno falešnými hodinami.
 */

import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { direct } from '@/play/director';
import { draftGameSpec, draftGameSpecWithMeta } from '@/play/draft';
import type { Reading } from '@/play/read/schema';
import { __resetProcessVersionStore, versionStoreFromEnv } from '@/play/version';
import { resetProcessAnswerStore } from '@/server/answer-cache';
import { resetRateWindows } from '@/server/rate-limit';
import { upstreamBranch } from '@/server/upstream';

const SENTENCE = 'a knight collects keys in a castle';
const READING: Reading = {
  control: 'shooter',
  verbs: [{ word: 'collect', class: 'aim_shoot' }],
  hero: 'knight',
  roles: [{ noun: 'dragons', kind: 'threat', count: 6 }],
  setting: 'a castle',
  mood: null,
  numbers: { seconds: null, counts: [] },
  genre: null,
  foe: null,
  item: null,
  world: null,
  title: null,
};

// P56A T10: fyzika se načítá za závorou, kterou test drží zavřenou – čtečka se musí zeptat dřív, než se otevře.
const rapier = vi.hoisted(() => ({ gate: Promise.resolve() }));
vi.mock('@/play/arcade/physics/world', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/play/arcade/physics/world')>();
  return { ...actual, loadRapier: async () => { await rapier.gate; return actual.loadRapier(); } };
});

vi.mock('../_director', () => ({
  getDirector: () => async () => ({ ok: true, spec: draftGameSpec(SENTENCE), source: 'draft', repairRounds: 0, fallbackReason: 'NO_MODEL', warnings: [], ms: 1, calls: 0, callerLimited: false }),
}));

const { POST: createGame } = await import('../games/route');
const { GET: readGame } = await import('../games/[id]/route');

const answering = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(READING) } }] }), { status: 200 }));
/** Čtečka, která neodpoví: fetch skončí až zrušením signálu. */
const silent = vi.fn(
  (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }),
);

const create = (sentence = SENTENCE) =>
  createGame(
    new Request('http://play.test/api/play/games', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
      body: JSON.stringify({ sentence }),
    }),
  );

async function publishedSpec(response: Response): Promise<unknown> {
  expect(response.status).toBe(201);
  const { versionId } = await response.json();
  return (await (await readGame(new Request(`http://play.test/api/play/games/${versionId}`), { params: Promise.resolve({ id: versionId }) })).json()).spec;
}

beforeEach(() => {
  __resetProcessVersionStore();
  resetRateWindows();
  // Čtečka si čtení pamatuje po větě (P56A T4); každý test čte znovu.
  resetProcessAnswerStore();
  vi.stubEnv('PLAY_READER_ENDPOINT', 'http://reader.test');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  answering.mockClear();
  silent.mockClear();
});

describe('create route reads the sentence before drafting', () => {
  it('is off by default: no call, the keyword draft', async () => {
    vi.stubGlobal('fetch', answering);
    expect(await publishedSpec(await create())).toEqual(draftGameSpec(SENTENCE));
    expect(answering).not.toHaveBeenCalled();
  });

  it('with PLAY_READER=on drafts from the reading', async () => {
    vi.stubEnv('PLAY_READER', 'on');
    vi.stubGlobal('fetch', answering);
    const spec = await publishedSpec(await create());
    expect(answering).toHaveBeenCalledOnce();
    expect(String(answering.mock.calls[0]?.[0])).toBe('http://reader.test/v1/chat/completions');
    expect(spec).toEqual(draftGameSpecWithMeta(SENTENCE, 1, { reading: READING }).spec);
    // This malformed reading invents dragons and misclassifies collect as shooting.
    // Reading is advisory: an unrequested threat cannot replace collecting keys.
    expect(spec).toEqual(draftGameSpec(SENTENCE));
    expect((spec as { roles: { label: string }[] }).roles.map(role => role.label)).toContain('key');
    expect((spec as { roles: { label: string }[] }).roles.map(role => role.label)).not.toContain('dragon');
  });

  it('keeps the named collectible and its explicit count from a faithful reading', async () => {
    const sentence = 'a knight collects six keys in a castle';
    const reading: Reading = {
      ...READING, control: 'tap_go', verbs: [{ word: 'collect', class: 'tap_go' }],
      roles: [{ noun: 'keys', kind: 'collectible', count: 6 }],
      numbers: { seconds: null, counts: [6] },
    };
    const reader = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reading) } }] }), { status: 200 }));
    vi.stubEnv('PLAY_READER', 'on');
    vi.stubGlobal('fetch', reader);
    const spec = await publishedSpec(await create(sentence));
    expect(reader).toHaveBeenCalledOnce();
    expect(spec).toEqual(draftGameSpecWithMeta(sentence, 1, { reading }).spec);
    expect((spec as { roles: unknown[] }).roles).toContainEqual(expect.objectContaining({ label: 'key', kind: 'collectible', count: 6 }));
  });

  it('a silent reader delays the game by the budget at most, then the keywords draft it', async () => {
    vi.stubEnv('PLAY_READER', 'on');
    vi.stubEnv('PLAY_READER_BUDGET_MS', '800');
    vi.stubGlobal('fetch', silent);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let settled = false;
    const pending = create().then((response) => {
      settled = true;
      return response;
    });
    await vi.advanceTimersByTimeAsync(799);
    expect(silent).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    expect(await publishedSpec(await pending)).toEqual(draftGameSpec(SENTENCE));
  });

  // P56A T10: čtečka za načítáním fyziky by přidala svůj rozpočet ke každé větě; souběžně se ptá hned.
  it('asks the reader while the physics engine is still loading', async () => {
    vi.stubEnv('PLAY_READER', 'on');
    vi.stubGlobal('fetch', answering);
    let open = (): void => undefined;
    rapier.gate = new Promise<void>((resolve) => { open = resolve; });
    try {
      const pending = create();
      await vi.waitFor(() => expect(answering).toHaveBeenCalledOnce());
      open();
      expect(await publishedSpec(await pending)).toEqual(draftGameSpecWithMeta(SENTENCE, 1, { reading: READING }).spec);
    } finally {
      open();
      rapier.gate = Promise.resolve();
    }
  });

  // P56A T10: vypnutá čtečka = rychlá cesta jako dřív u třiceti vět výchozích čísel (T1: audit-12 + prvních 18 z p30 dev).
  it('with the reader off publishes the keyword draft of every baseline sentence and calls nothing', async () => {
    vi.stubGlobal('fetch', answering);
    const set = (path: string) => (JSON.parse(readFileSync(path, 'utf8')) as { sentences: { text: string }[] }).sentences.map((row) => row.text);
    const sentences = [...set('evals/play/p56a/audit-12.json'), ...set('evals/play/p30/dev.json')].slice(0, 30);
    for (const sentence of sentences) {
      resetRateWindows();
      expect(await publishedSpec(await create(sentence)), sentence).toEqual(draftGameSpec(sentence));
    }
    expect(answering).not.toHaveBeenCalled();
  }, 300_000);

  it.each(['soon', '0', '-5', '2.5', '200000'])('a budget of %s is not a whole number in 1..120000 and falls back to 700 ms', async (budget) => {
    vi.stubEnv('PLAY_READER', 'on');
    vi.stubEnv('PLAY_READER_BUDGET_MS', budget);
    vi.stubGlobal('fetch', silent);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let settled = false;
    const pending = create().then((response) => {
      settled = true;
      return response;
    });
    await vi.advanceTimersByTimeAsync(699);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    expect((await pending).status).toBe(201);
  });
});

describe('the draft remembers who read the sentence (T6)', () => {
  const originOf = async (response: Response) => {
    const { versionId } = (await response.json()) as { versionId: string };
    return (await versionStoreFromEnv(process.env).get(versionId))!.origin;
  };

  it('stores readBy model only when the reading built the draft', async () => {
    vi.stubEnv('PLAY_READER', 'on');
    vi.stubGlobal('fetch', answering);
    expect(await originOf(await create())).toEqual({ sentence: SENTENCE, seed: null, readBy: 'model' });
  });

  it('keeps the origin as before when the keywords built it', async () => {
    vi.stubGlobal('fetch', answering);
    expect(await originOf(await create())).toEqual({ sentence: SENTENCE, seed: null });
  });
});

describe('director reads the sentence before drafting', () => {
  it('drafts from the reading when on, from the keywords when off', async () => {
    vi.stubGlobal('fetch', answering);
    const branch = upstreamBranch(null);
    const off = await direct(SENTENCE, { branch, now: Date.now });
    expect(off.spec).toEqual(draftGameSpec(SENTENCE));
    expect(answering).not.toHaveBeenCalled();
    vi.stubEnv('PLAY_READER', 'on');
    const on = await direct(SENTENCE, { branch, now: Date.now });
    expect(answering).toHaveBeenCalledOnce();
    expect(on.spec).toEqual(draftGameSpecWithMeta(SENTENCE, 1, { reading: READING }).spec);
  });
});
