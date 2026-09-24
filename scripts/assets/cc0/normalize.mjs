#!/usr/bin/env node
/**
 * Převede vybrané CC0 modely na kontrakt katalogu (P26A T3).
 *
 *   node scripts/assets/cc0/normalize.mjs [--style] [--bake-colors]
 *                                              projde selection.json do asset-quarantine/cc0-*
 *
 * Každý model: statický glTF bez animací a rozšíření, nejvýš `MAX_TRIANGLES`
 * trojúhelníků. Textura barvy zůstává (P26A T8), zmenšená na `MAX_TEXTURE` px
 * jako PNG; části bez textury mají barvu materiálu v barvách vrcholů
 * (COLOR_0) a jen ty přebarví paleta (`--style`). `--bake-colors` vrátí
 * původní režim T3: i textura se zapeče do COLOR_0. Osy,
 * jednotky a podstavu srovná existující karanténa `import-external.mjs`
 * podle os a měřítka balíku; LOD1 je zjednodušený LOD0. Oba projdou
 * Khronos validací (`glb-meta.mjs validate`) bez chyb i varování.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Logger, NodeIO, Primitive, VertexLayout } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { clearNodeTransform, flatten, getBounds, join, prune, simplify, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

import { Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { metadata, validate } from '../glb-meta.mjs';
import { importExternal } from '../import-external.mjs';
import { isPurple, loadPalette, nearest, recolorDoc, toSrgb } from './palette.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
export const MAX_TRIANGLES = 5000;
const LOD1_RATIO = 0.5;
const KEEP_ATTRIBUTES = new Set(['POSITION', 'NORMAL', 'COLOR_0']);
const KEEP_TEXTURED = new Set([...KEEP_ATTRIBUTES, 'TEXCOORD_0']);
export const MAX_TEXTURE = 512;

export const quarantineDir = (assetId) => path.join(ROOT, 'asset-quarantine', assetId);

const io = () => new NodeIO().setLogger(new Logger(Logger.Verbosity.WARN)).registerExtensions(ALL_EXTENSIONS).setVertexLayout(VertexLayout.SEPARATE);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const frac = (x) => x - Math.floor(x);

function triangles(doc) {
  let count = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) count += (prim.getIndices()?.getCount() ?? prim.getAttribute('POSITION').getCount()) / 3;
  }
  return count;
}

/**
 * Textura nejvýš `MAX_TEXTURE` px jako PNG (jádro glTF, bez `EXT_texture_webp`);
 * fialové pixely nahradí nejbližší barva palety – pravidlo projektu platí i pro atlasy.
 */
async function shrinkTexture(doc, texture, palette) {
  const { data, info } = await sharp(Buffer.from(texture.getImage()))
    .resize(MAX_TEXTURE, MAX_TEXTURE, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let at = 0; at < data.length; at += 4) {
    const srgb = [data[at] / 255, data[at + 1] / 255, data[at + 2] / 255];
    if (!isPurple(srgb)) continue;
    toSrgb(nearest(srgb.map(toLinear), palette).linear).forEach((c, k) => { data[at + k] = Math.round(c * 255); });
  }
  const png = await sharp(data, { raw: info }).png().toBuffer();
  return doc.createTexture(texture.getName()).setImage(new Uint8Array(png)).setMimeType('image/png');
}

/**
 * Primitiva s texturou barvy si ji nechají: jedno UV (`TEXCOORD_0`, transformace
 * zapečená), textura zmenšená `shrinkTexture`, materiál bez dalších slotů a
 * rozšíření. Vrací množinu takových primitiv – paleta na ně nesahá, protože
 * atlas Kenney nese přechody a přebarvení po vrcholech je lámalo na střepy
 * různých barev palety (palačinky).
 */
async function keepTextures(doc, palette) {
  const textures = new Map();
  const materials = new Map();
  const kept = new Set();
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const source = prim.getMaterial();
      const texture = source?.getBaseColorTexture();
      if (prim.getMode() !== Primitive.Mode.TRIANGLES || !texture) continue;
      const info = source.getBaseColorTextureInfo();
      const transform = info.getExtension('KHR_texture_transform');
      if (transform && transform.getRotation() !== 0) throw new Error('rotated texture transform unsupported');
      const offset = transform?.getOffset() ?? [0, 0];
      const scale = transform?.getScale() ?? [1, 1];
      const uv = prim.getAttribute(`TEXCOORD_${transform?.getTexCoord() ?? info.getTexCoord()}`);
      if (!uv) continue;
      const out = new Float32Array(uv.getCount() * 2);
      const t = [0, 0];
      for (let i = 0; i < uv.getCount(); i++) {
        uv.getElement(i, t);
        out[i * 2] = t[0] * scale[0] + offset[0];
        out[i * 2 + 1] = t[1] * scale[1] + offset[1];
      }
      for (const semantic of prim.listSemantics()) if (!KEEP_TEXTURED.has(semantic)) prim.setAttribute(semantic, null);
      prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(out).setBuffer(doc.getRoot().listBuffers()[0]));
      if (!textures.has(texture)) textures.set(texture, await shrinkTexture(doc, texture, palette));
      const alpha = source.getAlphaMode();
      const key = [[...textures.keys()].indexOf(texture), source.getBaseColorFactor().join(), alpha, source.getDoubleSided()].join('|');
      if (!materials.has(key)) {
        const material = doc.createMaterial(`cc0-textured-${materials.size}`).setBaseColorTexture(textures.get(texture)).setBaseColorFactor(source.getBaseColorFactor())
          .setMetallicFactor(0).setRoughnessFactor(0.85).setAlphaMode(alpha).setDoubleSided(source.getDoubleSided());
        if (alpha === 'MASK') material.setAlphaCutoff(source.getAlphaCutoff());
        materials.set(key, material);
      }
      prim.setMaterial(materials.get(key));
      kept.add(prim);
    }
  }
  return kept;
}

/** Barvy textury × barva materiálu × COLOR_0 do COLOR_0; dva sdílené materiály místo všech. `skip` nechá být. */
async function bakeColors(doc, skip = new Set()) {
  const images = new Map();
  const pixels = async (texture) => {
    if (!images.has(texture)) {
      const { data, info } = await sharp(Buffer.from(texture.getImage())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      images.set(texture, { data, width: info.width, height: info.height });
    }
    return images.get(texture);
  };
  const shared = {};
  const material = (kind, doubleSided) => {
    const key = `${kind}${doubleSided ? '-2' : ''}`;
    shared[key] ??= doc.createMaterial(`cc0-${kind}`).setBaseColorFactor([1, 1, 1, 1]).setMetallicFactor(0).setRoughnessFactor(0.85)
      .setAlphaMode(kind === 'blend' ? 'BLEND' : 'OPAQUE').setDoubleSided(doubleSided);
    return shared[key];
  };

  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (skip.has(prim)) continue;
      if (prim.getMode() !== Primitive.Mode.TRIANGLES) { prim.dispose(); continue; }
      const source = prim.getMaterial();
      const count = prim.getAttribute('POSITION').getCount();
      const factor = source?.getBaseColorFactor() ?? [1, 1, 1, 1];
      const texture = source?.getBaseColorTexture() ?? null;
      const info = source?.getBaseColorTextureInfo() ?? null;
      const transform = info?.getExtension('KHR_texture_transform') ?? null;
      if (transform && transform.getRotation() !== 0) throw new Error('rotated texture transform unsupported');
      const offset = transform?.getOffset() ?? [0, 0];
      const scale = transform?.getScale() ?? [1, 1];
      const uv = texture ? prim.getAttribute(`TEXCOORD_${transform?.getTexCoord() ?? info.getTexCoord()}`) : null;
      const image = uv ? await pixels(texture) : null;
      const vertex = prim.getAttribute('COLOR_0');
      const blend = source !== null && source.getAlphaMode() === 'BLEND';
      const width = blend ? 4 : 3;
      const out = new Float32Array(count * width);
      const t = [0, 0];
      const c = [0, 0, 0, 0];
      for (let i = 0; i < count; i++) {
        const rgba = [...factor];
        if (image) {
          uv.getElement(i, t);
          const x = Math.min(image.width - 1, Math.floor(frac(t[0] * scale[0] + offset[0]) * image.width));
          const y = Math.min(image.height - 1, Math.floor(frac(t[1] * scale[1] + offset[1]) * image.height));
          const at = (y * image.width + x) * 4;
          for (let k = 0; k < 3; k++) rgba[k] *= toLinear(image.data[at + k] / 255);
          rgba[3] *= image.data[at + 3] / 255;
        }
        if (vertex) {
          vertex.getElement(i, c);
          for (let k = 0; k < vertex.getElementSize(); k++) rgba[k] *= c[k];
        }
        out.set(rgba.slice(0, width), i * width);
      }
      for (const semantic of prim.listSemantics()) if (!KEEP_ATTRIBUTES.has(semantic)) prim.setAttribute(semantic, null);
      for (const target of prim.listTargets()) target.dispose();
      prim.setAttribute('COLOR_0', doc.createAccessor().setType(blend ? 'VEC4' : 'VEC3').setArray(out).setBuffer(doc.getRoot().listBuffers()[0]));
      prim.setMaterial(material(blend ? 'blend' : 'opaque', source?.getDoubleSided() ?? false));
    }
  }
}

/** Jen statická geometrie: bez animací, kostí, kamer, rozšíření a textur mimo `keep`. */
function stripToStatic(doc, keep = new Set()) {
  const root = doc.getRoot();
  for (const animation of root.listAnimations()) animation.dispose();
  for (const node of root.listNodes()) { node.setSkin(null); node.setCamera(null); node.setWeights([]); }
  for (const skin of root.listSkins()) skin.dispose();
  for (const camera of root.listCameras()) camera.dispose();
  for (const texture of root.listTextures()) if (!keep.has(texture)) texture.dispose();
  for (const extension of root.listExtensionsUsed()) extension.dispose();
}

/** Dekódovaná paměť textur tak, jak ji počítá `src/assets/loader.ts` (RGBA + mipmapy). */
async function decodedTextureBytes(doc) {
  let bytes = 0;
  for (const texture of doc.getRoot().listTextures()) {
    const { width, height } = await sharp(Buffer.from(texture.getImage())).metadata();
    bytes += Math.ceil((width * height * 4 * 4) / 3);
  }
  return bytes;
}

/** Rozměr scény po osách. */
function sizeOf(doc) {
  const { min, max } = getBounds(doc.getRoot().listScenes()[0]);
  return [0, 1, 2].map((axis) => max[axis] - min[axis]);
}

/** LOD1 smí zjednodušit, ne zmenšit: loader odmítne rozměr pod 90 % katalogu, drží se 95 %. */
const keepsSize = (doc, size) => sizeOf(doc).every((extent, axis) => extent >= 0.95 * size[axis]);

/** Zjednoduší indexy každého primitiva i přes švy atributů (Permissive), nakonec hrubě (sloppy). */
function acrossSeams(doc, ratio) {
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const positions = new Float32Array(prim.getAttribute('POSITION').getArray());
      const source = prim.getIndices();
      const indices = source ? Uint32Array.from(source.getArray()) : Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
      const target = Math.max(3, Math.floor((indices.length * ratio) / 3) * 3);
      let [reduced] = MeshoptSimplifier.simplify(indices, positions, 3, target, 0.05, ['Permissive']);
      if (reduced.length >= indices.length) [reduced] = MeshoptSimplifier.simplifySloppy(indices, positions, 3, null, target, 0.05);
      if (reduced.length > 0 && reduced.length < indices.length) {
        prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(reduced).setBuffer(doc.getRoot().listBuffers()[0]));
      }
    }
  }
}

async function simplifyUnder(doc, limit) {
  await MeshoptSimplifier.ready;
  for (let error = 0.01; triangles(doc) >= limit && error <= 1; error *= 4) {
    await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: ((limit - 1) / triangles(doc)) * 0.95, error }), prune());
  }
  if (triangles(doc) >= limit) throw new Error(`cannot simplify under ${limit} triangles`);
}

/**
 * Jeden model z balíku → karanténa `asset-quarantine/<assetId>/` s LOD0 (`model.glb`),
 * LOD1 (`lod1.glb`) a `cc0.json`. Osy a jednotky bere z balíku (`up`, `front`, `metersPerUnit`).
 */
export async function normalizeModel({ input, assetId, label, tags, pack, licenseFile, sourceFile, style = false, keepTextures: keep = true }) {
  const doc = await io().read(input);
  if (doc.getRoot().listBuffers().length === 0) doc.createBuffer();
  const [buffer, ...extra] = doc.getRoot().listBuffers();
  for (const accessor of doc.getRoot().listAccessors()) accessor.setBuffer(buffer);
  for (const other of extra) other.dispose();

  const palette = loadPalette();
  const textured = keep ? await keepTextures(doc, palette) : new Set();
  await bakeColors(doc, textured);
  if (style) recolorDoc(doc, palette, textured);
  stripToStatic(doc, new Set([...textured].map((prim) => prim.getMaterial().getBaseColorTexture())));
  await doc.transform(prune(), flatten());
  // Transformace uzlů do vrcholů: pivoty částí pak nenesou float32 zaokrouhlení.
  for (const node of doc.getRoot().listNodes()) if (node.getMesh()) clearNodeTransform(node);
  await doc.transform(join(), weld(), prune());
  if (triangles(doc) >= MAX_TRIANGLES) await simplifyUnder(doc, MAX_TRIANGLES);

  const work = mkdtempSync(path.join(tmpdir(), 'cc0-'));
  try {
    const clean = path.join(work, 'clean.glb');
    writeFileSync(clean, await io().writeBinary(doc));
    const evidence = path.join(work, 'source.txt');
    writeFileSync(evidence, `pack: ${pack.id}\npage: ${pack.pageUrl}\nfile: ${sourceFile}\nsha256: ${sha256(readFileSync(input))}\nlicense: ${pack.license}\n`);

    rmSync(quarantineDir(assetId), { recursive: true, force: true });
    const { output, candidate } = await importExternal({
      input: clean,
      outputName: assetId,
      metadata: {
        assetId, label, tags, style: textured.size ? 'CC0 low-poly, texture at most 512 px' : 'CC0 low-poly, colours baked into vertices', author: pack.author,
        source: `${pack.pageUrl} (${sourceFile})`, license: pack.license, licenseEvidence: licenseFile, sourceEvidence: evidence,
        importedAt: new Date().toISOString().slice(0, 10), metersPerUnit: pack.metersPerUnit ?? 1, up: pack.up ?? '+Y', front: pack.front ?? '+Z', pivot: 'bottom-center',
      },
    });

    const lod0File = path.join(output, 'model.glb');
    // Katalog chce LOD1 ostře lehčí; malý model povolí větší chybu, než se zmenší.
    const lod0Doc = await io().read(lod0File);
    // Oba LOD projdou stejným zápisem, aby uzly nesly bit po bitu tytéž transformace.
    writeFileSync(lod0File, await io().writeBinary(lod0Doc));
    const lod0Triangles = triangles(lod0Doc);
    const lod0Size = sizeOf(lod0Doc);
    let lod1Doc;
    await MeshoptSimplifier.ready;
    for (let error = 0.02; error <= 1.5; error *= 4) {
      lod1Doc = await io().read(lod0File);
      await lod1Doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: LOD1_RATIO, error }), prune());
      if (triangles(lod1Doc) < lod0Triangles && keepsSize(lod1Doc, lod0Size)) break;
    }
    if (triangles(lod1Doc) >= lod0Triangles || !keepsSize(lod1Doc, lod0Size)) {
      // Švy barev a normál drží každý vrchol; dovolit slučování přes ně.
      lod1Doc = await io().read(lod0File);
      acrossSeams(lod1Doc, LOD1_RATIO);
      await lod1Doc.transform(prune());
    }
    if (triangles(lod1Doc) >= lod0Triangles || !keepsSize(lod1Doc, lod0Size)) throw new Error('LOD1 cannot be made lighter than LOD0 at the same size');
    const lod1File = path.join(output, 'lod1.glb');
    writeFileSync(lod1File, await io().writeBinary(lod1Doc));

    const lods = [];
    for (const [level, file] of [[0, lod0File], [1, lod1File]]) {
      const bytes = readFileSync(file);
      await validate(bytes, `${assetId}/${path.basename(file)}`);
      const meta = metadata(bytes);
      lods.push({ level, file, hash: sha256(bytes), bytes: bytes.length, triangles: meta.triangles, decodedGeometryBytes: meta.decodedGeometryBytes, decodedTextureBytes: await decodedTextureBytes(await io().read(file)), materials: meta.json.materials.length });
      if (style) {
        const purple = purpleColours(await io().read(file));
        if (purple) throw new Error(`purple vertex colour ${purple} survived recolouring`);
      }
    }
    // Pivoty částí tak, jak je spočítá GLTFLoader, ne karanténa ve float64.
    // Textury pryč: GLTFLoader je v Node dekódovat neumí a na uzly nemají vliv.
    const pivotDoc = await io().read(lod0File);
    for (const texture of pivotDoc.getRoot().listTextures()) texture.dispose();
    const bytes = Buffer.from(await io().writeBinary(pivotDoc));
    const scene = (await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), '')).scene;
    scene.updateMatrixWorld(true);
    for (const part of candidate.parts) part.pivot = scene.getObjectByName(part.node).getWorldPosition(new Vector3()).toArray();
    candidate.hash = lods[0].hash;
    const record = { assetId, pack: pack.id, sourceFile, lod0: lods[0], lod1: lods[1], bounds: candidate.bounds, candidate };
    writeFileSync(path.join(output, 'cc0.json'), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** První barva vrcholu, která je fialová (sRGB 0–255), nebo `null`. */
export function purpleColours(doc) {
  const element = [];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const colour = prim.getAttribute('COLOR_0');
      for (let i = 0; i < (colour?.getCount() ?? 0); i++) {
        const srgb = toSrgb(colour.getElement(i, element));
        if (isPurple(srgb)) return srgb.map((c) => Math.round(c * 255)).join(',');
      }
    }
  }
  return null;
}

/**
 * Náhled 256 px z barev vrcholů: trojúhelníky promítnuté kamerou zepředu
 * šikmo shora, stínované jedním světlem, seřazené odzadu (malířův algoritmus).
 */
export async function renderPreview(file) {
  const doc = await io().read(file);
  const tris = [];
  const points = [];
  const world = new Matrix4();
  const images = new Map();
  for (const texture of doc.getRoot().listTextures()) {
    images.set(texture, await sharp(Buffer.from(texture.getImage())).ensureAlpha().raw().toBuffer({ resolveWithObject: true }));
  }
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    world.fromArray(node.getWorldMatrix());
    for (const prim of mesh.listPrimitives()) {
      const position = prim.getAttribute('POSITION');
      const colour = prim.getAttribute('COLOR_0');
      const uv = prim.getAttribute('TEXCOORD_0');
      const factor = prim.getMaterial()?.getBaseColorFactor() ?? [1, 1, 1, 1];
      const image = images.get(prim.getMaterial()?.getBaseColorTexture());
      const indices = prim.getIndices();
      const vertex = (i) => new Vector3().fromArray(position.getElement(i, [])).applyMatrix4(world);
      const count = indices?.getCount() ?? position.getCount();
      for (let i = 0; i < count; i += 3) {
        const ids = [0, 1, 2].map((k) => (indices ? indices.getScalar(i + k) : i + k));
        const v = ids.map(vertex);
        const rgb = factor.slice(0, 3);
        if (colour) {
          const mean = [0, 0, 0];
          for (const id of ids) colour.getElement(id, []).slice(0, 3).forEach((c, k) => { mean[k] += c / 3; });
          mean.forEach((c, k) => { rgb[k] *= c; });
        }
        if (image && uv) {
          // Barva textury v těžišti UV trojúhelníku.
          const t = [0, 0];
          for (const id of ids) uv.getElement(id, []).forEach((c, k) => { t[k] += c / 3; });
          const x = Math.min(image.info.width - 1, Math.floor(frac(t[0]) * image.info.width));
          const y = Math.min(image.info.height - 1, Math.floor(frac(t[1]) * image.info.height));
          const at = (y * image.info.width + x) * 4;
          for (let k = 0; k < 3; k++) rgb[k] *= toLinear(image.data[at + k] / 255);
        }
        tris.push({ v, rgb, doubleSided: prim.getMaterial()?.getDoubleSided() ?? false });
        points.push(...v);
      }
    }
  }
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const p of points) { min.min(p); max.max(p); }
  const center = min.clone().add(max).multiplyScalar(0.5);
  const radius = max.clone().sub(min).length();
  const camera = new PerspectiveCamera(35, 1, 0.01, radius * 10 + 1);
  camera.position.copy(center).add(new Vector3(1.4, 0.9, 2.2).normalize().multiplyScalar(radius * 1.55));
  camera.lookAt(center);
  camera.updateMatrixWorld();
  const light = new Vector3(-1, 2, 3).normalize();
  const polygons = [];
  for (const { v, rgb, doubleSided } of tris) {
    const normal = v[1].clone().sub(v[0]).cross(v[2].clone().sub(v[0])).normalize();
    const facing = normal.dot(camera.position.clone().sub(v[0]));
    if (facing <= 0 && !doubleSided) continue;
    if (facing < 0) normal.negate();
    const shade = 0.55 + Math.max(0, normal.dot(light)) * 0.45;
    const hex = toSrgb(rgb.map((c) => c * shade)).map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
    const projected = v.map((p) => p.clone().project(camera));
    polygons.push({ z: projected.reduce((sum, p) => sum + p.z, 0), svg: `<polygon points="${projected.map((p) => `${((p.x + 1) * 128).toFixed(1)},${((1 - p.y) * 128).toFixed(1)}`).join(' ')}" fill="#${hex}" stroke="#${hex}" stroke-width="0.4"/>` });
  }
  polygons.sort((a, b) => b.z - a.z);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e8edf0"/>${polygons.map((p) => p.svg).join('')}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Kontaktní arch: náhledy v mřížce po šesti, pod každým id modelu. */
export async function contactSheet(previews) {
  const cell = 256;
  const caption = 28;
  const columns = 6;
  const rows = Math.max(1, Math.ceil(previews.length / columns));
  const layers = previews.flatMap(({ id, png }, i) => {
    const left = (i % columns) * cell;
    const top = Math.floor(i / columns) * (cell + caption);
    const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="${caption}"><rect width="${cell}" height="${caption}" fill="#1b1f24"/><text x="${cell / 2}" y="19" font-family="Arial, sans-serif" font-size="14" fill="#f3f1ea" text-anchor="middle">${id}</text></svg>`);
    return [{ input: png, left, top }, { input: label, left, top: top + cell }];
  });
  return sharp({ create: { width: columns * cell, height: rows * (cell + caption), channels: 3, background: '#e8edf0' } }).composite(layers).png().toBuffer();
}

/** Id modelu v katalogu: `cc0-<jméno>[-<význam>]`. */
export const assetIdOf = (entry) => `cc0-${entry.noun.replaceAll(' ', '-')}${entry.sense ? `-${entry.sense}` : ''}`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const read = (file) => JSON.parse(readFileSync(path.join(HERE, file), 'utf8'));
  const selection = read('selection.json');
  const fetched = read('fetched.json');
  const packs = new Map(read('sources.json').packs.map((pack) => [pack.id, pack]));
  const records = new Map(fetched.packs.map((record) => [record.pack, record]));
  const style = process.argv.includes('--style');
  // Výchozí `--keep-textures`; `--bake-colors` vrátí zapečení textur do barev vrcholů.
  const keepTextures = !process.argv.includes('--bake-colors');
  const previewDir = path.join(ROOT, 'public/assets/worldstream/cc0');
  const previews = [];
  const normalized = [];
  const failed = [];
  for (const entry of selection.selected) {
    const assetId = assetIdOf(entry);
    const pack = packs.get(entry.pack);
    try {
      const record = await normalizeModel({
        input: path.join(fetched.cache, entry.pack, entry.file),
        assetId,
        label: `${entry.noun[0].toUpperCase()}${entry.noun.slice(1)} (CC0, ${pack.author.replace(/ \(.*\)$/, '')})`,
        tags: [entry.noun],
        pack,
        licenseFile: records.get(entry.pack).licenseFile.replace('<cache>', fetched.cache),
        sourceFile: entry.file,
        style,
        keepTextures,
      });
      if (style) {
        const png = await renderPreview(record.lod0.file);
        mkdirSync(previewDir, { recursive: true });
        writeFileSync(path.join(previewDir, `${assetId}.png`), png);
        previews.push({ id: assetId, png });
      }
      normalized.push({ ...entry, assetId, styled: style, triangles: [record.lod0.triangles, record.lod1.triangles] });
      console.log(`${assetId}: ${record.lod0.triangles}/${record.lod1.triangles} triangles`);
    } catch (error) {
      failed.push({ assetId, pack: entry.pack, file: entry.file, error: error.message });
      console.log(`${assetId}: FAILED – ${error.message}`);
    }
  }
  mkdirSync(path.join(ROOT, 'asset-quarantine'), { recursive: true });
  writeFileSync(path.join(ROOT, 'asset-quarantine', 'cc0-manifest.json'), `${JSON.stringify({ normalized, failed }, null, 2)}\n`);
  if (style) writeFileSync(path.join(previewDir, '_contact-sheet.png'), await contactSheet(previews));
  console.log(`${normalized.length} normalized, ${failed.length} failed`);
}
