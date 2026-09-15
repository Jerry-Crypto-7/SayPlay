import { expect, it } from 'vitest';
import { buildRuntimeWorld } from '../../ir/build';
import { SOURCE_SYNTAX_EXAMPLE } from '../source-surface-guide';
import { createRuntimeController } from '../../worldstream/runtime-controller';

it('the documented syntax compiles and actually opens, then closes its example gate', () => {
  const built = buildRuntimeWorld(SOURCE_SYNTAX_EXAMPLE);
  expect(built.ok, JSON.stringify(built)).toBe(true);
  if (!built.ok) return;
  const runtime = createRuntimeController({ ...built.world, trace: [] });
  expect(runtime.dispatch({ actor: 'operator', actionId: 'press', target: 'button' }).ok).toBe(true);
  expect(runtime.getSnapshot().values['e:gate:locked']).toBe(0);
  runtime.advanceTicks(41);
  expect(runtime.getSnapshot().values['e:gate:locked']).toBe(1);
});
