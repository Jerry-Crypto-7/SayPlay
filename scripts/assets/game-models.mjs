#!/usr/bin/env node
/** Herní modely z Blenderu do katalogu (P23 QA 22. 9. 2026).
 *
 * node scripts/assets/game-models.mjs [--only knight,key]   postaví modely v Blenderu,
 *                                                         zkopíruje je do public/ a zapíše katalog
 * node scripts/assets/game-models.mjs --check              ověří commitnuté soubory proti katalogu
 *
 * Geometrii píše `blender/game_models.py` (vlastní tvary, žádný stažený model).
 * Blender se hledá v `BLENDER_PATH`, jinak ve výchozí instalaci 5.1. Kontrola
 * Blender nepotřebuje: drží hash, velikost, trojúhelníky a Khronos validaci.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { metadata, validate } from './glb-meta.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const SOURCE = 'scripts/assets/blender/game_models.py';
const PUBLIC_DIR = 'assets/worldstream/game';
const out = path.join(root, 'public', PUBLIC_DIR);
const catalogPath = path.join(root, 'src/assets/catalog.json');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const args = process.argv.slice(2);
const check = args.includes('--check');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

/** Kvádr z min/max akcesoru POSITION – Blender aplikuje transformace, uzel je v počátku. */
function boundsOf(json) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of json.meshes) {
    for (const primitive of mesh.primitives) {
      const accessor = json.accessors[primitive.attributes.POSITION];
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], accessor.min[axis]);
        max[axis] = Math.max(max[axis], accessor.max[axis]);
      }
    }
  }
  return { min, max };
}

const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
const reports = [];

if (check) {
  const sourceHash = hash(await readFile(path.join(root, SOURCE)));
  for (const asset of catalog.assets.filter((entry) => entry.provenance.source === SOURCE)) {
    if (asset.provenance.sourceHash !== sourceHash) throw new Error(`${asset.assetId}: stale source hash – rebuild with game-models.mjs`);
    for (const lod of asset.lods) {
      const bytes = await readFile(path.join(root, 'public', lod.path));
      const meta = metadata(bytes);
      if (hash(bytes) !== lod.hash || bytes.length !== lod.bytes || meta.triangles !== lod.triangles) throw new Error(`${lod.path}: stale metadata`);
      reports.push(await validate(bytes, lod.path));
    }
    await readFile(path.join(root, 'public', asset.thumbnail));
  }
} else {
  const blender = process.env.BLENDER_PATH ?? 'C:/Program Files/Blender Foundation/Blender 5.1/blender.exe';
  const work = await mkdtemp(path.join(tmpdir(), 'game-models-'));
  const blenderArgs = ['-b', '--factory-startup', '--python-exit-code', '1', '--python', path.join(root, SOURCE), '--', '--out', work];
  if (only) blenderArgs.push('--only', only);
  execFileSync(blender, blenderArgs, { stdio: ['ignore', 'ignore', 'inherit'] });

  const sourceHash = hash(await readFile(path.join(root, SOURCE)));
  const models = JSON.parse(await readFile(path.join(work, 'models.json'), 'utf8'));
  const built = only ? models.filter((m) => only.split(',').includes(m.id)) : models;
  await mkdir(out, { recursive: true });
  const records = [];
  for (const model of built) {
    const lods = [];
    let base;
    for (const level of [0, 1]) {
      const filename = `${model.id}-lod${level}.glb`;
      const bytes = await readFile(path.join(work, filename));
      const meta = metadata(bytes);
      reports.push(await validate(bytes, filename));
      await writeFile(path.join(out, filename), bytes);
      lods.push({ level, path: `/${PUBLIC_DIR}/${filename}`, hash: hash(bytes), bytes: bytes.length, triangles: meta.triangles, decodedGeometryBytes: meta.decodedGeometryBytes, decodedTextureBytes: 0, minScreenPixels: level ? 0 : 160 });
      if (level === 0) base = meta;
    }
    if (lods[1].triangles >= lods[0].triangles) throw new Error(`${model.id}: LOD1 is not cheaper than LOD0`);
    await copyFile(path.join(work, `${model.id}.png`), path.join(out, `${model.id}.png`));
    const bounds = boundsOf(base.json);
    records.push({
      assetId: model.id, version: 1, hash: lods[0].hash, label: model.label, tags: model.tags,
      style: 'original low-poly stylized', thumbnail: `/${PUBLIC_DIR}/${model.id}.png`,
      provenance: { source: SOURCE, author: 'Worldsmith project — AI-assisted original geometry (Blender)', license: 'LicenseRef-Worldsmith-Original', licenseEvidence: `public/${PUBLIC_DIR}/PROVENANCE.md`, importedAt: new Date().toISOString().slice(0, 10), sourceHash },
      units: 'meters', up: '+Y', front: '+Z', pivot: [0, 0, 0], bounds, stretchableAxes: [], lods,
      materials: base.json.materials.map((m, n) => ({ id: `material-${n}`, name: m.name, alphaMode: m.alphaMode ?? 'OPAQUE', doubleSided: m.doubleSided ?? false })),
      collision: [{ kind: 'box', bounds }], sockets: [], supportSurfaces: [], parts: [],
    });
  }
  // Záznam téhož id se nahradí na místě, nový jde na konec; cizí záznamy zůstanou.
  const byId = new Map(records.map((record) => [record.assetId, record]));
  const assets = catalog.assets.map((entry) => byId.get(entry.assetId) ?? entry);
  for (const record of records) if (!catalog.assets.some((entry) => entry.assetId === record.assetId)) assets.push(record);
  await writeFile(catalogPath, `${JSON.stringify({ version: 'worldstream-assets-v1', assets }, null, 2)}\n`);
  await rm(work, { recursive: true, force: true });
}
console.log(JSON.stringify({ mode: check ? 'check' : 'build', validator: 'Khronos glTF Validator', files: reports.length }, null, 2));
