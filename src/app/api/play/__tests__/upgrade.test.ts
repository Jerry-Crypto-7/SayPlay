/**
 * Progresivní hra (P23-D T2): `POST /api/play/games` s větou publikuje návrh
 * hned a režisér doběhne na pozadí. Režisér je skutečný `direct()` nad
 * `fakeBranch` z B – model se nevolá, scénář říká, co „odpověděl“. Závora
 * `gate` drží režiséra, dokud ji test nepustí, aby šel vidět stav `pending`.
 */

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import collectExit from '@/play/__fixtures__/collect_exit.json';
import { answerFixture, runnerAnswer } from '@/play/director/__fixtures__';
import type { DirectorDeps } from '@/play/director';
import { answered, failed, fakeBranch, type FakeBranch, type ScriptedOutcome } from '@/play/director/__fixtures__/branch';
import { draftGameSpec } from '@/play/draft';
import { __resetProcessVersionStore, versionStoreFromEnv } from '@/play/version';
import { resetRateWindows } from '@/server/rate-limit';

import { recordUpgradeFailure, upgradeAttemptLine } from '../_upgrade';

const director = vi.hoisted(() => ({
  script: [] as unknown[],
  calls: 0,
  gate: Promise.resolve() as Promise<void>,
  /** Režie odmítnutá vyčerpaným počtem volajícího (R8). */
  callerLimited: false,
  /** Větev poslední režie – test čte, co model dostal. */
  branch: null as FakeBranch | null,
}));

vi.mock('../_director', async (importOriginal) => {
  const { direct } = await import('@/play/director');
  const { fakeBranch: branchOf } = await import('@/play/director/__fixtures__/branch');
  return {
    // `DIRECTOR_BUDGET_MS` a spol. zůstávají skutečné: z rozpočtu se počítá `deadlineAt`.
    ...(await importOriginal<typeof import('../_director')>()),
    getDirector: (_startedAt: number, _caller: string, check?: DirectorDeps['check']) => async (sentence: string) => {
      director.calls += 1;
      await director.gate;
      if (director.callerLimited) return { ...(await direct(sentence, { branch: branchOf([]), now: Date.now, check })), callerLimited: true };
      director.branch = branchOf(director.script as ScriptedOutcome[]);
      return { ...(await direct(sentence, { branch: director.branch, now: Date.now, check })), callerLimited: false };
    },
  };
});

const { POST: createGame } = await import('../games/route');
const { GET: readGame } = await import('../games/[id]/route');
const { GET: readUpgrade } = await import('../games/[id]/upgrade/route');
const { __resetUpgrades } = await import('../_upgrade');

const { DIRECTOR_BUDGET_MS } = await import('../_director');
const { UPGRADE_DEADLINE_SLACK_MS } = await import('../_upgrade');
const PENDING = { status: 'pending', deadlineAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) };

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
    expect(await upgrade(created.body.versionId)).toEqual(PENDING);
  });

  it('pending nese deadlineAt: start práce + rozpočet režie + 15 s rezerva (P27C T1)', async () => {
    holdDirector();
    const before = Date.now();
    const created = await publish({ sentence: SENTENCE });
    const after = Date.now();
    const pending = await upgrade(created.body.versionId);
    const deadline = Date.parse(pending.deadlineAt);
    expect(deadline).toBeGreaterThanOrEqual(before + DIRECTOR_BUDGET_MS + UPGRADE_DEADLINE_SLACK_MS);
    expect(deadline).toBeLessThanOrEqual(after + DIRECTOR_BUDGET_MS + UPGRADE_DEADLINE_SLACK_MS);
    // Druhý dotaz lhůtu neposune: patří práci, ne dotazu.
    expect((await upgrade(created.body.versionId)).deadlineAt).toBe(pending.deadlineAt);
  });

  it('pending → ready: autorská verze je dítě návrhu s rodokmenem a vodopádem', async () => {
    holdDirector();
    const created = await publish({ sentence: SENTENCE });
    const draftId: string = created.body.versionId;
    expect(await upgrade(draftId)).toEqual(PENDING);
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

  // P26 T3: bez záznamu se nedá říct, proč model za 40 s nic nedodal.
  it('rozbitá odpověď modelu zapíše záznam s důvodem a surovou odpovědí', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'play-failures-'));
    vi.stubEnv('PLAY_FAILURES_DIR', dir);
    vi.stubEnv('VERCEL', undefined);
    director.script = [{ ok: false, reason: 'MALFORMED_RESPONSE', detail: 'the codex answer is not JSON: Unexpected token', usage: null, raw: 'Here is your game: {' }];
    const created = await publish({ sentence: SENTENCE });
    expect(await settled(created.body.versionId)).toEqual({ status: 'draft-final', reason: 'MALFORMED' });
    const record = JSON.parse(readFileSync(join(dir, `${created.body.versionId}.json`), 'utf8'));
    expect(record).toMatchObject({ outcome: 'MALFORMED', stage: 'model', reason: 'MALFORMED_RESPONSE', detail: 'the codex answer is not JSON: Unexpected token', raw: 'Here is your game: {', sentence: SENTENCE });
    // Odpověď, která je JSON, ale ne GameSpec: důvod čtení a celé tělo.
    director.script = [answered({ entities: [], rules: [] })];
    const second = await publish({ sentence: 'a robot collects batteries on Mars' });
    expect(await settled(second.body.versionId)).toEqual({ status: 'draft-final', reason: 'MALFORMED' });
    expect(JSON.parse(readFileSync(join(dir, `${second.body.versionId}.json`), 'utf8'))).toMatchObject({ stage: 'read', raw: { entities: [], rules: [] } });
    vi.unstubAllEnvs();
  });

  // Testy bez vlastní složky psaly podvržená selhání do `data/play/failures/` sady věrnosti.
  it('pod vitestem bez PLAY_FAILURES_DIR se záznam nezapíše', () => {
    const id = `vitest-${String(process.pid)}`;
    recordUpgradeFailure(id, SENTENCE, 'MALFORMED', { stage: 'model', reason: 'X', detail: 'x', raw: null }, { VITEST: 'true' });
    expect(existsSync(join(process.cwd(), 'data', 'play', 'failures', `${id}.json`))).toBe(false);
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

  // P26 T10a: neprošlý keypoint jde modelu k opravě, nerozhoduje tichá výměna.
  function brokenSwitch(): unknown {
    const broken = structuredClone(answerFixture('good-switch_puzzle')) as { mechanics: { id: string; params: Record<string, unknown> }[] };
    broken.mechanics[0].params.required = ['red', 'blue', 'green'];
    return broken;
  }

  it('neprošlý keypoint dostane opravné kolo a opravená hra se publikuje', async () => {
    director.script = [answered(brokenSwitch()), answered([{ op: 'replace', path: '/mechanics/0/params/required', value: ['lever_b', 'lever_d'] }])];
    const created = await publish({ sentence: SENTENCE });
    expect((await settled(created.body.versionId)).status).toBe('ready');
    const repair = director.branch?.calls[1]?.request.user ?? '';
    expect(repair).toContain('KEYPOINT_FAILED');
    expect(repair).toContain('right_pair_opens');
  });

  it('neopravený keypoint zůstane NOT_PLAYABLE i po opravných kolech', async () => {
    director.script = [answered(brokenSwitch()), answered([]), answered([])];
    const created = await publish({ sentence: SENTENCE });
    expect(await settled(created.body.versionId)).toEqual({ status: 'draft-final', reason: 'NOT_PLAYABLE' });
    expect(director.branch?.calls).toHaveLength(3);
    expect(await versionStoreFromEnv(process.env).childrenOf(created.body.versionId)).toEqual([]);
  });

  // P26 T4: AI smí opravit žánr, který návrh ze slov odhadl špatně – ověřuje robot, ne shoda s návrhem.
  // P32B T2: návrh nové hry je žánr – „zombie shooter in a mall“ z něj vyjde jako úkol (`move_free`), ne střelnice.
  it('vylepšení z úkolu na plošinovku se přijme, když je vyhratelné', async () => {
    director.script = [answered({ ...(runnerAnswer() as object), control: 'platform', controlParams: { difficulty: 'easy' } })];
    const created = await publish({ sentence: 'zombie shooter in a mall' });
    expect((await game(created.body.versionId)).spec.genre.id).toBe('quest');
    expect((await game(created.body.versionId)).spec.control).toBe('move_free');
    expect((await settled(created.body.versionId)).status).toBe('ready');
    const [childId] = await versionStoreFromEnv(process.env).childrenOf(created.body.versionId);
    expect((await game(childId as string)).spec.control).toBe('platform');
  });

  // P32B T2: skákací věta je od žánrů plošinovka, ne běžec.
  it('mřížková odpověď na plošinovku se přijme a dítě je mřížka', async () => {
    const created = await publish({ sentence: 'jumping arcade game with a lot of obstacles' });
    expect((await game(created.body.versionId)).spec.control).toBe('platform');
    expect((await settled(created.body.versionId)).status).toBe('ready');
    const [childId] = await versionStoreFromEnv(process.env).childrenOf(created.body.versionId);
    expect((await game(childId as string)).spec.control).toBeUndefined();
  });

  it('běžec vylepšený běžcem je ready a dítě zůstane běžcem', async () => {
    director.script = [answered(runnerAnswer())];
    const created = await publish({ sentence: 'endless runner in a neon city' });
    expect((await game(created.body.versionId)).spec.control).toBe('runner');
    expect((await settled(created.body.versionId)).status).toBe('ready');
    const children = await versionStoreFromEnv(process.env).childrenOf(created.body.versionId);
    expect(children).toHaveLength(1);
    const child = await game(children[0] as string);
    expect(child.spec.control).toBe('runner');
    expect(child.spec.title).toBe('Neon Rooftop Sprint');
  });

  // P32B T2: mřížkový návrh nová věta už nedostane; křeček je útěk v aréně.
  it('arénový návrh vylepšený běžcem je ready a dítě je běžec', async () => {
    director.script = [answered(runnerAnswer())];
    const created = await publish({ sentence: SENTENCE });
    expect((await game(created.body.versionId)).spec.genre).toMatchObject({ id: 'arena', mode: 'escape' });
    expect((await game(created.body.versionId)).spec.control).toBe('move_free');
    expect((await settled(created.body.versionId)).status).toBe('ready');
    const [childId] = await versionStoreFromEnv(process.env).childrenOf(created.body.versionId);
    expect((await game(childId as string)).spec.control).toBe('runner');
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

  // Srovnání modelů (`scripts/play-fidelity.mjs`) podle těch řádků čeká na doběhnutí
  // pokusu a čte jeho příčinu; konec nesmí příčinu předběhnout, proto týž proud.
  it('každý pokus zapíše začátek, příčinu a konec v tomto pořadí do console.warn (P30A T7b)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      director.script = [failed('UPSTREAM_REJECTED', 'no free play slot')];
      const created = await publish({ sentence: SENTENCE });
      const id = created.body.versionId as string;
      expect((await settled(id)).reason).toBe('MODEL_UNAVAILABLE');
      director.script = [answered(answerFixture('good-collect_exit'))];
      expect((await settled(id)).status).toBe('ready');
      const ended = `[play] upgrade of ${id} ended MODEL_UNAVAILABLE at model: UPSTREAM_REJECTED – no free play slot`;
      const kinds = warn.mock.calls
        .map(([line]) => String(line))
        .map((line) => (line === upgradeAttemptLine(id, 'started') ? 'S' : line === ended ? 'X' : line === upgradeAttemptLine(id, 'settled') ? 'E' : null))
        .filter((kind) => kind !== null);
      // Počet neúspěšných pokusů závisí na tom, kdy se test zeptá; pořadí v každém ne.
      expect(kinds.join('')).toMatch(/^(SXE)+SE$/);
    } finally {
      warn.mockRestore();
    }
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
    expect(outcomes).toContainEqual(PENDING);
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
