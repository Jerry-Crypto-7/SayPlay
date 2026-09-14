import { describe, expect, it } from 'vitest';
import type { Operation } from 'rfc6902';
import { hasUnsupportedMotion } from '../worldstream-capabilities';

const entity = { type: 'actor', motion: { kind: 'sway' } };
const world = { sim: { entities: { 'mast/one': entity } } };
describe('unsupported legacy entity motion paths', () => {
  it('detects motion copied from a value staged by an earlier operation', () => {
    const initial = { sim: { entities: { mast: { type: 'actor' } } } };
    const operations: Operation[] = [
      { op: 'add', path: '/sim/entities/mast/staged', value: entity },
      { op: 'copy', from: '/sim/entities/mast/staged', path: '/sim/entities/mast' },
    ];
    expect(hasUnsupportedMotion({ behavior: operations }, initial)).toBe(true);
    expect(initial).toEqual({ sim: { entities: { mast: { type: 'actor' } } } });
    expect(operations[0]).toEqual({ op: 'add', path: '/sim/entities/mast/staged', value: entity });
  });
  it('detects motion copied out of an existing array', () => {
    const initial = { sim: { entities: { mast: { type: 'actor', staged: [entity] } } } };
    expect(hasUnsupportedMotion({ behavior: [
      { op: 'copy', from: '/sim/entities/mast/staged/0', path: '/sim/entities/mast' },
    ] }, initial)).toBe(true);
  });
  it.each<Operation>([
    { op: 'add', path: '/sim/entities/mast/motion', value: { kind: 'sway' } },
    { op: 'replace', path: '/sim/entities/mast/motion/amplitude', value: 1 },
    { op: 'remove', path: '/sim/entities/mast/motion' },
    { op: 'add', path: '/sim/entities/mast', value: entity },
    { op: 'replace', path: '/sim/entities', value: { mast: entity } },
    { op: 'replace', path: '/sim', value: world.sim },
    { op: 'copy', path: '/sim/entities/mast', from: '/sim/entities/mast~1one' },
    { op: 'move', path: '/sim/entities/mast', from: '/sim/entities/mast~1one' },
    { op: 'copy', path: '/sim/entities/mast/state', from: '/sim/entities/mast~1one/motion' },
  ])('recognizes $op $path including ancestor/copy values', operation => {
    expect(hasUnsupportedMotion({ behavior: [operation] }, world)).toBe(true);
  });
  it.each<Operation>([
    { op: 'replace', path: '/sim/entities/mast/state', value: 'moving' },
    { op: 'remove', path: '/sim/entities/mast~1one' },
    { op: 'add', path: '/sim/rules/motion', value: { actions: [{ kind: 'moveTo' }] } },
    { op: 'replace', path: '/sim/entities', value: {} },
  ])('does not reject supported entity/rule operations: $path', operation => {
    expect(hasUnsupportedMotion({ behavior: [operation] }, world)).toBe(false);
  });
  it('leaves malformed from validation to the patch gate without crashing', () => {
    expect(hasUnsupportedMotion({ behavior: [{ op: 'move', path: '/sim/entities/mast/state', from: 7 } as unknown as Operation] }, world)).toBe(false);
  });
});
