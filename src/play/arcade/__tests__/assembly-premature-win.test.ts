import { beforeAll, describe, expect, it } from 'vitest';
import { draftGameSpecWithMeta } from '@/play/draft';
import type { GameSpecV1 } from '@/play/spec';
import { arcadeWorldOf } from '../compile';
import { underlyingRule } from '../addons';
import { ARCADE_LIMITS, COUNTER, HEADER, NO_INPUT, type ArcadeState, type ArcadeWorld, type ScoreBonusParams, endBonus, setTargetState } from '../contract';
import { ARCADE_LIBRARY } from '../library';
import { instantiate, loadProgram, outcomeOf, step } from '../kernel';
import { loadRapier } from '../physics/world';
import { losingVerbs } from '../rules/bot';

// Složená hra (P42) vyhraje, až když jsou hotové všechny díly: výhru pravidla
// specu ani dosažené cílové skóre nesmí jádro vyhlásit dřív (nález 4 review P42).
beforeAll(async () => { await loadRapier(); });

const draft = draftGameSpecWithMeta('a penguin slides down a glacier, hops over seals and catches fish').spec;
/** Pravidlo specu, které vyhrává samo po půl sekundě – bez obalu by ukončilo hru před díly. */
type SpecRule = NonNullable<GameSpecV1['rules']>[number];
const early: SpecRule = { id: 'early', verb: 'escape', when: { every: 30 }, do: [{ win: true }] };

function composed(extra: Partial<GameSpecV1>): ArcadeWorld {
  expect(draft.assemblyParts?.length ?? 0).toBeGreaterThan(0);
  const made = arcadeWorldOf({ ...draft, ...extra } as GameSpecV1, 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}
/** Těla dílů složené hry z parametrů `assembly_finish`. */
const partBodies = (world: ArcadeWorld): number[] =>
  (world.rules.find((rule) => rule.id === 'assembly_finish')!.params.parts as { body: number }[]).map((part) => part.body);
function finishParts(world: ArcadeWorld, state: ArcadeState): void {
  for (const body of partBodies(world)) setTargetState(state, body, 2);
}
const counter = (state: ArcadeState, name: keyof typeof COUNTER): number => state[HEADER.counters + COUNTER[name]] as number;

describe('a composed game cannot win before its parts', () => {
  it('(a) a spec rule that wins keeps the game running until the parts are done', () => {
    const world = composed({ rules: [...(draft.rules ?? []), early] });
    const state = instantiate(world);
    const program = loadProgram(world, ARCADE_LIBRARY);
    for (let tick = 0; tick < 45; tick += 1) step(state, NO_INPUT, program);
    expect(outcomeOf(state)).toBe('running');
    finishParts(world, state);
    for (let tick = 0; tick < 3 && outcomeOf(state) === 'running'; tick += 1) step(state, NO_INPUT, program);
    expect(outcomeOf(state)).toBe('won');
  });

  it('(b) reaching the target score keeps the game running until the parts are done', () => {
    const world = composed({ scoring: { target: 5 } });
    const state = instantiate(world);
    const program = loadProgram(world, ARCADE_LIBRARY);
    step(state, NO_INPUT, program);
    state[HEADER.counters + COUNTER.score] = 5;
    for (let tick = 0; tick < 5; tick += 1) step(state, NO_INPUT, program);
    expect(outcomeOf(state)).toBe('running');
    finishParts(world, state);
    for (let tick = 0; tick < 3 && outcomeOf(state) === 'running'; tick += 1) step(state, NO_INPUT, program);
    expect(outcomeOf(state)).toBe('won');
  });

  it('(c) the end bonus of a composed win is the same as an uncomposed one', () => {
    const world = composed({ rules: [...(draft.rules ?? []), early], scoring: {} });
    const program = loadProgram(world, ARCADE_LIBRARY);
    const bonus = world.rules.map(underlyingRule).find((rule) => rule.id === 'score_bonus')!.params as unknown as ScoreBonusParams;
    expect(program.bonus).toEqual(bonus);
    const state = instantiate(world);
    for (let tick = 0; tick < 45; tick += 1) step(state, NO_INPUT, program);
    finishParts(world, state);
    let before = { score: 0, health: 0, tick: 0 };
    while (outcomeOf(state) === 'running') {
      before = { score: counter(state, 'score'), health: counter(state, 'health'), tick: state[HEADER.tick] as number };
      step(state, NO_INPUT, program);
    }
    expect(outcomeOf(state)).toBe('won');
    expect(counter(state, 'score')).toBe(before.score + endBonus(bonus, before.health, before.tick));
    expect(counter(state, 'score')).toBeGreaterThan(before.score);
  });

  it('the bot still reads the wrapped spec rules', () => {
    const drown: SpecRule = { id: 'drown', verb: 'drown', when: { every: 1200 }, do: [{ lose: true }] };
    expect(losingVerbs(composed({ rules: [...(draft.rules ?? []), drown] }))).toContain('drown');
  });

  it('wrapping spec rules and the bonus replaces them, it adds no rule', () => {
    const world = composed({ rules: [...(draft.rules ?? []), early], scoring: {} });
    expect(world.rules.length).toBeLessThanOrEqual(ARCADE_LIMITS.maxRules);
    expect(world.rules.filter((rule) => !rule.id.startsWith('assembly_gate_')).map((rule) => rule.id).sort()).toEqual(['assembly_finish', 'assembly_part']);
    const natives = world.rules.map(underlyingRule);
    expect(natives.filter((rule) => rule.id === 'score_bonus')).toHaveLength(1);
    expect(natives.filter((rule) => rule.params.id === 'early')).toHaveLength(1);
  });
});
