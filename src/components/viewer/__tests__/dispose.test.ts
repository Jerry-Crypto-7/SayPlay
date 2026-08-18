/**
 * Úklid podstromu a hranice vieweru.
 *
 * **Oracle padesáti přepnutí je `renderer.info.memory` v prohlížeči** a leží
 * v `e2e/viewer-sse.spec.ts`; bez WebGL kontextu se na ten údaj zeptat nedá.
 * Tahle sada dělá druhou půlku, kterou prohlížeč naopak neumí: scéna z kitu
 * nese jednu texturu, takže by v ní zapomenutý slot nebyl vidět. Tady se
 * materiálům podstrčí textury ve slotech, které kit nemá — včetně slotu, který
 * v žádném seznamu three ani našem není — a právě to je vlastnost, na které
 * `disposeSubtree` stojí.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  BoxGeometry,
  DataTexture,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  ShaderMaterial,
  SphereGeometry,
} from 'three';
import { describe, expect, it, vi } from 'vitest';

import { buildImportGraph, isUnder, listFiles } from '../../../../scripts/prove-fallback-isolation.mjs';
import { disposeSubtree } from '../dispose';

function texture(): DataTexture {
  return new DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
}

describe('disposeSubtree', () => {
  it('odloží geometrii, materiál i texturu z celého podstromu', () => {
    const root = new Group();
    const nested = new Group();
    const geometry = new BoxGeometry();
    const material = new MeshStandardMaterial();
    material.map = texture();
    const mesh = new Mesh(geometry, material);
    nested.add(mesh);
    root.add(nested);

    const geometrySpy = vi.spyOn(geometry, 'dispose');
    const materialSpy = vi.spyOn(material, 'dispose');
    const textureSpy = vi.spyOn(material.map, 'dispose');

    const tally = disposeSubtree(root);

    expect(geometrySpy).toHaveBeenCalledTimes(1);
    expect(materialSpy).toHaveBeenCalledTimes(1);
    expect(textureSpy).toHaveBeenCalledTimes(1);
    expect(tally).toEqual({ geometries: 1, materials: 1, textures: 1 });
  });

  it('najde texturu ve slotu, který žádný seznam nezná', () => {
    // Nosná aserce celé sady. Ruční výčet slotů (`map`, `normalMap`, …) projde
    // všechno ostatní v tomhle souboru a padne přesně tady — a v provozu se to
    // projeví až jako rostoucí paměť po desítkách přepnutí.
    const material = new MeshBasicMaterial();
    const exotic = texture();
    (material as unknown as Record<string, unknown>).zcela_neznamy_slot = exotic;
    const spy = vi.spyOn(exotic, 'dispose');

    const tally = disposeSubtree(new Mesh(new BoxGeometry(), material));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(tally.textures).toBe(1);
  });

  it('najde texturu v uniformu ShaderMaterial', () => {
    const uniform = texture();
    const material = new ShaderMaterial({ uniforms: { tDiffuse: { value: uniform } } });
    const spy = vi.spyOn(uniform, 'dispose');

    expect(disposeSubtree(new Mesh(new BoxGeometry(), material)).textures).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('odloží každý materiál z pole materiálů', () => {
    const first = new MeshBasicMaterial();
    const second = new MeshBasicMaterial();
    const spies = [vi.spyOn(first, 'dispose'), vi.spyOn(second, 'dispose')];

    const tally = disposeSubtree(new Mesh(new BoxGeometry(), [first, second]));

    expect(tally.materials).toBe(2);
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });

  it('sdílený zdroj odloží právě jednou', () => {
    // Přesně tvar, jaký vydává kit: jeden materiál na celou scénu.
    const shared = new MeshBasicMaterial();
    shared.map = texture();
    const root = new Group();
    root.add(new Mesh(new BoxGeometry(), shared));
    root.add(new Mesh(new SphereGeometry(), shared));

    const materialSpy = vi.spyOn(shared, 'dispose');
    const textureSpy = vi.spyOn(shared.map, 'dispose');

    const tally = disposeSubtree(root);

    expect(tally).toEqual({ geometries: 2, materials: 1, textures: 1 });
    expect(materialSpy).toHaveBeenCalledTimes(1);
    expect(textureSpy).toHaveBeenCalledTimes(1);
  });

  it('rozpojí strom a odpojí kořen od rodiče', () => {
    const parent = new Group();
    const root = new Group();
    const nested = new Group();
    nested.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial()));
    root.add(nested);
    parent.add(root);

    disposeSubtree(root);

    // Bez rozpojení drží scéna, kterou už nikdo nekreslí, odkaz na každý mesh
    // v ní — `dispose()` uvolní paměť na GPU, ne na haldě.
    expect(parent.children).toHaveLength(0);
    expect(root.parent).toBeNull();
    expect(root.children).toHaveLength(0);
    expect(nested.children).toHaveLength(0);
  });

  it('prázdný podstrom nic neodloží a nespadne', () => {
    expect(disposeSubtree(new Group())).toEqual({ geometries: 0, materials: 0, textures: 0 });
  });
});

describe('hranice vieweru', () => {
  it('nesahá na src/fallback ani nepřímo', () => {
    const universe = new Set(listFiles(''));
    const sources = [...universe].filter((file) => /\.(ts|tsx|mts)$/.test(file) && file.startsWith('src/'));
    const graph = buildImportGraph(sources, universe, (file: string) =>
      readFileSync(join('.', file), 'utf-8'),
    );

    // Dopředný obal: co viewer importuje, ne kdo importuje viewer. `coreReachSet`
    // ve sdíleném skriptu jde druhým směrem, proto se prochází tady.
    const seed = sources.filter((file) => file.startsWith('src/components/viewer/'));
    expect(seed.length).toBeGreaterThan(0);

    const reached = new Set<string>();
    const queue = [...seed];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (reached.has(file)) continue;
      reached.add(file);
      queue.push(...(graph.get(file) ?? []));
    }

    const leaked = [...reached].filter((file) => isUnder(file, ['src/fallback', 'src/app/fallback']));
    expect(leaked, 'viewer sahá na fallback').toEqual([]);
  });
});
