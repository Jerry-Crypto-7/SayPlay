/**
 * AI verze nesmí ztratit pravidla ani logiku rychlé verze (P46E T2). Demo 12. 10.: křečkovi
 * (běžec) zmizela pravidla, autu (řízení) logika. Rychlá verze se publikuje skutečně, upgrade
 * běží skutečným `directUpgrade`; u křečka i skutečným `direct()` nad nahranou odpovědí.
 */

import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import { loadRapier } from '@/play/arcade/physics/world';
import { type DirectedGame, type DirectorDeps, direct } from '@/play/director';
import { answered, fakeBranch } from '@/play/director/__fixtures__/branch';
import { draftGameSpecWithMeta } from '@/play/draft';
import type { GameSpecV1 } from '@/play/spec';
import { memoryVersionStore } from '@/play/version';

import { derivedSeeds, publishReadSpec, seedFrom } from '../_publish';
import { directUpgrade } from '../_upgrade';

const HAMSTER = 'Hamster escapes a supermarket Roomba';
const CAR = 'Racing car escaping and shooting enemies';

/**
 * Nahraná odpověď gpt-oss-20b na banána (`logic-answers/s008.json`) s obsazením křečka: běžec,
 * jehož pravidla fází robot neprokáže, takže je `direct()` z AI verze vyřadí.
 */
function hamsterAnswer(): unknown {
  const { spec } = (JSON.parse(readFileSync('src/play/director/__fixtures__/logic-answers/s008.json', 'utf8')) as { answer: { spec: Record<string, unknown> } }).answer;
  return {
    plan: 'a hamster flees a giant roomba through a supermarket',
    spec: { ...spec, hero: 'hamster', setting: 'supermarket', palette: 'supermarket', cast: [{ label: 'giant roomba', does: 'chase_me', verb: 'chase', states: null, patrol: false }], ruleRoles: [{ id: 'monkey', kind: 'chaser', label: 'giant roomba', count: null }] },
  };
}

/** Rychlá verze jako `POST /api/play/games` a nad ní `directUpgrade` s režisérem `director`. */
async function upgraded(sentence: string, director: (check: DirectorDeps['check']) => Promise<DirectedGame>) {
  const store = memoryVersionStore();
  const seeds = derivedSeeds(seedFrom(sentence));
  const quick = await publishReadSpec(store, draftGameSpecWithMeta(sentence, 1).spec, seeds, null, { origin: { sentence, seed: null } });
  if (!quick.ok) throw new Error(JSON.stringify(quick.issues));
  const outcome = await directUpgrade(store, quick.value.game, { sentence, seed: null, ackMs: null, draftReadyMs: null, startedAt: Date.now(), caller: 'keeps-rules' }, (_startedAt, _caller, check) => async () => ({ ...(await director(check)), callerLimited: false }));
  if (outcome.status !== 'ready') throw new Error(`no AI version: ${outcome.reason}`);
  return { quick: quick.value.game.spec, ai: (await store.get(outcome.versionId))!.spec };
}

const ids = (spec: GameSpecV1) => (spec.rules ?? []).map((rule) => rule.id);

beforeAll(() => loadRapier());

describe('the AI version keeps the rules and logic of the quick version', () => {
  it('hamster (runner): the director drops the answer rules and takes the quick rules, things and logic instead', async () => {
    let tick = 0;
    const directed = await direct(HAMSTER, { branch: fakeBranch([answered(hamsterAnswer())]), now: () => (tick += 1), compact: true, maxRepairRounds: 0 });
    const quick = draftGameSpecWithMeta(HAMSTER, 1).spec;
    expect(ids(quick).length).toBeGreaterThan(0);
    expect(directed.source).toBe('authored');
    expect(directed.rulesFrom).toBe('draft');
    expect(ids(directed.spec)).toEqual(ids(quick));
    expect(directed.spec.logic).toEqual(quick.logic);
    expect(directed.spec.things).toEqual(quick.things);
  }, 120_000);

  it('hamster (runner): the published AI version has every quick rule and the quick logic', async () => {
    const { quick, ai } = await upgraded(HAMSTER, (check) => direct(HAMSTER, { branch: fakeBranch([answered(hamsterAnswer())]), now: Date.now, check, compact: true, maxRepairRounds: 0 }));
    expect(ids(ai)).toEqual(expect.arrayContaining(ids(quick)));
    expect(ai.logic).toEqual(quick.logic);
  }, 180_000);

  it('car (steer): an AI version with as many own rules but no logic keeps them and gains the quick rules and logic', async () => {
    const quick = draftGameSpecWithMeta(CAR, 1).spec;
    expect(quick.control).toBe('steer');
    expect(quick.logic).toBeDefined();
    // Stejný počet pravidel jako rychlá verze: AI verzi chybí jen logika.
    const own = ids(quick).map((_, i) => ({ id: `bonus${String(i)}`, verb: 'collect', when: { every: 300 + 100 * i }, do: [{ score: 1 }] }) as NonNullable<GameSpecV1['rules']>[number]);
    const { rules: _rules, things: _things, logic: _logic, ...bare } = quick;
    const ai: GameSpecV1 = { ...bare, title: 'Road Fury', rules: own };
    const published = await upgraded(CAR, async () => ({ ok: true, spec: ai, source: 'authored', repairRounds: 0, fallbackReason: null, warnings: [], ms: 1, calls: 1 }));
    expect(published.ai.title).toBe('Road Fury');
    expect(ids(published.ai)).toEqual([...ids(quick), ...own.map((rule) => rule.id)]);
    expect(published.ai.logic).toEqual(quick.logic);
  }, 180_000);

  it('only when the robot cannot verify the quick rules either does the game go without rules, marked rulesFrom none', async () => {
    let tick = 0;
    // Ověření robotem odmítne každou hru s pravidly – pravidla odpovědi i rychlé verze.
    const directed = await direct(HAMSTER, {
      branch: fakeBranch([answered(hamsterAnswer())]),
      now: () => (tick += 1),
      compact: true,
      maxRepairRounds: 0,
      check: (spec) => ((spec.rules?.length ?? 0) > 0 ? [{ code: 'VERB_UNPROVED', path: '/rules', evidence: 'chase never fired', repairHint: 'drop it' }] : []),
    });
    expect(directed.source).toBe('authored');
    expect(directed.rulesFrom).toBe('none');
    expect(directed.spec.rules).toBeUndefined();
    expect(directed.spec.logic).toBeUndefined();
  }, 120_000);
});
