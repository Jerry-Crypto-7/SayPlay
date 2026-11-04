/**
 * Řetěz dostane čtení (P58E T1): se čtečkou jen pro AI verzi route řetězovou větu nečte, takže řetěz čtení neměl.
 * Po publikaci řetězu se věta přečte na pozadí přes tytéž brány jako čtení AI verze (`mayPayChainRead`, strop
 * a počet čtečky) a když se čtením `chainOrSingle` řekne jedna hra, publikuje se hra ze čtení jako dítě řetězu.
 *
 * Skutečná route a skutečná placená čtečka (`openai:`); dvojník je jen `fetch` poskytovatele s uloženým čtením astry
 * z dev sady P58B (`compare-dev-t6b.json`, p56a/holdout – otevřená, ladí se na ní).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadRapier } from '@/play/arcade/physics/world';
import { buildChain } from '@/play/chain/build';
import { chainOrSingle } from '@/play/chain/decide';
import { readForChain } from '@/play/chain/read';
import { draftGameSpecWithMeta } from '@/play/draft';
import { classifyGenre } from '@/play/genre/classify';
import type { Reading } from '@/play/read/schema';
import { __resetProcessVersionStore, memoryVersionStore, type PublishedGame, type VersionStore, versionStoreFromEnv } from '@/play/version';
import { resetProcessAnswerStore } from '@/server/answer-cache';
import { resetRateWindows } from '@/server/rate-limit';
import { resetProcessSpendCap } from '@/server/spend-cap';

import { derivedSeeds, directorCallerOf, publishChain, seedFrom } from '../_publish';
import { __resetUpgrades, knownUpgrade, readingOf, upgradeOf } from '../_upgrade';
import { GET as readUpgrade } from '../games/[id]/upgrade/route';
import { POST as createGame } from '../games/route';
import { freshCaller, params, post } from './dare-fixtures';

const DEV = (JSON.parse(readFileSync(join(process.cwd(), 'evals/play/p56a/holdout.json'), 'utf8')) as { sentences: { id: string; text: string }[] }).sentences;
const READ = (JSON.parse(readFileSync(join(process.cwd(), 'evals/play/p58b/compare-dev-t6b.json'), 'utf8')) as { rows: { set: string; id: string; models: Record<string, { reading: Reading | null }> }[] }).rows;
const devRow = (id: string) => ({ text: DEV.find((row) => row.id === id)!.text, reading: READ.find((row) => row.set === 'p56a/holdout' && row.id === id)!.models['astra@openai']!.reading! });

/** s57: slovník hraje řetěz (`multi_verb`), čtení `rhythm.default` – jedna hra. Dřív s12, tu od P61 T4 slovník hraje jako jednu hru. */
const SINGLE = devRow('s57');
/** s01: slovník i čtení hrají řetěz. */
const CHAIN = devRow('s01');
/** Věta, která o víc her výslovně žádá (`CHAIN_CUES`): řetězem zůstane i se čtením (P58F). */
const CUE = { text: `${CHAIN.text} across three levels`, reading: CHAIN.reading };
/** P63 h18: slovník hraje řetěz s drakem; čtení astry starým promptem (`readings.astra.json`) i promptem T2. */
const KNIGHT = 'A knight rides through the forest and slays a dragon';
const knightReading = (file: string): Reading =>
  (JSON.parse(readFileSync(join(process.cwd(), 'evals/play/p63', file), 'utf8')) as { rows: { id: string; models: Record<string, { reading: Reading }> }[] }).rows.find((row) => row.id === 'h18')!.models['astra@openai']!.reading;

/** Placená čtečka (cena astry) a objednaná placená větev režiséra – `mayPayChainRead` je pak otevřená. */
const PAID = {
  PLAY_READER: 'on',
  PLAY_READER_PATH: 'ai',
  PLAY_READER_ENDPOINT: 'openai:https://reader.invalid/openai',
  PLAY_READER_KEY: 'sk-test',
  PLAY_READER_MODEL: 'gpt-6-astra',
  PLAY_READER_USD_PER_MTOK_IN: '10',
  PLAY_READER_USD_PER_MTOK_OUT: '50',
  PLAY_READER_SPEND_CAP_USD: '1',
  WORLDSMITH_BRANCH: 'live',
  WORLDSMITH_MODEL_ENDPOINT: 'https://upstream.invalid/v1/messages',
  WORLDSMITH_MODEL_KEY: 'test-key',
  WORLDSMITH_USD_PER_MTOK_OUT: '15',
  WORLDSMITH_SPEND_CAP_USD: '5',
};

const reader = vi.hoisted(() => ({ reading: null as Reading | null, delayMs: 0, silent: false, calls: [] as string[] }));

// P70A T2: nová věta hraje řetěz jen na výslovné přání. Čtení dostávají řetězy uložené dřív – dvě slovesa, neslyšená
// věta –, tak je route publikuje pravidlem před P70A (každý důvod `chainReasons`), jako by je uložila tehdy.
vi.mock('@/play/chain/decide', async (original) => {
  const actual = await original<typeof import('@/play/chain/decide')>();
  return { ...actual, chainOrSingle: (...args: Parameters<typeof actual.chainReasons>) => (actual.chainReasons(...args).length > 0 ? 'chain' : 'single') };
});

function answer(): Promise<Response> {
  const body = JSON.stringify({ choices: [{ message: { content: JSON.stringify(reader.reading) }, finish_reason: 'stop' }], usage: { prompt_tokens: 2400, completion_tokens: 170 } });
  return new Promise((resolve) => setTimeout(() => resolve(new Response(body)), reader.delayMs));
}

beforeEach(async () => {
  await loadRapier();
  __resetProcessVersionStore();
  __resetUpgrades();
  resetRateWindows();
  resetProcessAnswerStore();
  resetProcessSpendCap();
  Object.assign(reader, { reading: SINGLE.reading, delayMs: 0, silent: false, calls: [] });
  for (const [name, value] of Object.entries(PAID)) vi.stubEnv(name, value);
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    reader.calls.push(String(url));
    if (!reader.silent) return answer();
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetProcessSpendCap();
});

async function create(sentence: string, caller = freshCaller()): Promise<{ status: number; body: { versionId: string; upgrade?: string }; ms: number }> {
  const started = performance.now();
  const response = await createGame(post('/api/play/games', { sentence }, caller));
  const ms = performance.now() - started;
  return { status: response.status, body: (await response.json()) as { versionId: string; upgrade?: string }, ms };
}

/** Práce řetězu doběhla: `CHAIN` je jediný konec, který má. */
async function settled(chainId: string): Promise<void> {
  await vi.waitFor(() => expect(knownUpgrade(chainId)).toMatchObject({ status: 'draft-final', reason: 'CHAIN' }), { timeout: 30_000 });
}

/** Práce řetězu doběhla s konci, který si proces nedrží (T5: čtení odmítla brána) – v mapě už není. */
async function forgotten(chainId: string): Promise<void> {
  await vi.waitFor(() => expect(knownUpgrade(chainId)).toBeNull(), { timeout: 30_000 });
}

/** Práce řetězu doběhla, ať si konec drží (`settled`), nebo ne (`forgotten`). */
async function ended(chainId: string): Promise<void> {
  await vi.waitFor(() => expect(knownUpgrade(chainId) ?? { status: 'draft-final', reason: 'CHAIN' }).toMatchObject({ status: 'draft-final', reason: 'CHAIN' }), { timeout: 30_000 });
}

const again = { seed: null, ackMs: null, draftReadyMs: null, caller: 'chain-reading-test' } as const;

async function children(store: VersionStore, parentId: string): Promise<PublishedGame[]> {
  return (await Promise.all((await store.childrenOf(parentId)).map((id) => store.get(id)))).filter((child) => child !== null);
}

describe('a chain sentence gets the reading (P58E T1)', () => {
  it('the dev sentences: the words play a chain, the reading one game or a chain again', () => {
    for (const { text } of [SINGLE, CHAIN]) expect(chainOrSingle(text, readForChain(text, null), classifyGenre(text, null))).toBe('chain');
    expect(chainOrSingle(SINGLE.text, readForChain(SINGLE.text, SINGLE.reading), classifyGenre(SINGLE.text, SINGLE.reading))).toBe('single');
    expect(chainOrSingle(CHAIN.text, readForChain(CHAIN.text, CHAIN.reading), classifyGenre(CHAIN.text, CHAIN.reading))).toBe('chain');
  });

  it('publishes the reading game as a reading child of the chain when the reading plays one game', async () => {
    const { status, body } = await create(SINGLE.text);
    expect(status).toBe(201);
    const store = versionStoreFromEnv(process.env);
    expect((await store.get(body.versionId))?.chain).toBeDefined();
    await settled(body.versionId);
    const reading = await children(store, body.versionId);
    expect(reading).toHaveLength(1);
    expect(reading[0]).toMatchObject({ relation: 'reading', version: { parentId: body.versionId }, origin: { sentence: SINGLE.text, seed: null, readBy: 'model' } });
    expect(reading[0]!.spec).toEqual(draftGameSpecWithMeta(SINGLE.text, 1, { reading: SINGLE.reading }).spec);
    expect(reading[0]!.spec.genre).toMatchObject({ id: 'rhythm', mode: 'default' });
    expect(readingOf(body.versionId)).toBe(reading[0]!.version.versionId);
    expect(reader.calls).toHaveLength(1);
  });

  // P58F: dřív tu řetěz zůstal (`chainOrSingle` se čtením řekl znovu řetěz); čtení dá hru správného žánru, tak ji hraje.
  it('publishes the reading game even when the reading alone would play a chain again', async () => {
    reader.reading = CHAIN.reading;
    const { body } = await create(CHAIN.text);
    await settled(body.versionId);
    const reading = await children(versionStoreFromEnv(process.env), body.versionId);
    expect(reading).toHaveLength(1);
    expect(reading[0]).toMatchObject({ relation: 'reading', version: { parentId: body.versionId } });
    expect(reading[0]!.spec).toEqual(draftGameSpecWithMeta(CHAIN.text, 1, { reading: CHAIN.reading }).spec);
    expect(reader.calls).toHaveLength(1);
  });

  // P63 T3: hra ze čtení, která z rolí čtení ukáže méně než kola řetězu, řetěz nenahradí. Staré čtení h18 je jízda bez
  // draka (řetěz drak má), čtení T2 souboj s drakem.
  it.each([
    ['the old reading: a ride without the dragon stays a chain', 'readings.astra.json', undefined],
    ['the reading of T2: the duel with the dragon replaces the chain', 'readings.p63.astra.json', 'duel'],
  ])('h18, %s', async (_name, file, genre) => {
    reader.reading = knightReading(file);
    const { body } = await create(KNIGHT);
    expect((await versionStoreFromEnv(process.env).get(body.versionId))?.chain).toBeDefined();
    await settled(body.versionId);
    const reading = await children(versionStoreFromEnv(process.env), body.versionId);
    expect(reading.map((child) => child.spec.genre?.id)).toEqual(genre === undefined ? [] : [genre]);
    expect(reader.calls).toHaveLength(1);
  });

  // P70A T2: čtení by nic nezměnilo (řetězem zůstane), tak se ani neplatí.
  it('publishes nothing and pays nothing when the sentence asks for several games', async () => {
    reader.reading = CUE.reading;
    const { body } = await create(CUE.text);
    expect((await versionStoreFromEnv(process.env).get(body.versionId))?.chain).toBeDefined();
    await settled(body.versionId);
    expect(await children(versionStoreFromEnv(process.env), body.versionId)).toEqual([]);
    expect(reader.calls).toEqual([]);
  });

  // Čtení `null` – řetěz zůstane, nic se nepublikuje a nic dalšího se nevolá.
  it.each([
    ['no reader key', { PLAY_READER_KEY: '' }],
    ['the paid branch not ordered (mayPayChainRead closed)', { WORLDSMITH_BRANCH: '' }],
    ['the director spend cap used up (mayPayChainRead closed)', { WORLDSMITH_SPEND_CAP_USD: '0' }],
    ['the reader spend cap used up', { PLAY_READER_SPEND_CAP_USD: '0' }],
    ['the reader call cap used up', { PLAY_READER_CALL_CAP: '0' }],
  ])('%s: the chain stays and nothing is paid', async (_name, env) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const { body } = await create(SINGLE.text);
    await ended(body.versionId);
    expect(await children(versionStoreFromEnv(process.env), body.versionId)).toEqual([]);
    expect(reader.calls).toEqual([]);
  });

  it("the caller's director calls used up (mayPayChainRead closed): the chain stays and nothing is paid", async () => {
    vi.stubEnv('PLAY_DIRECTOR_CALLS_PER_CALLER', '1');
    const caller = freshCaller();
    expect(await versionStoreFromEnv(process.env).takeDirectorCall(directorCallerOf(post('/api/play/games', {}, caller)), 1)).toBe(true);
    const { body } = await create(SINGLE.text, caller);
    await ended(body.versionId);
    expect(await children(versionStoreFromEnv(process.env), body.versionId)).toEqual([]);
    expect(reader.calls).toEqual([]);
  });

  it('a reading past its budget: the chain stays, one call and no other', async () => {
    vi.stubEnv('PLAY_READER_BUDGET_MS', '300');
    reader.silent = true;
    const { body } = await create(SINGLE.text);
    await settled(body.versionId);
    expect(await children(versionStoreFromEnv(process.env), body.versionId)).toEqual([]);
    expect(reader.calls).toHaveLength(1);
  });

  it('the POST does not wait for the reading: a reader 3 s late, the chain back under 1 s', async () => {
    reader.delayMs = 3000;
    const { status, body, ms } = await create(SINGLE.text);
    expect(status).toBe(201);
    expect(ms).toBeLessThan(1000);
    expect(readingOf(body.versionId)).toBeNull();
    await settled(body.versionId);
    expect(readingOf(body.versionId)).not.toBeNull();
  });

  it('two concurrent POSTs of one chain read once', async () => {
    reader.delayMs = 500;
    const [a, b] = await Promise.all([create(SINGLE.text), create(SINGLE.text)]);
    expect(a.body.versionId).toBe(b.body.versionId);
    await settled(a.body.versionId);
    expect(reader.calls).toHaveLength(1);
    expect(await children(versionStoreFromEnv(process.env), a.body.versionId)).toHaveLength(1);
  });

  it('a failed reading publication is a log line: the chain is unchanged', async () => {
    const store = memoryVersionStore();
    const seeds = derivedSeeds(seedFrom(SINGLE.text.trim()));
    const built = buildChain(SINGLE.text, readForChain(SINGLE.text, null), seeds[0]!);
    if (!built.ok) throw new Error(`chain not built: ${built.issues.join('; ')}`);
    const chain = await publishChain(store, built.chain, null, { origin: { sentence: SINGLE.text, seed: null } });
    if (!chain.ok) throw new Error('chain not published');
    const failing: VersionStore = { ...store, put: (game) => (game.relation === 'reading' ? Promise.reject(new Error('disk on fire')) : store.put(game)) };
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const chainId = chain.value.game.version.versionId;
    const outcome = await upgradeOf(failing, chain.value.game, { sentence: SINGLE.text, seed: null, ackMs: null, draftReadyMs: null, startedAt: Date.now(), caller: 'chain-reading-test' });
    expect(outcome).toEqual({ status: 'draft-final', reason: 'CHAIN' });
    expect(warned.mock.calls.map((call) => String(call[0]))).toContainEqual(expect.stringContaining(`reading version of ${chainId} failed: disk on fire`));
    expect(await children(store, chainId)).toEqual([]);
    expect((await store.get(chainId))?.chain).toEqual(chain.value.game.chain);
    expect(readingOf(chainId)).toBeNull();
  });

  it('a reading game an earlier attempt published is found in the store: no second read', async () => {
    const { body } = await create(SINGLE.text);
    await settled(body.versionId);
    expect(reader.calls).toHaveLength(1);
    // Jiná instance (restart, serverless): práce v paměti není a cache odpovědí taky ne.
    __resetUpgrades();
    resetProcessAnswerStore();
    const again = await create(SINGLE.text);
    expect(again.status).toBe(200);
    await settled(body.versionId);
    expect(reader.calls).toHaveLength(1);
    expect(readingOf(body.versionId)).not.toBeNull();
  });
});

describe('a chain refused by a closed gate is read once the gate opens (P58E T5)', () => {
  // Brána před čtečkou (`mayPayChainRead`) i strop uvnitř placeného čtení: ani jedno nic nezaplatí.
  it.each([
    ['the paid branch not ordered', 'WORLDSMITH_BRANCH', '', 'live'],
    ['the reader call cap used up', 'PLAY_READER_CALL_CAP', '0', '10'],
  ])('%s: CHAIN, not kept, and the next ask after the gate opens reads once', async (_name, name, closed, open) => {
    vi.stubEnv(name, closed);
    const { body } = await create(SINGLE.text);
    await forgotten(body.versionId);
    expect(reader.calls).toEqual([]);
    vi.stubEnv(name, open);
    // Strop čtečky čte prostředí jednou za proces.
    resetProcessSpendCap();
    const store = versionStoreFromEnv(process.env);
    const chain = (await store.get(body.versionId))!;
    const outcome = await upgradeOf(store, chain, { ...again, sentence: SINGLE.text, startedAt: Date.now() });
    expect(outcome).toEqual({ status: 'draft-final', reason: 'CHAIN', reading: { versionId: expect.any(String) } });
    expect(reader.calls).toHaveLength(1);
    expect(await upgradeOf(store, chain, { ...again, sentence: SINGLE.text, startedAt: Date.now() })).toEqual(outcome);
    expect(reader.calls).toHaveLength(1);
    expect(await children(store, body.versionId)).toHaveLength(1);
  });

  it('a paid reading that came back empty is kept: the next ask does not pay again', async () => {
    reader.reading = null;
    const { body } = await create(SINGLE.text);
    await settled(body.versionId);
    expect(reader.calls).toHaveLength(1);
    // Zaplacené prázdné čtení drží i cache odpovědí; bez ní ho drží jen práce v procesu.
    resetProcessAnswerStore();
    const store = versionStoreFromEnv(process.env);
    const outcome = await upgradeOf(store, (await store.get(body.versionId))!, { ...again, sentence: SINGLE.text, startedAt: Date.now() });
    expect(outcome).toEqual({ status: 'draft-final', reason: 'CHAIN' });
    expect(reader.calls).toHaveLength(1);
    expect(await children(store, body.versionId)).toEqual([]);
  });

  it('an empty reading another process paid (in the answer cache) is kept: not paid again once it expires', async () => {
    reader.reading = null;
    const { body } = await create(SINGLE.text);
    await settled(body.versionId);
    expect(reader.calls).toHaveLength(1);
    // Jiný proces: práce v paměti není, prázdné čtení zaplacené prvním leží v cache odpovědí.
    __resetUpgrades();
    const store = versionStoreFromEnv(process.env);
    const chain = (await store.get(body.versionId))!;
    expect(await upgradeOf(store, chain, { ...again, sentence: SINGLE.text, startedAt: Date.now() })).toEqual({ status: 'draft-final', reason: 'CHAIN' });
    expect(knownUpgrade(body.versionId)).toEqual({ status: 'draft-final', reason: 'CHAIN' });
    // Prázdné čtení v cache vypršelo; konec drží práce v procesu.
    resetProcessAnswerStore();
    expect(await upgradeOf(store, chain, { ...again, sentence: SINGLE.text, startedAt: Date.now() })).toEqual({ status: 'draft-final', reason: 'CHAIN' });
    expect(reader.calls).toHaveLength(1);
  });

  it('a free local reader that came back empty is kept: no new call on the next ask', async () => {
    vi.stubEnv('PLAY_READER_ENDPOINT', 'llamacpp:http://127.0.0.1:8792');
    reader.reading = null;
    const { body } = await create(SINGLE.text);
    await settled(body.versionId);
    expect(reader.calls).toHaveLength(1);
    const store = versionStoreFromEnv(process.env);
    expect(await upgradeOf(store, (await store.get(body.versionId))!, { ...again, sentence: SINGLE.text, startedAt: Date.now() })).toEqual({ status: 'draft-final', reason: 'CHAIN' });
    expect(reader.calls).toHaveLength(1);
  });
});

describe('the upgrade route reports a chain reading game (P58E T2)', () => {
  async function asked(id: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await readUpgrade(new Request(`http://play.test/api/play/games/${id}/upgrade`, { headers: freshCaller() }), params(id));
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  /** Proces, který práci zná, odpoví hned (bez long-pollu) – klient se ptá znovu. */
  async function final(id: string): Promise<{ status: number; body: Record<string, unknown> }> {
    let last = await asked(id);
    await vi.waitFor(async () => {
      last = await asked(id);
      expect(last.body.status).not.toBe('pending');
    }, { timeout: 30_000 });
    return last;
  }

  it('pending without the reading while it is read, then CHAIN carrying the reading game', async () => {
    reader.delayMs = 1500;
    const { body } = await create(SINGLE.text);
    expect(body.upgrade).toBe(`/api/play/games/${body.versionId}/upgrade`);
    expect(await asked(body.versionId)).toEqual({ status: 200, body: { status: 'pending', deadlineAt: expect.stringMatching(/^\d{4}-/) } });
    const ended = await final(body.versionId);
    const [child] = await children(versionStoreFromEnv(process.env), body.versionId);
    expect(ended).toEqual({ status: 200, body: { status: 'draft-final', reason: 'CHAIN', reading: { versionId: child!.version.versionId } } });
  });

  it('a chain the sentence asks for ends CHAIN with no reading game', async () => {
    reader.reading = CUE.reading;
    const { body } = await create(CUE.text);
    expect(await final(body.versionId)).toEqual({ status: 200, body: { status: 'draft-final', reason: 'CHAIN' } });
  });

  it('a process that never saw the chain finds the stored reading game at once and reads nothing', async () => {
    const { body } = await create(SINGLE.text);
    await settled(body.versionId);
    __resetUpgrades();
    resetProcessAnswerStore();
    const started = performance.now();
    const final = await asked(body.versionId);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(final.body).toMatchObject({ status: 'draft-final', reason: 'CHAIN', reading: { versionId: readingOf(body.versionId) } });
    expect(reader.calls).toHaveLength(1);
  });
});
