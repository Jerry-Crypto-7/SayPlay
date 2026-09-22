/**
 * Progresivní hra (P23-D T2): `POST /api/play/games` s větou publikuje návrh
 * hned a režisér doběhne na pozadí. Režisér je skutečný `direct()` nad
 * `fakeBranch` z B – model se nevolá, scénář říká, co „odpověděl“. Závora
 * `gate` drží režiséra, dokud ji test nepustí, aby šel vidět stav `pending`.
 */

import { readFileSync } from 'node:fs';

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
  /** Režie odmítnutá vyčerpaným počtem volajícího (R8). */
  callerLimited: false,
}));

vi.mock('../_director', async () => {
  const { direct } = await import('@/play/director');
  const { fakeBranch: branchOf } = await import('@/play/director/__fixtures__/branch');
  return {
    getDirector: () => async (sentence: string) => {
      director.calls += 1;
      await director.gate;
      if (director.callerLimited) return { ...(await direct(sentence, { branch: branchOf([]), now: Date.now })), callerLimited: true };
      return { ...(await direct(sentence, { branch: branchOf(director.script as ScriptedOutcome[]), now: Date.now })), callerLimited: false };
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
  director.callerLimited = false;
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

  it('autorské dítě se do denního stropu publikací nepočítá (R11)', async () => {
    vi.stubEnv('PLAY_PUBLISH_DAILY_CAP', '1');
    __resetProcessVersionStore();
    try {
      const created = await publish({ sentence: SENTENCE });
      expect(created.status).toBe(201);
      expect((await settled(created.body.versionId)).status).toBe('ready');
      // Kvóta patří dál návrhům: druhá nová věta narazí.
      expect((await publish({ sentence: 'A cat delivers a fragile cake across a busy kitchen.' })).status).toBe(429);
    } finally {
      vi.unstubAllEnvs();
      __resetProcessVersionStore();
    }
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

  // R1 (P25A): model odpověděl mřížkovou hrou na větu, ze které návrh udělal běžce.
  it('vylepšení, které ztratí ovládání běžce, zůstane návrhem bez dítěte', async () => {
    const created = await publish({ sentence: 'jumping arcade game with a lot of obstacles' });
    expect((await game(created.body.versionId)).spec.control).toBe('runner');
    expect(await settled(created.body.versionId)).toEqual({ status: 'draft-final', reason: 'MALFORMED' });
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

  it('proces bez záznamu vrátí uložený verdikt o větě a režiséra nezaplatí znovu (R10)', async () => {
    director.script = [answered('this is not a game')];
    const created = await publish({ sentence: SENTENCE });
    expect(await settled(created.body.versionId)).toEqual({ status: 'draft-final', reason: 'MALFORMED' });
    __resetUpgrades();
    director.script = [answered(answerFixture('good-collect_exit'))];
    expect(await upgrade(created.body.versionId)).toEqual({ status: 'draft-final', reason: 'MALFORMED' });
    expect(director.calls).toBe(1);
  });

  it('uložený přechodný důvod (starší build) se nečte – nový pokus (revize R10 kolo 2)', async () => {
    director.script = [failed('UPSTREAM_UNAVAILABLE')];
    const created = await publish({ sentence: SENTENCE });
    expect(await settled(created.body.versionId)).toEqual({ status: 'draft-final', reason: 'MODEL_UNAVAILABLE' });
    await versionStoreFromEnv(process.env).rememberUpgradeVerdict(created.body.versionId, 'MODEL_UNAVAILABLE', 3600);
    __resetUpgrades();
    director.script = [answered(answerFixture('good-collect_exit'))];
    expect((await settled(created.body.versionId)).status).toBe('ready');
  });

  it('přechodný výpadek modelu se nepamatuje – další dotaz dostane nový pokus (revize R10)', async () => {
    director.script = [failed('UPSTREAM_UNAVAILABLE')];
    const created = await publish({ sentence: SENTENCE });
    expect(await settled(created.body.versionId)).toEqual({ status: 'draft-final', reason: 'MODEL_UNAVAILABLE' });
    director.script = [answered(answerFixture('good-collect_exit'))];
    const outcome = await settled(created.body.versionId);
    expect(outcome.status).toBe('ready');
  });

  it('vyčerpaný počet diváka se nepamatuje – další dotaz dostane vlastní pokus (revize R8)', async () => {
    director.callerLimited = true;
    const created = await publish({ sentence: SENTENCE });
    expect(await settled(created.body.versionId)).toEqual({ status: 'draft-final', reason: 'MODEL_UNAVAILABLE' });
    director.callerLimited = false;
    const outcome = await settled(created.body.versionId);
    expect(outcome.status).toBe('ready');
    expect((await game(outcome.versionId)).version.parentId).toBe(created.body.versionId);
  });

  it('souběžné dotazy bez záznamu spustí režiséra jednou', async () => {
    director.callerLimited = true;
    const created = await publish({ sentence: SENTENCE });
    await settled(created.body.versionId);
    director.callerLimited = false;
    __resetUpgrades();
    director.script = [answered(answerFixture('good-collect_exit'))];
    director.calls = 0;
    const [a, b] = await Promise.all([upgrade(created.body.versionId), upgrade(created.body.versionId)]);
    expect(a).toEqual(b);
    expect(director.calls).toBe(1);
  });

  it('připojený divák přechodného pokusu dostane pending a jeho další dotaz vlastní pokus (R13)', async () => {
    director.callerLimited = true;
    const created = await publish({ sentence: SENTENCE });
    await settled(created.body.versionId);
    __resetUpgrades();
    const outcomes = await Promise.all([upgrade(created.body.versionId), upgrade(created.body.versionId)]);
    expect(outcomes).toContainEqual({ status: 'draft-final', reason: 'MODEL_UNAVAILABLE' });
    expect(outcomes).toContainEqual({ status: 'pending' });
    director.callerLimited = false;
    director.script = [answered(answerFixture('good-collect_exit'))];
    expect((await settled(created.body.versionId)).status).toBe('ready');
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

  // Zmrazení instance po odpovědi je vlastnost platformy a zevnitř procesu se
  // změřit nedá (vzor `sessions.test.ts`): soudí se zdroj bez komentářů.
  it('práce na pozadí se předává platformě přes `after()`, ne jen `void`', () => {
    const source = readFileSync('src/app/api/play/_upgrade.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(source).toContain("import { after } from 'next/server'");
    expect(source).toMatch(/const remembered = attempt\.then\([\s\S]*?after\(remembered\)/);
  });

  it('neznámé a špatné id je 404', async () => {
    const bad = await readUpgrade(new Request('http://play.test/x', { headers: CALLER }), params('../etc'));
    expect(bad.status).toBe(404);
    const unknown = await readUpgrade(new Request('http://play.test/x', { headers: CALLER }), params('a'.repeat(32)));
    expect(unknown.status).toBe(404);
  });
});
