import { describe, expect, it } from 'vitest';
import worlds from '../__fixtures__/hybrid-live-onclick-worlds.json';
import { buildRuntimeWorld } from '@/ir/build';
import { inputAlphabet } from '@/verify/solve';
import { verifyWitness } from '@/verify/witness';
import { createRuntimeController } from '@/worldstream/runtime-controller';
import { repairEmission } from '../repair';
import { buildRepairRequest, type BlueprintFault } from '../worldstream-repair';

function lower(world: unknown) {
  const repaired = repairEmission(world);
  const result = buildRuntimeWorld((repaired.document as { sim: unknown }).sim);
  if (!result.ok) throw new Error(result.issues.join('; '));
  return result.world;
}
describe('2026-09-17 live onClick regression (two archived compiler worlds)', () => {
  it.each(worlds.map((world, attempt) => ({ world, attempt: attempt + 1 })))('keeps attempt $attempt rejected and explains the missing input producer', ({ world }) => {
    const runtime = lower(world);
    expect(inputAlphabet(runtime, 'firstPerson').every(move => move.actionId === 'moveTo')).toBe(true);
    expect(createRuntimeController(runtime).actions.every(move => move.actionId === 'moveTo')).toBe(true);
    const verdict = verifyWitness(runtime, runtime.trace);
    expect(verdict).toMatchObject({ verdict: 'REJECTED', reason: 'NO_WIN' });
    if (verdict.verdict !== 'REJECTED') throw new Error('Expected the historical failure.');
    const fault: BlueprintFault = { reason: 'WORLD_REJECTED', detail: verdict.detail, issues: [],
      world: { rejection: { ...verdict, stage: 'witness', issues: [] }, context: { witness: [], horizonTicks: 600 } } };
    const previous = { world }; const before = JSON.stringify(previous);
    const feedback = buildRepairRequest({ model: 'test', system: 'system', user: 'original brief' }, previous, fault);
    expect(feedback.user).toContain('INPUT_CONTRACT');
    expect(feedback.user).toContain('onAction/acted, not clicked');
    expect(feedback.user).toContain('"actor":"firstPerson"');
    expect(feedback.user).toContain('"target":"computerTerminal"');
    expect(feedback.user).toContain('do not add an unconditional win or increase the horizon');
    expect(JSON.stringify(previous)).toBe(before);
  });
  it.each(worlds.map((world, attempt) => ({ world, attempt: attempt + 1 })))('explicit input contract fixes attempt $attempt without changing its effects', ({ world }) => {
    const edited = structuredClone(world);
    for (const rule of Object.values(edited.sim.rules)) if (rule.event.kind === 'onClick')
      Object.assign(rule, { event: { kind: 'onAction', actor: 'firstPerson', actionId: 'activate', target: 'computerTerminal' } });
    const built = lower(edited);
    expect(verifyWitness(built, built.trace).verdict).toBe('CERTIFIED');
    expect(built.trace).toHaveLength(1);
    const runtime = createRuntimeController(built); runtime.observeAt(5);
    expect(runtime.getSnapshot()).toMatchObject({ runState: 'won', values: { 'f:signalOn': 1 } });
    expect(edited.sim.rules.activateSignal.actions).toEqual(world.sim.rules.activateSignal.actions);
    expect(edited.sim.rules.win.actions).toEqual(world.sim.rules.win.actions);
    expect(edited.look).toEqual(world.look);
  });
});
