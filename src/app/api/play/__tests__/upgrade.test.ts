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
import { lookOf } from '@/play/arcade/look';
import { answerFixture, genreAnswer } from '@/play/director/__fixtures__';
import type { DirectorDeps } from '@/play/director';
import { answered, failed, fakeBranch, type FakeBranch, type ScriptedOutcome } from '@/play/director/__fixtures__/branch';
import { draftGameSpec, draftGameSpecWithMeta } from '@/play/draft';
import type { Reading } from '@/play/read/schema';
import type { GameSpecV1 } from '@/play/spec';
import { __resetProcessVersionStore, memoryVersionStore, type PublishedGame, versionStoreFromEnv } from '@/play/version';
import { resetProcessAnswerStore } from '@/server/answer-cache';
import { resetRateWindows } from '@/server/rate-limit';

import { knownUpgrade, recordUpgradeFailure, upgradeAttemptLine } from '../_upgrade';

// AI verze je jen pro jednu hru: věty těchto testů (útěk s pronásledovatelem) P56C posílá do řetězu mikroher,
// který AI verzi nemá (`chain-publish.test.ts`). Tady se zkouší vylepšení jedné hry, proto rozhodnutí vždy `single`.
vi.mock('@/play/chain/decide', async (original) => ({ ...(await original<typeof import('@/play/chain/decide')>()), chainOrSingle: () => 'single' }));

const director = vi.hoisted(() => ({
  script: [] as unknown[],
  calls: 0,
  gate: Promise.resolve() as Promise<void>,
  /** Drží až volání modelu (P58D T2): návrh ze čtení už je venku, AI verze ještě ne. */
  modelGate: Promise.resolve() as Promise<void>,
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
    // Druhý pokus s pokynem (P46E T4, `nudge`) patří k témuž běhu upgradu: `calls` počítá běhy, `branch` drží první.
    // Tady model na pokyn neodpoví (rychlý výpadek, platí první verze): pokyn zkouší `upgrade-adds.test.ts`, a druhé
    // ověření robotem by každý případ zdvojilo nad časový limit.
    // `onDraft` (P58D T1) jde do `direct()` jako u živé režie: bez čtečky je návrh ze slov a hra ze čtení nevznikne.
    getDirector: (_startedAt: number, _caller: string, check?: DirectorDeps['check'], nudge?: string, _queueId?: string, _wait?: boolean, onDraft?: DirectorDeps['onDraft']) => async (sentence: string) => {
      if (nudge !== undefined) return { ...(await direct(sentence, { branch: branchOf([]), now: Date.now, check, nudge })), callerLimited: false };
      director.calls += 1;
      await director.gate;
      const drafted = onDraft === undefined ? {} : { onDraft };
      if (director.callerLimited) return { ...(await direct(sentence, { branch: branchOf([]), now: Date.now, check, ...drafted })), callerLimited: true };
      const branch = branchOf(director.script as ScriptedOutcome[]);
      director.branch = branch;
      const held = { ...branch, generate: async (call: Parameters<typeof branch.generate>[0]) => { await director.modelGate; return branch.generate(call); } };
      return { ...(await direct(sentence, { branch: held, now: Date.now, check, ...drafted })), callerLimited: false };
    },
  };
});

// Inject one failed verifier keypoint on the author's golden-hamster candidate.
// The same report seam is read during repair and final publication; quick is untouched.
const genre = vi.hoisted(() => ({ unplayable: false }));
vi.mock('../_report', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_report')>();
  const reportFor: typeof actual.reportFor = compiled => {
    const report = actual.reportFor(compiled);
    if (!genre.unplayable || compiled.spec.title !== 'Golden Hamster Run') return report;
    return { ...report, publishEligible:false, keypoints:report.keypoints.map((point,index)=>index===0 ? {...point,passed:false,failures:['injected_claim requires reviewed title Repaired Hamster Run']} : point) };
  };
  return { ...actual, reportFor };
});

const { POST: createGame } = await import('../games/route');
const { GET: readGame } = await import('../games/[id]/route');
const { GET: readUpgrade } = await import('../games/[id]/upgrade/route');
const { __resetUpgrades, directUpgrade, readingDiffers } = await import('../_upgrade');
const { derivedSeeds, publishReadSpec, seedFrom } = await import('../_publish');

const { DIRECTOR_BUDGET_MS } = await import('../_director');
const { UPGRADE_DEADLINE_SLACK_MS } = await import('../_upgrade');
const PENDING = { status: 'pending', deadlineAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) };

const SENTENCE = 'A hamster escapes a supermarket while a giant Roomba hunts it.';
/** Běžec bez dílů (P46B b04). */
const PLAIN_RUNNER = 'A squirrel runs through the forest grabbing acorns';
/**
 * Publikace návrhu: hra bez dílů do 3 s. Hra s díly a průběhem (úseky a boss od P46B R2) ověřuje víc běhů robota
 * a smí 2× tolik – rozhodnutí majitele 13. 10. (P46B R4, varianta a). Změřeno R4 za stejné zátěže: věta s křečkem
 * 3,2–3,4 s, veverka 1,6–1,7 s.
 */
const PUBLISH_MS = 3000;
const PUBLISH_WITH_PARTS_MS = 2 * PUBLISH_MS;
const CALLER = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' };

/**
 * Odpověď věrná `SENTENCE` (P32B T5): hrdina a nepřítel z věty, útěk v Aréně,
 * který hlavní sloveso „escapes“ hraje. Nevěrnou odpověď by režisér přepnul
 * (`switchGenre`) a test by měřil přepnutí místo svého předmětu. Věc ke sběru
 * je výchozí věc supermarketu (P39: obsazení se soudí proti větě a prostředí).
 */
function faithful(spec: Parameters<typeof genreAnswer>[0] = {}): ReturnType<typeof genreAnswer> {
  return genreAnswer({ hero: 'hamster', cast: [{ label: 'giant roomba', does: 'chase_me' }, { label: 'cheese', does: 'collect' }], setting: 'supermarket', palette: 'supermarket', ...spec });
}

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
  director.script = [answered(genreAnswer())];
  director.gate = Promise.resolve();
  director.modelGate = Promise.resolve();
  genre.unplayable = false;
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
  // Rozpočet měří nástěnné hodiny: samotný test projde (2/2), v celé sadě 3,2–3,9 s souběhem workerů
  // (16. 10. 2026). Opakování nesnižuje limit – aspoň jeden pokus ho musí splnit.
  it('odpoví návrhem dřív, než režisér doběhne, a pod 3 s (hra s díly pod 6 s)', { retry: 2 }, async () => {
    holdDirector();
    // První publikace v procesu nese i načtení a JIT modulů návrhu (5 s pod vitestem); měří se ustálená cesta.
    await publish({ sentence: 'A frog jumps across a swamp.' });
    const started = performance.now();
    const created = await publish({ sentence: SENTENCE });
    const elapsed = performance.now() - started;
    const plainStarted = performance.now();
    const plain = await publish({ sentence: PLAIN_RUNNER });
    const plainElapsed = performance.now() - plainStarted;
    expect(created.status).toBe(201);
    expect(plain.status).toBe(201);
    expect(elapsed).toBeLessThan(PUBLISH_WITH_PARTS_MS);
    expect(plainElapsed).toBeLessThan(PUBLISH_MS);
    // Až po měření, ať návrh navíc neohřeje měřenou cestu: věta s křečkem je hra s dílem, veverka bez dílů – každá má svůj limit.
    expect(draftGameSpec(SENTENCE).assemblyParts?.length ?? 0).toBeGreaterThan(0);
    expect(draftGameSpec(PLAIN_RUNNER).assemblyParts ?? []).toEqual([]);
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
    director.script = [answered(faithful({ hero: 'golden hamster' }))];
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
    // Modul žánru složil hru z odpovědi (zlatý křeček), ne z věty (křeček) – věrnost chce jen stejné hlavní slovo.
    expect(child.spec.title.toLowerCase()).toMatch(/^golden hamster\b/);
    expect(child.spec.roles).toContainEqual(expect.objectContaining({ id: 'player', label: 'golden hamster' }));
    expect(child.origin).toBeUndefined();
    expect(child.timings.source).toBe('authored');
    for (const field of ['ackMs', 'draftReadyMs', 'directorMs', 'compileMs', 'verifyMs']) expect(child.timings[field]).toBeTypeOf('number');
    expect(child.timings.ackMs).toBeLessThanOrEqual(child.timings.draftReadyMs);
    expect((await game(draftId)).children).toEqual([ready.versionId]);
  });

  it('AI verze nese původ (model z odpovědi, čas, cache, opravy), rychlá ne (P73C T4)', async () => {
    const named = answered(faithful({ hero: 'golden hamster' }));
    director.script = [named.ok ? { ...named, provenance: { branch: 'fake', model: 'gpt-oss-test' } } : named];
    const created = await publish({ sentence: SENTENCE });
    const draftId: string = created.body.versionId;
    await upgrade(draftId);
    const ready = await settled(draftId);
    expect(ready.status).toBe('ready');
    const child = await game(ready.versionId);
    expect(child.provenance).toEqual({ model: 'gpt-oss-test', ms: expect.any(Number), cached: false, revised: 0 });
    expect(Number.isInteger(child.provenance.ms)).toBe(true);
    expect(child.provenance.ms).toBeGreaterThanOrEqual(Math.floor(child.timings.directorMs));
    expect((await game(draftId)).provenance).toBeUndefined();
  });

  it('bez jména modelu v odpovědi AI verze původ nemá – nic vymyšleného', async () => {
    director.script = [answered(faithful({ hero: 'golden hamster' }))];
    const created = await publish({ sentence: SENTENCE });
    await upgrade(created.body.versionId);
    const ready = await settled(created.body.versionId);
    expect(ready.status).toBe('ready');
    expect((await game(ready.versionId)).provenance).toBeUndefined();
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
    // Odpověď, která je JSON, ale ne GenreSpec: důvod čtení a celé tělo.
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

  const checkSentence = 'a hamster runs through a supermarket';
  const checkAnswer = () => genreAnswer({genre:'runner',mode:'default',hero:'golden hamster',cast:[],setting:'supermarket',palette:'supermarket'});

  it('autorská hra s neprošlým caller keypointem zůstane návrhem bez dítěte', async () => {
    genre.unplayable = true;
    director.script = [answered(checkAnswer())];
    const created = await publish({sentence:checkSentence});
    expect(await settled(created.body.versionId)).toEqual({status:'draft-final',reason:'NOT_PLAYABLE'});
    expect(await versionStoreFromEnv(process.env).childrenOf(created.body.versionId)).toEqual([]);
  });
  it('neprošlý keypoint dostane opravné kolo a opravená hra se publikuje', async () => {
    genre.unplayable = true;
    director.script = [answered(checkAnswer()),answered([{op:'replace',path:'/title',value:'Repaired Hamster Run'}])];
    const created = await publish({sentence:checkSentence});
    expect((await settled(created.body.versionId)).status).toBe('ready');
    expect(director.branch?.calls).toHaveLength(2);
    expect(director.branch?.calls[1]?.request.user).toContain('KEYPOINT_FAILED');
    expect(director.branch?.calls[1]?.request.user).toContain('injected_claim');
  });
  it('neopravený keypoint zůstane NOT_PLAYABLE i po opravných kolech', async () => {
    genre.unplayable = true;
    director.script = [answered(checkAnswer()),answered([]),answered([])];
    const created = await publish({sentence:checkSentence});
    expect(await settled(created.body.versionId)).toEqual({status:'draft-final',reason:'NOT_PLAYABLE'});
    expect(director.branch?.calls).toHaveLength(3);
    expect(await versionStoreFromEnv(process.env).childrenOf(created.body.versionId)).toEqual([]);
  });

  // P26 T4: AI smí opravit žánr, který návrh ze slov odhadl špatně – ověřuje robot, ne shoda s návrhem.
  // P32B T5: opravit smí jen na žánr hlavního slovesa. Úkol (celý `fallback`) je návrhem jen věty,
  // ve které žádný `ready` žánr nic neslyšel, a tu věrnost z úkolu nepustí – proto návrh z Arény:
  // útěk nasbírá víc bodů („scary“, „escapes“, „survives“, „hunts“) než hlavní sloveso „jumps“.
  it('návrh zachová skákání; plošinovku, která ztratila pronásledovatele, nahradí hra návrhu', async () => {
    director.script = [answered(genreAnswer({ genre: 'platformer', mode: 'default', hero: 'frog', cast: [{ label: 'snake', does: 'avoid' }], setting: 'swamp', palette: 'forest' }))];
    const created = await publish({ sentence: 'A frog jumps across a scary swamp, escapes and survives while a snake hunts it.' });
    expect((await game(created.body.versionId)).spec.genre).toMatchObject({ id: 'platformer', mode: 'default' });
    expect((await game(created.body.versionId)).spec.control).toBe('platform');
    // Demo 12. 10.: verze, která pronásledovatele ztratila, nevyjde – vyjde hra návrhu se vzhledem od režiséra (`onQuickGame`).
    expect(await settled(created.body.versionId)).toEqual(expect.objectContaining({ status: 'ready' }));
    const children = await versionStoreFromEnv(process.env).childrenOf(created.body.versionId);
    expect(children).toHaveLength(1);
    expect((await game(children[0] as string)).spec.roles).toEqual(expect.arrayContaining((await game(created.body.versionId)).spec.roles));
    expect(director.branch?.calls[1]?.request.user).toContain('chaser');
  });

  // P32B T4: model píše jen žánr – celý GameSpec (tady mřížka) se nepřečte a hra zůstane návrhem.
  it('odpověď celým GameSpec místo žánru skončí návrhem MALFORMED bez dítěte', async () => {
    director.script = [answered(answerFixture('good-collect_exit'))];
    const created = await publish({ sentence: 'jumping arcade game with a lot of obstacles' });
    expect(await settled(created.body.versionId)).toEqual({ status: 'draft-final', reason: 'MALFORMED' });
    expect(await versionStoreFromEnv(process.env).childrenOf(created.body.versionId)).toEqual([]);
  });

  it('běžec vylepšený běžcem je ready a dítě zůstane běžcem', async () => {
    director.script = [answered(genreAnswer({ genre: 'runner', mode: 'default', hero: 'cyber cat', cast: [{ label: 'drone', does: 'avoid' }, { label: 'acorn', does: 'collect' }], setting: 'neon rooftops', palette: 'city' }))];
    const created = await publish({ sentence: 'endless runner in a neon city' });
    expect((await game(created.body.versionId)).spec.control).toBe('runner');
    expect((await settled(created.body.versionId)).status).toBe('ready');
    const children = await versionStoreFromEnv(process.env).childrenOf(created.body.versionId);
    expect(children).toHaveLength(1);
    const child = await game(children[0] as string);
    expect(child.spec.control).toBe('runner');
    expect(child.spec.title).toBe('Cyber Cat Run');
    // Robot ověřuje běžce ~25–45 s (měřeno 12. 10., i před spojením verzí); rozpočet režie je 270 s.
  }, 90_000);

  // P32B T2: mřížkový návrh nová věta už nedostane; křeček je útěk v aréně.
  // P32B T5: běžce věrnost pustí, jen když ho hraje hlavní sloveso („runs“); návrh zůstane útěkem,
  // protože útěk nasbírá víc bodů („scary“, „escapes“, „survives“, „chases“).
  // T5b: skutečný běžec má narážku „escape“, s „hunts“ by byla remíza a návrh by byl už běžec – „chases“ je i narážka Arény.
  it('návrh zachová běh i útěk a odmítne běžce, který ztratil pronásledovatele', async () => {
    director.script = [answered(genreAnswer({ genre: 'runner', mode: 'default', hero: 'hamster', cast: [{ label: 'giant roomba', does: 'avoid' }, { label: 'cheese', does: 'collect' }], setting: 'supermarket aisles', palette: 'supermarket' }))];
    const created = await publish({ sentence: 'A hamster runs through a scary supermarket, escapes and survives while a giant Roomba chases it.' });
    expect((await game(created.body.versionId)).spec.genre).toMatchObject({ id: 'runner', mode: 'default' });
    expect((await game(created.body.versionId)).spec.control).toBe('runner');
    // Demo 12. 10.: vyjde hra návrhu se vzhledem od režiséra (`onQuickGame`), ovládání zůstane z návrhu.
    expect(await settled(created.body.versionId)).toEqual(expect.objectContaining({ status: 'ready' }));
    const children = await versionStoreFromEnv(process.env).childrenOf(created.body.versionId);
    expect(children).toHaveLength(1);
    expect((await game(children[0] as string)).spec.control).toBe('runner');
    expect(director.branch?.calls[1]?.request.user).toContain('chaser');
    // Robot ověřuje běžce víckrát (odpověď, opravné kolo, spojení s návrhem) – 30–45 s.
  }, 90_000);


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
    // Úložiště zná dítě, ne co přidalo (`adds` nese jen výsledek běhu, P46E T4).
    const { adds: _adds, ...stored } = first as { adds?: unknown };
    expect(await upgrade(created.body.versionId)).toEqual(stored);
    expect(director.calls).toBe(1);
  }, 90_000);

  it('proces bez záznamu vrátí uložený verdikt o větě a režiséra nezaplatí znovu (R10)', async () => {
    director.script = [answered('this is not a game')];
    const created = await publish({ sentence: SENTENCE });
    expect(await settled(created.body.versionId)).toEqual({ status: 'draft-final', reason: 'MALFORMED' });
    __resetUpgrades();
    director.script = [answered(genreAnswer())];
    expect(await upgrade(created.body.versionId)).toEqual({ status: 'draft-final', reason: 'MALFORMED' });
    expect(director.calls).toBe(1);
  });

  it('uložený přechodný důvod (starší build) se nečte – nový pokus (revize R10 kolo 2)', async () => {
    director.script = [failed('UPSTREAM_UNAVAILABLE')];
    const created = await publish({ sentence: SENTENCE });
    expect(await settled(created.body.versionId)).toEqual({ status: 'draft-final', reason: 'MODEL_UNAVAILABLE' });
    await versionStoreFromEnv(process.env).rememberUpgradeVerdict(created.body.versionId, 'MODEL_UNAVAILABLE', 3600);
    __resetUpgrades();
    director.script = [answered(genreAnswer())];
    expect((await settled(created.body.versionId)).status).toBe('ready');
  });

  it('přechodný výpadek modelu se nepamatuje – další dotaz dostane nový pokus (revize R10)', async () => {
    director.script = [failed('UPSTREAM_UNAVAILABLE')];
    const created = await publish({ sentence: SENTENCE });
    expect(await settled(created.body.versionId)).toEqual({ status: 'draft-final', reason: 'MODEL_UNAVAILABLE' });
    director.script = [answered(genreAnswer())];
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
      director.script = [answered(genreAnswer())];
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
    director.script = [answered(genreAnswer())];
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
    director.script = [answered(genreAnswer())];
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

/**
 * Hra ze čtení na dotazu upgradu (P58D T2): `pending` nese `reading: { versionId }`, jakmile hra ze čtení vznikne,
 * a long-poll procesu, který o návrhu nevěděl, se s ní vrátí hned – ne až po `UPGRADE_WAIT_MS`. `pending` bez ní
 * (čtečka vypnutá) drží první test souboru přesnou shodou s `PENDING`.
 */
/** Čtení, které útěk křečka (`SENTENCE`) hraje jako hledání (`quest.spatial`); slovník ho hraje jako útěk v Aréně. */
const READ: Reading = {
  control: 'move_free', verbs: [{ word: 'escapes', class: 'move_free' }], hero: 'hamster', roles: [{ noun: 'roomba', kind: 'threat', count: null }], setting: 'supermarket',
  mood: null, numbers: { seconds: null, counts: [] }, genre: { genre: 'quest', mode: 'spatial' }, sure: true, foe: 'roomba', item: null, world: null, title: null,
};

/** Čtečka za místní adresou (nic se neplatí): odpoví `reading`; `calls` počítá dotazy, ať test bez čtení neprojde naprázdno. */
function stubReader(reading: Reading): { readonly calls: () => number } {
  let calls = 0;
  vi.stubEnv('PLAY_READER', 'on');
  vi.stubEnv('PLAY_READER_PATH', 'ai');
  vi.stubEnv('PLAY_READER_ENDPOINT', 'http://reader.test');
  resetProcessAnswerStore();
  vi.stubGlobal('fetch', async () => {
    calls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reading) } }] }));
  });
  return { calls: () => calls };
}

describe('dotaz upgradu hlásí hru ze čtení (P58D T2)', () => {
  beforeEach(() => {
    stubReader(READ);
    director.modelGate = new Promise((resolve) => {
      release = resolve;
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('pending nese hru ze čtení, jakmile vznikne; hotová AI verze (ready) ji nenese', async () => {
    const created = await publish({ sentence: SENTENCE });
    expect((await game(created.body.versionId)).spec.genre).not.toMatchObject({ id: 'quest', mode: 'spatial' });
    let pending: Record<string, any> = {};
    await vi.waitFor(async () => {
      pending = await upgrade(created.body.versionId);
      expect(pending.reading).toBeDefined();
    }, { timeout: 30_000 });
    expect(pending).toEqual({ ...PENDING, reading: { versionId: expect.stringMatching(/^[0-9a-f]{32}$/) } });
    const reading = await game(pending.reading.versionId);
    expect(reading.version.parentId).toBe(created.body.versionId);
    expect(reading.spec.genre).toMatchObject({ id: 'quest', mode: 'spatial' });
    release();
    const final = await settled(created.body.versionId);
    expect(final).not.toHaveProperty('reading');
  }, 120_000);

  it('long-poll procesu, který o návrhu nevěděl, se s hrou ze čtení vrátí hned', async () => {
    const created = await publish({ sentence: SENTENCE });
    // Jiná instance: práci z POST drží jiný proces, dotaz ji spustí sám a čeká nejvýš 25 s.
    __resetUpgrades();
    const started = performance.now();
    const pending = await upgrade(created.body.versionId);
    expect(pending).toEqual({ ...PENDING, reading: { versionId: expect.stringMatching(/^[0-9a-f]{32}$/) } });
    expect(performance.now() - started).toBeLessThan(15_000);
  }, 120_000);

  // Živá kontrola T4: strop odmítl AI verzi, každý dotaz našel uloženou hru ze čtení, vrátil `pending` s novou lhůtou
  // a spustil nový pokus – hráč na hře ze čtení čekal na AI verzi donekonečna.
  it('odmítnutí stropem předběhne hru ze čtení z dřívějšího pokusu', async () => {
    director.callerLimited = true;
    const created = await publish({ sentence: SENTENCE });
    const versions = versionStoreFromEnv(process.env);
    await vi.waitFor(async () => expect(await versions.childrenOf(created.body.versionId)).toHaveLength(1), { timeout: 30_000 });
    await vi.waitFor(() => expect(knownUpgrade(created.body.versionId)).toBeNull(), { timeout: 30_000 });
    // Konec, ne `pending`; od P63 T6 nese uloženou hru ze čtení – hráč na ní zůstane, hráč na rychlé hře ji dostane.
    const [reading] = await versions.childrenOf(created.body.versionId);
    expect(await upgrade(created.body.versionId)).toEqual({ status: 'draft-final', reason: 'MODEL_UNAVAILABLE', reading: { versionId: reading } });
  }, 120_000);
});

/**
 * Hra ze čtení i ve stejném žánru (P61 T2): čtení „zombie shooter in a mall“ zná obchodní centrum i zombie, hraje ale
 * týž žánr – dřív se hra ze čtení nepublikovala (`playsOtherGenre`). `readingDiffers` srovná specy rychlé hry a návrhu
 * ze čtení: svět a nepřítele či sbíranou věc z věty, ne název, čísla ani výchozí věci.
 */
describe('hra ze čtení i ve stejném žánru, když ukáže svět nebo věc z věty (P61 T2)', () => {
  const ZOMBIE = 'zombie shooter in a mall';
  /** Čtení věty (p30 dev s039): střílečka, nepřítel zombie, sada obchodního centra. */
  const MALL: Reading = {
    control: 'shooter', verbs: [{ word: 'shooter', class: 'aim_shoot' }], hero: null, roles: [{ noun: 'zombie', kind: 'threat', count: null }], setting: 'mall',
    mood: null, numbers: { seconds: null, counts: [] }, genre: { genre: 'shooter', mode: 'default' }, sure: true, foe: 'zombie', item: null, world: 'mall', title: null,
  };
  /** Běžec (p30 dev s006), jehož sbíraná věc je z věty: klobása, ne výchozí věc parku. */
  const CORGI = 'A corgi runs through a park grabbing sausages and jumping over sprinklers';
  const relabel = (spec: GameSpecV1, id: string, label: string): GameSpecV1 => ({ ...spec, roles: spec.roles.map((role) => (role.id === id ? { ...role, label } : role)) });
  const read = draftGameSpecWithMeta(ZOMBIE, 1, { reading: MALL }).spec;
  /** Rychlá hra jiného vzhledu (P60: aréna bez obchodního centra a bez zombie): bez sady, výchozí robot střílečky. */
  const plain = relabel({ ...read, theme: { setting: 'arena', mood: read.theme.mood } }, 'enemy', 'robot');

  it('hra ze čtení v obchodním centru se zombie se liší od rychlé hry na louce s robotem', () => {
    expect(read.genre).toEqual(plain.genre);
    expect([lookOf(plain.theme), lookOf(read.theme)]).toEqual(['meadow', 'mall']);
    expect(read.roles).toContainEqual(expect.objectContaining({ id: 'enemy', label: 'zombie' }));
    expect(readingDiffers(plain, read)).toBe(true);
  });

  /**
   * P63 T2 (P61 h24): sestavená jízda nenese `spec.genre`, mřížka ale není. Čtení zná bouřkové mraky, rychlá hra
   * kreslí žraloky – hra ze čtení se zveřejní; tentýž návrh ze staré cesty mřížky ne.
   */
  it('sestavená jízda ze čtení s bouřkovými mraky se liší od rychlé jízdy se žraloky, mřížka ne', () => {
    const BALLOON = 'Steer a hot air balloon between thunderclouds above the ocean';
    const STORM: Reading = {
      control: 'steer', verbs: [{ word: 'Steer', class: 'steer' }], hero: 'hot air balloon', roles: [{ noun: 'thunderclouds', kind: 'obstacle', count: null }], setting: 'above the ocean',
      mood: null, numbers: { seconds: null, counts: [] }, genre: { genre: 'voyage', mode: 'race' }, sure: true, foe: 'thunderclouds', item: null, world: 'ocean', title: 'Hot Air Balloon',
    };
    const quick = draftGameSpec(BALLOON);
    const drafted = draftGameSpecWithMeta(BALLOON, 1, { reading: STORM });
    expect(drafted.spec.genre).toBeUndefined();
    expect(drafted.genre).not.toBeNull();
    expect(drafted.spec.roles).toContainEqual(expect.objectContaining({ label: 'thundercloud' }));
    expect(readingDiffers(quick, drafted.spec, drafted.genre === null)).toBe(true);
    expect(readingDiffers(quick, drafted.spec, true)).toBe(false);
  });

  /** Rychlá hra a návrh ze čtení; páry se staví až v testu. */
  type Pair = [name: string, pair: () => readonly [quick: GameSpecV1, read: GameSpecV1]];

  it.each<Pair>([
    ['jen svět: obchodní centrum místo louky', () => [relabel(plain, 'enemy', 'zombie'), read]],
    ['jen nepřítel: zombie místo robota', () => [relabel(read, 'enemy', 'robot'), read]],
    ['jen sbíraná věc: klobásy místo mince', () => [relabel(draftGameSpec(CORGI), 'coin', 'coin'), draftGameSpec(CORGI)]],
    ['jiný žánr jako dřív: hledání místo útěku', () => [draftGameSpec(SENTENCE), draftGameSpecWithMeta(SENTENCE, 1, { reading: READ }).spec]],
  ])('liší se – %s', (_name, pair) => {
    const [quick, reading] = pair();
    expect(readingDiffers(quick, reading)).toBe(true);
  });

  it.each<Pair>([
    ['rychlá hra věty už ukazuje obchodní centrum i zombie', () => [draftGameSpec(ZOMBIE), read]],
    ['jen název, počty a čísla žánru', () => [read, { ...read, title: 'Mall Of The Dead', scoring: { target: 500 }, controlParams: { ...read.controlParams, waves: 5 }, roles: read.roles.map((role) => ({ ...role, count: role.count + 4 })) }]],
    ['týž model nepřítele pod jiným tvarem jména', () => [read, relabel(read, 'enemy', 'zombies')]],
    ['výchozí nepřítel za jiný výchozí', () => [plain, relabel(plain, 'enemy', 'wolf')]],
    ['čtení vymění zombie z věty za výchozího robota', () => [read, relabel(read, 'enemy', 'robot')]],
    ['návrh ze čtení bez žánru (mřížka)', () => [plain, (({ genre: _genre, ...grid }: GameSpecV1) => grid)(read)]],
  ])('neliší se – %s', (_name, pair) => {
    const [quick, reading] = pair();
    expect(readingDiffers(quick, reading)).toBe(false);
  });

  /** Upgrade, jak ho spustí dotaz: model nedostupný (prázdný scénář), takže publikuje jen hra ze čtení. */
  async function readingChildren(quickSpec: GameSpecV1): Promise<{ readonly reading: PublishedGame[]; readonly announced: string[] }> {
    const store = memoryVersionStore();
    const quick = await publishReadSpec(store, quickSpec, derivedSeeds(seedFrom(ZOMBIE)), null, { origin: { sentence: ZOMBIE, seed: null } });
    if (!quick.ok) throw new Error(`quick version did not publish: ${JSON.stringify(quick.issues)}`);
    const announced: string[] = [];
    const request = { sentence: ZOMBIE, seed: null, ackMs: null, draftReadyMs: null, startedAt: Date.now(), caller: 'p61-t2-test' };
    await directUpgrade(store, quick.value.game, request, undefined, (id) => announced.push(id));
    const children = await Promise.all((await store.childrenOf(quick.value.game.version.versionId)).map((id) => store.get(id)));
    return { reading: children.filter((child): child is PublishedGame => child?.relation === 'reading'), announced };
  }

  describe('publikace', () => {
    let reader: ReturnType<typeof stubReader>;
    beforeEach(() => {
      reader = stubReader(MALL);
      director.script = [];
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });

    it('rychlá hra jiného vzhledu dostane hru ze čtení jako dítě `reading`', async () => {
      const { reading, announced } = await readingChildren(plain);
      expect(reader.calls()).toBe(1);
      expect(reading).toHaveLength(1);
      expect(reading[0]!.spec).toEqual(read);
      expect(announced).toEqual([reading[0]!.version.versionId]);
    }, 120_000);

    it('rychlá hra, která už ukazuje obchodní centrum i zombie, hru ze čtení nedostane', async () => {
      const { reading, announced } = await readingChildren(draftGameSpec(ZOMBIE, 1));
      expect(reader.calls()).toBe(1);
      expect(reading).toEqual([]);
      expect(announced).toEqual([]);
    }, 120_000);
  });
});

/**
 * Bez brány věrnosti (P38 ruší P37A T8): AI verze, která projde ověřením, se
 * nabídne vždy – i když kontrolní seznam věty (kuchař, hrnec, ledovec, „stir“)
 * nenese víc než návrh. O přepnutí rozhodne hráč přepínačem Quick | AI.
 */
describe('AI verze se nabídne i bez zisku věrnosti (P38)', () => {
  const WALRUS = 'a walrus chef stirs a big pot of soup on an iceberg';
  const station = (spec: Record<string, unknown> = {}) => ({
    plan: 'stir the soup',
    spec: { genre: 'quest', mode: 'station', hero: 'walrus chef', enemy: 'shadow', collectible: 'coin', target: { label: 'big pot', verb: 'stir', states: 3 }, setting: 'iceberg', ...spec },
  });

  it.each([
    ['věrnější (ledovec dostane sadu sněhu)', { palette: 'snow' }, 'ready'],
    ['opravený nepřítel zachová původní obsah', { enemy: 'seal' }, 'UNCHANGED'],
    ['opravený cíl zachová původní hrnec', { target: { label: 'ladle', verb: 'stir', states: 3 } }, 'UNCHANGED'],
  ])('%s verze je hotová jako dítě návrhu', async (_name, change, expected) => {
    director.script = [answered(station(change))];
    const created = await publish({ sentence: WALRUS });
    const ready = await settled(created.body.versionId);
    if(expected === 'ready') {
      expect(ready.status).toBe('ready');
      expect((await game(ready.versionId)).version.parentId).toBe(created.body.versionId);
    } else {
      expect(ready).toEqual({status:'draft-final',reason:'UNCHANGED'});
      expect(await versionStoreFromEnv(process.env).childrenOf(created.body.versionId)).toEqual([]);
    }
  });
});
