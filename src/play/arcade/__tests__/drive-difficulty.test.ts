import { describe, expect, it } from 'vitest';
import { arcadeWorldOf } from '../compile';
import { AXIS_MAX, BODY, COUNTER, FLAG, HEADER, bodyBase, rampMarks, rampedSpeed } from '../contract';
import { hashArcade, instantiate, loadProgram, replay, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { checkSteerLevel, steerSegments, steerTrack } from '../pieces/steer';
import { assemblyOfCell, liveCells } from '../../compose/allowed';
import { compileRecipe } from '../../compose/compile';

function spec(crashBudget?: number) {
  const assembly = assemblyOfCell(liveCells().find(cell => cell.id === 'drive.reach')!);
  return compileRecipe({ ...assembly, content: { ...assembly.content, params: { lengthM: 700, roadWidth: 3600, roadEntryWidth: 4000, ...(crashBudget === undefined ? {} : { crashBudget }) } } });
}

describe('opt-in drive difficulty is physical', () => {
  it.each([1, 7, 20])('narrows actual sections while remaining geometrically playable: seed %i', seed => {
    const params = steerTrack.params.parse({ lengthM: 700, roadWidth: 3600, roadEntryWidth: 10000, crashBudget: 1 });
    const level = steerTrack.generate(seed, params);
    expect(checkSteerLevel(level, params.topSpeed)).toEqual([]);
    const widths = steerSegments(level).map(segment => segment.width);
    expect([...new Set(widths)]).toEqual([10000, 3800, 3600]);
    expect(rampedSpeed(params.topSpeed, 0, rampMarks(level.length))).toBeLessThan(rampedSpeed(params.topSpeed, level.length, rampMarks(level.length)));
  });

  it('an actual barrier contact consumes health, keeps the wall and exactly replays', () => {
    const made = arcadeWorldOf(spec(2), 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    const world = made.world, state = instantiate(world), program = loadProgram(world, ARCADE_LIBRARY);
    const inputs = [];
    for (let tick = 0; tick < 120 && state[HEADER.counters + COUNTER.health] === 2; tick++) {
      const input = { tick, buttons: 0, axis: AXIS_MAX };
      inputs.push(input); step(state, input, program);
    }
    expect(state[HEADER.counters + COUNTER.health]).toBe(1);
    for (let i = 0; i < state[HEADER.bodyCount]; i++) {
      const b = bodyBase(i);
      if (world.kinds[state[b + BODY.kind]] === 'tire-barrier') expect(state[b + BODY.flags] & FLAG.alive).not.toBe(0);
    }
    expect(replay(world, inputs, ARCADE_LIBRARY, state[HEADER.tick]).hash).toBe(hashArcade(state));
  });

  it('does not install damage without the opt-in budget', () => {
    const made = arcadeWorldOf(spec(), 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    expect(made.world.rules.some(rule => rule.id === 'steer_crash')).toBe(false);
  });
});
