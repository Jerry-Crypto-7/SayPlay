/**
 * Hra ze čtení (P58D T1): návrh, který režie AI verze postaví ze čtení věty, se publikuje jako dítě rychlé hry
 * (`relation: 'reading'`), když hraje jiný žánr – hráč ho dostane za ~3 s místo za minutu. Čtení se neplatí znovu,
 * publikace AI verzi nezdrží ani neshodí a AI verze zůstává dítětem rychlé hry.
 *
 * Skutečná cesta upgradu (`directUpgrade` → `direct()` → publikace) nad uloženými čteními P56A; dvojníky jsou
 * jen větev modelu (nahraná odpověď) a čtečka za `fetch` (místní adresa, nic se neplatí).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadRapier } from '@/play/arcade/physics/world';
import { direct } from '@/play/director';
import { answered, fakeBranch } from '@/play/director/__fixtures__/branch';
import type { LogicAnswerFixture } from '@/play/director/__fixtures__/logic-answers';
import { draftGameSpecWithMeta } from '@/play/draft';
import type { Reading } from '@/play/read/schema';
import { __resetProcessVersionStore, type PublishedGame, memoryVersionStore, type VersionStore, versionStoreFromEnv } from '@/play/version';
import { resetProcessAnswerStore } from '@/server/answer-cache';
import { resetRateWindows } from '@/server/rate-limit';

import type { getDirector } from '../_director';
import { derivedSeeds, publishReadSpec, seedFrom } from '../_publish';

/** Režie, kterou `upgradeOf` zavolá místo živé (`getDirector` je jediná věc, kterou `_director` mění). */
const seam = vi.hoisted(() => ({ director: null as typeof getDirector | null }));
vi.mock('../_director', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_director')>();
  return { ...actual, getDirector: (...args: Parameters<typeof getDirector>) => (seam.director ?? actual.getDirector)(...args) };
});

// Stránka hry (T2) mimo Next.js: hlavičky pro bránu, `notFound` jako výjimka a shell bez renderu (vzor `dare-by.test.ts`).
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.58' }) }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/components/play/PlayShell', () => ({ PlayShell: () => null }));

const { __resetUpgrades, directUpgrade, readingOf, upgradeOf } = await import('../_upgrade');
const { default: PlayGamePage } = await import('@/app/play/[id]/page');

const readings = (JSON.parse(readFileSync(join(process.cwd(), 'evals/play/p56a/readings/p30-dev.gpt-oss-20b.json'), 'utf8')) as { readings: { id: string; text: string; reading: Omit<Reading, 'sure'> }[] }).readings;
/** Čtení P56A je starší než `sure` (P58B T5): čtečka by ho bez něj odmítla. */
const stored = (id: string) => {
  const row = readings.find((candidate) => candidate.id === id)!;
  return { ...row, reading: { ...row.reading, sure: true } satisfies Reading };
};
const fixture = (id: string): LogicAnswerFixture =>
  JSON.parse(readFileSync(join(process.cwd(), 'src/play/director/__fixtures__/logic-answers', `${id}.json`), 'utf8')) as LogicAnswerFixture;

/** p30 dev s002: slovník hraje `arena.escape`, čtení `quest.spatial`; nahraná odpověď režiséra k téže větě. */
const OTHER = { ...stored('s002'), answer: fixture('s002').answer };
/** p30 dev s039: slovník i čtení hrají `shooter.default`. */
const SAME = stored('s039');

let reads = 0;
/** Čtečka za místní adresou: odpoví `reading`, nebo 500, když je `null`. */
function reader(reading: Reading | null) {
  vi.stubGlobal('fetch', async () => {
    reads += 1;
    return reading === null ? new Response('down', { status: 500 }) : new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reading) } }] }), { status: 200 });
  });
}

/** Rychlá hra věty, jak ji publikuje `POST /api/play/games` se čtečkou jen pro AI verzi: ze slovníku. */
async function quickGame(store: VersionStore, sentence: string): Promise<PublishedGame> {
  const quick = await publishReadSpec(store, draftGameSpecWithMeta(sentence, 1).spec, derivedSeeds(seedFrom(sentence)), null, { origin: { sentence, seed: null } });
  if (!quick.ok) throw new Error(`quick version did not publish: ${JSON.stringify(quick.issues)}`);
  return quick.value.game;
}

/**
 * Režie jako `getDirector`: `direct()` s volajícím (čtení pro AI verzi) a nahranou odpovědí. `forward: false` je
 * stav před T1 – návrh ze čtení se zahodí. `gate` podrží odpověď modelu.
 */
function director(answer: unknown, options: { forward?: boolean; gate?: Promise<void> } = {}) {
  const branches: ReturnType<typeof fakeBranch>[] = [];
  const make: typeof getDirector = (_startedAt, caller, check, nudge, _queueId, _wait, onDraft) => async (said) => {
    const branch = fakeBranch(answer === undefined ? [] : [answered(answer)]);
    branches.push(branch);
    const gated = options.gate === undefined ? branch : { ...branch, generate: async (call: Parameters<typeof branch.generate>[0]) => { await options.gate; return branch.generate(call); } };
    const drafted = options.forward !== false && onDraft !== undefined ? { onDraft } : {};
    return { ...(await direct(said, { branch: gated, now: Date.now, check, compact: true, maxRepairRounds: 0, caller, ...drafted, ...(nudge === undefined ? {} : { nudge }) })), callerLimited: false };
  };
  return { make, modelCalls: () => branches.reduce((sum, branch) => sum + branch.calls.length, 0) };
}

const request = (sentence: string) => ({ sentence, seed: null, ackMs: null, draftReadyMs: null, startedAt: Date.now(), caller: 'upgrade-reading-test' });

async function childrenOf(store: VersionStore, draftId: string) {
  return (await Promise.all((await store.childrenOf(draftId)).map((id) => store.get(id)))).filter((child) => child !== null);
}

beforeEach(async () => {
  await loadRapier();
  reads = 0;
  resetProcessAnswerStore();
  __resetUpgrades();
  seam.director = null;
  vi.stubEnv('PLAY_READER', 'on');
  vi.stubEnv('PLAY_READER_PATH', 'ai');
  vi.stubEnv('PLAY_READER_ENDPOINT', 'http://reader.test');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the reading game (P58D T1)', () => {
  it('publishes the reading draft as a reading child of the quick game when its genre differs', async () => {
    reader(OTHER.reading);
    const store = memoryVersionStore();
    const quick = await quickGame(store, OTHER.text);
    const announced: string[] = [];
    const outcome = await directUpgrade(store, quick, request(OTHER.text), director(OTHER.answer).make, (id) => announced.push(id));

    const reading = (await childrenOf(store, quick.version.versionId)).filter((child) => child.relation === 'reading');
    expect(reading).toHaveLength(1);
    expect(reading[0]!.version.parentId).toBe(quick.version.versionId);
    expect(reading[0]!.spec).toEqual(draftGameSpecWithMeta(OTHER.text, 1, { reading: OTHER.reading }).spec);
    expect(`${reading[0]!.spec.genre?.id}.${reading[0]!.spec.genre?.mode}`).toBe('quest.spatial');
    expect(`${quick.spec.genre?.id}.${quick.spec.genre?.mode}`).toBe('arena.escape');
    // Hra ze čtení je návrh věty: panel „From your sentence“ ji nevydává za AI ani za remix, upgrade z ní nestartuje.
    expect(reading[0]!.origin).toEqual({ sentence: OTHER.text, seed: null, readBy: 'model' });
    expect(announced).toEqual([reading[0]!.version.versionId]);
    // AI verze zůstává dítětem rychlé hry, ne hry ze čtení.
    expect(outcome.status).toBe('ready');
    const ai = await store.get(outcome.status === 'ready' ? outcome.versionId : '');
    expect(ai).toMatchObject({ relation: 'upgrade', version: { parentId: quick.version.versionId } });
  }, 180_000);

  it('publishes nothing when the reading plays the quick game genre', async () => {
    reader(SAME.reading);
    const store = memoryVersionStore();
    const quick = await quickGame(store, SAME.text);
    expect(draftGameSpecWithMeta(SAME.text, 1, { reading: SAME.reading }).spec.genre).toEqual(quick.spec.genre);
    const announced: string[] = [];
    await directUpgrade(store, quick, request(SAME.text), director(undefined).make, (id) => announced.push(id));
    expect(reads).toBe(1);
    expect((await childrenOf(store, quick.version.versionId)).filter((child) => child.relation === 'reading')).toEqual([]);
    expect(announced).toEqual([]);
  }, 120_000);

  // T2a (review fáze 1): id verze je ze specu, semínka a rodiče, ne ze vztahu – AI verze rovná návrhu ze čtení by
  // jinak dostala uložené dítě `'reading'` jako `ready`, mimo feed a bez štítku AI verze.
  // Kolize se vynutí: hra ze čtení uložená přesně se specem a semínkem, které AI cesta publikuje (z běhu bez čtení).
  it('an AI version that lands on the stored reading game ends UNCHANGED, not as the reading child', async () => {
    reader(null);
    const first = memoryVersionStore();
    const firstQuick = await quickGame(first, OTHER.text);
    const ai = await directUpgrade(first, firstQuick, request(OTHER.text), director(OTHER.answer).make);
    const aiGame = await first.get(ai.status === 'ready' ? ai.versionId : '');
    if (aiGame === null) throw new Error(`the AI version did not publish: ${JSON.stringify(ai)}`);

    const store = memoryVersionStore();
    const quick = await quickGame(store, OTHER.text);
    const reading = await publishReadSpec(store, aiGame.spec, [aiGame.version.seed], quick.version.versionId, { relation: 'reading', origin: { sentence: OTHER.text, seed: null, readBy: 'model' } });
    expect(reading.ok && reading.value.game.version.versionId).toBe(aiGame.version.versionId);
    resetProcessAnswerStore();
    __resetUpgrades();
    const outcome = await directUpgrade(store, quick, request(OTHER.text), director(OTHER.answer).make);
    expect(outcome).toMatchObject({ status: 'draft-final', reason: 'UNCHANGED' });
    expect((await childrenOf(store, quick.version.versionId)).map((child) => child.relation)).toEqual(['reading']);
  }, 180_000);

  it('publishes nothing without a reading, and the AI version runs as before', async () => {
    reader(null);
    const store = memoryVersionStore();
    const quick = await quickGame(store, OTHER.text);
    const announced: string[] = [];
    const outcome = await directUpgrade(store, quick, request(OTHER.text), director(OTHER.answer).make, (id) => announced.push(id));
    expect(reads).toBeGreaterThan(0);
    expect(announced).toEqual([]);
    expect((await childrenOf(store, quick.version.versionId)).map((child) => child.relation)).toEqual(['upgrade']);
    expect(outcome.status).toBe('ready');
  }, 180_000);

  it('a failed reading publication is a log line: the AI version is still ready', async () => {
    reader(OTHER.reading);
    const store = memoryVersionStore();
    const quick = await quickGame(store, OTHER.text);
    const failing: VersionStore = { ...store, put: (game) => (game.relation === 'reading' ? Promise.reject(new Error('disk on fire')) : store.put(game)) };
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const announced: string[] = [];
    const outcome = await directUpgrade(failing, quick, request(OTHER.text), director(OTHER.answer).make, (id) => announced.push(id));
    expect(outcome.status).toBe('ready');
    expect(announced).toEqual([]);
    expect(warned.mock.calls.map((call) => String(call[0]))).toContainEqual(expect.stringContaining(`reading version of ${quick.version.versionId} failed: disk on fire`));
    expect((await childrenOf(store, quick.version.versionId)).map((child) => child.relation)).toEqual(['upgrade']);
  }, 180_000);

  it('costs no extra call: as many reads and model calls as when the reading draft was dropped', async () => {
    const run = async (forward: boolean) => {
      reads = 0;
      resetProcessAnswerStore();
      reader(OTHER.reading);
      const store = memoryVersionStore();
      const quick = await quickGame(store, OTHER.text);
      const seam = director(OTHER.answer, { forward });
      await directUpgrade(store, quick, request(OTHER.text), seam.make);
      return { reads, model: seam.modelCalls(), reading: (await childrenOf(store, quick.version.versionId)).filter((child) => child.relation === 'reading').length };
    };
    const before = await run(false);
    const after = await run(true);
    expect(before.reading).toBe(0);
    expect(after.reading).toBe(1);
    expect(after.reads).toBe(before.reads);
    expect(after.model).toBe(before.model);
    expect(after.reads).toBe(1);
  }, 240_000);

  it('the upgrade job knows the reading game while the AI version is still being written', async () => {
    reader(OTHER.reading);
    const store = memoryVersionStore();
    const quick = await quickGame(store, OTHER.text);
    let release = (): void => undefined;
    seam.director = director(OTHER.answer, { gate: new Promise<void>((resolve) => { release = resolve; }) }).make;
    const done = upgradeOf(store, quick, request(OTHER.text));
    await vi.waitFor(() => expect(readingOf(quick.version.versionId)).not.toBeNull(), { timeout: 30_000 });
    const reading = await store.get(readingOf(quick.version.versionId)!);
    expect(reading).toMatchObject({ relation: 'reading', version: { parentId: quick.version.versionId } });
    release();
    expect((await done).status).toBe('ready');
  }, 180_000);
});

describe('the reading game page (P58D T2)', () => {
  /** `upgrade` z props shellu `/play/[id]`: kde se stránka ptá na AI verzi. */
  async function upgradeUrlOn(id: string): Promise<unknown> {
    const element = (await PlayGamePage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) })) as { props: { children: { props: Record<string, unknown> }[] } };
    return element.props.children.find((child) => 'upgrade' in child.props)!.props.upgrade;
  }

  it('asks the quick game it came from for the AI version', async () => {
    reader(OTHER.reading);
    __resetProcessVersionStore();
    resetRateWindows();
    const store = versionStoreFromEnv(process.env);
    const quick = await quickGame(store, OTHER.text);
    let reading = '';
    const outcome = await directUpgrade(store, quick, request(OTHER.text), director(OTHER.answer).make, (id) => { reading = id; });
    const parentUpgrade = `/api/play/games/${quick.version.versionId}/upgrade`;
    expect(await upgradeUrlOn(reading)).toBe(parentUpgrade);
    expect(await upgradeUrlOn(quick.version.versionId)).toBe(parentUpgrade);
    expect(await upgradeUrlOn(outcome.status === 'ready' ? outcome.versionId : '')).toBeNull();
  }, 180_000);
});
