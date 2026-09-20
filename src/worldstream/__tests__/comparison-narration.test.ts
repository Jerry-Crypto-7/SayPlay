import { describe, it, expect } from 'vitest';
import { a4Specs, a4Fixture, runA4Intervention, type A4Fixture } from '../../../evals/worldstream/world-quality/a4-fixtures';
import { narrateComparison } from '../comparison-narration';
import type { BranchComparison } from '../branch-controller';

/** Osm netimerových případů A4 přes stejnou commit/replay cestu jako HTTP route; model nahrazuje lokální orákulum. */
async function compared(fixture: A4Fixture) {
  const { stableId: _target, ...answer } = fixture.oracle;
  const result = await runA4Intervention(fixture, async () => answer);
  expect(result.status, JSON.stringify(result)).toBe('passed');
  return result.comparisons!.map(entry => ({ tick: entry.tick, comparison: entry.result! as BranchComparison }));
}
const names = (fixture: A4Fixture) => Object.fromEntries(fixture.blueprint.objects.map(o => [o.stableId, o.label]));
const specs = a4Specs().filter(spec => spec.kind !== 'timer');

describe('narrateComparison writes the two futures from the state diff', () => {
  it.each(specs)('$id: one to three English sentences, ending with the named slot differences', async spec => {
    const fixture = a4Fixture(spec);
    const [{ comparison }] = (await compared(fixture)).filter(entry => entry.tick === 400);
    const lines = narrateComparison(comparison, names(fixture));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.length).toBeLessThanOrEqual(3);
    for (const line of lines) expect(line).toMatch(/^[A-Z].*\.$/);
    expect(lines[0]).toBe('Both futures never won within 400 ticks.');
    expect(lines.join(' ')).not.toContain('No difference');
    // Rozchod přijde až s rozhodující akcí, ne s první akcí ve stopě: a03 sbírá krystal už v tiku 10,
    // a06 vstoupí do zóny dva tiky po `moveTo`, a08 mění `turnOff`, které střílí až na druhé stisknutí.
    expect(lines[1]).toBe(`The futures first part at tick ${{ a06: 22, a08: 40 }[spec.id] ?? 20}.`);
    expect(lines).toHaveLength(3);
    for (const id of Object.keys(fixture.observations[0].original)) {
      expect(lines[2]).not.toContain(id);
    }
  });

  it('names the entity from the blueprint and reads locked and flag slots as words', async () => {
    const byId = Object.fromEntries(specs.map(spec => [spec.id, a4Fixture(spec)]));
    const [a01] = await compared(byId.a01);
    expect(narrateComparison(a01.comparison, names(byId.a01))[2]).toBe('Biggest differences at tick 400: Gate / door / hatch locked → unlocked.');
    const [a02] = await compared(byId.a02);
    expect(narrateComparison(a02.comparison, names(byId.a02))[2]).toBe('Biggest differences at tick 400: lamp off → on.');
    const [a06] = (await compared(byId.a06)).filter(entry => entry.tick === 400);
    expect(narrateComparison(a06.comparison, names(byId.a06))[2]).toBe('Biggest differences at tick 400: left on → off; right off → on.');
    // Bez blueprintu (zdrojový projekt) zůstává stabilní ID entity.
    expect(narrateComparison(a01.comparison, {})[2]).toBe('Biggest differences at tick 400: case locked → unlocked.');
  });

  it('says "No difference" while the hashes are equal, even though the documents differ', async () => {
    const fixture = a4Fixture(specs.find(spec => spec.id === 'a08')!);
    const [early] = (await compared(fixture)).filter(entry => entry.tick === 30);
    expect(early.comparison.original.stateHash).toBe(early.comparison.changed.stateHash);
    const lines = narrateComparison(early.comparison, names(fixture));
    expect(lines).toEqual(['Both futures never won within 30 ticks.', 'No difference: both futures reach the same state at tick 30.']);
    expect(lines.join(' ')).not.toContain('→');
  });

  it('reports the outcome and its tick for each future', () => {
    const snapshot = (runState: 'won' | 'lost' | 'running', tick: number, hash: string) => ({
      stateHash: hash, observationTick: 400, tick, endedAtTick: runState === 'running' ? null : tick, paused: false,
      runState, entities: [], values: { 'f:done': runState === 'won' ? 1 : 0 },
      transitions: [{ tick: 12, inputs: [], ruleIds: ['finish'] }], canInput: false });
    const comparison = { ruleId: 'finish', forkTick: 5, observationTick: 400,
      original: snapshot('won', 340, 'a'), changed: snapshot('running', 400, 'b') } as unknown as BranchComparison;
    expect(narrateComparison(comparison, {})).toEqual([
      'The original future won at tick 340; the changed future never won within 400 ticks.',
      'The futures first part at tick 12.',
      'Biggest differences at tick 400: done on → off.']);
    const lost = { ...comparison, changed: snapshot('lost', 77, 'b') } as unknown as BranchComparison;
    expect(narrateComparison(lost, {})[0]).toBe('The original future won at tick 340; the changed future lost at tick 77.');
  });

  it('is deterministic', async () => {
    const fixture = a4Fixture(specs[0]);
    const [{ comparison }] = await compared(fixture);
    expect(narrateComparison(comparison, names(fixture))).toEqual(narrateComparison(comparison, names(fixture)));
  });
});
