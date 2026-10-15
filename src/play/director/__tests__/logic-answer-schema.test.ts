/**
 * Režisér skládá průběh hry (P45B T10): schéma odpovědi nabízí blok `logic`
 * v tvaru, který přijme přísný režim poskytovatele (bez `$ref`/`$defs`, každé
 * pole povinné, `additionalProperties: false`), prompt naroste proti `main`
 * nejvýš o 1 500 znaků a odpověď s logikou se přečte, zkompiluje a ověří
 * skutečným robotem. Vadná logika jde do opravného kola s cestou a hláškou;
 * neprokázaná logika, kterou oprava nespraví, ze hry vypadne i s blokem `logic`.
 */

import { describe, expect, it } from 'vitest';

import { canonicalHash } from '@/ir/worlddoc';

import { arcadeWorldOf } from '../../arcade/compile';
import { phaseEntryOf, withPhaseEntries } from '../../arcade/rules/schema';
import { templateParts } from '../../arcade/rules/templates';
import { verifyArcade } from '../../arcade/verify';
import { type GameSpecV1, readGameSpec } from '../../spec';
import { direct } from '..';
import { genreAnswer } from '../__fixtures__';
import { answered, fakeBranch } from '../__fixtures__/branch';
import { GENRE_ANSWER_SCHEMA } from '../answer-schema';
import { unprovedVerbs, verbIssues } from '../critic';
import { COURSE_LINE, DIRECTOR_PROMPT_VERSION, buildDirectorRequest, directorSystemPrompt } from '../prompt';
import { readGenreAnswer } from '../read';
import type { RepairIssue } from '../repair';

type Json = Record<string, unknown>;

/**
 * `directorSystemPrompt().length` na `main` `0714a352` (před P45B) – 9 921 znaků.
 * Jediná změna promptu od té doby je `rulesPromptLines` (T10): řádek 1 a dva nové
 * řádky logiky. Změřeno 9. 10. nad `git show 0714a352:src/play/director/prompt.ts`.
 */
const MAIN_SYSTEM_PROMPT_CHARS = 9_921;

/**
 * Věta sady režiséra (`director.test.ts`), jejíž trojice robot dosvědčí. Věta s útěkem
 * („escapes a wolf“) tu nejde: Aréna s `ruleRoles` ztratí svědka útěku i bez pravidel
 * a logiky (`ACTION_LOST`, stav z `main`) – test by zkoušel tohle, ne logiku.
 */
const SENTENCE = 'Collect five acorns in a moonlit forest';

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Každý uzel schématu (objekty i prvky polí), do hloubky. */
function nodes(node: unknown, out: Json[] = []): Json[] {
  if (Array.isArray(node)) for (const item of node) nodes(item, out);
  else if (isObject(node)) {
    out.push(node);
    for (const value of Object.values(node)) nodes(value, out);
  }
  return out;
}

const variants = () => ((GENRE_ANSWER_SCHEMA.properties as Json).spec as { anyOf: Json[] }).anyOf;

/** Pravidlo, jak ho model píše v přísném schématu: `if` je vždy, nejvýš `null`. */
const strictRule = (rule: object) => ({ if: null, ...rule });

/** Strážný, kterého šablona `reinforcements` pouští vlnou; v přísném schématu i `count: null`. */
const GUARD = { id: 'guard', kind: 'chaser', label: 'guard', count: null };

/** Útěk v Aréně (vlk, žaludy) s průběhem klid → poplach → vlna strážných ze šablony `reinforcements`. */
function logicAnswer(edit: (rules: Json[]) => Json[] = (rules) => rules) {
  const parts = templateParts('reinforcements', { enemy: 'guard' });
  if (parts === null) throw new Error('reinforcements needs an enemy slot');
  return {
    plan: 'escape the wolf while the guards muster',
    spec: {
      ...genreAnswer().spec,
      ruleRoles: [GUARD],
      things: null,
      logic: { vars: null, timers: null, events: null, ...parts.logic },
      rules: edit(parts.rules.map(strictRule)),
    },
  };
}

/** Robot na seedu 1 jako v publikaci (vzor `critic-rules.test.ts`): selhání nese `LOGIC_UNPROVED:<druh>:<jméno>`. */
function robot(spec: GameSpecV1): RepairIssue[] {
  const made = arcadeWorldOf(spec, 1);
  if (!made.ok) return [{ code: 'WORLD_REJECTED', path: '', evidence: made.issues.join('; '), repairHint: '' }];
  return verifyArcade(made.world).failures.map((failure) => ({ code: 'KEYPOINT_FAILED', path: '/verification/0', evidence: `keypoint failed: ${failure}`, repairHint: 'fix the game or the claim' }));
}

const NOOP = [{ op: 'replace', path: '/title', value: 'Night Watch' }];

async function run(first: object, repairs: readonly unknown[]) {
  let tick = 0;
  const branch = fakeBranch([answered(first), ...repairs.map((body) => answered(body))]);
  const game = await direct(SENTENCE, { branch, now: () => (tick += 100), compact: true, check: robot, maxRepairRounds: 2 });
  return { game, branch };
}

describe('the director answer schema offers logic in strict form', () => {
  it('has no $ref or $defs anywhere', () => {
    const text = JSON.stringify(GENRE_ANSWER_SCHEMA);
    expect(text).not.toContain('"$ref"');
    expect(text).not.toContain('"$defs"');
  });

  it('every object closes its properties and requires every key', () => {
    const objects = nodes(GENRE_ANSWER_SCHEMA).filter((node) => node.type === 'object');
    expect(objects.length).toBeGreaterThan(100);
    for (const node of objects) {
      expect(node.additionalProperties).toBe(false);
      expect([...(node.required as string[])].sort()).toEqual(Object.keys(node.properties as Json).sort());
    }
  });

  it('every variant that offers rules offers logic too, required and nullable, with the whole grammar', () => {
    const withRules = variants().filter((variant) => isObject(variant.properties) && 'rules' in variant.properties);
    expect(withRules.length).toBeGreaterThan(3);
    for (const variant of withRules) {
      const properties = variant.properties as Json;
      expect(variant.required).toContain('logic');
      const logic = properties.logic as { anyOf: Json[] };
      expect(logic.anyOf).toContainEqual({ type: 'null' });
      const declared = logic.anyOf.find((option) => option.type === 'object')!;
      expect(Object.keys(declared.properties as Json).sort()).toEqual(['events', 'phases', 'timers', 'vars']);
      // Spouštěče, podmínky a efekty logiky v gramatice pravidel téže varianty.
      const grammar = JSON.stringify(properties.rules);
      for (const key of ['timer', 'phase', 'phaseExit', 'var', 'event', 'inPhase', 'timerRunning', 'timerStopped', 'set', 'add', 'goPhase', 'startTimer', 'stopTimer', 'emit', 'wave']) {
        expect(grammar, key).toContain(`"${key}"`);
      }
    }
  });
});

describe('the director prompt describes logic within budget', () => {
  it('grows by at most 1 500 characters over main, with one grammar line and one example of a phase, a timer and a wave', () => {
    const system = directorSystemPrompt();
    // Řádek novinek AI verze (P46E T3) má vlastní rozpočet v dalším testu; tenhle hlídá logiku P45B.
    const extras = system.split('\n').filter((line) => line.startsWith('NEW IN YOUR VERSION'));
    const growth = system.length - extras.reduce((sum, line) => sum + line.length + 1, 0) - MAIN_SYSTEM_PROMPT_CHARS;
    expect(growth).toBeGreaterThan(0);
    expect(growth).toBeLessThanOrEqual(1_500);
    const lines = system.split('\n');
    expect(lines.filter((line) => line.startsWith('logic – '))).toHaveLength(1);
    const example = lines.filter((line) => line.startsWith('LOGIC EXAMPLE: '));
    expect(example).toHaveLength(1);
    for (const piece of ['"phases"', '"startTimer"', '"wave"']) expect(example[0]).toContain(piece);
    // Dnešní příklad klíče a dveří zůstává vedle.
    expect(lines.some((line) => line.startsWith('RULE EXAMPLE: '))).toBe(true);
  });

  it('adds boss, abilities and segments in one line of at most 500 characters with one example (P46E T3)', () => {
    const extras = directorSystemPrompt().split('\n').filter((line) => line.startsWith('NEW IN YOUR VERSION'));
    expect(extras).toHaveLength(1);
    expect(extras[0]!.length).toBeLessThanOrEqual(500);
    for (const piece of ['"boss"', '"abilities"', '"segments"', 'EXAMPLE: ']) expect(extras[0]).toContain(piece);
  });

  it('the prompt version hashes the new prompt, the schema and the course line, so the cache keyed by it is invalidated', () => {
    expect(DIRECTOR_PROMPT_VERSION).toBe(canonicalHash({ system: directorSystemPrompt(), schema: GENRE_ANSWER_SCHEMA, course: COURSE_LINE }));
    expect(buildDirectorRequest('Collect five acorns in a moonlit forest', null).user.endsWith(`\n\n${COURSE_LINE}`)).toBe(true);
  });
});

describe('the director composes logic in its answer', () => {
  it('an answer with a phase and a wave is read, compiled and verified with logic_proved', async () => {
    const { game, branch } = await run(logicAnswer(), []);
    expect(branch.calls).toHaveLength(1);
    expect(game).toMatchObject({ source: 'authored', fallbackReason: null, repairRounds: 0 });
    expect(game.spec.logic?.phases?.map((phase) => phase.id)).toEqual(['calm', 'alarm']);
    expect(game.spec.rules?.map((rule) => rule.verb)).toEqual(['sound', 'muster']);
    const made = arcadeWorldOf(game.spec, 1);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.world.runtimeVersion).toBe('arcade-v3');
    const verdict = verifyArcade(made.world);
    expect(verdict.failures).toEqual([]);
    expect(verdict.logic.length).toBeGreaterThan(0);
    expect(verdict.logic.every((proof) => proof.fired && proof.changed)).toBe(true);
  });

  it('the LOGIC EXAMPLE of the prompt is itself a game the robot wins, every phase and timer proved', async () => {
    // P45B T12a: příklad, který robot neprokáže, by model učil hru, kterou ověření odmítne.
    const line = directorSystemPrompt().split('\n').find((text) => text.startsWith('LOGIC EXAMPLE: ')) ?? '';
    const example = JSON.parse(line.slice('LOGIC EXAMPLE: '.length)) as { ruleRoles: Json[]; things: Json[] | null; logic: Json; rules: Json[] };
    const answer = { plan: 'the bats swarm once night falls', spec: { ...genreAnswer().spec, ...example, rules: example.rules.map(strictRule) } };
    const { game, branch } = await run(answer, []);
    expect(branch.calls).toHaveLength(1);
    expect(game).toMatchObject({ source: 'authored', fallbackReason: null, repairRounds: 0 });
    const made = arcadeWorldOf(game.spec, 1);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const verdict = verifyArcade(made.world);
    expect(verdict.failures).toEqual([]);
    expect(verdict.logic.map((proof) => `${proof.kind}:${proof.id}`)).toEqual(expect.arrayContaining(['phase:night', 'timer:dusk', 'wave:swarm']));
    expect(verdict.logic.every((proof) => proof.fired && proof.changed)).toBe(true);
  });

  it('a rule on an undeclared timer goes to the repair round with its path and reason, and the repaired logic is accepted', async () => {
    const ending = strictRule({ id: 'dawn', verb: 'survive', when: { timer: 'nope' }, do: [{ score: 1 }] });
    const valid = logicAnswer().spec.rules.map(({ if: cond, ...rule }) => (cond === null ? rule : { ...rule, if: cond }));
    const { game, branch } = await run(logicAnswer((rules) => [...rules, ending]), [
      [
        { op: 'add', path: '/logic', value: { phases: [{ id: 'calm' }, { id: 'alarm' }] } },
        { op: 'add', path: '/rules', value: valid },
      ],
    ]);
    const sent = branch.calls[1]?.request.user ?? '';
    expect(sent).toContain('RULE_INVALID');
    expect(sent).toMatch(/\/rules\/2\/when\/timer/);
    expect(sent).toContain('unknown timer');
    expect(game).toMatchObject({ source: 'authored', repairRounds: 1 });
    expect(game.spec.logic?.phases?.map((phase) => phase.id)).toEqual(['calm', 'alarm']);
    expect(robot(game.spec)).toEqual([]);
  });

  it('logic the robot never sees, unrepaired, leaves the game with its rules and the logic block', async () => {
    // Poplach po 90 s: robot vyhraje útěk dřív, fáze `alarm` se nikdy nespustí.
    const late = (rules: Json[]) => rules.map((rule) => (rule.id === 'sound' ? { ...rule, when: { every: 5400 } } : rule));
    const { game, branch } = await run(logicAnswer(late), [NOOP, NOOP]);
    const sent = branch.calls[1]?.request.user ?? '';
    expect(sent).toContain('LOGIC_UNPROVED');
    expect(sent).toContain('phase alarm');
    expect(game).toMatchObject({ source: 'authored', fallbackReason: 'VERB_UNPROVED' });
    expect(game.spec.rules).toBeUndefined();
    expect(game.spec.logic).toBeUndefined();
    expect(robot(game.spec)).toEqual([]);
  });
});

describe('the phase entry the read path adds is not the model\'s rule (R6)', () => {
  /**
   * Sběr žaludů s fází `harvest`, na kterou reaguje `cheer`; vstup do ní model nenapsal, doplní ho
   * čtení (`enter_harvest`, sloveso `advance`). `gusty` přidá poryv – časovač, který přežije fázi.
   */
  const harvest = (gusty: boolean) => ({
    plan: 'collect acorns until the harvest',
    spec: {
      ...genreAnswer().spec,
      ruleRoles: null,
      things: null,
      logic: { vars: null, timers: gusty ? [{ id: 'gust' }] : null, events: null, phases: [{ id: 'calm' }, { id: 'harvest' }] },
      rules: [
        strictRule({ id: 'cheer', verb: 'cheer', when: { phase: 'harvest' }, do: [{ score: 5 }] }),
        ...(gusty ? [strictRule({ id: 'wind', verb: 'blow', when: { every: 300 }, do: [{ startTimer: { timer: 'gust', ticks: 120 } }] }), strictRule({ id: 'gust', verb: 'blow', when: { timer: 'gust' }, do: [{ score: 1 }] })] : []),
      ],
    },
  });
  const failed = (evidence: string): RepairIssue[] => [{ code: 'KEYPOINT_FAILED', path: '/verification/0', evidence: `keypoint failed: ${evidence}`, repairHint: 'fix the game or the claim' }];
  /** `reads` = projde `readGameSpec`: hra z vyřazení jde do publikace bez dalšího čtení (nález R6-1). */
  const shape = (spec: GameSpecV1) => ({ rules: (spec.rules ?? []).map((rule) => rule.id), timers: spec.logic?.timers?.map((timer) => timer.id), phases: spec.logic?.phases?.map((phase) => phase.id), reads: readGameSpec(spec).ok });

  /** Hry, které vyřazení dá ověřit, když `said` hlásí nález nad hrou (`null` = žádný). */
  async function dropOut(gusty: boolean, said: (spec: GameSpecV1) => string | null) {
    const seen: ReturnType<typeof shape>[] = [];
    let tick = 0;
    const game = await direct(SENTENCE, {
      branch: fakeBranch([answered(harvest(gusty))]),
      now: () => (tick += 100),
      compact: true,
      maxRepairRounds: 0,
      check: (candidate) => {
        seen.push(shape(candidate));
        const evidence = said(candidate);
        return evidence === null ? [] : failed(evidence);
      },
    });
    return { game, seen };
  }
  const entered = (spec: GameSpecV1) => (spec.rules ?? []).some((rule) => rule.id === 'enter_harvest');
  const inHarvest = (spec: GameSpecV1) => (spec.logic?.phases ?? []).some((phase) => phase.id === 'harvest');

  it('an unproved phase names the model\'s rule that reacts to it, never the added entry', () => {
    const read = readGenreAnswer(harvest(false));
    if (!read.ok) throw new Error(read.detail);
    expect(read.spec.rules?.map((rule) => `${rule.id}:${rule.verb}`)).toEqual(['cheer:cheer', 'enter_harvest:advance']);
    const issues = verbIssues(failed('logic_proved: LOGIC_UNPROVED:phase:harvest – never entered while the bot played'), read.spec);
    expect(issues.map((issue) => `${issue.path} ${issue.evidence}`)).toEqual(['/rules/0 "cheer" phase harvest LOGIC_UNPROVED: never entered while the bot played']);
    expect(unprovedVerbs(issues)).toEqual(['cheer']);
  });

  it('only the exact added shape counts as the entry, a model rule without its inPhase does not', () => {
    const logic = { phases: [{ id: 'calm' }, { id: 'harvest' }] };
    const added = withPhaseEntries([{ id: 'cheer', verb: 'cheer', when: { phase: 'harvest' }, do: [{ score: 5 }] }], logic).at(-1)!;
    expect(phaseEntryOf(added)).toBe('harvest');
    const { if: _if, ...unconditioned } = added;
    expect(phaseEntryOf(unconditioned)).toBeNull();
    expect(phaseEntryOf({ ...added, if: [{ inPhase: 'calm' }, { inPhase: 'calm' }] })).toBeNull();
  });

  it('dropping the rule that reacts to the phase takes the entry and the phase too, and a lone phase left with them', async () => {
    const { game, seen } = await dropOut(true, (spec) => (inHarvest(spec) ? 'logic_proved: LOGIC_UNPROVED:phase:harvest – never entered while the bot played' : null));
    expect(seen[0]).toEqual({ rules: ['cheer', 'wind', 'gust', 'enter_harvest'], timers: ['gust'], phases: ['calm', 'harvest'], reads: true });
    // Fáze `calm` by zbyla sama – schéma chce aspoň dvě, takže odchází i ona; poryv zůstává.
    expect(seen[1]).toEqual({ rules: ['wind', 'gust'], timers: ['gust'], phases: undefined, reads: true });
    expect(readGameSpec(game.spec).ok).toBe(true);
  }, 120_000);

  it('dropping the added entry takes its phase and the rules that react to it', async () => {
    const { seen } = await dropOut(false, (spec) => (entered(spec) ? 'VERB_UNPROVED:advance' : null));
    expect(seen[0]).toEqual({ rules: ['cheer', 'enter_harvest'], timers: undefined, phases: ['calm', 'harvest'], reads: true });
    expect(seen[1]).toEqual({ rules: [], timers: undefined, phases: undefined, reads: true });
  }, 120_000);

  it('a drop-out that leaves a declared event without its listener is never played nor published (R6-2 A)', async () => {
    // `shout` vysílá `boom`, jediný posluchač `hear` neprojde – bez něj by `readGameSpec` hru odmítl.
    const answer = {
      plan: 'collect acorns while the owl hoots',
      spec: {
        ...genreAnswer().spec,
        ruleRoles: null,
        things: null,
        logic: { vars: null, timers: null, events: ['boom'], phases: null },
        rules: [
          strictRule({ id: 'shout', verb: 'shout', when: { every: 30 }, do: [{ emit: 'boom' }, { score: 1 }] }),
          strictRule({ id: 'hear', verb: 'hear', when: { event: 'boom' }, do: [{ score: 0 }] }),
        ],
      },
    };
    const seen: ReturnType<typeof shape>[] = [];
    let tick = 0;
    const game = await direct(SENTENCE, {
      branch: fakeBranch([answered(answer)]),
      now: () => (tick += 100),
      compact: true,
      maxRepairRounds: 0,
      check: (candidate) => {
        seen.push(shape(candidate));
        return (candidate.rules ?? []).some((rule) => rule.id === 'hear') ? failed('VERB_UNPROVED:hear') : [];
      },
    });
    expect(seen.every((candidate) => candidate.reads)).toBe(true);
    expect(game).toMatchObject({ source: 'authored', fallbackReason: 'VERB_UNPROVED' });
    expect(readGameSpec(game.spec).ok).toBe(true);
  }, 120_000);
});
