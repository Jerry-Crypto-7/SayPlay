import { describe, expect, it } from 'vitest';
import surface from '../../../evals/reality-compiler/museum.sim.json';
import { buildRuntimeWorld } from '@/ir/build';
import { createRuntimeController } from '../runtime-controller';

function setup(blocked = false) {
  const built = buildRuntimeWorld(surface);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return createRuntimeController({ ...built.world, trace: [], space: { ...built.world.space,
    blocked: blocked ? [[4, 1]] : [] } });
}
const activate = (target: string) => ({ actor: 'visitor', actionId: 'activate', target });
const move = { actor: 'visitor', actionId: 'moveTo', target: 'approachB' };

describe('visitor inputs through the sole runtime', () => {
  it('rejects remote activation in the engine, then walks and unlocks with the actual rule ID', () => {
    const c = setup();
    expect(c.dispatch(activate('sensorA'))).toMatchObject({ ok: true, tick: 0, ruleIds: ['start_countdown'] });
    expect(c.dispatch(activate('sensorB'))).toMatchObject({ ok: true, tick: 1, ruleIds: [] });
    expect(c.getSnapshot().values['e:case:locked']).toBe(1);
    expect(c.dispatch(move)).toMatchObject({ ruleIds: ['sys.moveTo.approachB'] });
    expect(c.getSnapshot().entities.find(e => e.stableId === 'visitor')!.x).toBeLessThan(7);
    c.advanceTicks(15);
    expect(c.getSnapshot().entities.find(e => e.stableId === 'visitor')!.x).toBe(7);
    expect(c.dispatch(activate('sensorB'))).toMatchObject({ ruleIds: ['unlock_case'] });
    expect(c.getSnapshot().values).toMatchObject({ 'e:case:locked': 0, 'f:alarm': 0 });
    const final = c.getSnapshot().values;
    c.advanceTicks(700);
    c.observeAt(0);
    expect(c.dispatch(move).ok).toBe(false);
    c.observeAt(719);
    expect(c.getSnapshot().values).toEqual(final);
    expect(c.getInputLog()).toHaveLength(4);
  });

  it('blocked movement cannot unlock remotely and expiration reports its own rule', () => {
    const c = setup(true);
    c.dispatch(activate('sensorA'));
    c.dispatch(move);
    c.advanceTicks(20);
    expect(c.getSnapshot().entities.find(e => e.stableId === 'visitor')!.x).toBe(3);
    expect(c.dispatch(activate('sensorB'))).toMatchObject({ ruleIds: [] });
    c.observeAt(400);
    expect(c.getSnapshot().values['f:alarm']).toBe(0);
    c.advanceTicks(1);
    expect(c.getSnapshot().values).toMatchObject({ 'f:alarm': 1, 'e:case:locked': 1 });
    expect(c.getSnapshot().transitions).toContainEqual({ tick: 400, inputs: [], ruleIds: ['expire_countdown'] });
  });

  it('does not mutate paused state or accept invented input', () => {
    const c = setup();
    expect(c.dispatch(activate('missing')).ok).toBe(false);
    c.setPaused(true);
    const before = c.getSnapshot();
    expect(c.dispatch(move).ok).toBe(false);
    expect(c.getSnapshot()).toBe(before);
    expect(c.getInputLog()).toEqual([]);
    c.setPaused(false);
    expect(c.dispatch(activate('sensorA')).ok).toBe(true);
  });
});
