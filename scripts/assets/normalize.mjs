#!/usr/bin/env node
/** Reproducible first-party import pipeline. No runtime model URL or downloads.
 * node scripts/assets/normalize.mjs          rebuild GLBs, manifest, thumbnails
 * node scripts/assets/normalize.mjs --check validate committed bytes and metadata
 * Inputs are original meter-space models in originals.mjs, not third-party GLBs.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as T from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import validator from 'gltf-validator';
import sharp from 'sharp';
import { buildModels } from './originals.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = path.join(root, 'public/assets/worldstream');
const catalogPath = path.join(root, 'src/assets/catalog.json');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceHash = hash(await readFile(new URL('./originals.mjs', import.meta.url)));
const read = (file) => readFile(path.join(root, file));
const check = process.argv.includes('--check');
const componentBytes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
function metadata(bytes) {
  const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
  return {
    json,
    triangles: json.meshes.reduce((sum, m) => sum + m.primitives.reduce((n, p) => n + json.accessors[p.indices ?? p.attributes.POSITION].count / 3, 0), 0),
    decodedGeometryBytes: json.accessors.reduce((sum, a) => sum + a.count * components[a.type] * componentBytes[a.componentType], 0),
  };
}
async function validate(bytes, name) {
  const report = await validator.validateBytes(new Uint8Array(bytes), { uri: name, maxIssues: 100 });
  if (report.issues.numErrors || report.issues.numWarnings) throw new Error(`${name}: ${JSON.stringify(report.issues)}`);
  return { file: name, errors: report.issues.numErrors, warnings: report.issues.numWarnings };
}
// GLTFExporter only needs FileReader for its final binary Blob in Node.
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then((result) => { this.result = result; this.onloadend?.(); }); }
};

/** Actual model projection, not a symbolic placeholder. Flat-shaded triangle
 * raster preview is sufficient for a catalog thumbnail; production uses PBR. */
async function thumbnail(scene, file) {
  scene.updateMatrixWorld(true);
  const bounds = new T.Box3().setFromObject(scene), center = bounds.getCenter(new T.Vector3());
  const camera = new T.PerspectiveCamera(35, 1, 0.01, 100);
  const radius = bounds.getSize(new T.Vector3()).length();
  camera.position.copy(center).add(new T.Vector3(1.4, 0.9, 2.2).normalize().multiplyScalar(radius * 1.65));
  camera.lookAt(center); camera.updateMatrixWorld();
  const tris = [], light = new T.Vector3(-1, 2, 3).normalize();
  scene.traverse((mesh) => {
    if (!mesh.isMesh) return;
    const g = mesh.geometry, pos = g.attributes.position, indices = g.index;
    for (let i = 0; i < (indices?.count ?? pos.count); i += 3) {
      const v = [0, 1, 2].map((k) => new T.Vector3().fromBufferAttribute(pos, indices ? indices.getX(i + k) : i + k).applyMatrix4(mesh.matrixWorld));
      const normal = v[1].clone().sub(v[0]).cross(v[2].clone().sub(v[0])).normalize();
      if (mesh.material.side !== T.DoubleSide && normal.dot(camera.position.clone().sub(v[0])) <= 0) continue;
      const color = mesh.material.color.clone().multiplyScalar(0.55 + Math.max(0, normal.dot(light)) * 0.45);
      const projected = v.map((p) => p.project(camera));
      tris.push({ z: projected.reduce((s, p) => s + p.z, 0), svg: `<polygon points="${projected.map((p) => `${((p.x + 1) * 128).toFixed(2)},${((1 - p.y) * 128).toFixed(2)}`).join(' ')}" fill="#${color.getHexString()}" opacity="${mesh.material.opacity}"/>` });
    }
  });
  tris.sort((a, b) => b.z - a.z);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e8edf0"/>${tris.map((t) => t.svg).join('')}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

const reports = [];
if (check) {
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const sources = [buildModels(0), buildModels(1)];
  for (const asset of catalog.assets) {
    if (asset.provenance.sourceHash !== sourceHash) throw new Error(`${asset.assetId}: stale source hash`);
    for (const lod of asset.lods) {
      const bytes = await read(`public${lod.path}`), meta = metadata(bytes);
      if (hash(bytes) !== lod.hash || bytes.length !== lod.bytes || meta.triangles !== lod.triangles || meta.decodedGeometryBytes !== lod.decodedGeometryBytes) throw new Error(`${lod.path}: stale metadata`);
      const source = sources[lod.level].find((model) => model.id === asset.assetId);
      const rebuilt = Buffer.from(await new GLTFExporter().parseAsync(source.scene, { binary: true, onlyVisible: true }));
      if (hash(rebuilt) !== lod.hash) throw new Error(`${lod.path}: original source does not reproduce the committed GLB`);
      reports.push(await validate(bytes, lod.path));
    }
    await read(`public${asset.thumbnail}`);
  }
} else {
  await mkdir(out, { recursive: true });
  const levels = [buildModels(0), buildModels(1)], assets = [];
  for (let i = 0; i < levels[0].length; i++) {
    const model = levels[0][i], lods = []; let baseMeta;
    for (let level = 0; level < levels.length; level++) {
      const scene = levels[level][i].scene;
      scene.updateMatrixWorld(true);
      const bytes = Buffer.from(await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: true }));
      const filename = `${model.id}-lod${level}.glb`, meta = metadata(bytes);
      reports.push(await validate(bytes, filename));
      await writeFile(path.join(out, filename), bytes);
      lods.push({ level, path: `/assets/worldstream/${filename}`, hash: hash(bytes), bytes: bytes.length, triangles: meta.triangles, decodedGeometryBytes: meta.decodedGeometryBytes, decodedTextureBytes: 0, minScreenPixels: level ? 0 : 160 });
      if (!level) baseMeta = meta;
    }
    // One conservative catalog bound encloses both LODs, including rotated leaves.
    const box = new T.Box3().setFromObject(model.scene, true);
    for (const level of levels.slice(1)) box.union(new T.Box3().setFromObject(level[i].scene, true));
    const bounds = { min: box.min.toArray(), max: box.max.toArray() };
    await thumbnail(model.scene, path.join(out, `${model.id}.png`));
    assets.push({ assetId: model.id, version: 1, hash: lods[0].hash, label: model.label, tags: model.tags,
      style: 'original stylized PBR', thumbnail: `/assets/worldstream/${model.id}.png`,
      provenance: { source: 'scripts/assets/originals.mjs', author: 'Worldsmith project — Codex-assisted original geometry', license: 'LicenseRef-Worldsmith-Original', licenseEvidence: 'public/assets/worldstream/PROVENANCE.md', importedAt: '2026-09-17', sourceHash },
      units: 'meters', up: '+Y', front: '+Z', pivot: [0, 0, 0], bounds, stretchableAxes: [], lods,
      materials: baseMeta.json.materials.map((m, n) => ({ id: `material-${n}`, name: m.name, alphaMode: m.alphaMode ?? 'OPAQUE', doubleSided: m.doubleSided ?? false })),
      collision: [{ kind: 'box', bounds }], sockets: model.sockets, supportSurfaces: model.supportSurfaces, parts: model.parts,
    });
  }
  await writeFile(catalogPath, `${JSON.stringify({ version: 'worldstream-assets-v1', assets }, null, 2)}\n`);
}
console.log(JSON.stringify({ mode: check ? 'check' : 'build', validator: 'Khronos glTF Validator', files: reports }, null, 2));
