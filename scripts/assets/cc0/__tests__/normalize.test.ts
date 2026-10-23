import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Document, NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';

import { metadata, validate } from '../../glb-meta.mjs';
import { HERO_MAX_TRIANGLES, MAX_TRIANGLES, normalizeModel, quarantineDir } from '../normalize.mjs';
import { isPurple, loadPalette } from '../palette.mjs';

const work = mkdtempSync(path.join(tmpdir(), 'cc0-normalize-'));
const ids: string[] = [];
afterAll(() => {
  for (const id of ids) rmSync(quarantineDir(id), { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

const license = path.join(work, 'LICENSE.txt');
writeFileSync(license, 'Creative Commons Zero, CC0');

/** Kvádr o rozměrech `size` s rohem v `corner`, volitelně s UV do textury. */
function box(doc: Document, size: [number, number, number], corner: [number, number, number], uv?: [number, number]) {
  const [sx, sy, sz] = size;
  const [cx, cy, cz] = corner;
  const p: number[] = [];
  const faces = [
    [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],
    [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
    [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
  ];
  const idx: number[] = [];
  for (const face of faces) {
    const base = p.length / 3;
    for (const [x, y, z] of face) p.push(cx + x * sx, cy + y * sy, cz + z * sz);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(p)))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(idx)));
  if (uv) prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(Array.from({ length: p.length / 3 }, () => uv).flat())));
  return prim;
}

/** Koule s `segments²` trojúhelníky – model nad stropem. */
function sphere(doc: Document, segments: number) {
  const p: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= segments; i++) {
    for (let j = 0; j <= segments; j++) {
      const t = (i / segments) * Math.PI;
      const f = (j / segments) * Math.PI * 2;
      p.push(Math.sin(t) * Math.cos(f), Math.cos(t) + 1, Math.sin(t) * Math.sin(f));
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * (segments + 1) + j;
      const b = a + segments + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(p)))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(idx)));
}

async function writeFixture(name: string, build: (doc: Document) => Promise<void> | void): Promise<string> {
  const doc = new Document();
  doc.createBuffer();
  await build(doc);
  const file = path.join(work, `${name}.glb`);
  writeFileSync(file, await new NodeIO().writeBinary(doc));
  return file;
}

const pack = (over: Record<string, unknown> = {}) => ({ id: 'test-pack', author: 'Test Author', license: 'CC0-1.0', pageUrl: 'https://example.test/pack', up: '+Y', front: '+Z', metersPerUnit: 1, ...over });

async function run(assetId: string, input: string, packOver: Record<string, unknown> = {}, options: { style?: boolean; keepTextures?: boolean; maxTriangles?: number; lod1Max?: number } = {}) {
  ids.push(assetId);
  rmSync(quarantineDir(assetId), { recursive: true, force: true });
  return normalizeModel({ input, assetId, label: assetId, tags: [assetId], pack: pack(packOver), licenseFile: license, sourceFile: 'Models/x.glb', ...options });
}

/** Textura `size`² jako atlas Kenney: svislý přechod oranžové (světlá → tmavá), pravý horní roh fialový. */
async function gradientAtlas(size: number) {
  const raw = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const shade = 1 - (0.3 * y) / size;
      raw.set(x > size / 2 && y < size / 4 ? [150, 60, 220, 255] : [Math.round(235 * shade), Math.round(146 * shade), Math.round(104 * shade), 255], (y * size + x) * 4);
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
}

describe('normalizeModel', () => {
  it('turns a Z-up model in centimetres into metres, +Y up, base on the floor, centred', async () => {
    // 100 cm × 50 cm půdorys, 300 cm vysoký podél +Z, roh mimo počátek.
    const input = await writeFixture('zup-cm', (doc) => {
      const mat = doc.createMaterial('paint').setBaseColorFactor([0.8, 0.2, 0.1, 1]);
      doc.createScene().addChild(doc.createNode('box').setMesh(doc.createMesh().addPrimitive(box(doc, [100, 50, 300], [40, -20, 10]).setMaterial(mat))));
    });
    const result = await run('test-p26a-zup-cm', input, { up: '+Z', front: '-Y', metersPerUnit: 0.01 });
    const { min, max } = result.bounds;
    expect(max[1] - min[1]).toBeCloseTo(3, 4); // výška = původní Z
    expect(max[0] - min[0]).toBeCloseTo(1, 4);
    expect(max[2] - min[2]).toBeCloseTo(0.5, 4);
    expect(min[1]).toBeCloseTo(0, 5);
    expect((min[0] + max[0]) / 2).toBeCloseTo(0, 5);
    expect((min[2] + max[2]) / 2).toBeCloseTo(0, 5);
    for (const lod of [result.lod0, result.lod1]) await validate(readFileSync(lod.file), lod.file);
  });

  it('keeps a Y-up metre model upright and still moves its pivot to the base centre', async () => {
    const input = await writeFixture('yup-m', (doc) => {
      const mat = doc.createMaterial('paint').setBaseColorFactor([0.1, 0.5, 0.2, 1]);
      doc.createScene().addChild(doc.createNode('box').setMesh(doc.createMesh().addPrimitive(box(doc, [0.4, 2, 0.6], [5, 3, -7]).setMaterial(mat))));
    });
    const { bounds } = await run('test-p26a-yup-m', input);
    expect(bounds.max[1] - bounds.min[1]).toBeCloseTo(2, 5);
    expect(bounds.min[1]).toBeCloseTo(0, 5);
    expect(bounds.max[0]).toBeCloseTo(0.2, 5);
    expect(bounds.max[2]).toBeCloseTo(0.3, 5);
  });

  it('bakes a palette texture into vertex colours and keeps at most two materials, no textures', async () => {
    const input = await writeFixture('textured', async (doc) => {
      // Levá půlka textury červená, pravá modrá; kvádr sahá UV do modré.
      const raw = Buffer.alloc(8 * 8 * 4);
      for (let i = 0; i < 64; i++) raw.set(i % 8 < 4 ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4);
      const png = await sharp(raw, { raw: { width: 8, height: 8, channels: 4 } }).png().toBuffer();
      const texture = doc.createTexture('colormap').setImage(new Uint8Array(png)).setMimeType('image/png');
      const mesh = doc.createMesh();
      for (let k = 0; k < 4; k++) {
        const mat = doc.createMaterial(`m${k}`).setBaseColorTexture(texture).setAlphaMode(k === 3 ? 'BLEND' : 'OPAQUE');
        mesh.addPrimitive(box(doc, [1, 1, 1], [k * 1.5, 0, 0], [0.8, 0.5]).setMaterial(mat));
      }
      doc.createScene().addChild(doc.createNode('boxes').setMesh(mesh));
    });
    const result = await run('test-p26a-textured', input, {}, { keepTextures: false });
    const { json } = metadata(readFileSync(result.lod0.file));
    expect(json.images ?? []).toHaveLength(0);
    expect(json.textures ?? []).toHaveLength(0);
    expect(json.materials.length).toBeLessThanOrEqual(2);
    const doc = await new NodeIO().read(result.lod0.file);
    const colors = doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives()).map((p) => p.getAttribute('COLOR_0'));
    expect(colors.every(Boolean)).toBe(true);
    const first = colors[0]!.getElement(0, []);
    expect(first[2]).toBeGreaterThan(0.9); // modrá
    expect(first[0]).toBeLessThan(0.05);
  });

  it('keeps a 2048 px texture at most 512 px, recolours only the untextured part to the palette', async () => {
    const png = await gradientAtlas(2048);
    const input = await writeFixture('atlas', (doc) => {
      const texture = doc.createTexture('colormap').setImage(new Uint8Array(png)).setMimeType('image/png');
      const textured = doc.createMaterial('colormap').setBaseColorTexture(texture);
      const paint = doc.createMaterial('paint').setBaseColorFactor([0.1, 0.5, 0.2, 1]);
      const mesh = doc.createMesh();
      // Tři kvádry vzorkují různé výšky přechodu, čtvrtý fialový roh; pátý je bez textury.
      [0.3, 0.6, 0.9].forEach((v, k) => mesh.addPrimitive(box(doc, [1, 1, 1], [k * 1.5, 0, 0], [0.25, v]).setMaterial(textured)));
      mesh.addPrimitive(box(doc, [1, 1, 1], [4.5, 0, 0], [0.9, 0.1]).setMaterial(textured));
      mesh.addPrimitive(box(doc, [1, 1, 1], [6, 0, 0]).setMaterial(paint));
      doc.createScene().addChild(doc.createNode('atlas').setMesh(mesh));
    });
    const result = await run('test-p26a-atlas', input, {}, { style: true });

    const doc = await new NodeIO().read(result.lod0.file);
    const images = doc.getRoot().listTextures();
    expect(images).toHaveLength(1);
    const { data, info } = await sharp(Buffer.from(images[0].getImage()!)).raw().toBuffer({ resolveWithObject: true });
    expect(Math.max(info.width, info.height)).toBeLessThanOrEqual(512);
    expect(result.lod0.decodedTextureBytes).toBe(Math.ceil((info.width * info.height * 4 * 4) / 3));
    expect(result.lod1.decodedTextureBytes).toBe(result.lod0.decodedTextureBytes);
    // Přechod přežil – světlý a tmavý konec se liší; fialová ne.
    const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)].map((c) => c / 255);
    expect(pixel(0, 0)[0] - pixel(0, info.height - 1)[0]).toBeGreaterThan(0.15);
    for (let i = 0; i < info.width * info.height; i++) expect(isPurple(pixel(i % info.width, Math.floor(i / info.width)))).toBe(false);

    const prims = doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives());
    const texturedPrims = prims.filter((p) => p.getMaterial()?.getBaseColorTexture());
    expect(texturedPrims.length).toBeGreaterThan(0);
    for (const p of texturedPrims) expect(p.getAttribute('TEXCOORD_0')).toBeTruthy();
    // Paleta jen na části bez textury: barvy vrcholů jsou přesně barvy palety.
    const palette: number[][] = loadPalette().map((entry: { linear: number[] }) => entry.linear);
    const plain = prims.filter((p) => !p.getMaterial()?.getBaseColorTexture());
    expect(plain.length).toBeGreaterThan(0);
    for (const p of plain) {
      const colour = p.getAttribute('COLOR_0')!;
      for (let i = 0; i < colour.getCount(); i++) {
        const c = colour.getElement(i, []);
        expect(palette.some((entry) => entry.every((v, k) => Math.abs(v - c[k]) < 1e-5))).toBe(true);
      }
    }
    for (const lod of [result.lod0, result.lod1]) await validate(readFileSync(lod.file), lod.file);
  });

  it(`simplifies a dense model under ${MAX_TRIANGLES} triangles and makes a lighter LOD1`, async () => {
    const input = await writeFixture('dense', (doc) => {
      const mat = doc.createMaterial('paint').setBaseColorFactor([0.9, 0.9, 0.2, 1]);
      doc.createScene().addChild(doc.createNode('ball').setMesh(doc.createMesh().addPrimitive(sphere(doc, 80).setMaterial(mat))));
    });
    const result = await run('test-p26a-dense', input);
    expect(result.lod0.triangles).toBeLessThan(MAX_TRIANGLES);
    expect(result.lod1.triangles).toBeLessThan(result.lod0.triangles);
    expect(result.bounds.max[1] - result.bounds.min[1]).toBeCloseTo(2, 1);
  });

  it('a hero budget keeps LOD0 above the default cap and holds LOD1 to the replaced model (P57 T8)', async () => {
    const input = await writeFixture('dense-hero', (doc) => {
      const mat = doc.createMaterial('paint').setBaseColorFactor([0.9, 0.9, 0.2, 1]);
      doc.createScene().addChild(doc.createNode('ball').setMesh(doc.createMesh().addPrimitive(sphere(doc, 80).setMaterial(mat))));
    });
    const result = await run('test-p57-hero', input, {}, { maxTriangles: HERO_MAX_TRIANGLES, lod1Max: 1200 });
    expect(result.lod0.triangles).toBeGreaterThan(MAX_TRIANGLES);
    expect(result.lod0.triangles).toBeLessThan(HERO_MAX_TRIANGLES);
    expect(result.lod1.triangles).toBeLessThanOrEqual(1200);
    expect(result.bounds.max[1] - result.bounds.min[1]).toBeCloseTo(2, 1);
  });
});
