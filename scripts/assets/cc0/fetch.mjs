#!/usr/bin/env node
/**
 * Stáhne CC0 balíky modelů do lokální cache mimo repo (P26A T1).
 *
 *   node scripts/assets/cc0/fetch.mjs      stáhne, co v cache chybí, a zapíše fetched.json
 *
 * Licence se hlídá dvakrát: deklarace v `sources.json` musí být z povoleného
 * seznamu (`RULES.md` §4), a text licence přibalený v archivu jí musí odpovídat.
 * Balík, který jedno z toho nesplní, se nestáhne nebo se zahodí a do
 * `fetched.json` jde se `skipped` důvodem – běh pokračuje. Z archivu se
 * rozbalí jen glTF/GLB s buffery a texturami a text licence, který se uloží
 * vedle balíku jako `<pack>.license.txt`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Document, NodeIO } from '@gltf-transform/core';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { unzipSync } from 'three/addons/libs/fflate.module.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CACHE = 'D:/claude/_cc0-cache';

/** Povolené licence a to, jak se poznají v přibaleném textu. */
const ALLOWED = {
  'CC0-1.0': /creative commons zero|\bcc0\b|publicdomain\/zero/i,
  'CC-BY-4.0': /attribution 4\.0|\bcc[- ]by[- ]4\.0\b|licenses\/by\/4\.0/i,
};
/** Text, který povolenou licenci vylučuje, i když zmíní „Creative Commons“. */
const RESTRICTED = /non-?commercial|\bby-nc\b|no-?derivatives|\bby-nd\b|share-?alike|\bby-sa\b/i;

const KEEP = /\.(glb|gltf|bin)$/i;
const KEEP_TEXTURE = /\.(png|jpe?g)$/i;
const KEEP_OBJ = /\.(obj|mtl)$/i;
const LICENSE_FILE = /(^|\/)licen[cs]e(\.txt)?$/i;

export function licenseProblem(pack) {
  return Object.hasOwn(ALLOWED, pack.license) ? null : `license ${JSON.stringify(pack.license)} not allowed (CC0-1.0, CC-BY-4.0 only)`;
}

export function licenseTextProblem(pack, text) {
  if (RESTRICTED.test(text) || !ALLOWED[pack.license].test(text)) return `license text does not say ${pack.license}`;
  return null;
}

async function resolveUrl(pack, fetchImpl) {
  if (pack.kind === 'github-zip') return `https://codeload.github.com/${pack.repo}/zip/refs/heads/${pack.branch}`;
  if (pack.kind === 'kenney-page') {
    const page = await fetchImpl(pack.pageUrl);
    if (!page.ok) throw new Error(`pack page ${page.status}`);
    const link = (await page.text()).match(/https:\/\/kenney\.nl\/media\/pages\/assets\/[^"' ]+\.zip/);
    if (!link) throw new Error('no zip link on the pack page');
    return link[0];
  }
  throw new Error(`unknown kind ${pack.kind}`);
}

/** Cesta uvnitř archivu bez společné kořenové složky (`repo-main/…`). */
function stripRoot(names) {
  const roots = new Set(names.map((name) => name.split('/')[0]));
  const shared = roots.size === 1 && names.every((name) => name.includes('/')) ? `${[...roots][0]}/` : '';
  return (name) => name.slice(shared.length);
}

function extract(pack, zip, cacheDir) {
  const entries = unzipSync(zip, { filter: (file) => KEEP.test(file.name) || KEEP_TEXTURE.test(file.name) || KEEP_OBJ.test(file.name) || LICENSE_FILE.test(file.name) });
  const names = Object.keys(entries).filter((name) => !name.endsWith('/'));
  const licenseName = names.filter((name) => LICENSE_FILE.test(name)).sort((a, b) => a.split('/').length - b.split('/').length)[0];
  if (licenseName === undefined) return { skipped: 'no license file in the archive' };
  const licenseText = new TextDecoder().decode(entries[licenseName]);
  const problem = licenseTextProblem(pack, licenseText);
  if (problem) return { skipped: problem };

  const relative = stripRoot(names);
  const dir = path.join(cacheDir, pack.id);
  rmSync(dir, { recursive: true, force: true });
  let models = 0;
  for (const name of names) {
    if (LICENSE_FILE.test(name)) continue;
    const target = path.join(dir, relative(name));
    if (!target.startsWith(dir + path.sep)) continue; // zip slip
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, entries[name]);
    if (/\.(glb|gltf)$/i.test(name)) models += 1;
  }
  const licenseFile = path.join(cacheDir, `${pack.id}.license.txt`);
  writeFileSync(licenseFile, licenseText);
  return { licenseFile, models };
}

/**
 * OBJ + MTL → GLB vedle zdroje: barva `Kd` (a `map_Kd`, leží-li obrázek vedle)
 * do materiálu glTF, jedno primitivum na materiál. Starší balíky Quaternius
 * glTF nemají; zbytek potrubí čte jen glTF.
 */
export async function objToGlb(objFile) {
  const dir = path.dirname(objFile);
  const text = readFileSync(objFile, 'utf8');
  const materials = new Map();
  const mtlName = text.match(/^mtllib\s+(.+)$/m)?.[1].trim();
  if (mtlName && existsSync(path.join(dir, mtlName))) {
    let current = null;
    for (const line of readFileSync(path.join(dir, mtlName), 'utf8').split(/\r?\n/)) {
      const [key, ...rest] = line.trim().split(/\s+/);
      if (key === 'newmtl') materials.set((current = rest.join(' ')), { color: [1, 1, 1, 1] });
      else if (current && key === 'Kd') materials.get(current).color.splice(0, 3, ...rest.slice(0, 3).map(Number));
      else if (current && key === 'd') materials.get(current).color[3] = Number(rest[0]);
      else if (current && key === 'map_Kd') materials.get(current).map = rest.at(-1);
    }
  }
  const group = new OBJLoader().parse(text);
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene();
  const made = new Map();
  const material = (name) => {
    if (!made.has(name)) {
      const spec = materials.get(name) ?? { color: [1, 1, 1, 1] };
      const created = doc.createMaterial(name).setBaseColorFactor(spec.color).setMetallicFactor(0).setRoughnessFactor(0.85).setAlphaMode(spec.color[3] < 1 ? 'BLEND' : 'OPAQUE');
      const image = spec.map && path.join(dir, spec.map);
      if (image && existsSync(image) && KEEP_TEXTURE.test(image)) {
        created.setBaseColorTexture(doc.createTexture(spec.map).setImage(readFileSync(image)).setMimeType(/\.png$/i.test(image) ? 'image/png' : 'image/jpeg'));
      }
      made.set(name, created);
    }
    return made.get(name);
  };
  const attribute = (source, start, count, type) => (source
    ? doc.createAccessor().setType(type).setBuffer(buffer).setArray(source.array.slice(start * source.itemSize, (start + count) * source.itemSize))
    : null);
  for (const child of group.children) {
    const geometry = child.geometry;
    const list = Array.isArray(child.material) ? child.material : [child.material];
    const ranges = geometry.groups.length ? geometry.groups : [{ start: 0, count: geometry.attributes.position.count, materialIndex: 0 }];
    const mesh = doc.createMesh(child.name);
    for (const { start, count, materialIndex } of ranges) {
      if (count === 0) continue;
      const prim = doc.createPrimitive().setMaterial(material(list[materialIndex].name));
      for (const [semantic, name, type] of [['POSITION', 'position', 'VEC3'], ['NORMAL', 'normal', 'VEC3'], ['TEXCOORD_0', 'uv', 'VEC2']]) {
        const accessor = attribute(geometry.attributes[name], start, count, type);
        if (accessor) prim.setAttribute(semantic, accessor);
      }
      mesh.addPrimitive(prim);
    }
    scene.addChild(doc.createNode(child.name).setMesh(mesh));
  }
  const glb = objFile.replace(/\.obj$/i, '.glb');
  writeFileSync(glb, await new NodeIO().writeBinary(doc));
  return glb;
}

/** Každé OBJ v adresáři, které nemá GLB vedle sebe, převede `objToGlb`. */
async function convertObjs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !/\.obj$/i.test(entry.name)) continue;
    const file = path.join(entry.parentPath, entry.name);
    if (!existsSync(file.replace(/\.obj$/i, '.glb'))) await objToGlb(file);
  }
}

const countModels = (dir) => readdirSync(dir, { recursive: true }).filter((name) => /\.(glb|gltf)$/i.test(name)).length;

/** Podsložky a soubory veřejné složky Drive ze statického `embeddedfolderview`. */
async function listDrive(folderId, fetchImpl) {
  const response = await fetchImpl(`https://drive.google.com/embeddedfolderview?id=${folderId}`);
  if (!response.ok) throw new Error(`drive folder ${response.status}`);
  const html = await response.text();
  return [...html.matchAll(/href="https:\/\/drive\.google\.com\/(drive\/folders|file\/d)\/([\w-]+)[^"]*"[\s\S]*?flip-entry-title">([^<]+)</g)]
    .map(([, kind, id, name]) => ({ id, name: name.trim(), folder: kind === 'drive/folders' }));
}

/** Složka formátu, kterou potrubí čte: glTF před OBJ; Blender, FBX a rigy nikdy. */
const GLTF_DIR = /^gl(tf|b)$/i;
const OBJ_DIR = /^obj$/i;
const SKIP_DIR = /^(blends?|blender|fbx|textures?\b.*|png|icons?|humanoid rigs?.*|separate skeletal.*)$/i;

async function walkDrive(folderId, fetchImpl, prefix = '') {
  const entries = await listDrive(folderId, fetchImpl);
  const folders = entries.filter((e) => e.folder);
  const format = folders.find((e) => GLTF_DIR.test(e.name)) ?? folders.find((e) => OBJ_DIR.test(e.name));
  const descend = format ? [format] : folders.filter((e) => !SKIP_DIR.test(e.name));
  const files = entries.filter((e) => !e.folder && !/^preview/i.test(e.name) && (KEEP.test(e.name) || KEEP_TEXTURE.test(e.name) || KEEP_OBJ.test(e.name) || LICENSE_FILE.test(e.name)))
    .map((e) => ({ ...e, path: `${prefix}${e.name}` }));
  for (const sub of descend) files.push(...await walkDrive(sub.id, fetchImpl, `${prefix}${sub.name}/`));
  return files;
}

/**
 * Balík ze složky Drive, kterou autor sám odkazuje ze své stránky. Složku,
 * na kterou stránka autora neukazuje, nestáhne – přebalené „zrcadlo“ vypadá
 * stejně. Text licence je `License.txt` ze složky, jinak výrok CC0 ze stránky.
 */
async function fetchDrive(pack, cacheDir, fetchImpl) {
  if (!pack.pageUrl) return { skipped: 'no author page to trace the folder to' };
  const page = await fetchImpl(pack.pageUrl);
  if (!page.ok) return { skipped: `author page ${page.status}` };
  const html = await page.text();
  if (!html.includes(`drive.google.com/drive/folders/${pack.folderId}`)) return { skipped: 'the author page does not link this folder' };
  const files = await walkDrive(pack.folderId, fetchImpl);
  const download = async (file) => {
    const url = `https://drive.usercontent.google.com/download?id=${file.id}&export=download&confirm=t`;
    let response = await fetchImpl(url);
    if (response.status >= 500) response = await fetchImpl(url); // Drive občas vrátí 500 na jeden soubor z mnoha

    if (!response.ok) throw new Error(`download ${file.path} ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  };
  const licenseEntry = files.filter((f) => LICENSE_FILE.test(f.name)).sort((a, b) => a.path.split('/').length - b.path.split('/').length)[0];
  const statement = html.match(/[^<>]{0,120}creativecommons\.org\/publicdomain\/zero[^<>]{0,120}/)?.[0];
  const licenseText = licenseEntry
    ? new TextDecoder().decode(await download(licenseEntry))
    : statement ? `Author page ${pack.pageUrl} states the licence:\n${statement}\n` : '';
  const problem = licenseText ? licenseTextProblem(pack, licenseText) : 'no license file and no CC0 statement on the author page';
  if (problem) return { skipped: problem };

  const dir = path.join(cacheDir, pack.id);
  rmSync(dir, { recursive: true, force: true });
  const queue = files.filter((f) => !LICENSE_FILE.test(f.name));
  const hash = createHash('sha256');
  let bytes = 0;
  // Několik stažení souběžně; Drive jinak drží stovky malých souborů minuty.
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      const target = path.join(dir, file.path);
      if (!target.startsWith(dir + path.sep)) continue;
      const data = await download(file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, data);
      bytes += data.length;
    }
  }));
  for (const file of files) hash.update(`${file.path}:${file.id}\n`);
  mkdirSync(dir, { recursive: true });
  const licenseFile = path.join(cacheDir, `${pack.id}.license.txt`);
  writeFileSync(licenseFile, licenseText);
  return { licenseFile, url: `https://drive.google.com/drive/folders/${pack.folderId}`, sha256: hash.digest('hex'), bytes };
}

/**
 * Projde balíky; co už v cache leží se shodným otiskem (`<pack>/.complete`),
 * znovu nestahuje. Balík `manual` se načte ze zipu `<cache>/manual/<id>.zip`,
 * jinak skončí jako `skipped` se stránkou ke ručnímu stažení. Vrací záznamy
 * pro `fetched.json` a počet stažených.
 */
export async function fetchPacks({ packs, cacheDir = DEFAULT_CACHE, fetchImpl = fetch, log = () => {} }) {
  mkdirSync(cacheDir, { recursive: true });
  const records = [];
  let downloaded = 0;
  for (const pack of packs) {
    const manualZip = path.join(cacheDir, 'manual', `${pack.id}.zip`);
    const manual = pack.kind === 'manual' && !existsSync(manualZip);
    const refused = licenseProblem(pack) ?? (manual ? pack.reason ?? 'needs a manual download' : null);
    if (refused) { records.push({ pack: pack.id, url: pack.pageUrl, skipped: refused }); log(`${pack.id}: skipped – ${refused}`); continue; }

    const marker = path.join(cacheDir, pack.id, '.complete');
    if (existsSync(marker)) { records.push(JSON.parse(readFileSync(marker, 'utf8'))); continue; }

    try {
      let url;
      let sha256;
      let bytes;
      let result;
      if (pack.kind === 'drive-folder') {
        result = await fetchDrive(pack, cacheDir, fetchImpl);
        ({ url = pack.pageUrl, sha256, bytes } = result);
      } else {
        let zip;
        if (pack.kind === 'manual') {
          url = `manual:${manualZip.replaceAll('\\', '/')}`;
          zip = new Uint8Array(readFileSync(manualZip));
        } else {
          url = await resolveUrl(pack, fetchImpl);
          const response = await fetchImpl(url);
          if (!response.ok) throw new Error(`download ${response.status}`);
          zip = new Uint8Array(await response.arrayBuffer());
        }
        sha256 = createHash('sha256').update(zip).digest('hex');
        bytes = zip.length;
        result = extract(pack, zip, cacheDir);
      }
      if (result.skipped) { records.push({ pack: pack.id, url, ...(sha256 ? { sha256 } : {}), skipped: result.skipped }); log(`${pack.id}: skipped – ${result.skipped}`); continue; }
      await convertObjs(path.join(cacheDir, pack.id));
      result.models = countModels(path.join(cacheDir, pack.id));
      const record = { pack: pack.id, url, sha256, bytes, licenseFile: result.licenseFile, license: pack.license, models: result.models };
      writeFileSync(marker, JSON.stringify(record));
      records.push(record);
      downloaded += 1;
      log(`${pack.id}: ${result.models} models, ${bytes} bytes`);
    } catch (error) {
      records.push({ pack: pack.id, url: pack.pageUrl, skipped: error.message });
      log(`${pack.id}: skipped – ${error.message}`);
    }
  }
  return { records, downloaded };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { packs } = JSON.parse(readFileSync(path.join(HERE, 'sources.json'), 'utf8'));
  const { records, downloaded } = await fetchPacks({ packs, log: (line) => console.log(line) });
  const cachePrefix = `${DEFAULT_CACHE}/`;
  const portable = records.map((r) => (r.licenseFile ? { ...r, licenseFile: r.licenseFile.replaceAll('\\', '/').replace(cachePrefix, '<cache>/') } : r));
  writeFileSync(path.join(HERE, 'fetched.json'), `${JSON.stringify({ cache: DEFAULT_CACHE, packs: portable }, null, 2)}\n`);
  const fetched = records.filter((r) => !r.skipped).length;
  console.log(`${downloaded} downloaded, ${fetched} packs in cache, ${records.length - fetched} skipped`);
}
