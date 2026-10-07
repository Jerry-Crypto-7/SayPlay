import { describe, expect, it } from 'vitest';

import { canonicalHash } from '@/ir/worlddoc';
import { readGameSpec } from '@/play/spec';

import steer from '../__fixtures__/steer.json';
import { arcadeWorldOf } from '../compile';
import { BODY, HEADER, bodyBase } from '../contract';
import { STEER } from '../pieces/steer';
import { verifyArcade } from '../verify';

// The legacy steer track actually races rivals. Voyage intentionally has a
// different course and must not stand in for this composition.
function combined(seed: number) {
  const spec = readGameSpec({
    ...steer,
    addons: ['shoot', 'chaser'],
    roles: [
      ...steer.roles,
      { id: 'enemy', kind: 'hazard', label: 'zombie' },
      { id: 'chaser', kind: 'chaser', label: 'police car' },
    ],
  });
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const made = arcadeWorldOf(spec.value, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made;
}

describe('P41 T12 steer with shooting and pursuit', () => {
  it.each(Array.from({ length: 20 }, (_, index) => index + 1))('seed %i plays driving, racing, shooting and escape together', seed => {
    const made = combined(seed);
    expect(canonicalHash(combined(seed).world)).toBe(canonicalHash(made.world));
    const verdict = verifyArcade(made.world, undefined, made.roleBindings);
    expect(verdict.failures).toEqual([]);
    expect(verdict.publishEligible).toBe(true);
    expect(verdict.bot.outcome).toBe('won');
    expect(verdict.idle.outcome).toBe('lost');
    expect(verdict.replayEqual).toBe(true);
    expect(verdict.witnesses).toEqual(expect.arrayContaining([
      expect.objectContaining({ verb: 'drive', run: 'winner', actor: expect.objectContaining({ roleId: 'player' }) }),
      expect.objectContaining({ verb: 'race', run: 'winner', evidence: 'overtake', object: expect.objectContaining({ roleId: 'rival' }) }),
      expect.objectContaining({ verb: 'shoot', run: 'winner', evidence: 'projectile-hit', object: expect.objectContaining({ roleId: 'enemy', label: 'zombie' }) }),
      expect.objectContaining({ verb: 'escape', run: 'winner', object: expect.objectContaining({ roleId: 'chaser', label: 'police car' }) }),
      expect.objectContaining({ verb: 'chaser', run: 'probe', actor: expect.objectContaining({ roleId: 'chaser', label: 'police car' }) }),
    ]));
  });

  it('rejects a race whose real rivals outrun even the maximum player speed with ramp and turbo', () => {
    const made = combined(7);
    const initial = [...made.world.initial];
    const rivals = Array.from({ length: initial[HEADER.bodyCount]! }, (_, body) => body)
      .filter(body => made.world.kinds[initial[bodyBase(body) + BODY.kind]!] === 'rival-car');
    expect(rivals.length).toBeGreaterThan(0);
    // 360 is the maximum permitted steer topSpeed; two ramps add 20%,
    // and turbo adds STEER.boost. Alter velocity, not a label or metadata.
    const impossibleSpeed = Math.ceil(360 * 1.2) + STEER.boost + 1000;
    for (const rival of rivals) initial[bodyBase(rival) + BODY.vz] = impossibleSpeed;
    const verdict = verifyArcade({ ...made.world, initial }, undefined, made.roleBindings);
    expect(verdict.bot.outcome).toBe('lost');
    expect(verdict.publishEligible).toBe(false);
    expect(verdict.failures.some(failure => failure.startsWith('bot_wins:'))).toBe(true);
    expect(verdict.witnesses.some(witness => witness.verb === 'race' && witness.run === 'winner')).toBe(false);
  });
});
