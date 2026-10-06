import { expect, it } from 'vitest';
import runner from '../arcade/__fixtures__/runner.json';
import { CONTROLS, readGameSpec } from '../spec';
import { compileArcade } from '../arcade/compile';

it('retains every control used by pre-P41 saved games', () => {
  for (const control of ['tap_go', 'runner', 'platform', 'flap', 'steer', 'move_free', 'shooter', 'throw', 'timing', 'rhythm', 'duel']) {
    expect(CONTROLS).toContain(control);
  }
});

it.each([
  ['glide', { mode: 'race', lengthM: 160, topSpeed: 180 }],
  ['walker', { size: 11, speed: 110 }],
  ['ball', { goal: 'hoop', keeper: true, targets: 2 }],
] as const)('reads %s without silently compiling a runner', (control, controlParams) => {
  const read = readGameSpec({ ...runner, control, controlParams, mechanics: [] });
  expect(read.ok, JSON.stringify(read)).toBe(true);
  if (!read.ok) return;
  expect(read.value.control).toBe(control);
  expect(read.value.controlParams).toEqual(controlParams);
  const compiled = compileArcade(read.value, 1);
  if (control === 'glide') {
    expect(compiled.ok, JSON.stringify(compiled)).toBe(true);
    return;
  }
  expect(compiled.ok).toBe(false);
  if (!compiled.ok) expect(compiled.issues.join(' ')).toContain(`native ${control} runtime is not registered`);
});

it.each([
  ['glide', { topSpeed: 241 }], ['glide', { mode: 'teleport' }],
  ['walker', { size: 10 }], ['walker', { speed: 1000 }],
  ['ball', { goal: 'net' }], ['ball', { targets: 6 }],
] as const)('rejects invalid %s parameters %j', (control, controlParams) => {
  expect(readGameSpec({ ...runner, control, controlParams }).ok).toBe(false);
});

it('does not inject parameters when none were stored', () => {
  const { controlParams: _params, ...input } = runner;
  for (const control of ['glide', 'walker', 'ball']) {
    const read = readGameSpec({ ...input, control, mechanics: [] });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.controlParams).toBeUndefined();
  }
});
