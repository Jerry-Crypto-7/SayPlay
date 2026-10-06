import { beforeAll, expect, it } from 'vitest';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { loadRapier } from '@/play/arcade/physics/world';
import { verifyArcade } from '@/play/arcade/verify';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { instantiate, loadProgram, replay, step } from '@/play/arcade/kernel';
import { BODY, COUNTER, FLAG, HEADER, NO_INPUT, ROLE, bodyBase } from '@/play/arcade/contract';
import { releasePhysics } from '@/play/arcade/physics/step';
import { ALLOWED, assemblyOfCell } from '../allowed';
import { compileRecipe } from '../compile';

beforeAll(async () => { await loadRapier(); });
it('wins by physically tipping pins with the launched sphere, with identity and replay evidence', () => {
  const cell = ALLOWED.find(cell => cell.id === 'ball.defeat')!;
  const spec = compileRecipe(assemblyOfCell(cell));
  for (const seed of [1, 2, 3, 4, 5]) {
    const made = arcadeWorldOf(spec, seed);
    if (!made.ok) throw new Error(made.issues.join('; '));
    const verdict = verifyArcade(made.world, undefined, made.roleBindings);
    expect(verdict.failures, `seed ${seed}`).toEqual([]);
    expect(verdict.replayEqual).toBe(true);
    expect(verdict.witnesses).toContainEqual(expect.objectContaining({ verb: 'defeat', evidence: 'physical-pin-knocked-down', object: expect.objectContaining({ label: 'pin' }) }));
    expect(verdict.witnesses.some(w => w.verb === 'ball')).toBe(true);
  }
}, 120000);

it('requires every pin and cannot win without a physical launch', () => {
  const assembly = assemblyOfCell(ALLOWED.find(cell => cell.id === 'ball.defeat')!);
  const spec = compileRecipe({ ...assembly, content: { ...assembly.content, counts: { target: 3 } } });
  const made = arcadeWorldOf(spec, 7);
  if (!made.ok) throw new Error(made.issues.join('; '));
  const verdict = verifyArcade(made.world, undefined, made.roleBindings);
  expect(verdict.failures).toEqual([]);
  // Witnesses deduplicate by role identity; check each physical body separately.
  const state = instantiate(made.world), program = loadProgram(made.world, ARCADE_LIBRARY);
  const events = new Map(verdict.bot.inputs.map(input => [input.tick, input]));
  try {
    for (let tick = 0; tick < verdict.bot.tick; tick++) step(state, events.get(tick) ?? NO_INPUT, program);
    expect(state[HEADER.counters + COUNTER.score]).toBe(3);
    for (let body = 0; body < state[HEADER.bodyCount]!; body++) {
      const b = bodyBase(body);
      if (state[b + BODY.role] === ROLE.target) expect(state[b + BODY.flags]! & FLAG.alive).toBe(0);
    }
  } finally { releasePhysics(state); }
  const idle = replay(made.world, [], ARCADE_LIBRARY);
  expect(idle.outcome).toBe('lost');
  const noBall = { ...made.world, rules: made.world.rules.filter(rule => rule.id !== 'ball_launch') };
  expect(replay(noBall, verdict.bot.inputs, ARCADE_LIBRARY).outcome).toBe('lost');
});
