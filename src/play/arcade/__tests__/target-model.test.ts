import { expect, it } from 'vitest';
import { compileGenre } from '../../genre';
import { fidelityChain } from '../../fidelity/chain';
import { targetModelOf } from '../target-model';

it.each(['spatial', 'station'] as const)('named quest targets are drawn, unknown targets are not (%s)', (mode) => {
  for (const label of ['lantern', 'potion', 'letter', 'zzzxqv']) {
    const spec = compileGenre({ genre: 'quest', mode, hero: 'robot', setting: 'forest', cast: [{ label, does: 'reach', verb: 'paint', states: 2 }] });
    const role = spec.roles.find(role => role.id === 'target')!;
    const model = targetModelOf(spec, role);
    expect(model !== undefined).toBe(label !== 'zzzxqv');
    expect(fidelityChain(spec, [{ item: label, slot: 'role', match: [label] }])[0]).toMatchObject({ inSpec: true, read: true, drawn: label !== 'zzzxqv' });
    expect(targetModelOf(spec, { ...role, id: 'phantom' })).toBeUndefined();
  }
});
