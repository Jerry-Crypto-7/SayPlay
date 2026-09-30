#!/usr/bin/env node
/**
 * Stáhne riggované CC0 postavy s klipy (P26B T3) do cache mimo repo.
 *
 *   node scripts/assets/rigged/fetch.mjs [cacheDir]
 *
 * Zdroje jsou v `sources.json`. Licence se nejdřív porovná s whitelistem
 * (CC0-1.0, CC-BY-4.0), pak se stáhne její text a ten musí deklaraci
 * odpovídat – teprve potom se stahují modely. Zdroj, který nejde stáhnout
 * bez klikání, nebo jehož licence nesedí, skončí `skipped` s důvodem a běh
 * pokračuje. Výsledek (url, sha256, licence, soubor s textem licence) jde
 * do `fetched.json` vedle skriptu.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Cache sad P32C (plán P32C, T3); ručně stažené sady z `evals/play/p32/kits-missing.md` patří sem taky. */
const DEFAULT_CACHE = 'D:/caches/p32-kits';
export const ALLOWED_LICENSES = ['CC0-1.0', 'CC-BY-4.0'];

const RESTRICTED = /NonCommercial|NoDerivatives|NoDerivs|ShareAlike|All rights reserved/i;
const LICENSE_TEXT = {
  'CC0-1.0': /\bCC0\b|publicdomain\/zero|Creative Commons Zero/i,
  'CC-BY-4.0': /Attribution 4\.0|licenses\/by\/4\.0/i,
};

/** Text licence odpovídá deklaraci – a nenese omezení, které whitelist nepovoluje. */
export function licenseMatches(declared, text) {
  const pattern = LICENSE_TEXT[declared];
  return pattern !== undefined && pattern.test(text) && !RESTRICTED.test(text);
}

/** Ze zipu Kenney se berou modely a jejich textury, ne náhledy a zdrojové soubory. */
const KEEP = /\.(glb|gltf|bin)$/i;
const KEEP_TEXTURE = /(^|\/)(Models|Textures)\/.*\.(png|jpe?g)$/i;
const LICENSE_ENTRY = /(^|\/)licen[cs]e(\.txt)?$/i;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const skipped = (source, reason) => ({ id: source.id, name: source.name, page: source.page, license: source.license, status: 'skipped', reason });

async function download(fetchImpl, url) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function save(dir, relative, bytes) {
  const file = path.join(dir, ...relative.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
  return file;
}

/** Stáhne jeden zdroj. Nikdy nehází – chyba je `skipped` s důvodem. */
export async function fetchSource(source, { fetch: fetchImpl = globalThis.fetch, cacheDir = DEFAULT_CACHE } = {}) {
  if (source.kind === 'skip') return skipped(source, source.skipReason ?? 'marked skip');
  if (!ALLOWED_LICENSES.includes(source.license)) return skipped(source, `license ${source.license} is not on the whitelist (${ALLOWED_LICENSES.join(', ')})`);
  const dir = path.join(cacheDir, source.id);
  try {
    let licenseText;
    let entries;
    if (source.kind === 'github') {
      licenseText = new TextDecoder().decode(await download(fetchImpl, source.licenseUrl));
      if (!licenseMatches(source.license, licenseText)) return skipped(source, `license text at ${source.licenseUrl} does not state ${source.license}`);
      entries = [];
      for (const url of source.files) entries.push({ url, relative: decodeURIComponent(new URL(url).pathname.split('/').pop()), bytes: await download(fetchImpl, url) });
    } else if (source.kind === 'kenney') {
      const page = new TextDecoder().decode(await download(fetchImpl, source.page));
      const zipUrl = page.match(/https:\/\/kenney\.nl\/media\/[^"'\s]+\.zip/)?.[0];
      if (zipUrl === undefined) return skipped(source, `no zip link on ${source.page}`);
      const files = unzipSync(await download(fetchImpl, zipUrl));
      const licenseName = Object.keys(files).find((name) => LICENSE_ENTRY.test(name));
      if (licenseName === undefined) return skipped(source, `no license file inside ${zipUrl}`);
      licenseText = new TextDecoder().decode(files[licenseName]);
      if (!licenseMatches(source.license, licenseText)) return skipped(source, `license file in ${zipUrl} does not state ${source.license}`);
      entries = Object.keys(files)
        .filter((name) => KEEP.test(name) || KEEP_TEXTURE.test(name))
        .sort()
        .map((name) => ({ url: `${zipUrl}#${name}`, relative: name, bytes: files[name] }));
      if (entries.length === 0) return skipped(source, `no glTF models inside ${zipUrl}`);
    } else {
      return skipped(source, `unknown source kind ${source.kind}`);
    }
    const licenseFile = await save(dir, 'LICENSE.txt', licenseText);
    const saved = [];
    for (const entry of entries) saved.push({ url: entry.url, path: await save(dir, entry.relative, entry.bytes), sha256: sha256(entry.bytes), bytes: entry.bytes.length });
    return { id: source.id, name: source.name, author: source.author, page: source.page, license: source.license, licenseFile, status: 'fetched', files: saved };
  } catch (error) {
    return skipped(source, error instanceof Error ? error.message : String(error));
  }
}

async function main() {
  const cacheDir = process.argv[2] ?? DEFAULT_CACHE;
  const { sources } = JSON.parse(await readFile(path.join(HERE, 'sources.json'), 'utf8'));
  const records = [];
  for (const source of sources) {
    const record = await fetchSource(source, { cacheDir });
    records.push(record);
    console.log(`${record.status === 'fetched' ? 'fetched' : 'skipped'}  ${source.id}${record.status === 'fetched' ? `  ${record.files.length} files` : `  – ${record.reason}`}`);
  }
  const relative = (file) => path.relative(cacheDir, file).split(path.sep).join('/');
  const portable = records.map((record) =>
    record.status === 'fetched' ? { ...record, licenseFile: relative(record.licenseFile), files: record.files.map((file) => ({ ...file, path: relative(file.path) })) } : record,
  );
  await writeFile(path.join(HERE, 'fetched.json'), `${JSON.stringify({ cacheDir: cacheDir.split(path.sep).join('/'), sources: portable }, null, 2)}\n`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
