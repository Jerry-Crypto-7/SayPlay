/**
 * Režisér píše pravidla (P29A T7): kompaktní odpověď nese `rules`, `ruleRoles`
 * a `things` v přísném tvaru (volitelné pole = null) a `composeCompact` je
 * dostane do specu beze ztráty. Hlídá tichou ztrátu: prompt, který pravidla
 * popisuje, a schéma nebo skládání, které je zahodí.
 */

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '../arcade/compile';
import carryKey from '../arcade/__fixtures__/rules/carry-key.json';
import collectGate from '../arcade/__fixtures__/rules/collect-gate.json';
import giveFlower from '../arcade/__fixtures__/rules/give-flower.json';
import leverBridge from '../arcade/__fixtures__/rules/lever-bridge.json';
import pushCrate from '../arcade/__fixtures__/rules/push-crate.json';
import throwRock from '../arcade/__fixtures__/rules/throw-rock.json';
import { DIRECTOR_ANSWER_SCHEMA } from '../director/answer-schema';
import { COMPACT_ANSWER_SCHEMA, compactSystemPrompt, composeCompact } from '../director/compact';
import { readDirectorAnswer } from '../director/read';
import carryKeyAnswer from '../director/__fixtures__/rules-answers/carry-key.json';
import collectGateAnswer from '../director/__fixtures__/rules-answers/collect-gate.json';
import giveFlowerAnswer from '../director/__fixtures__/rules-answers/give-flower.json';
import leverBridgeAnswer from '../director/__fixtures__/rules-answers/lever-bridge.json';
import pushCrateAnswer from '../director/__fixtures__/rules-answers/push-crate.json';
import throwRockAnswer from '../director/__fixtures__/rules-answers/throw-rock.json';

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Každý objekt schématu musí mít všechna pole v `required` a `additionalProperties: false` – jinak ho API odmítne celé. */
function looseNodes(node: unknown, path = ''): string[] {
  if (Array.isArray(node)) return node.flatMap((item, i) => looseNodes(item, `${path}/${i}`));
  if (!isObject(node)) return [];
  const own: string[] = [];
  if (node.type === 'object') {
    const keys = Object.keys((node.properties as Json | undefined) ?? {});
    if (node.additionalProperties !== false) own.push(`${path}: additionalProperties`);
    if (JSON.stringify([...((node.required as string[] | undefined) ?? [])].sort()) !== JSON.stringify([...keys].sort())) own.push(`${path}: required`);
  }
  return [...own, ...Object.entries(node).flatMap(([key, value]) => looseNodes(value, `${path}/${key}`))];
}

const CASES = [
  ['carry-key', carryKeyAnswer, carryKey],
  ['collect-gate', collectGateAnswer, collectGate],
  ['give-flower', giveFlowerAnswer, giveFlower],
  ['lever-bridge', leverBridgeAnswer, leverBridge],
  ['push-crate', pushCrateAnswer, pushCrate],
  ['throw-rock', throwRockAnswer, throwRock],
] as const;

describe('the director writes rules', () => {
  it('the compact schema takes rules, rule roles and things, strict in every node', () => {
    const properties = COMPACT_ANSWER_SCHEMA.properties as Json;
    for (const key of ['rules', 'ruleRoles', 'things']) {
      expect(properties[key], key).toBeDefined();
      expect(COMPACT_ANSWER_SCHEMA.required).toContain(key);
    }
    expect(looseNodes(COMPACT_ANSWER_SCHEMA)).toEqual([]);
  });

  it('neither model schema offers the interact trigger while it is a stub, but both keep the live ones', () => {
    // `when.interact` do P32G T1 nic nedělá: hra s ním je mrtvá a opravné kolo ji nespraví (revize P32-0 T4).
    for (const [name, schema] of [['compact', COMPACT_ANSWER_SCHEMA], ['director', DIRECTOR_ANSWER_SCHEMA]] as const) {
      const text = JSON.stringify(schema);
      expect(text, name).not.toContain('"interact"');
      for (const trigger of ['contact', 'press', 'every', 'counter', 'hit']) expect(text, `${name} ${trigger}`).toContain(`"${trigger}"`);
    }
  });

  it('an answer with the stub interact trigger is refused on the read path too, where no transport enforces the schema', () => {
    // Přenos Messages schéma odpovědi neposílá (revize hranice fáze P32-0): odmítnout musí i čtení.
    const interact = { interact: { role: 'key', radius: 2, hold: 30, states: 2 } };
    const answer = carryKeyAnswer.answer;
    const composed = composeCompact(carryKeyAnswer.sentence, { ...answer, rules: answer.rules.map((rule, i) => (i === 0 ? { ...rule, when: interact } : rule)) });
    expect(!composed.ok && composed.detail).toContain('/rules/0/when: interact does nothing yet');
    const full = readDirectorAnswer({ ...carryKey, rules: carryKey.rules.map((rule, i) => (i === 0 ? { ...rule, when: interact } : rule)) });
    expect(!full.ok && full.detail).toContain('/rules/0/when: interact does nothing yet');
    // Bez `interact` čtení projde: odmítá se spouštěč, ne pravidla.
    expect(composeCompact(carryKeyAnswer.sentence, answer).ok).toBe(true);
    expect(readDirectorAnswer(carryKey).ok).toBe(true);
  });

  it('the prompt carries the rules grammar, three examples and the only-for-missing-verbs instruction', () => {
    const prompt = compactSystemPrompt();
    expect(prompt).toContain('only for a verb of the sentence the chosen control cannot play');
    for (const effect of ['grab', 'throwHeld', 'push', 'toggle', 'release']) expect(prompt).toContain(effect);
    expect(prompt.match(/"verb":/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it.each(CASES)('%s: a recorded answer composes into a spec with its rules', (_, recorded, fixture) => {
    const read = composeCompact(recorded.sentence, recorded.answer);
    if (!read.ok) throw new Error(`${read.reason}: ${read.detail}`);
    expect(read.spec.rules).toEqual(fixture.rules);
    expect(read.spec.things ?? []).toEqual((fixture as { things?: unknown[] }).things ?? []);
    // Popisek čistí `readGameSpec` (`roleLabel`), soudí se id, druh a počet.
    for (const role of fixture.roles) expect(read.spec.roles).toContainEqual(expect.objectContaining({ id: role.id, kind: role.kind, count: (role as { count?: number }).count ?? 1 }));
    expect(arcadeWorldOf(read.spec, 1).ok).toBe(true);
  });

  it('an answer without rules composes exactly as before', () => {
    const { rules: _rules, ruleRoles: _roles, things: _things, ...plain } = carryKeyAnswer.answer;
    const before = composeCompact(carryKeyAnswer.sentence, plain);
    const empty = composeCompact(carryKeyAnswer.sentence, { ...plain, rules: [], ruleRoles: [], things: [] });
    expect(before.ok).toBe(true);
    expect(empty).toEqual(before);
    if (before.ok) expect(before.spec.rules).toBeUndefined();
  });

  it('rules on the tap-to-move grid are refused, not dropped', () => {
    const read = composeCompact(carryKeyAnswer.sentence, { ...carryKeyAnswer.answer, control: 'tap_go' });
    expect(read.ok).toBe(false);
  });
});
