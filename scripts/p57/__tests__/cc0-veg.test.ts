import { describe, expect, it } from 'vitest';

import { bestCandidate, isVegetation, matchFiles, queryFor, vegResult, vegTargets } from '../cc0-veg.mjs';

/**
 * P57 T8r bod 4: vegetace z CC0 balíků. Co je vegetace, které soubory jméno najde (druh musí sedět,
 * sníh, pařez, kámen a mimozemské balíky ne), cíle bez už vyměněných a výsledek podle skóre a souboje.
 */
describe('cc0-veg (P57 T8r item 4)', () => {
  it('vegetation is a plant noun, not a thing that carries plants', () => {
    for (const noun of ['street tree', 'tall grass tuft', 'wildflower patch', 'buttercup', 'thorn bush', 'palm tree']) expect(isVegetation(noun)).toBe(true);
    for (const noun of ['flower box', 'concrete planter with tree', 'flower stall', 'rock moss', 'vine covered rock wall', 'flower cart', 'picnic table']) expect(isVegetation(noun)).toBe(false);
  });

  it('a species must be in the file name; a species CC0 lacks has no query', () => {
    expect(queryFor('palm tree')?.key).toBe('palm');
    expect(queryFor('street tree')?.key).toBe('tree');
    expect(queryFor('tall grass tuft')?.key).toBe('grass');
    expect(queryFor('wildflower patch')?.key).toBe('flower');
    for (const noun of ['olive tree', 'sunflower', 'thorn bush']) expect(queryFor(noun)).toBeNull();
  });

  it('matches files by name, drops off-season, terrain, rock, alien packs, skipped files and the second format', () => {
    const models = [
      { pack: 'kenney-nature-kit', file: 'Models/GLTF format/tree_oak.glb' },
      { pack: 'kenney-nature-kit', file: 'Models/GLTF format/tree_palm.glb' },
      { pack: 'kenney-nature-kit', file: 'Models/GLTF format/tree_oak_fall.glb' },
      { pack: 'quaternius-ultimate-nature', file: 'OBJ/CommonTree_Snow_1.glb' },
      { pack: 'quaternius-ultimate-nature', file: 'OBJ/CommonTree_1.glb' },
      { pack: 'quaternius-ultimate-space-kit', file: 'Environment/GLTF/Tree_Blob_1.gltf' },
      { pack: 'kenney-survival-kit', file: 'Models/GLB format/tree.glb' },
      { pack: 'kenney-survival-kit', file: 'Models/GLTF format/tree.gltf' },
      { pack: 'kenney-survival-kit', file: 'Models/GLB format/rock-flat-grass.glb' },
      { pack: 'kenney-nature-kit', file: 'Models/GLTF format/flower_yellowA.glb' },
      { pack: 'kenney-nature-kit', file: 'Models/GLTF format/flower_redA.glb' },
    ];
    const skip = new Set(['quaternius-ultimate-nature/OBJ/CommonTree_1.glb']);
    expect(matchFiles(queryFor('street tree'), models, skip).map((model) => model.file)).toEqual(['Models/GLTF format/tree_oak.glb', 'Models/GLB format/tree.glb']);
    expect(matchFiles(queryFor('palm tree'), models).map((model) => model.file)).toEqual(['Models/GLTF format/tree_palm.glb']);
    expect(matchFiles(queryFor('buttercup'), models).map((model) => model.file)).toEqual(['Models/GLTF format/flower_yellowA.glb']);
    expect(matchFiles(queryFor('grass'), models)).toEqual([]);
    expect(matchFiles(queryFor('olive tree'), models)).toEqual([]);
  });

  it('targets top-50 vegetation not yet replaced (by T8 at 8+ or by this script) and kit vegetation the catalog has below 6', () => {
    const asset = (assetId: string, tag: string) => ({ assetId, tags: [tag], provenance: { license: 'LicenseRef-Worldsmith-Generated' } });
    const catalog = { assets: [asset('gen3d-a-tree', 'apple tree'), asset('gen3d-bench', 'park bench'), asset('gen3d-done', 'willow tree'), asset('gen3d-done-7', 'street tree'), asset('gen3d-cc0-done', 'poppy flower'), asset('gen3d-kit-bush', 'kit bush')] };
    const judge = { models: { 'gen3d-a-tree': { score: 7 }, 'gen3d-bench': { score: 5 }, 'gen3d-done': { score: 5 }, 'gen3d-done-7': { score: 8 }, 'gen3d-cc0-done': { score: 5 }, 'gen3d-kit-bush': { score: 4 } } };
    const usage = { top300: ['gen3d-a-tree', 'gen3d-bench', 'gen3d-done', 'gen3d-done-7', 'gen3d-cc0-done'] };
    const report = { models: { 'gen3d-done': { result: 'replaced', newScore: 8 }, 'gen3d-done-7': { result: 'replaced', newScore: 7 } }, cc0Veg: { models: { 'gen3d-cc0-done': { result: 'replaced' } } } };
    const kit = { missing: [{ id: 'gen3d-kit-bush', noun: 'kit bush' }, { id: 'gen3d-nowhere-fern', noun: 'fern' }, { id: 'gen3d-flower-cart', noun: 'flower cart' }] };
    expect(vegTargets({ judge, usage, catalog, report, kit })).toEqual({
      targets: [{ id: 'gen3d-a-tree', noun: 'apple tree', from: 'top50' }, { id: 'gen3d-done-7', noun: 'street tree', from: 'top50' }, { id: 'gen3d-kit-bush', noun: 'kit bush', from: 'kit' }],
      outside: [{ id: 'gen3d-nowhere-fern', noun: 'fern' }],
    });
  });

  it('result: no match, no fit, below 6, duel lost or won – and a duel against an older model does not count', () => {
    const candidate = (key: string, extra: Record<string, unknown>) => ({ key, pack: 'p', file: key, ...extra });
    const fitted = (key: string, score: number | null) => candidate(key, { glb: `${key}.glb`, refused: null, score });
    const item = (candidates: ReturnType<typeof candidate>[], duel: { candidate: string; oldHash: string; votes: { judge: string; vote: string | null }[] } | null = null) => ({ id: 'x', noun: 'x', oldHash: 'h1', candidates, duel });
    expect(vegResult(item([]))).toBe('no-cc0-match');
    expect(vegResult(item([candidate('a', { fit: 'bounds' }), candidate('b', { glb: 'b.glb', refused: 'lod1: 300 triangles, the replaced model had 96' })]))).toBe('no-fit');
    expect(vegResult(item([fitted('a', 5), fitted('b', null)]))).toBe('below-6');
    const pair = [fitted('a', 6), fitted('b', 7), fitted('c', 7)];
    expect(bestCandidate(pair)?.key).toBe('b');
    const won = [{ judge: 'claude', vote: 'new' }, { judge: 'codex', vote: 'new' }];
    expect(vegResult(item(pair, { candidate: 'b', oldHash: 'h1', votes: won }))).toBe('replace');
    expect(vegResult(item(pair, { candidate: 'b', oldHash: 'h1', votes: [won[0], { judge: 'claude', vote: null }] }))).toBe('kept-old');
    expect(vegResult(item(pair, { candidate: 'b', oldHash: 'h0', votes: won }))).toBe('unjudged');
    expect(vegResult(item(pair, { candidate: 'a', oldHash: 'h1', votes: won }))).toBe('unjudged');
  });
});
