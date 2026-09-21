/**
 * Progresivní hra (P23-D T2): `POST /api/play/games` s větou publikuje návrh
 * hned a režisér doběhne na pozadí. Režisér je skutečný `direct()` nad
 * `fakeBranch` z B – model se nevolá, scénář říká, co „odpověděl“. Závora
 * `gate` drží režiséra, dokud ji test nepustí, aby šel vidět stav `pending`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import collectExit from '@/play/__fixtures__/collect_exit.json';
import { answerFixture } from '@/play/director/__fixtures__';
import { answered, failed, fakeBranch, type ScriptedOutcome } from '@/play/director/__fixtures__/branch';
import { draftGameSpec } from '@/play/draft';
import { __resetProcessVersionStore, versionStoreFromEnv } from '@/play/version';
import { resetRateWindows } from '@/server/rate-limit';

const director = vi.hoisted(() => ({
  script: [] as unknown[],
  calls: 0,
  gate: Promise.resolve() as Promise<void>,
}));

vi.mock('../_director', async () => {
  const { direct } = await import('@/play/director');
  const { fakeBranch: branchOf } = await import('@/play/director/__fixtures__/branch');
  return {
    getDirector: () => async (sentence: string) => {
      director.calls += 1;
      await director.gate;
      return direct(sentence, { branch: branchOf(director.script as ScriptedOutcome[]), now: Date.now });
    },
  };
});

const { POST: createGame } = await import('../games/route');
const { GET: readGame } = await import('../games/[id]/route');
const { GET: readUpgrade } = await import('../games/[id]/upgrade/route');
const { __resetUpgrades } = await import('../_upgrade');

const SENTENCE = 'A hamster escapes a supermarket while a giant Roomba hunts it.';
const CALLER = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' };

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

async function publish(body: unknown): Promise<{ status: number; body: Record<string, any> }> {
  const response = await createGame(new Request('http://play.test/api/play/games', { method: 'POST', headers: CALLER, body: JSON.stringify(body) }));
  return { status: response.status, body: await response.json() };
}

async function upgrade(id: string): Promise<Record<string, any>> {
  const response = await readUpgrade(new Request(`http://play.test/api/play/games/${id}/upgrade`, { headers: CALLER }), params(id));
  expect(response.status).toBe(200);
  return response.json();
}

async function settled(id: string): Promise<Record<string, any>> {
  let last: Record<string, any> = { status: 'pending' };
  await vi.waitFor(async () => {
    last = await upgrade(id);
    expect(last.status).not.toBe('pending');
  });
  return last;
}

async function game(id: string): Promise<Record<string, any>> {
  return (await readGame(new Request(`http://play.test/api/play/games/${id}`), params(id))).json();
}

let release: () => void = () => {};

beforeEach(() => {
  __resetProcessVersionStore();
  __resetUpgrades();
  resetRateWindows();
  director.calls = 0;
  director.script = [answered(answerFixture('good-collect_exit'))];
  director.gate = Promise.resolve();
});

afterEach(() => {
  release();
});

function holdDirector(): void {
  director.gate = new Promise((resolve) => {
    release = resolve;
  });
}

describe('POST s větou: návrh hned, režisér na pozadí', () => {
  it('odpoví návrhem dřív, než režisér doběhne, a pod 3 s', async () => {
    holdDirector();
    const started = performance.now();
    const created = await publish({ sentence: SENTENCE });
    const elapsed = performance.now() - started;
    expect(created.status).toBe(201);
    expect(elapsed).toBeLessThan(3000);
    expect(created.body.upgrade).toBe(`/api/play/games/${created.body.versionId}/upgrade`);
    const draft = await game(created.body.versionId);
    expect(draft.spec).toEqual(draftGameSpec(SENTENCE));
    expect(draft.origin).toEqual({ sentence: SENTENCE, seed: null });
    expect(await upgrade(created.body.versionId)).toEqual({ status: 'pending' });
  });

  it('pending → ready: autorská verze je dítě návrhu s rodokmenem a vodopádem', async () => {
    holdDirector();
    const created = await publish({ sentence: SENTENCE });
    const draftId: string = created.body.versionId;
    expect(await upgrade(draftId)).toEqual({ status: 'pending' });
    release();
    const ready = await settled(draftId);
    expect(ready.status).toBe('ready');
    expect(ready.versionId).not.toBe(draftId);

    const child = await game(ready.versionId);
    expect(child.relation).toBe('upgrade');
    expect(child.version.parentId).toBe(draftId);
    expect(child.spec.archetype).toBe('collect_exit');
    expect(child.origin).toBeUndefined();
    expect(child.timings.source).toBe('authored');
    for (const field of ['ackMs', 'draftReadyMs', 'directorMs', 'compileMs', 'verifyMs']) expect(child.timings[field]).toBeTypeOf('number');
    expect(child.timings.ackMs).toBeLessThanOrEqual(child.timings.draftReadyMs);
    expect((await game(draftId)).children).toEqual([ready.versionId]);
  });

  it('model nedostupný: draft-final s důvodem a žádné dítě', async () => {
    director.script = [failed('UPSTREAM_UNAVAILABLE')];
    const created = await publish({ sentence: SENTENCE });
    expect(await settled(created.body.versionId)).toEqual({ status: 'draft-final', reason: 'MODEL_UNAVAILABLE' });
    expect(await versionStoreFromEnv(process.env).childrenOf(created.body.versionId)).toEqual([]);
  });

  it('autorská hra, která neprojde kontrolou, zůstane návrhem bez dítěte', async () => {
    // Táž mutace jako v `authored-fallback.test.ts`: tři barvy spínače, verifikátor ji chytí.
    const broken = structuredClone(answerFixture('good-switch_puzzle')) as { mechanics: { id: string; params: Record<string, unknown> }[] };
    const toggle = broken.mechanics.find((mechanic) => mechanic.id === 'switch');
    if (toggle === undefined) throw new Error('fixture');
    toggle.params.required = ['red', 'blue', 'green'];
    director.script = [answered(broken)];
    const created = await publish({ sentence: SENTENCE });
    expect(await settled(created.body.versionId)).toEqual({ status: 'draft-final', reason: 'NOT_PLAYABLE' });
    expect(await versionStoreFromEnv(process.env).childrenOf(created.body.versionId)).toEqual([]);
  });
});

describe('GET …/upgrade', () => {
  it('druhý dotaz po ready je idempotentní a režisér běží jednou', async () => {
    const created = await publish({ sentence: SENTENCE });
    const first = await settled(created.body.versionId);
    const second = await upgrade(created.body.versionId);
    expect(second).toEqual(first);
    // Tatáž věta podruhé: návrh už je (200), práce v paměti se nespouští znovu.
    const again = await publish({ sentence: SENTENCE });
    expect(again.status).toBe(200);
    expect(await upgrade(again.body.versionId)).toEqual(first);
    expect(director.calls).toBe(1);
  });

  it('proces bez záznamu (restart) najde hotové dítě v úložišti a model nevolá', async () => {
    const created = await publish({ sentence: SENTENCE });
    const first = await settled(created.body.versionId);
    __resetUpgrades();
    expect(await upgrade(created.body.versionId)).toEqual(first);
    expect(director.calls).toBe(1);
  });

  it('proces bez záznamu práci sám spustí z věty u návrhu a počká na ni', async () => {
    director.script = [failed('UPSTREAM_UNAVAILABLE')];
    const created = await publish({ sentence: SENTENCE });
    await settled(created.body.versionId);
    __resetUpgrades();
    director.script = [answered(answerFixture('good-collect_exit'))];
    const outcome = await upgrade(created.body.versionId);
    expect(outcome.status).toBe('ready');
    expect((await game(outcome.versionId)).version.parentId).toBe(created.body.versionId);
    expect(director.calls).toBe(2);
  });

  it('souběžné dotazy bez záznamu spustí režiséra jednou', async () => {
    director.script = [failed('UPSTREAM_UNAVAILABLE')];
    const created = await publish({ sentence: SENTENCE });
    await settled(created.body.versionId);
    __resetUpgrades();
    director.script = [answered(answerFixture('good-collect_exit'))];
    director.calls = 0;
    const [a, b] = await Promise.all([upgrade(created.body.versionId), upgrade(created.body.versionId)]);
    expect(a).toEqual(b);
    expect(director.calls).toBe(1);
  });

  it('hra z hotového specu nemá z čeho vylepšit', async () => {
    const created = await publish({ spec: collectExit });
    expect(created.body.upgrade).toBeUndefined();
    expect(await upgrade(created.body.versionId)).toEqual({ status: 'draft-final', reason: 'NOT_FROM_SENTENCE' });
    expect(director.calls).toBe(0);
  });

  it('táž autorská verze zapsaná dvakrát s jinými časy je exists, ne conflict', async () => {
    const created = await publish({ sentence: SENTENCE });
    const ready = await settled(created.body.versionId);
    const versions = versionStoreFromEnv(process.env);
    const child = await versions.get(ready.versionId);
    if (child?.timings === undefined) throw new Error('child without timings');
    expect(await versions.put({ ...child, timings: { ...child.timings, directorMs: child.timings.directorMs + 1 } })).toBe('exists');
  });

  it('neznámé a špatné id je 404', async () => {
    const bad = await readUpgrade(new Request('http://play.test/x', { headers: CALLER }), params('../etc'));
    expect(bad.status).toBe(404);
    const unknown = await readUpgrade(new Request('http://play.test/x', { headers: CALLER }), params('a'.repeat(32)));
    expect(unknown.status).toBe(404);
  });
});
