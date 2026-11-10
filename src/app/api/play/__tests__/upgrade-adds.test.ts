/**
 * Brána „AI verze se liší“ (P46E T4): nahraná odpověď režiséra s bossem, akcí nebo scénářem úseků projde
 * skutečnou cestou upgradu (rychlá verze publikovaná jako v `POST /api/play/games`, `direct()`, ověření
 * robotem, publikace) a AI verze novinku nese ve hře. Bez novinky upgrade jednou požádá o bosse nebo akci.
 * Jediný dvojník je větev modelu: vrátí nahrané tělo.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { bossKindOf, segmentNewsOf } from '@/play/arcade/pieces/pacing';
import { type DirectedGame, direct } from '@/play/director';
import { answered, fakeBranch } from '@/play/director/__fixtures__/branch';
import type { LogicAnswerFixture } from '@/play/director/__fixtures__/logic-answers';
import { draftForControl, draftGameSpecWithMeta } from '@/play/draft';
import { memoryVersionStore } from '@/play/version';

import { derivedSeeds, publishReadSpec, seedFrom } from '../_publish';
import { ADD_NUDGE, AI_VERSION_TARGET_MS, UPGRADE_WINDOW, directUpgrade } from '../_upgrade';

const fixture = (id: string): LogicAnswerFixture =>
  JSON.parse(readFileSync(join(process.cwd(), 'src/play/director/__fixtures__/logic-answers', `${id}.json`), 'utf8')) as LogicAnswerFixture;

/** Nahraná odpověď s novinkami T3 v `spec`. */
const withExtras = (answer: unknown, extras: Record<string, unknown>): unknown => {
  const envelope = answer as { readonly spec: Record<string, unknown> };
  return { ...envelope, spec: { ...envelope.spec, ...extras } };
};

/**
 * Upgrade nad rychlou verzí věty: první volání režiséra dostane `answers[0]`, druhé (s pokynem) `answers[1]`.
 * Výchozí `startedAt` je o cíl v budoucnu: brána času pokynu (P70B T4a) je předmětem jen svého testu a ověření robotem
 * pod zátěží trvá přes 20 s, takže by okno 42 s (P83B T3) pokyn ostatním testům náhodně vzalo.
 */
async function upgrade(sentence: string, answers: readonly unknown[], quickSpec = draftGameSpecWithMeta(sentence, 1).spec, startedAt = Date.now() + AI_VERSION_TARGET_MS) {
  const store = memoryVersionStore();
  const quick = await publishReadSpec(store, quickSpec,derivedSeeds(seedFrom(sentence)), null, { origin: { sentence, seed: null } });
  if (!quick.ok) throw new Error(`quick version did not publish: ${JSON.stringify(quick.issues)}`);
  const draft = quick.value.game;
  const nudges: (string | undefined)[] = [];
  const prompts: string[] = [];
  const results: DirectedGame[] = [];
  const windows: unknown[] = [];
  const outcome = await directUpgrade(store, draft, { sentence, seed: null, ackMs: null, draftReadyMs: null, startedAt, caller: 'upgrade-adds-test' }, (_startedAt, _caller, check, nudge, _queueId, _wait, _onDraft, window) => async (said) => {
    const answer = answers[nudges.length];
    nudges.push(nudge);
    windows.push(window);
    const branch = fakeBranch(answer === undefined ? [] : [answered(answer)]);
    const directed = await direct(said, { branch, now: Date.now, check, compact: true, maxRepairRounds: 0, ...(nudge === undefined ? {} : { nudge }) });
    prompts.push(...branch.calls.map((call) => call.request.user));
    results.push(directed);
    return { ...directed, callerLimited: false };
  });
  const child = outcome.status === 'ready' ? await store.get(outcome.versionId) : null;
  return { draft, outcome, child, nudges, prompts, results, windows };
}

const s008 = fixture('s008');
const f22 = fixture('f22');
const si018 = fixture('si-018');

describe('the AI version adds what the quick version lacks (P46E T4)', () => {
  it('composes a recorded boss into the published game and shows its name', async () => {
    const boss = { role: 'monkey', name: 'Monkey King', attack: 'charge' };
    const { draft, outcome, child, nudges } = await upgrade(s008.sentence, [withExtras(s008.answer, { boss })]);
    expect(outcome).toMatchObject({ status: 'ready', adds: expect.arrayContaining(['boss']) });
    expect(child!.spec.boss).toEqual({ name: 'Monkey King', role: 'monkey' });
    expect(draft.spec.boss).toBeUndefined();
    expect(bossKindOf(child!.arcade!)).not.toBeNull();
    // Novinka v první odpovědi: druhý pokus s pokynem není.
    expect(nudges).toEqual([undefined]);
  }, 180_000);

  it('plays the recorded segment script instead of the drawn one', async () => {
    const { draft, outcome, child } = await upgrade(s008.sentence, [withExtras(s008.answer, { segments: ['faster', 'newFoe', 'faster'] })]);
    expect(outcome).toMatchObject({ status: 'ready', adds: expect.arrayContaining(['segments']) });
    const news = (world: Parameters<typeof segmentNewsOf>[0]) => segmentNewsOf(world).map((item) => `${item.beat}:${item.news}`);
    // Úsek 2 bez nového nepřítele, nový přijde až v úseku 3.
    expect(news(child!.arcade!)).not.toContain('segment2:newFoe');
    expect(news(child!.arcade!)).toContain('segment3:newFoe');
    expect(news(child!.arcade!)).not.toEqual(news(draft.arcade!));
  }, 180_000);

  it('asks once for a boss or an ability when the answer adds nothing, then publishes with adds: []', async () => {
    const { outcome, nudges, prompts } = await upgrade(f22.sentence, [f22.answer, f22.answer]);
    expect(outcome).toMatchObject({ status: 'ready', adds: [] });
    expect(nudges).toEqual([undefined, ADD_NUDGE]);
    expect(ADD_NUDGE).toContain('add a boss or an ability');
    // Pokyn jde modelu jen ve druhém volání.
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain(ADD_NUDGE);
    expect(prompts[1]).toContain(ADD_NUDGE);
  }, 180_000);

  it('skips the nudge when a second run would end past the target and publishes the first with adds: [] (P70B T4a, P83B T3)', async () => {
    const late = await upgrade(f22.sentence, [f22.answer, f22.answer], undefined, Date.now() - AI_VERSION_TARGET_MS);
    expect(late.outcome).toMatchObject({ status: 'ready', adds: [] });
    expect(late.nudges).toEqual([undefined]);
    // Těsně pod cílem se pokyn pořád zkusí – brána měří zbývající čas, nevypíná pokus.
    const early = await upgrade(f22.sentence, [f22.answer, f22.answer], undefined, Date.now() - 1_000);
    expect(early.nudges).toEqual([undefined, ADD_NUDGE]);
    // Obě režie AI verze běží v okně pod stropem 45 s, ne v rozpočtu trasy (P83B T3); cíl pokynu je totéž okno.
    expect(early.windows).toEqual([UPGRADE_WINDOW, UPGRADE_WINDOW]);
    expect(AI_VERSION_TARGET_MS).toBe(UPGRADE_WINDOW.budgetMs);
  }, 180_000);

  it('publishes the nudged answer when it adds a boss the first one lacked', async () => {
    const boss = { role: 'monkey', name: 'Monkey King', attack: 'charge' };
    const { outcome, child, nudges } = await upgrade(s008.sentence, [s008.answer, withExtras(s008.answer, { boss })]);
    expect(nudges).toEqual([undefined, ADD_NUDGE]);
    expect(outcome).toMatchObject({ status: 'ready', adds: expect.arrayContaining(['boss']) });
    expect(child!.spec.boss?.name).toBe('Monkey King');
  }, 180_000);

  // Akci dokazuje pravidlo se slovesem akce (`verdict.verbs`), ne svědek záměru: dřív padala každá jako „never used“.
  it('gives the hero a recorded ability the robot uses and reports adds: action', async () => {
    const { draft, outcome, child, results, nudges } = await upgrade(si018.sentence, [withExtras(si018.answer, { abilities: ['dash'] })]);
    expect(results[0]!.failure).toBeUndefined();
    expect(outcome).toMatchObject({ status: 'ready', adds: ['action'] });
    expect(draft.spec.abilities ?? []).not.toContain('dash');
    expect(child!.spec.abilities).toEqual(['dash']);
    expect(child!.spec.tutorial.controlsHint).toMatch(/J to dash\.$/);
    expect(nudges).toEqual([undefined]);
  }, 180_000);

  // Do P46C robot se střelbou prohrál na 465 m a akce šla pryč („did not win with the shoot ability“). S kombem a
  // power-upy P46C vyhraje, takže střelba zůstane. Větev „nevyhrál s akcí“ dnes žádná nahrávka nespustí (zkoušeno
  // s008, si-018, f22 × shoot/strike/dash/shield, 15. 10.).
  it('keeps a recorded ability once the robot wins with it (s008 shoot after P46C)', async () => {
    const { outcome, child, results } = await upgrade(s008.sentence, [withExtras(s008.answer, { abilities: ['shoot'] })]);
    expect(results[0]!.source).toBe('authored');
    expect(results[0]!.failure?.detail ?? '').not.toContain('"shoot" ability');
    expect(outcome).toMatchObject({ status: 'ready', adds: ['action'] });
    expect(child!.spec.abilities).toEqual(['shoot']);
  }, 180_000);

  // Na téže nahrávce dřív „never used the grab ability“: robot krade, jen to svědci záměru neukázali.
  it('keeps a recorded ability the runner robot uses on the same answer that used to drop it', async () => {
    const { outcome, child, results } = await upgrade(s008.sentence, [withExtras(s008.answer, { abilities: ['grab'] })]);
    expect(results[0]!.failure?.detail ?? '').not.toContain('"grab" ability');
    expect(outcome).toMatchObject({ status: 'ready', adds: ['action'] });
    expect(child!.spec.abilities).toEqual(['grab']);
    expect(child!.spec.tutorial.controlsHint).toMatch(/J to grab\.$/);
  }, 180_000);

  // Mřížková rychlá verze nemá arkádový svět: srovnání novinek dřív padalo na TypeError místo publikace.
  it('upgrades a grid quick version without adds and without a nudge', async () => {
    const { draft, outcome, child, nudges } = await upgrade(s008.sentence, [s008.answer], draftForControl(s008.sentence, 'tap_go', 1)!);
    expect(draft.arcade).toBeUndefined();
    expect(outcome.status).toBe('ready');
    expect(outcome).not.toHaveProperty('adds');
    expect(child!.arcade).toBeDefined();
    expect(nudges).toEqual([undefined]);
  }, 180_000);

  it('keeps the first AI version when the nudged call fails', async () => {
    const { outcome, child, nudges } = await upgrade(s008.sentence, [s008.answer]);
    expect(nudges).toEqual([undefined, ADD_NUDGE]);
    expect(outcome).toMatchObject({ status: 'ready', adds: [] });
    expect(child!.spec.boss).toBeUndefined();
  }, 180_000);

  // `direct()` ověří první seed, publikace první seed, který drží akci věty: dřív publikace hru se strike odmítla
  // (verbs_proved) a z upgradu zbyla jen rychlá verze.
  it('keeps the AI version when its ability is proved only on a seed it is not published on', async () => {
    const { outcome, child, results } = await upgrade(s008.sentence, [withExtras(s008.answer, { abilities: ['strike'] })]);
    expect(results[0]!.spec.abilities).toContain('strike');
    expect(outcome).toMatchObject({ status: 'ready' });
    expect(child!.spec.abilities ?? []).not.toContain('strike');
  }, 180_000);
});
