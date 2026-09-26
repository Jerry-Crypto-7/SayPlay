/**
 * Nenačtený Rapier je vada serveru, ne specu (P29A R5): opravné kolo režiséra
 * ji modelu nesmí vrátit, jinak model fyziku zahodí. Rapier tu nikdy nenaběhne.
 */

import { describe, expect, it, vi } from 'vitest';

import arena from '@/play/arcade/__fixtures__/arena.json';
import throwRock from '@/play/arcade/__fixtures__/rules/throw-rock.json';
import { type GameSpecV1, readGameSpec } from '@/play/spec';

const load = vi.hoisted(() => vi.fn(() => Promise.reject(new Error('wasm fetch failed'))));
vi.mock('@/play/arcade/physics/world', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/play/arcade/physics/world')>()),
  loadRapier: load,
  rapierIfLoaded: () => null,
}));

import { compileArcade, PHYSICS_NOT_LOADED } from '@/play/arcade/compile';

import { playabilityIssues } from '../_publish';

function read(input: unknown): GameSpecV1 {
  const spec = readGameSpec(input);
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  return spec.value;
}

const physical = read({ ...throwRock, things: [{ role: 'rock', physics: true }] });

describe('playabilityIssues without Rapier', () => {
  it('compileArcade names the missing engine, the repair round gets no finding and a reload starts', () => {
    const compiled = compileArcade(physical, 1);
    expect(compiled.ok ? [] : compiled.issues).toEqual([PHYSICS_NOT_LOADED]);
    const before = load.mock.calls.length;
    expect(playabilityIssues(physical, [1])).toEqual([]);
    expect(load.mock.calls.length).toBe(before + 1);
  });

  it('a spec error in a game without physics still reaches the repair round', () => {
    const broken = read({ ...arena, things: [{ role: 'coin', start: 'hidden' }] });
    expect(playabilityIssues(broken, [1])).toEqual([expect.objectContaining({ code: 'WORLD_REJECTED' })]);
  });
});
