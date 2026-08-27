import { describe, expect, it } from 'vitest';

import { buildEmissionRequest, EXAMPLE_MARKER } from '../../prompt';
import { deriveCollisionAabb } from '../aabb';
import { emitLocally, localGrammar } from '../emit';
import { LARGE_MODEL, type ChatEngine } from '../engine';

const EXAMPLE_WORLD = (() => {
  const system = buildEmissionRequest('anything', localGrammar()).system;
  const at = system.indexOf(EXAMPLE_MARKER);
  return JSON.parse(system.slice(system.indexOf('{', at))) as {
    readonly sim: Record<string, unknown>;
    readonly [key: string]: unknown;
  };
})();

function scriptedEngine(raw: string): ChatEngine {
  return {
    modelId: LARGE_MODEL,
    complete: () => Promise.resolve({ raw, finishReason: 'stop' }),
    unload: () => Promise.resolve(),
  };
}

describe('deriveCollisionAabb', () => {
  it('derives one unit box per entity from its socket when the field is missing', () => {
    const { collisionAabb: _missing, ...withoutAabb } = EXAMPLE_WORLD.sim;

    expect(deriveCollisionAabb(withoutAabb).collisionAabb).toEqual({
      player: [1, 4, 1, 1],
      card: [3, 4, 1, 1],
      lever: [5, 4, 1, 1],
      gate: [10, 4, 1, 1],
    });
  });

  it('replaces a malformed field instead of carrying it into certification', () => {
    const malformed = { ...EXAMPLE_WORLD.sim, collisionAabb: { player: [1, 4, 1] } };

    expect(deriveCollisionAabb(malformed).collisionAabb).toEqual({
      player: [1, 4, 1, 1],
      card: [3, 4, 1, 1],
      lever: [5, 4, 1, 1],
      gate: [10, 4, 1, 1],
    });
  });

  it('does not overwrite a complete valid box map supplied by the model', () => {
    const collisionAabb = {
      ...(EXAMPLE_WORLD.sim.collisionAabb as Record<string, unknown>),
      gate: [9, 3, 2, 4],
    };
    const supplied = { ...EXAMPLE_WORLD.sim, collisionAabb };

    expect(deriveCollisionAabb(supplied)).toBe(supplied);
    expect(deriveCollisionAabb(supplied).collisionAabb).toBe(collisionAabb);
  });

  it('repairs a model emission before the shared certification chain sees it', async () => {
    const { collisionAabb: _missing, ...withoutAabb } = EXAMPLE_WORLD.sim;
    const emission = { ...EXAMPLE_WORLD, sim: withoutAabb };

    const outcome = await emitLocally({
      sentence: 'a sentence the recogniser does not know',
      recognize: () => null,
      engine: scriptedEngine(JSON.stringify(emission)),
    });

    expect(outcome.kind).toBe('verdict');
    if (outcome.kind !== 'verdict') return;
    expect(outcome.body.outcome).toBe('CERTIFIED');
    expect(outcome.body.emission).toMatchObject({
      sim: { collisionAabb: { player: [1, 4, 1, 1], gate: [10, 4, 1, 1] } },
    });
  });
});
