import { beforeAll, describe, expect, it } from 'vitest';
import { draftGameSpecWithMeta } from '@/play/draft';
import { arcadeWorldOf } from '../compile';
import { underlyingRule } from '../addons';
import type { GameSpecV1 } from '@/play/spec';
import { ARCADE_HZ, ARCADE_LIMITS, NO_INPUT, type ArcadeWorld, type PieceRef, logicBase, phaseOf, varValue } from '../contract';
import { patchProblem, startLive, stepLive } from '../live';
import { verifyArcade } from '../verify';
import { loadRapier } from '../physics/world';

// Složená hra (P42) balí nativní pravidla do `assembly_gate_*`; hledání podle id
// na straně simulace (skóre, živé úpravy, ověření) musí najít pravidlo pod obalem.
beforeAll(async () => { await loadRapier(); });

function composed(sentence: string): ArcadeWorld {
  const { spec } = draftGameSpecWithMeta(sentence);
  expect(spec.assemblyParts?.length ?? 0).toBeGreaterThan(0);
  const made = arcadeWorldOf({ ...spec, scoring: spec.scoring ?? {} }, 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}
const gated = (world: ArcadeWorld, id: string): PieceRef => {
  const ref = world.rules.find((rule) => rule.id.startsWith('assembly_gate_') && underlyingRule(rule).id === id);
  expect(ref, `${id} wrapped in a gate`).toBeDefined();
  return ref!;
};

describe('gated native rules on the sim side', () => {
  it('scoring adds the combo to a wrapped pickup', () => {
    const world = composed('a penguin slides down a glacier, hops over seals and catches fish');
    expect(underlyingRule(gated(world, 'pickup')).params.combo).toEqual(expect.any(Number));
  });

  it('the score bonus and live patches find a wrapped clock, lives and waves', () => {
    const world = composed('a knight grabs coins in a castle and rescues a princess before time runs out');
    const seconds = underlyingRule(gated(world, 'time_limit')).params.seconds as number;
    const bonus = world.rules.map(underlyingRule).find((rule) => rule.id === 'score_bonus')!;
    expect(bonus.params.limit).toBe(Math.min(ARCADE_LIMITS.maxTicks, seconds * ARCADE_HZ));
    expect(bonus.params.limit).toBeLessThan(ARCADE_LIMITS.maxTicks);

    gated(world, 'out_of_health');
    const run = startLive(world);
    expect(patchProblem(world, run.state, { kind: 'count', counter: 'time', amount: 10 })).toBeNull();
    expect(patchProblem(world, run.state, { kind: 'count', counter: 'health', amount: 1 })).toBeNull();
    // Vlny arény: čítač nábojů je číslo vlny, takže náboje nejdou přidat ani v obalu.
    gated(world, 'arena_waves');
    expect(patchProblem(world, run.state, { kind: 'count', counter: 'ammo', amount: 5 })).toBe('This game has no ammo.');

    // Dvakrát po 30 s přes strop schématu (90 s): jádro dál běží a hodiny se posunou.
    stepLive(world, run, NO_INPUT, [{ kind: 'count', counter: 'time', amount: 30 }]);
    stepLive(world, run, NO_INPUT, [{ kind: 'count', counter: 'time', amount: 30 }]);
    for (let tick = 0; tick < 5; tick += 1) stepLive(world, run, NO_INPUT, []);
    const clocks = run.program.rules.map((rule) => ({ id: rule.piece.id, params: rule.params as PieceRef['params'] })).filter((ref) => underlyingRule(ref).id === 'time_limit');
    expect(clocks).toHaveLength(1);
    expect(underlyingRule(clocks[0]!).params.seconds).toBe(seconds + 60);
  });

  it('verify proves a wrapped interact verb by the target state only', () => {
    const world = composed('fix the broken lamps in the lighthouse and dodge the falling rocks');
    const verb = underlyingRule(gated(world, 'interact')).params.verb as string;
    const proof = verifyArcade(world).verbs.find((item) => item.verb === verb);
    expect(proof?.changed).toBe(true);
    expect(proof?.evidence).toMatch(/now in state/);
  });
});

// P45B R1: časovač, fáze a událost obal `assembly_gate_*` nemají. Pravidlo bez výhry hraje vedle
// dílů beze změny; výhru by obal nepodržel, takže ji složená hra odmítne s důvodem.
describe('logic rules in a composed game', () => {
  const PENGUIN = 'a penguin slides down a glacier, hops over seals and catches fish';
  const withLogic = (rules: NonNullable<GameSpecV1['rules']>): GameSpecV1 => {
    const { spec } = draftGameSpecWithMeta(PENGUIN);
    expect(spec.assemblyParts?.length ?? 0).toBeGreaterThan(0);
    return { ...spec, rules: [...(spec.rules ?? []), ...rules], logic: { vars: [{ id: 'rang' }], timers: [{ id: 'fuse' }], phases: [{ id: 'calm' }, { id: 'rush' }] } };
  };

  it('a timer started every second rings its rule on time – var rang 0 → 1 by tick 61, the timer rule sits outside the gate', () => {
    const made = arcadeWorldOf(withLogic([
      { id: 'light', verb: 'light', when: { every: 30 }, if: [{ timerStopped: 'fuse' }], do: [{ startTimer: { timer: 'fuse', ticks: 30 } }] },
      { id: 'ring', verb: 'ring', when: { timer: 'fuse' }, do: [{ add: { var: 'rang', amount: 1 } }, { goPhase: 'rush' }] },
    ]), 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    const world = made.world;
    // Spouštěč s obalem (`every` = tik) se dál balí, časovač ne.
    expect(world.rules.some((rule) => rule.id === 'assembly_gate_tick' && underlyingRule(rule).params.id === 'light')).toBe(true);
    expect(world.rules.find((rule) => rule.id === 'rule_timer')?.params.id).toBe('ring');
    const run = startLive(world);
    const rang: number[] = [];
    for (let tick = 0; tick < 62; tick += 1) {
      stepLive(world, run, NO_INPUT, []);
      rang.push(varValue(run.state, logicBase(run.state), 0));
    }
    expect(rang[58]).toBe(0);
    expect(rang.indexOf(1)).toBeGreaterThan(58);
    expect(rang.at(-1)).toBe(1);
    expect(phaseOf(run.state, logicBase(run.state))).toBe(1);
  });

  it('a rule that wins on a timer is refused with the rule id – its win could not wait for the parts', () => {
    const made = arcadeWorldOf(withLogic([
      { id: 'light', verb: 'light', when: { every: 30 }, do: [{ startTimer: { timer: 'fuse', ticks: 30 } }] },
      { id: 'ring', verb: 'ring', when: { timer: 'fuse' }, do: [{ add: { var: 'rang', amount: 1 } }] },
      { id: 'calm', verb: 'calm', when: { phase: 'calm' }, do: [{ win: true }] },
    ]), 1);
    expect(made.ok).toBe(false);
    if (made.ok) return;
    expect(made.issues).toEqual([expect.stringMatching(/^rules: rule "calm" wins on a phase trigger.*composed game/)]);
  });
});
