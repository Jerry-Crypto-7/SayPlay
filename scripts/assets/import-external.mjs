#!/usr/bin/env node
/** Offline, explicit local input -> quarantine only. Never fetches or approves assets.
 * node scripts/assets/import-external.mjs input.glb metadata.json quarantine-name
 * Metadata requires assetId,label,tags,style,author,source,license,licenseEvidence,
 * sourceEvidence (local files), importedAt, metersPerUnit, up, front, pivot:'bottom-center'. */
import { open, writeFile, mkdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Box3, Matrix4, Quaternion, Vector3 } from 'three';
import validator from 'gltf-validator';
import sharp from 'sharp';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MAX_BYTES = 16 * 1024 ** 2, MAX_GEOMETRY = 32 * 1024 ** 2, MAX_TEXTURE = 64 * 1024 ** 2;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const integer = n => Number.isSafeInteger(n) && n >= 0;
async function boundedRead(file, max) {
  const handle = await open(file, 'r');
  try { const stat = await handle.stat(); requireValue(stat.isFile() && stat.size > 0 && stat.size <= max, 'Local file exceeds byte budget or is not a file');
    const bytes = Buffer.alloc(stat.size + 1); let at = 0;
    while (at < bytes.length) { const { bytesRead } = await handle.read(bytes, at, bytes.length - at, at); if (!bytesRead) break; at += bytesRead; }
    requireValue(at === stat.size, 'Input changed while reading'); return bytes.subarray(0, at);
  } finally { await handle.close(); }
}
export function readGlb(bytes) {
  requireValue(bytes.length >= 28 && bytes.length <= MAX_BYTES && bytes.readUInt32LE(0) === 0x46546c67
    && bytes.readUInt32LE(4) === 2 && bytes.readUInt32LE(8) === bytes.length, 'Invalid or oversized GLB');
  const size = bytes.readUInt32LE(12), binAt = 20 + size;
  requireValue(size <= 2 * 1024 ** 2 && size % 4 === 0 && binAt + 8 <= bytes.length && bytes.readUInt32LE(16) === 0x4e4f534a, 'Invalid JSON chunk');
  requireValue(bytes.readUInt32LE(binAt + 4) === 0x004e4942 && bytes.readUInt32LE(binAt) % 4 === 0
    && binAt + 8 + bytes.readUInt32LE(binAt) === bytes.length, 'Exactly one embedded binary chunk required');
  return { doc: JSON.parse(bytes.subarray(20, binAt).toString('utf8')), bin: bytes.subarray(binAt + 8) };
}
export function writeGlb(doc, bin) {
  const json = Buffer.from(JSON.stringify(doc)), j = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32), b = Buffer.alloc(Math.ceil(bin.length / 4) * 4);
  json.copy(j); bin.copy(b); const result = Buffer.alloc(28 + j.length + b.length);
  [0x46546c67, 2, result.length, j.length, 0x4e4f534a].forEach((n, i) => result.writeUInt32LE(n, i * 4));
  j.copy(result, 20); result.writeUInt32LE(b.length, 20 + j.length); result.writeUInt32LE(0x004e4942, 24 + j.length); b.copy(result, 28 + j.length);
  requireValue(result.length <= MAX_BYTES, 'Normalized GLB exceeds 16 MiB'); return result;
}
function profile(doc, bin) {
  const walk = (value, depth = 0) => {
    requireValue(depth < 64, 'Nesting budget exceeded'); if (!value || typeof value !== 'object') return;
    requireValue(!('uri' in value) && !('extensions' in value), 'External URI or extension unsupported');
    for (const item of Object.values(value)) walk(item, depth + 1);
  }; walk(doc);
  requireValue(doc.asset?.version === '2.0' && !(doc.extensionsUsed?.length || doc.extensionsRequired?.length || doc.animations?.length || doc.skins?.length), 'Only static core glTF is supported');
  requireValue(doc.buffers?.length === 1 && integer(doc.buffers[0].byteLength) && doc.buffers[0].byteLength <= bin.length && bin.length - doc.buffers[0].byteLength <= 3, 'Invalid binary buffer');
  requireValue(doc.scenes?.length === 1 && (doc.scene ?? 0) === 0 && doc.nodes?.length > 0 && doc.nodes.length <= 2048
    && doc.meshes?.length <= 2048 && doc.accessors?.length <= 16384 && doc.bufferViews?.length <= 16384
    && doc.materials?.length > 0 && doc.materials.length <= 64 && (doc.images?.length ?? 0) <= 64, 'Unsupported structure or count budget');
  for (const v of doc.bufferViews) requireValue(v.buffer === 0 && integer(v.byteOffset ?? 0) && integer(v.byteLength)
    && (v.byteOffset ?? 0) + v.byteLength <= doc.buffers[0].byteLength, 'Invalid buffer view');
  let geometryBytes = 0;
  for (const a of doc.accessors) {
    const count = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type], width = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType], v = doc.bufferViews[a.bufferView];
    requireValue(v && !a.sparse && integer(a.count) && a.count > 0 && count && width && integer(a.byteOffset ?? 0)
      && (v.byteStride ?? count * width) === count * width && ((v.byteOffset ?? 0) + (a.byteOffset ?? 0)) % width === 0
      && (a.byteOffset ?? 0) + a.count * count * width <= v.byteLength, 'Sparse/interleaved/invalid accessor unsupported');
    geometryBytes += a.count * count * width; requireValue(geometryBytes <= MAX_GEOMETRY, 'Geometry allocation budget exceeded');
  }
  const textureSources = new Set();
  for (const t of doc.textures ?? []) { requireValue(integer(t.source) && doc.images?.[t.source] && !textureSources.has(t.source), 'Duplicated or invalid texture source unsupported'); textureSources.add(t.source); }
  return geometryBytes;
}
function measure(doc, bin, normalization = new Matrix4()) {
  const visited = new Set(), box = new Box3(), parts = [], points = []; let triangles = 0;
  const visit = (index, parent, depth) => {
    const n = doc.nodes[index]; requireValue(integer(index) && n && !visited.has(index) && depth < 64, 'Invalid node graph'); visited.add(index);
    requireValue(n.skin === undefined && n.weights === undefined && n.camera === undefined, 'Animated or camera node unsupported');
    for (const key of ['matrix', 'translation', 'rotation', 'scale']) if (n[key] !== undefined)
      requireValue(Array.isArray(n[key]) && n[key].length === (key === 'matrix' ? 16 : key === 'rotation' ? 4 : 3) && n[key].every(Number.isFinite), 'Invalid transform');
    const local = n.matrix ? new Matrix4().fromArray(n.matrix) : new Matrix4().compose(new Vector3(...(n.translation ?? [0, 0, 0])), new Quaternion(...(n.rotation ?? [0, 0, 0, 1])), new Vector3(...(n.scale ?? [1, 1, 1])));
    const world = parent.clone().multiply(local); requireValue(Number.isFinite(world.determinant()) && Math.abs(world.determinant()) > 1e-15, 'Degenerate transform');
    if (n.mesh !== undefined) {
      requireValue(integer(n.mesh) && doc.meshes[n.mesh]?.primitives?.length, 'Invalid mesh');
      const part = { id: `part-${index}`, node: `part_${index}`, pivot: new Vector3().setFromMatrixPosition(world).toArray(), sockets: [] };
      n.name = part.node; parts.push(part); requireValue(parts.length <= 64, 'More than 64 mesh parts unsupported');
      for (const p of doc.meshes[n.mesh].primitives) {
        const a = doc.accessors[p.attributes?.POSITION];
        requireValue((p.mode ?? 4) === 4 && !p.targets && a?.type === 'VEC3' && a.componentType === 5126 && !a.normalized && doc.materials[p.material], 'Only static triangle primitives with materials supported');
        for (const idx of Object.values(p.attributes ?? {})) requireValue(integer(idx) && doc.accessors[idx]?.count === a.count, 'Invalid attribute');
        const indices = p.indices === undefined ? undefined : doc.accessors[p.indices];
        requireValue(p.indices === undefined || (indices?.type === 'SCALAR' && [5121, 5123, 5125].includes(indices.componentType)), 'Invalid indices');
        const count = indices?.count ?? a.count; requireValue(count % 3 === 0, 'Invalid triangle count'); triangles += count / 3;
        requireValue(triangles <= 100000, 'Triangle budget exceeded');
        if (indices) {
          const v = doc.bufferViews[indices.bufferView], off = (v.byteOffset ?? 0) + (indices.byteOffset ?? 0), width = { 5121: 1, 5123: 2, 5125: 4 }[indices.componentType];
          for (let i = 0; i < indices.count; i++) requireValue(bin.readUIntLE(off + i * width, width) < a.count, 'Index exceeds vertex count');
        }
        const view = doc.bufferViews[a.bufferView], off = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
        for (let i = 0; i < a.count; i++) {
          const point = new Vector3(bin.readFloatLE(off + i * 12), bin.readFloatLE(off + i * 12 + 4), bin.readFloatLE(off + i * 12 + 8));
          requireValue(point.toArray().every(Number.isFinite), 'Nonfinite vertex'); point.applyMatrix4(world); box.expandByPoint(point);
          if (points.length < 30000) points.push(point.clone());
        }
      }
    } else n.name = `node_${index}`;
    for (const child of n.children ?? []) visit(child, world, depth + 1);
  };
  for (const i of doc.scenes[0].nodes ?? []) visit(i, normalization, 0);
  requireValue(visited.size === doc.nodes.length && triangles > 0 && box.getSize(new Vector3()).toArray().every(n => Number.isFinite(n) && n > 0), 'Unreachable nodes or empty/flat model unsupported');
  return { box, parts, points, triangles };
}
const axis = value => {
  requireValue(typeof value === 'string' && /^[+-][XYZ]$/.test(value), 'Explicit signed up/front axes required');
  const a = new Vector3(); a.setComponent('XYZ'.indexOf(value[1]), value[0] === '+' ? 1 : -1); return a;
};
function metadata(m) {
  requireValue(m && typeof m.assetId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(m.assetId) && m.pivot === 'bottom-center'
    && Number.isFinite(m.metersPerUnit) && m.metersPerUnit > 0 && m.metersPerUnit <= 1000, 'Explicit asset ID, units and bottom-center pivot required');
  for (const field of ['label', 'style', 'author', 'source', 'license', 'licenseEvidence', 'sourceEvidence', 'importedAt'])
    requireValue(typeof m[field] === 'string' && m[field].trim().length > 0 && m[field].length <= 2048, `Missing explicit ${field}`);
  requireValue(m.label.length <= 160 && m.style.length <= 120 && m.author.length <= 160 && m.license.length <= 160
    && /^\d{4}-\d{2}-\d{2}$/.test(m.importedAt) && Number.isFinite(Date.parse(m.importedAt))
    && new Date(m.importedAt).toISOString().slice(0, 10) === m.importedAt, 'Metadata limits exceeded');
  requireValue(Array.isArray(m.tags) && m.tags.length > 0 && m.tags.length <= 64 && m.tags.every(t => typeof t === 'string' && t.length > 0 && t.length <= 80), 'Explicit bounded tags required');
  const up = axis(m.up), front = axis(m.front); requireValue(up.dot(front) === 0, 'Up/front axes must be perpendicular');
  return new Matrix4().makeBasis(up.clone().cross(front), up, front).transpose().scale(new Vector3().setScalar(m.metersPerUnit));
}
export async function importExternal({ input, metadata: m, outputName }) {
  const rotation = metadata(m);
  requireValue(typeof outputName === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(outputName), 'Quarantine output must be a simple new directory name');
  const [source, license, evidence] = await Promise.all([boundedRead(input, MAX_BYTES), boundedRead(m.licenseEvidence, 65536), boundedRead(m.sourceEvidence, 65536)]);
  const { doc, bin: sourceBin } = readGlb(source); const geometryBytes = profile(doc, sourceBin);
  const before = await validator.validateBytes(new Uint8Array(source), { maxIssues: 32 });
  requireValue(!before.issues.numErrors, `Invalid input GLB: ${JSON.stringify(before.issues.messages)}`);
  let bin = Buffer.from(sourceBin.subarray(0, doc.buffers[0].byteLength)), textureBytes = 0;
  const dataImages = new Set(), colorImages = new Set();
  for (const material of doc.materials ?? []) {
    for (const slot of [material.normalTexture, material.occlusionTexture, material.pbrMetallicRoughness?.metallicRoughnessTexture])
      if (slot) dataImages.add(doc.textures?.[slot.index]?.source);
    for (const slot of [material.emissiveTexture, material.pbrMetallicRoughness?.baseColorTexture])
      if (slot) colorImages.add(doc.textures?.[slot.index]?.source);
  }
  requireValue(![...dataImages].some(index => colorImages.has(index)), 'One image used for both color and linear data is unsupported; separate it before import');
  for (const [imageIndex, image] of (doc.images ?? []).entries()) {
    const v = doc.bufferViews[image.bufferView]; requireValue(v && ['image/png', 'image/jpeg'].includes(image.mimeType), 'Only embedded PNG/JPEG supported');
    const bytes = bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
    // Normal/roughness/metalness/occlusion samples are linear data, not color.
    // Ignore embedded ICC profiles for those images; glTF material slots tell
    // GLTFLoader which GPU color-space conversion applies.
    const linearData = dataImages.has(imageIndex);
    const converter = sharp(bytes, { limitInputPixels: 2048 * 2048, failOn: 'warning', ignoreIcc: linearData }); const info = await converter.metadata();
    requireValue(!linearData || ['srgb', 'rgb', 'b-w'].includes(info.space), 'Linear data image must contain RGB or grayscale samples');
    requireValue(info.width > 0 && info.height > 0 && info.width <= 2048 && info.height <= 2048 && (info.pages ?? 1) === 1, 'Only single 2K images supported');
    textureBytes += Math.ceil(info.width * info.height * 4 * 4 / 3); requireValue(textureBytes <= MAX_TEXTURE, 'Texture allocation budget exceeded');
    const png = await converter.toColourspace('srgb').ensureAlpha().png({ palette: false }).toBuffer();
    const offset = Math.ceil(bin.length / 4) * 4; bin = Buffer.concat([bin, Buffer.alloc(offset - bin.length), png]);
    requireValue(bin.length <= MAX_BYTES, 'Normalized binary exceeds byte budget');
    image.bufferView = doc.bufferViews.length; image.mimeType = 'image/png'; doc.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: png.length });
  }
  const initial = measure(doc, bin, rotation), center = initial.box.getCenter(new Vector3());
  const transform = new Matrix4().makeTranslation(-center.x, -initial.box.min.y, -center.z).multiply(rotation);
  const measured = measure(doc, bin, transform);
  const children = doc.scenes[0].nodes; doc.scenes[0].nodes = [doc.nodes.length]; doc.nodes.push({ name: 'normalized_root', matrix: transform.toArray(), children });
  doc.materials.forEach((material, index) => { material.name = `material_${index}`; });
  doc.buffers[0].byteLength = bin.length;
  const normalized = writeGlb(doc, bin), digest = hash(normalized), bounds = { min: measured.box.min.toArray(), max: measured.box.max.toArray() };
  profile(doc, Buffer.concat([bin, Buffer.alloc(Math.ceil(bin.length / 4) * 4 - bin.length)]));
  const after = await validator.validateBytes(new Uint8Array(normalized), { maxIssues: 32 }); requireValue(!after.issues.numErrors, 'Normalized GLB failed validator');
  const basePath = `/assets/worldstream/${m.assetId}`, candidate = {
    assetId: m.assetId, version: 1, hash: digest, label: m.label, tags: m.tags, style: m.style, thumbnail: `${basePath}/preview.png`,
    provenance: { source: m.source, author: m.author, license: m.license, licenseEvidence: `${basePath}/license-evidence.txt`, importedAt: m.importedAt, sourceHash: hash(source) },
    units: 'meters', up: '+Y', front: '+Z', pivot: [0, 0, 0], bounds, stretchableAxes: [],
    lods: [{ level: 0, path: `${basePath}/model.glb`, hash: digest, bytes: normalized.length, triangles: measured.triangles,
      decodedGeometryBytes: geometryBytes, decodedTextureBytes: textureBytes, minScreenPixels: 0 }],
    materials: doc.materials.map((material, i) => ({ id: `material-${i}`, name: material.name, alphaMode: material.alphaMode ?? 'OPAQUE', doubleSided: material.doubleSided ?? false })),
    collision: [{ kind: 'box', bounds }], sockets: [], supportSurfaces: [], parts: measured.parts,
  };
  const parent = path.join(ROOT, 'asset-quarantine'); await mkdir(parent, { recursive: true });
  requireValue(!(await lstat(parent)).isSymbolicLink(), 'Quarantine symlink unsupported');
  const output = path.join(parent, outputName); await mkdir(output); // Never overwrite an existing package.
  const size = measured.box.getSize(new Vector3()), circles = measured.points.map(p => `<circle cx="${16 + (p.x - bounds.min[0]) / size.x * 224}" cy="${240 - (p.y - bounds.min[1]) / size.y * 224}" r="0.7"/>`).join('');
  const preview = await sharp(Buffer.from(`<svg width="256" height="256"><rect width="256" height="256" fill="#e8edf0"/><g fill="#385060">${circles}</g></svg>`)).png().toBuffer();
  const report = { status: 'QUARANTINED_NOT_APPROVED', sourceHash: hash(source), normalizedHash: digest,
    sourceBytes: source.length, normalizedBytes: normalized.length, normalization: { metersPerUnit: m.metersPerUnit, up: m.up, front: m.front, pivot: m.pivot, matrix: transform.toArray() },
    evidence: { licenseHash: hash(license), sourceEvidenceHash: hash(evidence) }, validator: { input: before.issues, output: after.issues },
    limitations: ['static core glTF only', 'no LOD generation', 'no automatic semantic socket/part labels', 'parts are individual mesh nodes, not inferred submesh mechanisms', 'collision is conservative bounds', 'preview is front vertex projection, not PBR visual approval', 'paths are prospective; production files and catalog remain untouched'] };
  for (const [name, bytes] of Object.entries({ 'model.glb': normalized, 'preview.png': preview, 'license-evidence.txt': license, 'source-evidence.txt': evidence,
    'candidate.json': JSON.stringify({ version: 'worldstream-assets-v1', assets: [candidate] }, null, 2), 'report.json': JSON.stringify(report, null, 2) })) await writeFile(path.join(output, name), bytes, { flag: 'wx' });
  return { output, candidate, report };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [, , input, metadataFile, outputName] = process.argv; requireValue(input && metadataFile && outputName, 'Usage: import-external.mjs input.glb metadata.json quarantine-name');
    const m = JSON.parse((await boundedRead(metadataFile, 65536)).toString('utf8'));
    console.log(JSON.stringify(await importExternal({ input, metadata: m, outputName }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
