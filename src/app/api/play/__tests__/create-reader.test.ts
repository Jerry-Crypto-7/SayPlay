/**
 * Čtení věty před draftem (P29B T5): route tvorby i režisér se nejdřív zeptají
 * lokální čtečky a draft postaví s jejím čtením. Čtečka je vypnutá ve výchozím
 * stavu (T3 rozhodl `off`, `evals/play/read/README.md`) a zapíná ji jen
 * `PLAY_READER=on` s `PLAY_READER_ENDPOINT`. Čtečka, která neodpoví, smí
 * tvorbu prodloužit nejvýš o `PLAY_READER_BUDGET_MS` – měřeno falešnými hodinami.
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { chainOrSingle } from '@/play/chain/decide';
import { readForChain } from '@/play/chain/read';
import { direct } from '@/play/director';
import { draftGameSpec, draftGameSpecWithMeta } from '@/play/draft';
import { classifyGenre } from '@/play/genre/classify';
import { DEFAULT_LOCAL_READER_BUDGET_MS } from '@/play/read/client';
import type { Reading } from '@/play/read/schema';
import { __resetProcessVersionStore, versionStoreFromEnv } from '@/play/version';
import { resetProcessAnswerStore } from '@/server/answer-cache';
import { resetRateWindows } from '@/server/rate-limit';
import { resetProcessSpendCap } from '@/server/spend-cap';
import { upstreamBranch } from '@/server/upstream';

const SENTENCE = 'a knight collects keys in a castle';
/** Dev P56C d04 (`multi_verb`): věta řetězu mikroher. */
const CHAIN = 'can u make one where a robot hops over lava cracks and shoots bubbles at grumpy clouds';
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
// P56C T17e: `loaded: false` je studený server – Rapier, kterého načetl dřívější test, se do otevření závory nepočítá.
const rapier = vi.hoisted(() => ({ gate: Promise.resolve(), loaded: true }));
vi.mock('@/play/arcade/physics/world', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/play/arcade/physics/world')>();
  return {
    ...actual,
    loadRapier: async () => {
      await rapier.gate;
      rapier.loaded = true;
      return actual.loadRapier();
    },
    rapierIfLoaded: () => (rapier.loaded ? actual.rapierIfLoaded() : null),
  };
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

async function publishedGame(response: Response): Promise<{ spec: unknown; chain?: unknown }> {
  expect(response.status).toBe(201);
  const { versionId } = await response.json();
  return (await readGame(new Request(`http://play.test/api/play/games/${versionId}`), { params: Promise.resolve({ id: versionId }) })).json();
}

const publishedSpec = async (response: Response): Promise<unknown> => (await publishedGame(response)).spec;

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

  // P56A T10-R1: fyzika, která se nenačte, shodí tvorbu – placené čtení, které už běží, pak model nezavolá.
  describe('a paid reader', () => {
    const PAID = {
      PLAY_READER: 'on',
      PLAY_READER_ENDPOINT: 'openai:https://api.groq.com/openai',
      PLAY_READER_KEY: 'gsk-test',
      PLAY_READER_MODEL: 'openai/gpt-oss-20b',
      PLAY_READER_USD_PER_MTOK_IN: '0.075',
      PLAY_READER_USD_PER_MTOK_OUT: '0.30',
      PLAY_READER_SPEND_CAP_USD: '1',
      PLAY_STORE_DIR: mkdtempSync(join(tmpdir(), 'p56a-route-reader-')),
    };
    const paid = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(READING) }, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 300 } })));

    beforeEach(() => {
      for (const [name, value] of Object.entries(PAID)) vi.stubEnv(name, value);
      resetProcessSpendCap();
      paid.mockClear();
      vi.stubGlobal('fetch', paid);
    });
    afterEach(() => {
      rapier.gate = Promise.resolve();
      resetProcessSpendCap();
    });

    it('pays once when the physics loads', async () => {
      expect((await create()).status).toBe(201);
      expect(paid).toHaveBeenCalledOnce();
    });

    // P56C T17: řetěz fyziku nepotřebuje – věta řetězu se publikuje i bez ní a nepoužité čtení se nezaplatí.
    it('publishes a chain sentence without the physics and pays nothing', async () => {
      const broken = Promise.reject(new Error('rapier wasm failed'));
      broken.catch(() => undefined);
      rapier.gate = broken;
      expect(await publishedGame(await create(CHAIN))).toHaveProperty('chain');
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(paid).not.toHaveBeenCalled();
    });

    it('sends nothing when the physics load fails', async () => {
      const broken = Promise.reject(new Error('rapier wasm failed'));
      broken.catch(() => undefined);
      rapier.gate = broken;
      await expect(create()).rejects.toThrow('rapier wasm failed');
      // Čtení dobíhá po pádu route; jeho lety jsou tu místní, takže za 300 ms by volání dávno odešlo.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(paid).not.toHaveBeenCalled();
    });
  });

  // P56C T17e: čtení řetězu staví návrh věty, který se s míčem bez fyziky nepřeloží – route na ni počká jako jedna hra.
  describe('on a cold server, before the physics loads', () => {
    /** Uložené čtení P56A (`p30-dev` d01): model říká běžec, návrh z něj staví míč. */
    const ROLLS = 'a hedgehog rolls down a mushroom hill avoiding foxes';
    const ROLLS_READING: Reading = {
      control: 'runner', verbs: [{ word: 'rolls', class: 'runner' }], hero: 'hedgehog', roles: [{ noun: 'foxes', kind: 'threat', count: null }],
      setting: 'mushroom hill', mood: null, numbers: { seconds: null, counts: [] }, genre: { genre: 'runner', mode: 'default' },
      foe: 'foxes', item: null, world: 'forest', title: 'Hedgehog Hill Roll',
    };
    const readerOf = (reading: Reading) => vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reading) } }] }), { status: 200 }));
    let open = (): void => undefined;

    beforeEach(() => {
      vi.stubEnv('PLAY_READER', 'on');
      rapier.loaded = false;
      rapier.gate = new Promise<void>((resolve) => { open = resolve; });
    });
    afterEach(() => {
      open();
      rapier.gate = Promise.resolve();
      rapier.loaded = true;
    });

    it('a reading that drafts a ball game waits for the physics instead of failing', async () => {
      const reader = readerOf(ROLLS_READING);
      vi.stubGlobal('fetch', reader);
      const pending = create(ROLLS);
      const settled = vi.fn();
      pending.then(settled, settled);
      await vi.waitFor(() => expect(reader).toHaveBeenCalledOnce());
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(settled).not.toHaveBeenCalled();
      open();
      expect(((await publishedSpec(await pending)) as { control?: string }).control).toBe('ball');
    });

    it('a chain reading without a ball publishes the chain with the physics still loading', async () => {
      vi.stubGlobal('fetch', readerOf({ ...READING, control: 'platform', verbs: [{ word: 'hops', class: 'platform' }, { word: 'shoots', class: 'aim_shoot' }], hero: 'robot', roles: [], setting: null, foe: 'grumpy cloud' }));
      expect(await publishedGame(await create(CHAIN))).toHaveProperty('chain');
    });
  });

  // P56A T10: vypnutá čtečka = rychlá cesta jako dřív u třiceti vět výchozích čísel (T1: audit-12 + prvních 18 z p30 dev).
  it('with the reader off publishes the keyword draft of every baseline sentence and calls nothing', async () => {
    vi.stubGlobal('fetch', answering);
    const set = (path: string) => (JSON.parse(readFileSync(path, 'utf8')) as { sentences: { text: string }[] }).sentences.map((row) => row.text);
    const sentences = [...set('evals/play/p56a/audit-12.json'), ...set('evals/play/p30/dev.json')].slice(0, 30);
    for (const sentence of sentences) {
      resetRateWindows();
      const game = await publishedGame(await create(sentence));
      // P56C T10: věta, kterou `chainOrSingle` pošle do řetězu, hraje řetěz – jeho obsah pinuje `chain-publish.test.ts`.
      if (chainOrSingle(sentence, readForChain(sentence, null), classifyGenre(sentence, null)) === 'single') expect(game.spec, sentence).toEqual(draftGameSpec(sentence));
      else expect(game, sentence).toHaveProperty('chain');
    }
    expect(answering).not.toHaveBeenCalled();
  }, 300_000);

  // T4-R1: holá adresa je lokální llama-server, jeho výchozí rozpočet je DEFAULT_LOCAL_READER_BUDGET_MS, ne 700 ms.
  it.each(['soon', '0', '-5', '2.5', '200000'])('a budget of %s is not a whole number in 1..120000 and falls back to the local default', async (budget) => {
    vi.stubEnv('PLAY_READER', 'on');
    vi.stubEnv('PLAY_READER_BUDGET_MS', budget);
    vi.stubGlobal('fetch', silent);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let settled = false;
    const pending = create().then((response) => {
      settled = true;
      return response;
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCAL_READER_BUDGET_MS - 1);
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

  // P56C T17: řetěz ze čtení modelem nese readBy a hrdinu čtení v každém kole.
  it('stores readBy model on a chain the reading built, with its hero in every round', async () => {
    const reading: Reading = { ...READING, control: 'platform', verbs: [{ word: 'hops', class: 'platform' }, { word: 'shoots', class: 'aim_shoot' }], hero: 'robot', roles: [], setting: null, foe: 'grumpy cloud' };
    vi.stubEnv('PLAY_READER', 'on');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reading) } }] }), { status: 200 })));
    const { versionId } = (await (await create(CHAIN)).json()) as { versionId: string };
    const game = (await versionStoreFromEnv(process.env).get(versionId))!;
    expect(game.origin).toEqual({ sentence: CHAIN, seed: null, readBy: 'model' });
    const hero = readForChain(CHAIN, reading).hero;
    expect(game.chain!.rounds.map((round) => round.spec.roles.find((role) => role.kind === 'player')?.label)).toEqual(game.chain!.rounds.map(() => hero));
  });

  // P56C T17a: název čtení, ne název kola 1 ze slov – v odpovědi POST, ve verzi (feed) i v každém kole.
  it('publishes a chain the reading built under the reading title', async () => {
    const reading: Reading = { ...READING, control: 'platform', verbs: [{ word: 'hops', class: 'platform' }, { word: 'shoots', class: 'aim_shoot' }], hero: 'robot', roles: [], setting: null, foe: 'grumpy cloud', title: 'Cloud Popper' };
    vi.stubEnv('PLAY_READER', 'on');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reading) } }] }), { status: 200 })));
    expect(readForChain(CHAIN, reading).title).toBe('Cloud Popper');
    const body = (await (await create(CHAIN)).json()) as { versionId: string; title: string };
    const game = (await versionStoreFromEnv(process.env).get(body.versionId))!;
    expect(game.chain).toBeDefined();
    expect(body.title).toBe('Cloud Popper');
    expect(game.version.title).toBe('Cloud Popper');
    expect(game.chain!.rounds.map((round) => round.spec.title)).toEqual(game.chain!.rounds.map(() => 'Cloud Popper'));
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
