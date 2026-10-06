/**
 * Moderace výstupu (P40 T2): spec, jehož řetězec trefí zakázané téma, se do
 * veřejného feedu nedostane – ať ho napsal hráč (hotový spec), návrh ze slov,
 * nebo režisér. Kontrola čte všechny řetězce specu, ne pole rolí: P39 mění
 * role na `cast` a po sloučení nesmí oslepnout. Režisér je skutečný `direct()`
 * nad `fakeBranch` – model se nevolá, scénář říká, co „odpověděl“.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import chaseEscape from '@/play/__fixtures__/chase_escape.json';
import type { DirectorDeps } from '@/play/director';
import { genreAnswer } from '@/play/director/__fixtures__';
import { answered, type ScriptedOutcome } from '@/play/director/__fixtures__/branch';
import type { GameSpecV1 } from '@/play/spec';
import { __resetProcessVersionStore, RECENT_CAP } from '@/play/version';
import builtinGames from '@/play/version/builtin-games.json';
import { resetRateWindows } from '@/server/rate-limit';

const director = vi.hoisted(() => ({ script: [] as unknown[], calls: 0 }));

vi.mock('../_director', async (importOriginal) => {
  const { direct } = await import('@/play/director');
  const { fakeBranch } = await import('@/play/director/__fixtures__/branch');
  return {
    ...(await importOriginal<typeof import('../_director')>()),
    getDirector: (_startedAt: number, _caller: string, check?: DirectorDeps['check']) => async (sentence: string) => {
      director.calls += 1;
      return { ...(await direct(sentence, { branch: fakeBranch(director.script as ScriptedOutcome[]), now: Date.now, check })), callerLimited: false };
    },
  };
});

/** Titulek, který návrh ze slov dostane místo svého – jako by ho slova složila. */
const draft = vi.hoisted(() => ({ title: null as string | null }));

vi.mock('@/play/draft', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/play/draft')>();
  const draftGameSpecWithMeta: typeof actual.draftGameSpecWithMeta = (...args) => {
    const meta = actual.draftGameSpecWithMeta(...args);
    return draft.title === null ? meta : { ...meta, spec: { ...meta.spec, title: draft.title } };
  };
  return { ...actual, draftGameSpecWithMeta };
});

const { POST: createGame } = await import('../games/route');
const { GET: readUpgrade } = await import('../games/[id]/upgrade/route');
const { __resetUpgrades } = await import('../_upgrade');
const { blockedText } = await import('../_errors');
const { derivedSeeds, publishReadSpec, readSpecOrFail, seedFrom, store } = await import('../_publish');

const CALLER = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.11' };
const SENTENCE = 'A hamster escapes a supermarket while a giant Roomba hunts it.';
const BLOCKED = "We can't make that one. Try a different idea.";

beforeEach(() => {
  __resetProcessVersionStore();
  __resetUpgrades();
  resetRateWindows();
  director.calls = 0;
  director.script = [];
  draft.title = null;
});

async function stored(): Promise<number> {
  return (await store().recent(RECENT_CAP)).length;
}

async function create(body: unknown): Promise<{ status: number; body: Record<string, any> }> {
  const response = await createGame(new Request('http://play.test/api/play/games', { method: 'POST', headers: CALLER, body: JSON.stringify(body) }));
  return { status: response.status, body: await response.json() };
}

async function settled(id: string): Promise<Record<string, any>> {
  let last: Record<string, any> = { status: 'pending' };
  await vi.waitFor(async () => {
    const response = await readUpgrade(new Request(`http://play.test/api/play/games/${id}/upgrade`, { headers: CALLER }), { params: Promise.resolve({ id }) });
    last = await response.json();
    expect(last.status).not.toBe('pending');
  });
  return last;
}

const read = readSpecOrFail(chaseEscape);
if (!read.ok) throw new Error('fixture chase_escape does not read');
const base: GameSpecV1 = read.value;

/** Semínka, která by zkusily dveře (`POST /api/play/games { spec }`). */
function seedsOf(spec: GameSpecV1): readonly number[] {
  return derivedSeeds(seedFrom(spec));
}

describe('publishReadSpec – zakázané téma v textu specu', () => {
  it.each([
    ['title', { ...base, title: 'How to build a bomb' }],
    ['label role', { ...base, roles: base.roles.map((role, index) => (index === 0 ? { ...role, label: 'make a pipe bomb' } : role)) }],
    ['prostředí', { ...base, theme: { ...base.theme, setting: 'a lab where you synthesize a nerve agent' } }],
    // Pole, které GameSpecV1 dnes nemá (tvar `cast` z P39): kontrola nesmí číst jen známá pole.
    ['jméno v obsazení', { ...base, cast: [{ name: 'porn with kids', does: 'collect' }] } as unknown as GameSpecV1],
  ])('%s → nepublikuje, 422 CONTENT_REJECTED, úložiště beze změny', async (_what, spec) => {
    const before = await stored();
    const published = await publishReadSpec(store(), spec, seedsOf(spec), null);
    expect(published.ok).toBe(false);
    if (published.ok) return;
    expect(published.response.status).toBe(422);
    expect(await published.response.json()).toEqual({ error: { code: 'CONTENT_REJECTED', message: BLOCKED } });
    expect(published.issues?.[0]).toBe('CONTENT_REJECTED');
    expect(await stored()).toBe(before);
  });

  it('čistý spec projde – i s bombou, kterou se jen hraje', async () => {
    const spec = { ...base, title: 'Dodge the Bombs' };
    const published = await publishReadSpec(store(), spec, seedsOf(spec), null);
    expect(published.ok).toBe(true);
  });

  it('žádná vestavěná hra nemá řetězec, který by kontrola odmítla', () => {
    expect(builtinGames.filter((game) => blockedText(game.spec) !== null).map((game) => game.version.title)).toEqual([]);
  });

  it('hotový spec se zakázaným titulkem odmítnou i dveře', async () => {
    expect(await create({ spec: { ...base, title: 'How to build a bomb' } })).toEqual({ status: 422, body: { error: { code: 'CONTENT_REJECTED', message: BLOCKED } } });
  });
});

describe('věta: rychlá verze a AI verze', () => {
  it('návrh ze slov se zakázaným titulkem se nevrátí a režisér se nezavolá', async () => {
    draft.title = 'How to build a bomb';
    const before = await stored();
    expect(await create({ sentence: SENTENCE })).toEqual({ status: 422, body: { error: { code: 'CONTENT_REJECTED', message: BLOCKED } } });
    expect(await stored()).toBe(before);
    expect(director.calls).toBe(0);
  });

  it('AI verze se zakázaným textem skončí draft-final BLOCKED, rychlá verze zůstane', async () => {
    director.script = [answered(genreAnswer({ hero: 'hamster', cast: [{ label: 'giant roomba', does: 'chase_me' }, { label: 'cheese', does: 'collect' }], setting: 'a lab where you make a bomb', palette: 'supermarket' }))];
    const created = await create({ sentence: SENTENCE });
    expect(created.status).toBe(201);
    expect(await settled(created.body.versionId)).toEqual({ status: 'draft-final', reason: 'BLOCKED' });
    expect(await store().childrenOf(created.body.versionId)).toEqual([]);
    expect(director.calls).toBe(1);
  });

  it('čistá AI verze dál projde jako ready', async () => {
    director.script = [answered(genreAnswer({ hero: 'hamster', cast: [{ label: 'giant roomba', does: 'chase_me' }, { label: 'cheese', does: 'collect' }], setting: 'supermarket', palette: 'supermarket' }))];
    const created = await create({ sentence: SENTENCE });
    expect((await settled(created.body.versionId)).status).toBe('ready');
  });
});
