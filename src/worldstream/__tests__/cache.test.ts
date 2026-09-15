/**
 * **Idempotentní cache meshů (P13 T15).**
 *
 * Vada, kterou tu hledáme, je jediného druhu: **cache, která odpoví na
 * otázku, kterou jí nikdo nepoložil.** Klíč, ve kterém chybí rozlišení, vrátí
 * na žádost o 48³ mesh spočítaný ve 32³; klíč bez semínka relace vrátí tvar
 * s cizím šumem; artefakt uložený pod cizí klíč vrátí rovnou cizí tvar. Ani
 * jedna z těch tří se neprojeví výjimkou — projeví se tím, že na plátně stojí
 * hrubá hlína, o které si potrubí myslí, že je hotová.
 *
 * Proto se všude testuje **rozdíl klíčů**, ne jen jejich existence, a všude
 * se tvrdí obě strany: co se sloučit má i co se sloučit nesmí.
 */

import { describe, expect, it } from 'vitest';

import { coveringProgram } from '@/shape/__fixtures__/programs';
import type { ShapeProgram } from '@/shape/types';

import {
  MESH_FAILURES,
  createMeshCache,
  isRetryable,
  restoreMeshCache,
  shapeContentHash,
  type MeshArtifact,
} from '../cache';

const SEED = 4021;

function artifact(overrides: Partial<MeshArtifact> = {}): MeshArtifact {
  return {
    shapeId: 'fixture',
    contentHash: 'deadbeef',
    resolution: 32,
    vertices: 5_003,
    triangles: 10_044,
    bounds: { min: [-3, -1, -3], max: [3, 4, 3] },
    buildMs: 249,
    ...overrides,
  };
}

/** Týž program s klíči v opačném pořadí zápisu. Obsah se nemění. */
function reordered(program: ShapeProgram): ShapeProgram {
  return Object.fromEntries(Object.entries(program).reverse()) as unknown as ShapeProgram;
}

describe('shapeContentHash', () => {
  it('ignores the order in which the program was assembled', () => {
    const program = coveringProgram();
    expect(shapeContentHash(reordered(program), 32)).toBe(shapeContentHash(program, 32));
  });

  it('separates the two rungs of the ladder', () => {
    // Kdyby rozlišení v klíči nebylo, tahle dvě čísla se rovnají a hrubá
    // podoba se vydá jako vysoký detail — bez jediné chybové hlášky.
    const program = coveringProgram();
    expect(shapeContentHash(program, 48)).not.toBe(shapeContentHash(program, 32));
  });

  it('separates two programs that differ by one number', () => {
    const program = coveringProgram();
    const nudged: ShapeProgram = {
      ...program,
      nodes: [{ kind: 'sphere', radius: 0.61 }, ...program.nodes.slice(1)],
    };
    expect(shapeContentHash(nudged, 32)).not.toBe(shapeContentHash(program, 32));
  });

  it('is eight hex digits, like every other hash in the project', () => {
    expect(shapeContentHash(coveringProgram(), 32)).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('mesh cache', () => {
  it('never lets the same program at the same resolution be computed twice', () => {
    const cache = createMeshCache(SEED);
    const key = shapeContentHash(coveringProgram(), 32);

    expect(cache.lookup(key)).toEqual({ kind: 'miss' });
    expect(cache.reserve(key)).toBe(true);

    // Druhá objednávka dorazí dřív než první výsledek — bez `pending` by si
    // odnesla `miss` a spustila druhou práci nad týmž tvarem.
    expect(cache.lookup(key)).toEqual({ kind: 'pending' });
    expect(cache.reserve(key)).toBe(false);
    expect(cache.pending).toBe(1);
    expect(cache.size).toBe(0);

    const stored = artifact({ contentHash: key });
    cache.settle(key, stored);

    expect(cache.lookup(key)).toEqual({ kind: 'hit', artifact: stored });
    expect(cache.reserve(key)).toBe(false);
    expect(cache.pending).toBe(0);
    expect(cache.size).toBe(1);
  });

  it('refuses to file an artifact under a key that is not its own hash', () => {
    const cache = createMeshCache(SEED);
    const key = shapeContentHash(coveringProgram(), 32);

    expect(() => cache.settle(key, artifact({ contentHash: 'c0ffee00' }))).toThrow(/cannot be filed/);
    expect(cache.size).toBe(0);
  });

  it('frees the key when the work ends without an artifact', () => {
    const cache = createMeshCache(SEED);
    const key = shapeContentHash(coveringProgram(), 48);

    expect(cache.reserve(key)).toBe(true);
    cache.release(key);

    expect(cache.lookup(key)).toEqual({ kind: 'miss' });
    expect(cache.reserve(key)).toBe(true);
  });

  it('carries settled work across a reload and drops work in flight', () => {
    const cache = createMeshCache(SEED);
    const done = shapeContentHash(coveringProgram(), 32);
    const running = shapeContentHash(coveringProgram(), 48);

    cache.settle(done, artifact({ contentHash: done }));
    cache.reserve(running);

    const restored = restoreMeshCache(cache.snapshot(), SEED);

    expect(restored.lookup(done).kind).toBe('hit');
    // Pracovník, který `running` počítal, reload nepřežil. Obnovit ho jako
    // `pending` znamená klíč, na který se čeká navždy.
    expect(restored.lookup(running)).toEqual({ kind: 'miss' });
    expect(restored.pending).toBe(0);
  });

  it('refuses to restore a cache under a different session seed', () => {
    const cache = createMeshCache(SEED);
    const key = shapeContentHash(coveringProgram(), 32);
    cache.settle(key, artifact({ contentHash: key }));

    // `displace` je šum deterministický ze semínka, takže tentýž program pod
    // jiným semínkem je jiný tvar. Klíč to nerozliší — obor cache ano.
    expect(() => restoreMeshCache(cache.snapshot(), SEED + 1)).toThrow(/session seed/);
  });
});

describe('isRetryable', () => {
  it('does not repeat a deterministic rejection', () => {
    // Meshovač je deterministický (design book §11.2: mezi Node a prohlížečem
    // se nelišil ani jeden trojúhelník), takže tyhle tři dají podruhé totéž.
    expect(isRetryable('EMPTY_MESH')).toBe(false);
    expect(isRetryable('BUDGET_EXCEEDED')).toBe(false);
    expect(isRetryable('GATE_REJECTED')).toBe(false);
  });

  it('repeats a fault of the surroundings', () => {
    expect(isRetryable('WORKER_FAILED')).toBe(true);
    expect(isRetryable('CANCELLED')).toBe(true);
    expect(isRetryable('ARTIFACT_MISMATCH')).toBe(true);
  });

  it('decides every failure the vocabulary has', () => {
    // Nový důvod bez rozhodnutí by tiše spadl do „neopakovat" — což je u vady
    // okolí ztracený objekt, ne ušetřená práce.
    expect(MESH_FAILURES.filter((failure) => isRetryable(failure))).toHaveLength(3);
  });
});
