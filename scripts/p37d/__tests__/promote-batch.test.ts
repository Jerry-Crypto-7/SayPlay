import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { afterEach, describe, expect, it } from 'vitest';

import { isGen3d } from '../../assets/gen3d/promote.mjs';
import { licenseFileOf, promote as promoteCc0, replacedRow } from '../../assets/cc0/promote.mjs';
import { CC0, LICENSE, PUBLIC_DIR, checkReplaced, promoteBatch, replaceModels } from '../promote-batch.mjs';

/**
 * Povýšení dávky do katalogu (P37D T3) nad dočasným kořenem: přijatý model projde
 * do katalogu, indexu i disclosure; zamítnutý, cizí licence, obsazené id a obsazené
 * jméno se přeskočí a nic cizího se nezmění; druhé povýšení téhož id nezdvojí.
 */

const ROOT = path.resolve(__dirname, '../../..');
const GLB = path.join(ROOT, 'public/assets/worldstream/gen3d/gen3d-acorn-lod0.glb');
const roots: string[] = [];

const taken = {
  assetId: 'gen3d-taken', tags: ['toad'], bounds: { min: [0, 0, 0], max: [1, 1, 1] }, provenance: { source: 'scripts/assets/gen3d/promote.mjs' },
  lods: [{ level: 0, path: '/assets/worldstream/gen3d/gen3d-taken-lod0.glb' }, { level: 1, path: '/assets/worldstream/gen3d/gen3d-taken-lod1.glb' }],
};

function makeRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'p37d-root-'));
  roots.push(root);
  mkdirSync(path.join(root, 'src/assets'), { recursive: true });
  writeFileSync(path.join(root, 'src/assets/catalog.json'), JSON.stringify({ version: 1, assets: [taken] }));
  writeFileSync(path.join(root, 'disclosure.json'), JSON.stringify({ $comment: 'test', entries: [{ name: 'public/other.png', kind: 'asset' }] }));
  return root;
}

const entry = (id: string, nouns: string[], extra: Record<string, unknown> = {}) => ({
  id, nouns, glb: GLB, bounds: [0.6, 1, 0.6], palette: ['#8a5a2b'],
  source: { pipeline: 'ops/gen3d', imageModel: 'FLUX.2-klein-4B', shapeModel: 'TRELLIS.2-4B', seed: 1 },
  licence: LICENSE, checked: { judge: 'blind four-view sheet: top1', verdict: 'pass' }, ...extra,
});

const read = (root: string, file: string) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  // `normalizeModel` pracuje v `asset-quarantine/<id>` repa, ne pod dočasným kořenem.
  for (const id of ['gen3d-test-acorn', 'gen3d-test-broken', 'cc0-test-grass']) rmSync(path.join(ROOT, 'asset-quarantine', id), { recursive: true, force: true });
});

/** Model z repa přeškálovaný v osách – kandidát výměny s předem známým rozměrem. */
async function scaled(root: string, file: string, scale: [number, number, number]): Promise<string> {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(path.join(ROOT, file));
  for (const node of doc.getRoot().listScenes()[0].listChildren()) {
    const [x, y, z] = node.getScale();
    node.setScale([x * scale[0], y * scale[1], z * scale[2]]).setTranslation(node.getTranslation().map((value, axis) => value * scale[axis]) as [number, number, number]);
  }
  const out = path.join(root, `in-${scale.join('x')}-${path.basename(file)}`);
  await io.write(out, doc);
  return out;
}

const GRASS = 'cc0-grass';
const TEST_GRASS = 'cc0-test-grass';
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * Dočasný kořen se skutečnou CC0 trávou z katalogu repa pod testovým id: soubory,
 * záznam katalogu i CC0 záznamy disclosure, jako je má 19 CC0 modelů z `below6` (P57 T4).
 */
function makeReplaceRoot() {
  const root = makeRoot();
  const repoCatalog = JSON.parse(readFileSync(path.join(ROOT, 'src/assets/catalog.json'), 'utf8'));
  const grass = JSON.parse(JSON.stringify(repoCatalog.assets.find((asset: { assetId: string }) => asset.assetId === GRASS)).replaceAll(GRASS, TEST_GRASS));
  const repoDisclosure = JSON.parse(readFileSync(path.join(ROOT, 'disclosure.json'), 'utf8'));
  const files = [...grass.lods.map((lod: { path: string }) => lod.path), grass.thumbnail].map((url: string) => `public${url}`);
  mkdirSync(path.join(root, 'public/assets/worldstream/cc0'), { recursive: true });
  const records = files.map((name: string) => {
    copyFileSync(path.join(ROOT, name.replace(TEST_GRASS, GRASS)), path.join(root, name));
    return { ...repoDisclosure.entries.find((record: { name: string }) => record.name === name.replace(TEST_GRASS, GRASS)), name };
  });
  writeFileSync(path.join(root, 'src/assets/catalog.json'), JSON.stringify({ version: 1, assets: [taken, grass] }));
  writeFileSync(path.join(root, 'disclosure.json'), JSON.stringify({ $comment: 'test', entries: [{ name: 'public/other.png', kind: 'asset' }, ...records] }));
  return { root, grass, files, replacedDir: path.join(root, 'replaced') };
}

describe('promote-batch --replace (P57 T5)', () => {
  it('replaces a CC0 model under the same id: same paths, kept gameplay fields, old files kept aside', async () => {
    const { root, grass, files, replacedDir } = makeReplaceRoot();
    const oldHashes = files.map((name) => sha(path.join(root, name)));
    const glb = await scaled(root, grass.lods[0].path.replace('/', 'public/').replace(TEST_GRASS, GRASS), [1.05, 1.05, 1.05]);

    const { replaced, skipped } = await replaceModels({ schema: 'catalog-batch.v1', entries: [entry(TEST_GRASS, ['grass'], { glb })] }, { root, sync: false, replacedDir });

    expect(skipped).toEqual([]);
    expect(replaced).toEqual([TEST_GRASS]);
    const catalog = read(root, 'src/assets/catalog.json');
    expect(catalog.assets.map((asset: { assetId: string }) => asset.assetId)).toEqual(['gen3d-taken', TEST_GRASS]);
    const asset = catalog.assets[1];
    for (const key of ['assetId', 'tags', 'collision', 'sockets', 'pivot', 'thumbnail']) expect(asset[key]).toEqual(grass[key]);
    expect(asset.version).toBe(grass.version + 1);
    expect(asset.lods.map((lod: { path: string }) => lod.path)).toEqual(grass.lods.map((lod: { path: string }) => lod.path));
    for (const lod of asset.lods) {
      const file = path.join(root, `public${lod.path}`);
      expect(sha(file)).toBe(lod.hash);
      expect(readFileSync(file).length).toBe(lod.bytes);
    }
    expect(asset.hash).toBe(asset.lods[0].hash);
    expect(asset.hash).not.toBe(grass.hash);
    expect(asset.lods[1].triangles).toBeLessThanOrEqual(grass.lods[1].triangles);
    // Nový rozměr ze souboru: 5 % větší v každé ose.
    for (let axis = 0; axis < 3; axis++) {
      const ratio = (asset.bounds.max[axis] - asset.bounds.min[axis]) / (grass.bounds.max[axis] - grass.bounds.min[axis]);
      expect(ratio).toBeCloseTo(1.05, 2);
    }
    expect(asset.label).toBe('Grass (generated)');
    expect(asset.provenance).toMatchObject({ license: LICENSE, replacedAt: new Date().toISOString().slice(0, 10), replacedFrom: grass.provenance.source });
    expect(asset.provenance.source).toMatch(/ops\/gen3d.*P57/);

    // Staré soubory vedle, po verzích: návrat = zkopírovat zpět.
    expect(files.map((name) => sha(path.join(replacedDir, TEST_GRASS, `v${grass.version}`, path.basename(name))))).toEqual(oldHashes);
    const disclosure = read(root, 'disclosure.json');
    for (const name of files) expect(disclosure.entries.find((record: { name: string }) => record.name === name)).toMatchObject({ license: LICENSE, firstParty: true });
    expect(read(root, 'src/assets/catalog-index.json').assets[1]).toMatchObject({ assetId: TEST_GRASS, bounds: asset.bounds });
    expect(readFileSync(path.join(root, PUBLIC_DIR, 'PROVENANCE.md'), 'utf8')).toMatch(new RegExp(`${TEST_GRASS}.*replaced`));
    expect(await checkReplaced({ catalog, disclosure, root })).toEqual([]);
  }, 180_000);

  it('refuses a size change over 10 % in any axis, a heavier LOD1 and an unknown id, and touches nothing', async () => {
    const { root, grass, files, replacedDir } = makeReplaceRoot();
    const before = ['src/assets/catalog.json', 'disclosure.json', ...files].map((name) => sha(path.join(root, name)));
    const lod0 = grass.lods[0].path.replace('/', 'public/').replace(TEST_GRASS, GRASS);
    const deeper = await scaled(root, lod0, [1, 1, 1.15]);
    // Žalud (LOD1 2 370 trojúhelníků) vtěsnaný do krabice trávy (LOD1 96): rozměr sedí, váha ne.
    const heavy = await scaled(root, 'public/assets/worldstream/gen3d/gen3d-acorn-lod0.glb', [0.4988, 1.2021, 0.6969]);

    const { replaced, skipped } = await replaceModels({
      schema: 'catalog-batch.v1',
      entries: [entry(TEST_GRASS, ['grass'], { glb: deeper }), entry(TEST_GRASS, ['grass'], { glb: heavy }), entry('gen3d-test-nowhere', ['nowhere'])],
    }, { root, sync: false, replacedDir });

    expect(replaced).toEqual([]);
    expect(skipped).toEqual([
      { id: TEST_GRASS, reason: expect.stringMatching(/^bounds: z /) },
      { id: TEST_GRASS, reason: expect.stringMatching(/^lod1: /) },
      { id: 'gen3d-test-nowhere', reason: 'not in the catalog, nothing to replace' },
    ]);
    expect(['src/assets/catalog.json', 'disclosure.json', ...files].map((name) => sha(path.join(root, name)))).toEqual(before);
    expect(existsSync(replacedDir)).toBe(false);
  }, 180_000);

  it('a rerun after a crash mid-batch never overwrites the originals kept aside (P57 R2)', async () => {
    const { root, grass, files, replacedDir } = makeReplaceRoot();
    const oldHashes = files.map((name) => sha(path.join(root, name)));
    const glb = await scaled(root, grass.lods[0].path.replace('/', 'public/').replace(TEST_GRASS, GRASS), [1.05, 1.05, 1.05]);
    // Stav po pádu: originály už vedle, v `public/` nové soubory, katalog pořád starý.
    const aside = path.join(replacedDir, TEST_GRASS, `v${grass.version}`);
    mkdirSync(aside, { recursive: true });
    for (const name of files) {
      copyFileSync(path.join(root, name), path.join(aside, path.basename(name)));
      writeFileSync(path.join(root, name), 'half-written swap');
    }

    const { replaced } = await replaceModels({ schema: 'catalog-batch.v1', entries: [entry(TEST_GRASS, ['grass'], { glb })] }, { root, sync: false, replacedDir });

    expect(replaced).toEqual([TEST_GRASS]);
    expect(files.map((name) => sha(path.join(aside, path.basename(name))))).toEqual(oldHashes);
  }, 180_000);

  it('the hero profile simplifies LOD1 toward the replaced one instead of refusing it as heavier (P57 T8)', async () => {
    const { root, grass, replacedDir } = makeReplaceRoot();
    // Žalud (4 740) do trávy (LOD1 96): na 96 trojúhelníků při stejné velikosti zjednodušit nejde;
    // hero to zkusí se starým LOD1 jako stropem (výchozí profil odmítne až po normalizaci jako `lod1:`).
    const heavy = await scaled(root, 'public/assets/worldstream/gen3d/gen3d-acorn-lod0.glb', [0.4988, 1.2021, 0.6969]);
    const { replaced, skipped } = await replaceModels({ schema: 'catalog-batch.v1', entries: [entry(TEST_GRASS, ['grass'], { glb: heavy })] }, { root, sync: false, replacedDir, profile: 'hero' });
    expect(replaced).toEqual([]);
    expect(skipped).toEqual([{ id: TEST_GRASS, reason: `normalize: LOD1 cannot be made lighter than LOD0 and at most ${grass.lods[1].triangles} triangles at the same size` }]);
  }, 180_000);

  it('checkReplaced flags a replaced model whose bounds, file or disclosure drifted', async () => {
    const { root, grass, replacedDir } = makeReplaceRoot();
    const glb = await scaled(root, grass.lods[0].path.replace('/', 'public/').replace(TEST_GRASS, GRASS), [1.05, 1.05, 1.05]);
    await replaceModels({ schema: 'catalog-batch.v1', entries: [entry(TEST_GRASS, ['grass'], { glb })] }, { root, sync: false, replacedDir });
    const catalog = read(root, 'src/assets/catalog.json');
    const disclosure = read(root, 'disclosure.json');

    const wide = structuredClone(catalog);
    wide.assets[1].bounds.max[0] += 0.05;
    expect((await checkReplaced({ catalog: wide, disclosure, root })).join('\n')).toMatch(new RegExp(`${TEST_GRASS}: bounds`));
    const reverted = structuredClone(disclosure);
    reverted.entries.find((record: { name: string }) => record.name.endsWith(`${TEST_GRASS}-lod1.glb`)).license = 'CC0-1.0';
    expect((await checkReplaced({ catalog, disclosure: reverted, root })).join('\n')).toMatch(/lod1\.glb.*CC0-1\.0/);
    rmSync(path.join(root, `public${grass.thumbnail}`));
    expect((await checkReplaced({ catalog, disclosure, root })).join('\n')).toMatch(/\.png is missing/);
  }, 180_000);
});

/**
 * Výměna za model z CC0 balíku (P57 T8r, `origin: 'cc0'`) nad dočasnou cache: balík ze `sources.json`,
 * text licence vedle, zdrojový soubor v balíku. Do katalogu jde autor a text licence balíku, ne „generated“.
 */
const PACK = 'quaternius-ultimate-nature';
const SOURCE_FILE = 'OBJ/Grass_9.glb';
function makeCache(licence = readFileSync(path.join(ROOT, 'public/assets/worldstream/cc0/licenses', `${PACK}.txt`), 'utf8')) {
  const cache = mkdtempSync(path.join(os.tmpdir(), 'p57-cc0-cache-'));
  roots.push(cache);
  mkdirSync(path.join(cache, PACK, 'OBJ'), { recursive: true });
  copyFileSync(GLB, path.join(cache, PACK, SOURCE_FILE));
  writeFileSync(path.join(cache, `${PACK}.license.txt`), licence);
  return cache;
}
const cc0Entry = (glb: string, extra: Record<string, unknown> = {}) => entry(TEST_GRASS, ['grass'], { glb, licence: CC0, source: { pack: PACK, file: SOURCE_FILE }, ...extra });

describe('promote-batch --replace with a CC0 model (P57 T8r)', () => {
  it('records the CC0 pack, author and licence text, discloses every file as CC0, and checkReplaced accepts it', async () => {
    const { root, grass, files, replacedDir } = makeReplaceRoot();
    const cc0Cache = makeCache();
    const glb = await scaled(root, grass.lods[0].path.replace('/', 'public/').replace(TEST_GRASS, GRASS), [1.05, 1.05, 1.05]);

    const { replaced, skipped } = await replaceModels({ schema: 'catalog-batch.v1', entries: [cc0Entry(glb)] }, { root, sync: false, replacedDir, origin: 'cc0', cc0Cache });

    expect(skipped).toEqual([]);
    expect(replaced).toEqual([TEST_GRASS]);
    const catalog = read(root, 'src/assets/catalog.json');
    const asset = catalog.assets[1];
    expect(asset.label).toBe('Grass (CC0, Quaternius)');
    expect(asset.version).toBe(grass.version + 1);
    expect(asset.provenance).toMatchObject({ license: CC0, author: 'Quaternius (quaternius.com)', licenseEvidence: licenseFileOf(PACK), replacedFrom: grass.provenance.source });
    expect(asset.provenance.source).toContain(`${SOURCE_FILE} from the ${PACK} pack`);
    expect(readFileSync(path.join(root, licenseFileOf(PACK)), 'utf8')).toMatch(/CC0 1\.0/);
    const disclosure = read(root, 'disclosure.json');
    for (const name of files) expect(disclosure.entries.find((record: { name: string }) => record.name === name)).toMatchObject({ license: CC0, firstParty: false, authorOrProvider: 'Quaternius (quaternius.com)' });
    expect(disclosure.entries.find((record: { name: string }) => record.name === licenseFileOf(PACK))).toMatchObject({ license: CC0 });
    expect(readFileSync(path.join(root, PUBLIC_DIR, 'PROVENANCE.md'), 'utf8')).toMatch(new RegExp(`Replaced by CC0[\\s\\S]*${TEST_GRASS}.*Quaternius`));
    expect(await checkReplaced({ catalog, disclosure, root })).toEqual([]);

    // Špatně zapsaná CC0 výměna neprojde: záznam souboru jako vlastní, cizí text licence, štítek „generated“, cizí licence.
    const own = structuredClone(disclosure);
    Object.assign(own.entries.find((record: { name: string }) => record.name.endsWith(`${TEST_GRASS}-lod0.glb`)), { license: LICENSE, firstParty: true });
    expect((await checkReplaced({ catalog, disclosure: own, root })).join('\n')).toMatch(/lod0\.glb is disclosed as LicenseRef-Worldsmith-Generated first-party/);
    const labelled = structuredClone(catalog);
    labelled.assets[1].label = 'Grass (generated)';
    expect((await checkReplaced({ catalog: labelled, disclosure, root })).join('\n')).toMatch(/claims a generated model/);
    const foreign = structuredClone(catalog);
    foreign.assets[1].provenance.license = 'CC-BY-4.0';
    expect((await checkReplaced({ catalog: foreign, disclosure, root })).join('\n')).toMatch(/provenance says CC-BY-4\.0/);
    const undeclared = structuredClone(catalog);
    undeclared.assets[1].provenance.licenseEvidence = 'public/assets/worldstream/cc0/licenses/some-pack.txt';
    expect((await checkReplaced({ catalog: undeclared, disclosure, root })).join('\n')).toMatch(/not the text of a CC0 pack/);
    writeFileSync(path.join(root, licenseFileOf(PACK)), 'Creative Commons Attribution-NonCommercial 4.0');
    expect((await checkReplaced({ catalog, disclosure, root })).join('\n')).toMatch(/does not say CC0-1\.0/);
  }, 180_000);

  it('refuses a wrong licence, an undeclared pack, a missing or non-CC0 licence text, a file not in the pack and a size change, and touches nothing', async () => {
    const { root, grass, files, replacedDir } = makeReplaceRoot();
    const before = ['src/assets/catalog.json', 'disclosure.json', ...files].map((name) => sha(path.join(root, name)));
    const lod0 = grass.lods[0].path.replace('/', 'public/').replace(TEST_GRASS, GRASS);
    const glb = await scaled(root, lod0, [1.05, 1.05, 1.05]);
    const deeper = await scaled(root, lod0, [1, 1, 1.15]);
    const cache = makeCache();
    const run = (entries: Record<string, unknown>[], cc0Cache = cache) => replaceModels({ schema: 'catalog-batch.v1', entries }, { root, sync: false, replacedDir, origin: 'cc0', cc0Cache });

    expect((await run([
      cc0Entry(glb, { licence: 'CC-BY-4.0' }),
      cc0Entry(glb, { licence: LICENSE }),
      cc0Entry(glb, { source: { pack: 'some-pack', file: SOURCE_FILE } }),
      cc0Entry(glb, { source: { pack: PACK, file: 'OBJ/Missing.glb' } }),
      cc0Entry(deeper),
    ])).skipped).toEqual([
      { id: TEST_GRASS, reason: 'licence CC-BY-4.0 is not CC0-1.0' },
      { id: TEST_GRASS, reason: `licence ${LICENSE} is not CC0-1.0` },
      { id: TEST_GRASS, reason: 'CC0 pack some-pack is not declared in scripts/assets/cc0/sources.json' },
      { id: TEST_GRASS, reason: `source file OBJ/Missing.glb is not in the ${PACK} pack` },
      { id: TEST_GRASS, reason: expect.stringMatching(/^bounds: z /) },
    ]);
    expect((await run([cc0Entry(glb)], makeCache('Creative Commons Attribution-NonCommercial 4.0'))).skipped).toEqual([{ id: TEST_GRASS, reason: `${PACK}: license text does not say CC0-1.0` }]);
    const noText = makeCache();
    rmSync(path.join(noText, `${PACK}.license.txt`));
    expect((await run([cc0Entry(glb)], noText)).skipped).toEqual([{ id: TEST_GRASS, reason: `licence text ${path.join(noText, `${PACK}.license.txt`)} is missing` }]);
    // Generovaná cesta CC0 záznam dál odmítá.
    expect((await replaceModels({ schema: 'catalog-batch.v1', entries: [cc0Entry(glb)] }, { root, sync: false, replacedDir })).skipped).toEqual([{ id: TEST_GRASS, reason: `licence ${CC0} is not the pipeline licence ${LICENSE}` }]);

    expect(['src/assets/catalog.json', 'disclosure.json', ...files].map((name) => sha(path.join(root, name)))).toEqual(before);
    expect(existsSync(replacedDir)).toBe(false);
  }, 180_000);
});

/**
 * Model ve složce cc0 vyměněný pod stejným id (bříza, palma, P57 R1): tabulka `cc0/PROVENANCE.md` ho nesmí dál
 * připisovat starému balíku a nový běh `scripts/assets/cc0/promote.mjs` ho nesmí ze staré karantény vrátit jako v1.
 */
describe('a model swapped inside the cc0 folder (P57 R1)', () => {
  it('replaceModels rewrites its cc0/PROVENANCE.md row, and a later cc0 promote() keeps the swap', async () => {
    const { root, grass, files, replacedDir } = makeReplaceRoot();
    const table = path.join(root, 'public/assets/worldstream/cc0/PROVENANCE.md');
    const other = '| `cc0-test-other` | other | Kenney | [kenney-nature-kit](https://kenney.nl) | `x.glb` | CC0-1.0 |';
    writeFileSync(table, ['| Model | Noun | Author | Pack | Source file | License |', '|---|---|---|---|---|---|',
      `| \`${TEST_GRASS}\` | grass | Quaternius (quaternius.com) | [${PACK}](https://quaternius.com) | \`${SOURCE_FILE}\` | CC0-1.0 |`, other, ''].join('\n'));
    const glb = await scaled(root, grass.lods[0].path.replace('/', 'public/').replace(TEST_GRASS, GRASS), [1.05, 1.05, 1.05]);
    await replaceModels({ schema: 'catalog-batch.v1', entries: [entry(TEST_GRASS, ['grass'], { glb })] }, { root, sync: false, replacedDir });

    const swapped = read(root, 'src/assets/catalog.json').assets[1];
    expect(replacedRow(swapped)).toMatch(new RegExp(`^\\| \`${TEST_GRASS}\` \\| grass \\| Worldsmith project – generated by ops/gen3d \\| replaced \\d{4}-\\d\\d-\\d\\d .* \\| ${LICENSE} \\|$`));
    expect(readFileSync(table, 'utf8').split('\n').slice(2, 4)).toEqual([replacedRow(swapped), other]);

    // Nový běh CC0 povýšení nad karanténou, která trávu pořád má (a vedle ní nový model).
    const cache = makeCache();
    const fern = { assetId: 'cc0-test-fern', pack: PACK, file: 'OBJ/Fern_1.glb', noun: 'fern', category: 'nature', styled: true };
    const stale = { assetId: TEST_GRASS, pack: PACK, file: SOURCE_FILE, noun: 'grass', category: 'nature', styled: true };
    const record = {
      pack: PACK,
      lod0: { ...grass.lods[0], file: path.join(ROOT, `public${grass.lods[0].path}`.replace(TEST_GRASS, GRASS)) },
      lod1: { ...grass.lods[1], file: path.join(ROOT, `public${grass.lods[1].path}`.replace(TEST_GRASS, GRASS)) },
      candidate: { label: 'Fern (CC0, Quaternius)', style: grass.style, provenance: grass.provenance, bounds: grass.bounds, materials: grass.materials, collision: grass.collision, parts: grass.parts },
    };
    for (const item of [stale, fern]) {
      mkdirSync(path.join(root, 'asset-quarantine', item.assetId), { recursive: true });
      writeFileSync(path.join(root, 'asset-quarantine', item.assetId, 'cc0.json'), JSON.stringify(record));
    }
    writeFileSync(path.join(root, 'asset-quarantine/cc0-manifest.json'), JSON.stringify({ normalized: [stale, fern], failed: [] }));
    mkdirSync(path.join(root, 'scripts/assets/cc0'), { recursive: true });
    writeFileSync(path.join(root, 'scripts/assets/cc0/selection.json'), JSON.stringify({ selected: [stale, fern].map(({ pack, file, noun }) => ({ pack, file, noun })) }));
    writeFileSync(path.join(root, 'scripts/assets/cc0/fetched.json'), JSON.stringify({ cache, packs: [{ pack: PACK, licenseFile: `<cache>/${PACK}.license.txt` }] }));
    copyFileSync(path.join(ROOT, 'scripts/assets/cc0/sources.json'), path.join(root, 'scripts/assets/cc0/sources.json'));
    // Vlastní id vyměněné za CC0 z balíku, který žádný model složky cc0 nepoužívá (`gen3d-wildflower-patch`): text licence zůstane.
    const evidence = licenseFileOf('kenney-nature-kit');
    const before = read(root, 'src/assets/catalog.json');
    before.assets.push({
      assetId: 'gen3d-test-weed', tags: ['weed'], bounds: grass.bounds, thumbnail: '/assets/worldstream/gen3d-p37d/gen3d-test-weed.png',
      lods: [{ level: 0, path: '/assets/worldstream/gen3d-p37d/gen3d-test-weed-lod0.glb' }], provenance: { license: CC0, replacedAt: '2026-10-22', licenseEvidence: evidence },
    });
    writeFileSync(path.join(root, 'src/assets/catalog.json'), JSON.stringify(before));
    mkdirSync(path.join(root, path.dirname(evidence)), { recursive: true });
    writeFileSync(path.join(root, evidence), 'CC0 1.0 Universal');
    const withEvidence = read(root, 'disclosure.json');
    withEvidence.entries.push({ name: evidence, kind: 'asset', license: CC0, authorOrProvider: 'Kenney' });
    writeFileSync(path.join(root, 'disclosure.json'), JSON.stringify(withEvidence));
    const kept = [...files, evidence];
    const hashes = files.map((name) => sha(path.join(root, name)));
    const disclosed = withEvidence.entries.filter((entry: { name: string }) => kept.includes(entry.name));

    await promoteCc0({ root });

    expect(existsSync(path.join(root, evidence))).toBe(true);
    const catalog = read(root, 'src/assets/catalog.json');
    expect(catalog.assets.find((asset: { assetId: string }) => asset.assetId === TEST_GRASS)).toEqual(swapped);
    expect(catalog.assets.find((asset: { assetId: string }) => asset.assetId === 'cc0-test-fern')).toMatchObject({ version: 1, provenance: { license: CC0 } });
    expect(files.map((name) => sha(path.join(root, name)))).toEqual(hashes);
    const disclosure = read(root, 'disclosure.json');
    expect(disclosure.entries.filter((entry: { name: string }) => kept.includes(entry.name))).toEqual(disclosed);
    const rows = readFileSync(table, 'utf8');
    expect(rows).toContain(replacedRow(swapped));
    expect(rows).toMatch(/\| `cc0-test-fern` \| fern \| .*Fern_1\.glb/);
    expect(rows).not.toContain(SOURCE_FILE);
    expect(await checkReplaced({ catalog: { assets: [swapped] }, disclosure, root })).toEqual([]);
  }, 180_000);
});

describe('promote-batch (P37D T3)', () => {
  it('promotes a passed model into the catalog, the index and disclosure, and skips the rest', async () => {
    const root = makeRoot();
    const batch = {
      schema: 'catalog-batch.v1',
      entries: [
        entry('gen3d-test-acorn', ['test acorn', 'toad']),
        entry('gen3d-test-rejected', ['rejected'], { checked: { judge: 'blind four-view sheet: no', verdict: 'fail' } }),
        entry('gen3d-test-foreign', ['foreign'], { licence: 'CC-BY-4.0' }),
        entry('gen3d-taken', ['fresh noun']),
        entry('gen3d-test-toad', ['toad']),
      ],
    };
    const { promoted, skipped } = await promoteBatch(batch, { root, sync: false });

    expect(promoted).toEqual(['gen3d-test-acorn']);
    expect(Object.fromEntries(skipped.map((skip: { id: string; reason: string }) => [skip.id, skip.reason]))).toEqual({
      'gen3d-test-rejected': 'judge: blind four-view sheet: no',
      'gen3d-test-foreign': `licence CC-BY-4.0 is not the pipeline licence ${LICENSE}`,
      'gen3d-taken': 'id already in the catalog outside gen3d-p37d',
      'gen3d-test-toad': '"toad" is already a tag of another catalog model',
    });

    const catalog = read(root, 'src/assets/catalog.json');
    expect(catalog.assets.map((asset: { assetId: string }) => asset.assetId)).toEqual(['gen3d-taken', 'gen3d-test-acorn']);
    expect(catalog.assets[0]).toEqual(taken);
    const promotedAsset = catalog.assets[1];
    // „toad“ už je štítek jiného modelu, do nového nepatří.
    expect(promotedAsset.tags).toEqual(['test acorn']);
    expect(promotedAsset.provenance.license).toBe(LICENSE);
    expect(promotedAsset.lods.map((lod: { path: string }) => lod.path)).toEqual([
      '/assets/worldstream/gen3d-p37d/gen3d-test-acorn-lod0.glb',
      '/assets/worldstream/gen3d-p37d/gen3d-test-acorn-lod1.glb',
    ]);
    expect(promotedAsset.lods[1].triangles).toBeLessThan(promotedAsset.lods[0].triangles);
    expect(isGen3d(promotedAsset)).toBe(false);
    expect(isGen3d(taken)).toBe(true);

    expect(read(root, 'src/assets/catalog-index.json').assets[1]).toMatchObject({ assetId: 'gen3d-test-acorn', path: '/assets/worldstream/gen3d-p37d/gen3d-test-acorn-lod1.glb' });
    const files = readdirSync(path.join(root, PUBLIC_DIR)).sort();
    expect(files).toEqual(['PROVENANCE.md', 'gen3d-test-acorn-lod0.glb', 'gen3d-test-acorn-lod1.glb', 'gen3d-test-acorn.png']);
    const names = read(root, 'disclosure.json').entries.map((record: { name: string }) => record.name);
    expect(names).toEqual(['public/other.png', ...files.map((file) => `${PUBLIC_DIR}/${file}`)]);
  }, 180_000);

  it('promoting the same id again replaces the entry instead of doubling it', async () => {
    const root = makeRoot();
    const batch = { schema: 'catalog-batch.v1', entries: [entry('gen3d-test-acorn', ['test acorn'])] };
    await promoteBatch(batch, { root, sync: false });
    // Téhož id dvakrát v jedné dávce: první nahradí starý záznam, druhé už narazí na obsazené id.
    const { promoted, skipped } = await promoteBatch({ ...batch, entries: [...batch.entries, ...batch.entries] }, { root, sync: false });

    expect(promoted).toEqual(['gen3d-test-acorn']);
    expect(skipped).toEqual([{ id: 'gen3d-test-acorn', reason: 'id already in the catalog outside gen3d-p37d' }]);
    const ids = read(root, 'src/assets/catalog.json').assets.map((asset: { assetId: string }) => asset.assetId);
    expect(ids).toEqual(['gen3d-taken', 'gen3d-test-acorn']);
    const names: string[] = read(root, 'disclosure.json').entries.map((record: { name: string }) => record.name);
    expect(new Set(names).size).toBe(names.length);
    expect(readFileSync(path.join(root, PUBLIC_DIR, 'PROVENANCE.md'), 'utf8').match(/gen3d-test-acorn/g)).toHaveLength(1);
  }, 180_000);

  it('skips a model normalize cannot finish and still promotes the rest', async () => {
    const root = makeRoot();
    const batch = {
      schema: 'catalog-batch.v1',
      entries: [entry('gen3d-test-broken', ['broken thing'], { glb: path.join(root, 'missing-lod0.glb') }), entry('gen3d-test-acorn', ['test acorn'])],
    };
    const { promoted, skipped } = await promoteBatch(batch, { root, sync: false });

    expect(promoted).toEqual(['gen3d-test-acorn']);
    expect(skipped).toEqual([{ id: 'gen3d-test-broken', reason: expect.stringMatching(/^normalize: /) }]);
    expect(read(root, 'src/assets/catalog.json').assets.map((asset: { assetId: string }) => asset.assetId)).toEqual(['gen3d-taken', 'gen3d-test-acorn']);
    expect(readdirSync(path.join(root, PUBLIC_DIR)).some((file) => file.includes('broken'))).toBe(false);
  }, 180_000);

  it('keeps the disclosure of a model replaced under the same id: a CC0 swap stays CC0 (P57 T8r)', async () => {
    const root = makeRoot();
    await promoteBatch({ schema: 'catalog-batch.v1', entries: [entry('gen3d-test-acorn', ['test acorn'])] }, { root, sync: false });
    const catalog = read(root, 'src/assets/catalog.json');
    Object.assign(catalog.assets[1].provenance, { license: CC0, replacedAt: '2026-10-22' });
    writeFileSync(path.join(root, 'src/assets/catalog.json'), JSON.stringify(catalog));
    const disclosure = read(root, 'disclosure.json');
    for (const record of disclosure.entries.filter((record: { name: string }) => record.name.includes('acorn'))) Object.assign(record, { license: CC0, firstParty: false });
    writeFileSync(path.join(root, 'disclosure.json'), JSON.stringify(disclosure));

    await promoteBatch({ schema: 'catalog-batch.v1', entries: [] }, { root, sync: false });

    const acorn = read(root, 'disclosure.json').entries.filter((record: { name: string }) => record.name.includes('acorn'));
    expect(acorn.map((record: { name: string }) => record.name).sort()).toEqual(['lod0.glb', 'lod1.glb', 'png'].map((end) => `${PUBLIC_DIR}/gen3d-test-acorn${end === 'png' ? '.png' : `-${end}`}`).sort());
    for (const record of acorn) expect(record).toMatchObject({ license: CC0, firstParty: false });
  }, 180_000);

  it('a skipped re-promotion of an own id keeps its old record, files and disclosure (P57 R3)', async () => {
    const root = makeRoot();
    await promoteBatch({ schema: 'catalog-batch.v1', entries: [entry('gen3d-test-acorn', ['test acorn'])] }, { root, sync: false });
    // CC0 výměna pod vlastním id (jako `gen3d-wildflower-patch`): vypadnout z katalogu, dostaly by její soubory záznam „vlastní generovaný“.
    const catalog = read(root, 'src/assets/catalog.json');
    Object.assign(catalog.assets[1].provenance, { license: CC0, replacedAt: '2026-10-22' });
    writeFileSync(path.join(root, 'src/assets/catalog.json'), JSON.stringify(catalog));
    const disclosure = read(root, 'disclosure.json');
    for (const record of disclosure.entries.filter((record: { name: string }) => record.name.includes('acorn'))) Object.assign(record, { license: CC0, firstParty: false });
    writeFileSync(path.join(root, 'disclosure.json'), JSON.stringify(disclosure));
    const files = readdirSync(path.join(root, PUBLIC_DIR)).filter((file) => file.includes('acorn'));
    const hashes = files.map((file) => sha(path.join(root, PUBLIC_DIR, file)));

    const { promoted, skipped } = await promoteBatch({
      schema: 'catalog-batch.v1',
      entries: [
        // Štítek modelu, který si nechá starý záznam, nový model nedostane.
        entry('gen3d-test-oak', ['test acorn']),
        entry('gen3d-test-acorn', ['test acorn'], { licence: 'CC-BY-4.0' }),
        entry('gen3d-test-acorn', ['test acorn'], { glb: path.join(root, 'missing-lod0.glb') }),
      ],
    }, { root, sync: false });

    expect(promoted).toEqual([]);
    expect(skipped).toEqual([
      { id: 'gen3d-test-oak', reason: '"test acorn" is already a tag of another catalog model' },
      { id: 'gen3d-test-acorn', reason: `licence CC-BY-4.0 is not the pipeline licence ${LICENSE}` },
      { id: 'gen3d-test-acorn', reason: expect.stringMatching(/^normalize: /) },
    ]);
    expect(read(root, 'src/assets/catalog.json').assets).toEqual(catalog.assets);
    expect(files.map((file) => sha(path.join(root, PUBLIC_DIR, file)))).toEqual(hashes);
    const acorn = read(root, 'disclosure.json').entries.filter((record: { name: string }) => record.name.includes('acorn'));
    expect(acorn).toHaveLength(3);
    for (const record of acorn) expect(record).toMatchObject({ license: CC0, firstParty: false });
  }, 180_000);

  it('drops an own model with its files and disclosure, and never a foreign one', async () => {
    const root = makeRoot();
    await promoteBatch({ schema: 'catalog-batch.v1', entries: [entry('gen3d-test-acorn', ['test acorn'])] }, { root, sync: false });
    const { dropped } = await promoteBatch({ schema: 'catalog-batch.v1', entries: [] }, { root, sync: false, drop: ['gen3d-test-acorn', 'gen3d-taken'] });

    expect(dropped).toEqual(['gen3d-test-acorn']);
    expect(read(root, 'src/assets/catalog.json').assets.map((asset: { assetId: string }) => asset.assetId)).toEqual(['gen3d-taken']);
    expect(readdirSync(path.join(root, PUBLIC_DIR))).toEqual(['PROVENANCE.md']);
    const names = read(root, 'disclosure.json').entries.map((record: { name: string }) => record.name);
    expect(names.some((name: string) => name.includes('acorn'))).toBe(false);
    expect(readFileSync(path.join(root, PUBLIC_DIR, 'PROVENANCE.md'), 'utf8')).not.toMatch(/acorn/);
  }, 180_000);

  it('refuses a batch that breaks the schema before touching anything', () => {
    const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts/p37d/promote-batch.mjs'), '--batch', path.join(ROOT, 'src/play/assets/__fixtures__/batch-no-licence.json')], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/invalid batch/);
    expect(existsSync(path.join(ROOT, 'asset-quarantine/acorn'))).toBe(false);
  });
});
