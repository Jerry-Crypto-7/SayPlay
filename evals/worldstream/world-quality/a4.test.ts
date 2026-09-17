import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import surface from '../../reality-compiler/museum.sim.json';
import { buildRuntimeWorld } from '@/ir/build';
import { sealSimHash } from '@/ir/worlddoc';
import { compareAcceptedBranch, prepareBranch } from '@/worldstream/accepted-branch';
import { createRuntimeController } from '@/worldstream/runtime-controller';
import type { TraceInput } from '@/sim/interpreter';
import { qualityRoot, verifyQualityCorpus } from './corpus';

/** Runtime oracles for frozen P20 changes. The shared room is only a test
 * substrate, not a generated scene or a substitute for the live A4 acceptance. */
const cases = [
  { id: 'a01', condition: { kind: 'flagIs', ref: 'key', value: true },
    action: { kind: 'setLocked', target: 'case', value: false }, removeCondition: true,
    key: 'e:case:locked', before: 1, after: 0 },
  { id: 'a02', condition: { kind: 'flagIs', ref: 'switch', value: true },
    nextCondition: { kind: 'flagIs', ref: 'switch', value: false },
    action: { kind: 'setFlag', ref: 'lamp', value: true },
    key: 'f:lamp', before: 0, after: 1 },
  { id: 'a03', condition: { kind: 'counterIs', ref: 'crystals', op: '>=', value: 3 },
    nextCondition: { kind: 'counterIs', ref: 'crystals', op: '>=', value: 1 },
    action: { kind: 'setLocked', target: 'case', value: false }, collect: true,
    key: 'e:case:locked', before: 1, after: 0 },
  { id: 'a04', action: { kind: 'setFlag', ref: 'lamp', value: true },
    nextAction: { kind: 'setFlag', ref: 'lamp', value: false }, lampInitially: true,
    key: 'f:lamp', before: 1, after: 0 },
  { id: 'a05', action: { kind: 'setLocked', target: 'case', value: false },
    nextAction: { kind: 'setLocked', target: 'case', value: true }, gateInitiallyOpen: true,
    key: 'e:case:locked', before: 0, after: 1 },
  { id: 'a07', condition: { kind: 'flagIs', ref: 'helmet', value: true },
    action: { kind: 'setLocked', target: 'case', value: false }, removeCondition: true,
    key: 'e:case:locked', before: 1, after: 0 },
];

describe('frozen P20 non-timer intervention oracles', () => {
  it.each(cases)('$id preserves the fork and produces the specified state difference', (entry) => {
    verifyQualityCorpus();
    const specifications = JSON.parse(readFileSync(`${qualityRoot}a4-cases.json`, 'utf8')) as { id: string; kind: string; horizonTicks: number }[];
    const spec = specifications.find((item) => item.id === entry.id)!;
    expect(spec.kind).not.toBe('timer');
    const target = entry.key.startsWith('e:') ? 'case' : 'sensorA';
    const rule: Record<string, unknown> = {
      event: { kind: 'onAction', actionId: 'activate', target }, actions: [entry.action],
      ...(entry.condition ? { condition: entry.condition } : {}),
    };
    const sim = { ...structuredClone(surface),
      entities: { ...structuredClone(surface.entities), case: { ...surface.entities.case, locked: !entry.gateInitiallyOpen } },
      state: { flags: { key: false, switch: false, lamp: entry.lampInitially ?? false, helmet: false },
        counters: { crystals: { min: 0, max: 3, initial: 0 } }, timers: {}, zones: surface.state.zones },
      rules: { rule, ...(entry.collect ? { collect: {
        event: { kind: 'onAction', actionId: 'collect', target: 'sensorB' },
        actions: [{ kind: 'addCounter', ref: 'crystals', by: 1 }],
      } } : {}) },
    };
    const document = sealSimHash({ irVersion: 'v1', simRevision: 0, lookRevision: 0, sim,
      look: { modules: [], palette: {}, lightRig: {}, atmosphere: {}, materialRoles: {}, camera: {}, audio: {} } });
    const built = buildRuntimeWorld(document.sim);
    if (!built.ok) throw new Error(built.issues.join('; '));
    const trace: TraceInput[] = [
      ...(entry.collect ? [{ tick: 10, actor: 'visitor', actionId: 'collect', target: 'sensorB' }] : []),
      { tick: 20, actor: 'visitor', actionId: 'activate', target },
    ];
    const runtime = createRuntimeController({ ...built.world, trace });
    runtime.observeAt(spec.horizonTicks);
    const original = runtime.getSnapshot();
    const prepared = prepareBranch(document, runtime);
    const draft = structuredClone(document);
    const editedRule = (draft.sim.rules as Record<string, Record<string, unknown>>).rule;
    if (entry.removeCondition) delete editedRule.condition;
    if (entry.nextCondition) editedRule.condition = entry.nextCondition;
    if (entry.nextAction) editedRule.actions = [entry.nextAction];
    const accepted = sealSimHash({ ...draft, simRevision: 1 });
    const compared = compareAcceptedBranch(prepared, accepted, { forkTick: 5, observationTick: spec.horizonTicks });
    expect(compared.verdict).toBe('COMPARED');
    if (compared.verdict !== 'COMPARED') return;
    const result = compared.snapshot.comparison!;
    expect(result.inputLog).toEqual(trace);
    expect(result.changedAtFork.values).toEqual(result.originalAtFork.values);
    expect(result.original.values[entry.key]).toBe(entry.before);
    expect(result.changed.values[entry.key]).toBe(entry.after);
    expect(runtime.getSnapshot()).toBe(original);
    // A second private comparison must produce byte-identical observations.
    const again = compareAcceptedBranch(prepareBranch(document, runtime), accepted, { forkTick: 5, observationTick: spec.horizonTicks });
    expect(again.verdict).toBe('COMPARED');
    if (again.verdict === 'COMPARED') expect(again.snapshot.comparison).toEqual(result);
  });
});

describe('remaining frozen P20 intervention oracles', () => {
  function setup(rules: Record<string, { event: Record<string, unknown>; condition?: unknown; actions: unknown[] }>, trace: TraceInput[], lamp = false) {
    verifyQualityCorpus();
    const sim = { ...structuredClone(surface),
      state: { flags: { left: false, right: false, lamp }, counters: {},
        timers: { countdown: { durationTicks: 400, initial: 0 } }, zones: surface.state.zones },
      rules,
    };
    const document = sealSimHash({ irVersion: 'v1', simRevision: 0, lookRevision: 0, sim,
      look: { modules: [], palette: {}, lightRig: {}, atmosphere: {}, materialRoles: {}, camera: {}, audio: {} } });
    const built = buildRuntimeWorld(document.sim);
    if (!built.ok) throw new Error(built.issues.join('; '));
    const runtime = createRuntimeController({ ...built.world, trace });
    runtime.observeAt(400);
    const original = runtime.getSnapshot();
    return (ruleId: string, action: unknown, observationTick = 400) => {
      const draft = structuredClone(document);
      (draft.sim.rules as typeof rules)[ruleId].actions[0] = action;
      const accepted = sealSimHash({ ...draft, simRevision: 1 });
      const compare = () => compareAcceptedBranch(prepareBranch(document, runtime), accepted,
        { forkTick: 19, observationTick });
      const compared = compare();
      expect(compared.verdict).toBe('COMPARED');
      if (compared.verdict !== 'COMPARED') throw new Error('Comparison rejected');
      const result = compared.snapshot.comparison!;
      expect(result.inputLog).toEqual(trace);
      expect(result.changedAtFork.values).toEqual(result.originalAtFork.values);
      expect(result.changedAtFork.entities).toEqual(result.originalAtFork.entities);
      expect(compare()).toEqual(compared);
      expect(runtime.getSnapshot()).toBe(original);
      return result;
    };
  }

  const button = { kind: 'onAction', actionId: 'activate', target: 'sensorA' };
  const input = { tick: 20, actor: 'visitor', actionId: 'activate', target: 'sensorA' };

  it('a06 changes the target lamp after actual entry onto the plate', () => {
    const compare = setup({ plate: {
      event: { kind: 'onEnterZone', entity: 'visitor', zone: 'sensorA' },
      actions: [{ kind: 'setFlag', ref: 'left', value: true }],
    } }, [{ ...input, actionId: 'moveTo' }]);
    const result = compare('plate', { kind: 'setFlag', ref: 'right', value: true });
    expect(result.original.values).toMatchObject({ 'f:left': 1, 'f:right': 0 });
    expect(result.changed.values).toMatchObject({ 'f:left': 0, 'f:right': 1 });
  });

  it('a08 changes a toggle into always-on and checks both switch uses', () => {
    const compare = setup({
      turnOn: { event: button, condition: { kind: 'flagIs', ref: 'lamp', value: false },
        actions: [{ kind: 'setFlag', ref: 'lamp', value: true }] },
      turnOff: { event: button, condition: { kind: 'flagIs', ref: 'lamp', value: true },
        actions: [{ kind: 'setFlag', ref: 'lamp', value: false }] },
    }, [input, { ...input, tick: 40 }]);
    const action = { kind: 'setFlag', ref: 'lamp', value: true };
    const first = compare('turnOff', action, 30);
    expect(first.original.values['f:lamp']).toBe(1);
    expect(first.changed.values['f:lamp']).toBe(1);
    const second = compare('turnOff', action);
    expect(second.original.values['f:lamp']).toBe(0);
    expect(second.changed.values['f:lamp']).toBe(1);
  });

  it.each([
    { id: 'a09', duration: 100, changed: 40, lamp: false,
      action: { kind: 'setLocked', target: 'case', value: false }, key: 'e:case:locked', before: 1, after: 0 },
    { id: 'a10', duration: 40, changed: 100, lamp: true,
      action: { kind: 'setFlag', ref: 'lamp', value: false }, key: 'f:lamp', before: 0, after: 1 },
  ])('$id observes the difference after 60 ticks, then convergence within the 400-tick horizon', entry => {
    const compare = setup({
      start: { event: button, actions: [{ kind: 'startTimer', ref: 'countdown', durationTicks: entry.duration }] },
      expire: { event: { kind: 'onTimerEnd', timer: 'countdown' }, actions: [entry.action] },
    }, [input], entry.lamp);
    const action = { kind: 'startTimer', ref: 'countdown', durationTicks: entry.changed };
    const result = compare('start', action, input.tick + 60);
    expect(result.original.values[entry.key]).toBe(entry.before);
    expect(result.changed.values[entry.key]).toBe(entry.after);
    const final = compare('start', action);
    expect(final.original.values[entry.key]).toBe(0);
    expect(final.changed.values[entry.key]).toBe(0);
  });
});
