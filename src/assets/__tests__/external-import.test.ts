import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
// @ts-expect-error Explicit Node-only offline tool, not part of the runtime bundle.
import { importExternal, readGlb, writeGlb } from '../../../scripts/assets/import-external.mjs';
import catalog from '../catalog.json';
import { createAssetManifest } from '../manifest';
import { createAssetLoader } from '../loader';
import { disposeSubtree } from '@/components/viewer/dispose';

const fixture = catalog.assets.find(a => a.assetId === 'chair') ?? catalog.assets[0];
const input = `public${fixture.lods[0].path}`;
const evidence = 'public/assets/worldstream/PROVENANCE.md';
const metadata = { assetId: 'fixture-external-import', label: 'EXISTING LOCAL FIXTURE - not generated', tags: ['fixture'],
  style: 'fixture', author: 'Worldsmith fixture', source: input, license: 'LicenseRef-Worldsmith-Original',
  sourceEvidence: evidence, licenseEvidence: evidence, importedAt: '2026-09-17',
  metersPerUnit: 0.01, up: '+Z', front: '-Y', pivot: 'bottom-center' };
const owned = new Set<string>();
const outputName = () => { const name = `fixture-${randomUUID()}`; owned.add(path.resolve('asset-quarantine', name)); return name; };
afterAll(async () => {
  for (const directory of owned) {
    if (path.dirname(directory) !== path.resolve('asset-quarantine') || !/^(fixture|input)-[a-f0-9-]{36}$/.test(path.basename(directory))) throw new Error('Unsafe test cleanup target');
    await rm(directory, { recursive: true, force: true });
  }
});
async function mutated(change: (doc: any, bin: Buffer) => { bin?: Buffer } | void) {
  const { doc, bin } = readGlb(await readFile(input)); const result = change(doc, bin);
  const directory = `asset-quarantine/input-${randomUUID()}`; owned.add(path.resolve(directory)); await mkdir(directory, { recursive: true });
  const file = `${directory}/input.glb`; await writeFile(file, writeGlb(doc, result?.bin ?? bin)); return file;
}

describe('offline external GLB quarantine importer', () => {
  it('normalizes an existing fixture, emits exact metadata and loads through the actual production loader', async () => {
    const before = await readFile('src/assets/catalog.json');
    const result = await importExternal({ input, metadata, outputName: outputName() });
    expect(result.report.status).toBe('QUARANTINED_NOT_APPROVED');
    const candidate = result.candidate;
    expect(candidate.bounds.min[1]).toBeCloseTo(0, 8);
    expect(candidate.bounds.min[0] + candidate.bounds.max[0]).toBeCloseTo(0, 8);
    expect(candidate.bounds.max[1] - candidate.bounds.min[1]).toBeCloseTo((fixture.bounds.max[2] - fixture.bounds.min[2]) * .01, 5);
    const bytes = await readFile(`${result.output}/model.glb`);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(candidate.hash);
    const manifest = createAssetManifest(JSON.parse(await readFile(`${result.output}/candidate.json`, 'utf8')));
    const loaded = await createAssetLoader(manifest, { fetch: async () => new Response(bytes) })
      .load({ kind: 'asset', assetId: candidate.assetId, version: 1, hash: candidate.hash });
    expect(loaded.triangles).toBe(candidate.lods[0].triangles);
    expect(loaded.geometryBytes).toBe(candidate.lods[0].decodedGeometryBytes);
    expect(candidate.parts.length).toBeGreaterThan(0); disposeSubtree(loaded.object);
    expect(await readFile('src/assets/catalog.json')).toEqual(before);
    await expect(importExternal({ input, metadata, outputName: result.output.split(/[\\/]/).at(-1) })).rejects.toThrow();
  });

  it('converts an embedded JPEG into bounded RGBA PNG without external image fetching', async () => {
    const jpg = await sharp({ create: { width: 8, height: 4, channels: 3, background: '#669988' } }).jpeg().toBuffer();
    const file = await mutated((doc, bin) => {
      const offset = Math.ceil(bin.length / 4) * 4;
      doc.images = [{ mimeType: 'image/jpeg', bufferView: doc.bufferViews.length }];
      doc.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: jpg.length });
      doc.buffers[0].byteLength = offset + jpg.length;
      return { bin: Buffer.concat([bin, Buffer.alloc(offset - bin.length), jpg]) };
    });
    const result = await importExternal({ input: file, metadata, outputName: outputName() });
    const { doc, bin } = readGlb(await readFile(`${result.output}/model.glb`));
    expect(doc.images[0].mimeType).toBe('image/png');
    const view = doc.bufferViews[doc.images[0].bufferView];
    const info = await sharp(bin.subarray(view.byteOffset, view.byteOffset + view.byteLength)).metadata();
    expect(info).toMatchObject({ format: 'png', width: 8, height: 4, channels: 4 });
    expect(result.candidate.lods[0].decodedTextureBytes).toBe(Math.ceil(8 * 4 * 4 * 4 / 3));
  });

  it.each(['uri', 'extension', 'animation', 'count', 'cycle'])('rejects unsupported %s before writing a candidate', async kind => {
    const file = await mutated(doc => {
      if (kind === 'uri') doc.buffers[0].uri = 'https://example.invalid/model.bin';
      if (kind === 'extension') doc.extensionsUsed = ['KHR_draco_mesh_compression'];
      if (kind === 'animation') doc.animations = [{}];
      if (kind === 'count') doc.accessors[0].count = 100000000;
      if (kind === 'cycle') doc.nodes[0].children = [0];
    });
    await expect(importExternal({ input: file, metadata, outputName: outputName() })).rejects.toThrow();
  });

  it('preserves linear normal samples despite ICC metadata, and rejects mixed color/data use', async () => {
    const png=await sharp({create:{width:2,height:2,channels:3,background:'#8040ff'}}).withIccProfile('p3').png().toBuffer();
    const expected=await sharp(png,{ignoreIcc:true}).ensureAlpha().raw().toBuffer();
    const file=await mutated((doc,sourceBin)=>{
      let bin=Buffer.from(sourceBin.subarray(0,doc.buffers[0].byteLength));
      const append=(bytes:Buffer)=>{const offset=Math.ceil(bin.length/4)*4; const index=doc.bufferViews.length;
        doc.bufferViews.push({buffer:0,byteOffset:offset,byteLength:bytes.length});
        bin=Buffer.concat([bin,Buffer.alloc(offset-bin.length),bytes]); return index;};
      doc.images=[{mimeType:'image/png',bufferView:append(png)}]; doc.textures=[{source:0}];
      for(const mesh of doc.meshes)for(const primitive of mesh.primitives){
        const count=doc.accessors[primitive.attributes.POSITION].count;
        primitive.attributes.TEXCOORD_0=doc.accessors.length;
        doc.accessors.push({bufferView:append(Buffer.alloc(count*8)),componentType:5126,count,type:'VEC2'});
      }
      doc.materials[0].normalTexture={index:0}; doc.buffers[0].byteLength=bin.length;
      return {bin};
    });
    const result=await importExternal({input:file,metadata,outputName:outputName()});
    const output=readGlb(await readFile(`${result.output}/model.glb`));const view=output.doc.bufferViews[output.doc.images[0].bufferView];
    expect(await sharp(output.bin.subarray(view.byteOffset,view.byteOffset+view.byteLength)).raw().toBuffer()).toEqual(expected);
    const original=readGlb(await readFile(file));original.doc.materials[0].pbrMetallicRoughness.baseColorTexture={index:0};
    await writeFile(file,writeGlb(original.doc,original.bin));
    await expect(importExternal({input:file,metadata,outputName:outputName()})).rejects.toThrow(/both color and linear data/);
  });
  it.each(['assetId', 'license', 'sourceEvidence', 'metersPerUnit', 'up', 'pivot'])('requires explicit %s', async field => {
    await expect(importExternal({ input, metadata: { ...metadata, [field]: undefined }, outputName: outputName() })).rejects.toThrow();
  });
  it('refuses production paths and contradictory axes', async () => {
    await expect(importExternal({ input, metadata, outputName: '../public/assets/worldstream' })).rejects.toThrow('Quarantine');
    await expect(importExternal({ input, metadata: { ...metadata, front: '-Z' }, outputName: outputName() })).rejects.toThrow('perpendicular');
  });
});
