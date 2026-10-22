/**
 * Terén kola běžce postavený workerem (P56C T18) musí být týž, jaký by scéna
 * postavila sama: jinak by kolo řetězu mělo jiné údolí, cestu nebo výšky kulis
 * než stejná hra hraná samostatně – a na pohled by to nikdo nepoznal.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BufferGeometry } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { arcadeWorldOf } from '@/play/arcade/compile';
import { type ArcadeWorld, UNIT } from '@/play/arcade/contract';
import { type Look, sceneLook } from '@/play/arcade/look';
import { readGameSpec } from '@/play/spec';

import { levelSpansOf, pathOf, runnerPathOf } from '../runner/path';
import { type TerrainJob, type TerrainReply, buildRunnerTerrain, prebuildRunnerTerrain, prebuiltRunnerTerrain, runTerrainJob, unpackTerrain } from '../runner/terrain';

function fixture(name: string): { readonly world: ArcadeWorld; readonly look: Look } {
  const spec = readGameSpec(JSON.parse(readFileSync(join(process.cwd(), 'src/play/arcade/__fixtures__', `${name}.json`), 'utf8')));
  if (!spec.ok) throw new Error(`${name}: ${spec.issues.join('; ')}`);
  const built = arcadeWorldOf(spec.value, 1);
  if (!built.ok) throw new Error(`${name}: ${built.issues.join('; ')}`);
  return { world: built.world, look: sceneLook(spec.value.theme) };
}

/** Cesta přes `postMessage`: zpráva projde strukturovaným klonem tam i zpět. */
function viaWorker(job: TerrainJob): TerrainReply {
  return structuredClone(runTerrainJob(structuredClone(job)));
}

function expectSameGeometry(got: BufferGeometry, want: BufferGeometry): void {
  expect(Object.keys(got.attributes).sort()).toEqual(Object.keys(want.attributes).sort());
  for (const name of Object.keys(want.attributes)) expect(got.getAttribute(name).array).toEqual(want.getAttribute(name).array);
  expect(got.index?.array ?? null).toEqual(want.index?.array ?? null);
  want.computeBoundingSphere();
  want.computeBoundingBox();
  expect(got.boundingSphere).toEqual(want.boundingSphere);
  expect(got.boundingBox).toEqual(want.boundingBox);
}

/** Worker, který zprávu zpracuje v tomtéž vlákně (Node workery z `new URL(…ts)` nespustí). */
class InlineWorker {
  static posted = 0;
  onmessage: ((event: { data: TerrainReply }) => void) | null = null;
  postMessage(job: TerrainJob): void {
    InlineWorker.posted += 1;
    const reply = viaWorker(job);
    setTimeout(() => this.onmessage?.({ data: reply }), 0);
  }
}

describe('terén běžce z workeru (P56C T18)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('údolí, cesta i výšky kulis jsou tytéž jako ze stavby na místě', () => {
    const { world, look } = fixture('runner');
    const length = world.length / UNIT;
    // Trať s mostem: most vede křivku po rovině, worker ji musí složit z týchž úseků.
    const spans = [...levelSpansOf(world), { from: 60, to: 80 }];
    const reply = viaWorker({ id: 1, look, length, seed: world.seed, spans });
    if (!('terrain' in reply)) throw new Error(reply.error);
    const got = unpackTerrain(reply.terrain, look, length);
    const want = buildRunnerTerrain(look, length, pathOf(world.seed, spans));
    expectSameGeometry(got.valley.geometry, want.valley.geometry);
    expect(got.lane).not.toBeNull();
    expectSameGeometry(got.lane!.surface, want.lane!.surface);
    expectSameGeometry(got.lane!.edges, want.lane!.edges);
    if (want.lane!.marks === null) expect(got.lane!.marks).toBeNull();
    else expectSameGeometry(got.lane!.marks!, want.lane!.marks);
    for (let z = -40; z <= length + 60; z += 7.3) for (const x of [-60, -20, -9, -5, 0, 5, 9, 20, 60]) expect(got.valley.heightAt(x, z)).toBe(want.valley.heightAt(x, z));
  });

  it('scéna kola vezme terén workeru jen pro tentýž svět a tutéž sadu', async () => {
    vi.stubGlobal('Worker', InlineWorker);
    const { world, look } = fixture('runner');
    expect(runnerPathOf(world)).not.toBeNull();
    prebuildRunnerTerrain(world, look);
    // Než worker odpoví, staví scéna sama.
    expect(prebuiltRunnerTerrain(world, look)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Scéna kola si sadu skládá sama (`sceneLook` v `ChainPlay`): jiný objekt, týž obsah.
    const got = prebuiltRunnerTerrain(world, structuredClone(look));
    expect(got).not.toBeNull();
    const want = buildRunnerTerrain(look, world.length / UNIT, runnerPathOf(world));
    expectSameGeometry(got!.valley.geometry, want.valley.geometry);
    // Jiná sada (kolo kreslené jinak) i jiný svět staví samy.
    expect(prebuiltRunnerTerrain(world, { ...look, ground: '#123456' })).toBeNull();
    expect(prebuiltRunnerTerrain({ ...world }, look)).toBeNull();
    // Kolo, které není běžec, worker nedostane; téhož světa podruhé taky ne.
    const posted = InlineWorker.posted;
    prebuildRunnerTerrain(fixture('shooter').world, look);
    prebuildRunnerTerrain(world, look);
    expect(InlineWorker.posted).toBe(posted);
  });
});
