/**
 * `compileGame` → `WORLD_REJECTED` (P23-D R5): svět, který neprojde bránou
 * blueprintu, se nesmí vrátit jako hra. Platný spec bránou vždy projde, proto
 * se odmítnutí vyrábí podvrženým validátorem; `UNWINNABLE` měří routy nad
 * skutečným nevyhratelným rozvržením (`routes.test.ts`).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { compileGame } from '../compile';
import { readGameSpec, type GameSpecV1 } from '../spec';

const reject = vi.hoisted(() => ({ on: false }));

vi.mock('@/worldstream/schema', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/worldstream/schema')>();
  return {
    ...original,
    validateBlueprint: (blueprint: unknown) => (reject.on ? { ok: false, issues: ['/world: rejected on purpose'] } : original.validateBlueprint(blueprint)),
  };
});

function fixture(name: string): GameSpecV1 {
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL(`../__fixtures__/${name}.json`, import.meta.url)), 'utf8'));
  const result = readGameSpec(raw);
  if (!result.ok) throw new Error(name);
  return result.value;
}

describe('compileGame – the blueprint gate', () => {
  it('a world the blueprint gate refuses is WORLD_REJECTED with its issues, never a game', () => {
    const spec = fixture('collect_exit');
    expect(compileGame(spec, 1).ok).toBe(true);
    reject.on = true;
    try {
      expect(compileGame(spec, 1)).toEqual({ ok: false, reason: 'WORLD_REJECTED', issues: ['/world: rejected on purpose'] });
    } finally {
      reject.on = false;
    }
  });
});
