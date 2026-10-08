#!/usr/bin/env node
/**
 * Zapíše normalizované CC0 modely do katalogu s doložitelným původem (P26A T5).
 *
 *   node scripts/assets/cc0/promote.mjs          karanténa → public/assets/worldstream/cc0, catalog.json, disclosure.json
 *   node scripts/assets/cc0/promote.mjs --check  jen ověří licence, texty licencí a registr
 *
 * Každý CC0 záznam nese licenci z povoleného seznamu, cestu k uloženému textu
 * licence balíku a v `disclosure.json` záznam pro každý svůj soubor. Tag, který
 * už nese vlastní model projektu, CC0 model nedostane – vlastní má přednost.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { licenseProblem, licenseTextProblem } from './fetch.mjs';
import { contactSheet, renderPreview } from './normalize.mjs';
import { modelTokensOf } from './tokens.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const PUBLIC_DIR = 'public/assets/worldstream/cc0';
const URL_BASE = '/assets/worldstream/cc0';
const SOURCE = 'scripts/assets/cc0/normalize.mjs';

export const isCc0 = (asset) => asset.assetId.startsWith('cc0-');

/**
 * Rozpočet CC0 složky (P26A T11): obě LOD jednoho modelu nejvýš 300 kB, celá
 * složka nejvýš 80 MB – víc modelů by vypadalo lépe a zpomalilo nasazení.
 */
export const BUDGET = { modelBytes: 300_000, totalBytes: 80_000_000 };

/**
 * Modely v pořadí výběru; `bytes` = obě LOD, `folderBytes` = co model zabere ve
 * složce (LOD + náhled). Model přes strop vypadne, model, který by přetekl
 * celek, taky – menší model za ním se ještě vejít může.
 */
export function fitBudget(items, budget = BUDGET) {
  const kept = [];
  const dropped = [];
  let total = 0;
  for (const item of items) {
    const size = item.folderBytes ?? item.bytes;
    if (item.bytes > budget.modelBytes) dropped.push({ ...item, reason: `${item.bytes} B of LODs, over ${budget.modelBytes} B per model` });
    else if (total + size > budget.totalBytes) dropped.push({ ...item, reason: `${size} B would bring the folder to ${total + size} B, over the ${budget.totalBytes} B total` });
    else {
      total += size;
      kept.push(item);
    }
  }
  return { kept, dropped, total };
}

/** Velikost složky i s podsložkami v bajtech. */
export function folderBytes(dir) {
  return readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
    const name = path.join(dir, entry.name);
    return sum + (entry.isDirectory() ? folderBytes(name) : statSync(name).size);
  }, 0);
}

/** Slova názvu souboru, která nic nejmenují: zařazení, barvy, tvary, velikosti. */
const GENERIC = new Set([
  'animal', 'character', 'item', 'prop', 'detail', 'model',
  'red', 'green', 'blue', 'yellow', 'orange', 'white', 'black', 'grey', 'gray', 'brown', 'pink', 'gold', 'silver', 'bronze', 'dark', 'light',
  'cube', 'round', 'square', 'rectangle', 'wide', 'long', 'tall', 'large', 'small', 'medium', 'big', 'tiny', 'low', 'high', 'open', 'closed', 'cane', 'decorated',
  // Holé slovo znamená ve větě něco jiného než v názvu souboru: „battle tank“ není `gas-tank`.
  'tank',
]);

/** Hranice zaokrouhlené ven na 10 µm: LOD1 po zjednodušení vyčnívá z LOD0 o miliontiny metru. */
const outward = (bounds) => ({
  min: bounds.min.map((value, axis) => (axis === 1 ? value : Math.floor((value - 2e-6) * 1e5) / 1e5)),
  max: bounds.max.map((value) => Math.ceil((value + 2e-6) * 1e5) / 1e5),
});

/** Tagy CC0 modelu: jméno z věty, synonyma a slova názvu souboru, bez obecných slov a bez tagů, které už někdo nese. */
export function cc0Tags({ noun, file, synonyms = [] }, taken) {
  const tags = [];
  // Přívlastek složeného jména model nejmenuje: „bear trap“ není medvěd, „gas tank“ není plyn.
  const modifiers = new Set(noun.split(' ').slice(0, -1));
  for (const tag of [noun, ...synonyms, ...modelTokensOf(file)]) {
    if ((tag !== noun && GENERIC.has(tag)) || modifiers.has(tag) || taken.has(tag) || tags.includes(tag)) continue;
    tags.push(tag);
  }
  return tags;
}

/**
 * Štíhlý index katalogu pro prohlížeč (P26A T6): arkáda potřebuje jen id, tagy,
 * cestu k LOD1 a rozměr, ne provenienci, materiály a části.
 */
export function catalogIndex(catalog) {
  return {
    assets: catalog.assets.map((asset) => ({
      assetId: asset.assetId,
      tags: asset.tags,
      path: (asset.lods.find((lod) => lod.level === 1) ?? asset.lods[0]).path,
      bounds: asset.bounds,
    })),
  };
}

const licenseFileOf = (pack) => `${PUBLIC_DIR}/licenses/${pack}.txt`;

/** Problémy CC0 záznamů katalogu: licence, text licence, soubory, registr, tagy. Prázdné pole = v pořádku. */
export function checkCatalog({ catalog, disclosure, root = ROOT, budget = BUDGET }) {
  const problems = [];
  const folder = folderBytes(path.join(root, PUBLIC_DIR));
  if (folder > budget.totalBytes) problems.push(`cc0 folder ${PUBLIC_DIR} holds ${folder} B, over the ${budget.totalBytes} B total`);
  const records = new Map(disclosure.entries.filter((entry) => entry.kind === 'asset').map((entry) => [entry.name, entry]));
  const own = new Set(catalog.assets.filter((asset) => !isCc0(asset)).flatMap((asset) => [asset.assetId, ...asset.tags]));
  for (const asset of catalog.assets.filter(isCc0)) {
    const { license, licenseEvidence } = asset.provenance;
    const refused = licenseProblem({ license });
    if (refused) problems.push(`${asset.assetId}: ${refused}`);
    const evidence = path.join(root, licenseEvidence);
    if (!existsSync(evidence)) problems.push(`${asset.assetId}: license text ${licenseEvidence} is missing`);
    else if (!refused) {
      const wrong = licenseTextProblem({ license }, readFileSync(evidence, 'utf8'));
      if (wrong) problems.push(`${asset.assetId}: ${licenseEvidence}: ${wrong}`);
    }
    for (const url of [...asset.lods.map((lod) => lod.path), asset.thumbnail]) {
      const name = `public${url}`;
      if (!existsSync(path.join(root, name))) problems.push(`${asset.assetId}: ${name} is missing`);
      const record = records.get(name);
      if (!record) problems.push(`${asset.assetId}: ${name} has no disclosure record`);
      else if (record.license !== license) problems.push(`${asset.assetId}: disclosure says ${record.license} for ${name}, catalog says ${license}`);
    }
    if (!records.has(licenseEvidence)) problems.push(`${asset.assetId}: ${licenseEvidence} has no disclosure record`);
    // `seen:` je jméno ze slepého soudu P43 – nikdy nepřebije vlastní tag (`tagIndex` v models.ts), nekrade ho.
    for (const tag of asset.tags) if (!tag.startsWith('seen:') && own.has(tag)) problems.push(`${asset.assetId}: tag ${tag} belongs to a project model`);
    const bytes = asset.lods.reduce((sum, lod) => sum + lod.bytes, 0);
    if (bytes > budget.modelBytes) problems.push(`${asset.assetId}: ${bytes} B of LODs, over ${budget.modelBytes} B per model`);
  }
  return problems;
}

function disclosureRecord(name, { reason, source, author, license, attribution, reviewNote }) {
  return {
    name, kind: 'asset', firstParty: false, reason, source, authorOrProvider: author, license,
    requiredNotices: license === 'CC-BY-4.0' ? ['attribution to the author', 'link to the licence', 'note that the model was changed'] : ['none – CC0 waives attribution; credit is given voluntarily in public/assets/worldstream/cc0/PROVENANCE.md'],
    attribution, reviewNote, scope: 'prod',
  };
}

function provenanceMarkdown(rows, packs) {
  const lines = [
    '# CC0 models – provenance',
    '',
    'Third-party models from free CC0 packs, fetched by `scripts/assets/cc0/fetch.mjs`, picked for sentence nouns by `select.mjs`,',
    'normalized (metres, +Y up, +Z forward, base-centre pivot, textures kept up to 512 px, untextured parts in the project palette, LOD1)',
    'by `normalize.mjs --style`, and written here by `promote.mjs` within a size budget (`promote-report.json` lists what fell out).',
    'CC0 1.0 needs no attribution; the credit below is voluntary.',
    '',
    '| Model | Noun | Author | Pack | Source file | License |',
    '|---|---|---|---|---|---|',
    ...rows.map((row) => `| \`${row.assetId}\` | ${row.noun} | ${row.author} | [${row.pack}](${row.pageUrl}) | \`${row.file}\` | ${row.license} |`),
    '',
    '## Pack licence texts',
    '',
    ...packs.map((pack) => `- \`${pack.id}\` – [licenses/${pack.id}.txt](licenses/${pack.id}.txt), ${pack.licenseUrl}`),
    '',
  ];
  return lines.join('\n');
}

export async function promote({ root = ROOT, budget = BUDGET } = {}) {
  const read = (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
  const manifest = read('asset-quarantine/cc0-manifest.json');
  const selection = read('scripts/assets/cc0/selection.json');
  const fetched = read('scripts/assets/cc0/fetched.json');
  const packs = new Map(read('scripts/assets/cc0/sources.json').packs.map((pack) => [pack.id, pack]));
  const licenseFiles = new Map(fetched.packs.filter((entry) => !entry.skipped).map((entry) => [entry.pack, entry.licenseFile.replace('<cache>', fetched.cache)]));
  // Štítky širokého výběru (T10) jdou do tagů stejně jako synonyma.
  const synonyms = new Map(selection.selected.map((entry) => [`${entry.noun}#${entry.sense ?? ''}`, [...(entry.synonyms ?? []), ...(entry.tags ?? [])]]));
  const catalog = read('src/assets/catalog.json');
  const disclosure = read('disclosure.json');

  const publicDir = path.join(root, PUBLIC_DIR);
  mkdirSync(path.join(publicDir, 'licenses'), { recursive: true });
  const others = catalog.assets.filter((asset) => !isCc0(asset));
  const taken = new Set(others.flatMap((asset) => [asset.assetId, ...asset.tags]));
  const entries = [];
  const rows = [];
  const usedPacks = new Map();
  const keep = new Set(['PROVENANCE.md', 'licenses']);

  // Model, který z výběru vypadl po normalizaci (ruční oprava dat), se nezařadí.
  const selected = new Set(selection.selected.map((entry) => `${entry.pack}/${entry.file}`));
  const sized = manifest.normalized.filter((entry) => entry.styled && selected.has(`${entry.pack}/${entry.file}`)).map((item) => {
    const record = read(`asset-quarantine/${item.assetId}/cc0.json`);
    const bytes = record.lod0.bytes + record.lod1.bytes;
    const preview = path.join(publicDir, `${item.assetId}.png`);
    return { item, record, assetId: item.assetId, category: item.category, bytes, folderBytes: bytes + (existsSync(preview) ? statSync(preview).size : 0) };
  });
  const { kept, dropped } = fitBudget(sized, budget);

  for (const { item, record, bytes } of kept) {
    const pack = packs.get(record.pack);
    const tags = cc0Tags({ noun: item.noun, file: item.file, synonyms: synonyms.get(`${item.noun}#${item.sense ?? ''}`) }, taken);
    if (!tags.includes(item.noun)) { // jméno z věty už nese jiný model
      dropped.push({ assetId: item.assetId, category: item.category, bytes, reason: `"${item.noun}" is already a tag of another catalog model` });
      continue;
    }
    tags.forEach((tag) => taken.add(tag));
    usedPacks.set(pack.id, pack);
    const lods = [record.lod0, record.lod1].map((lod) => {
      const name = `${item.assetId}-lod${lod.level}.glb`;
      copyFileSync(lod.file, path.join(publicDir, name));
      keep.add(name);
      return { level: lod.level, path: `${URL_BASE}/${name}`, hash: lod.hash, bytes: lod.bytes, triangles: lod.triangles, decodedGeometryBytes: lod.decodedGeometryBytes, decodedTextureBytes: lod.decodedTextureBytes, minScreenPixels: lod.level ? 0 : 160 };
    });
    // Náhled modelu, který minulý běh vyřadil a smazal, se vykreslí znovu.
    const preview = path.join(publicDir, `${item.assetId}.png`);
    if (!existsSync(preview)) writeFileSync(preview, await renderPreview(record.lod0.file));
    keep.add(`${item.assetId}.png`);
    const { candidate } = record;
    entries.push({
      assetId: item.assetId, version: 1, hash: lods[0].hash, label: candidate.label, tags, style: candidate.style,
      thumbnail: `${URL_BASE}/${item.assetId}.png`,
      provenance: { source: SOURCE, author: pack.author, license: pack.license, licenseEvidence: licenseFileOf(pack.id), importedAt: candidate.provenance.importedAt, sourceHash: candidate.provenance.sourceHash },
      units: 'meters', up: '+Y', front: '+Z', pivot: [0, 0, 0], bounds: outward(candidate.bounds), stretchableAxes: [], lods,
      materials: candidate.materials, collision: candidate.collision, sockets: [], supportSurfaces: [], parts: candidate.parts,
    });
    rows.push({ assetId: item.assetId, noun: item.noun, category: item.category, bytes, author: pack.author, pack: pack.id, pageUrl: pack.pageUrl, file: item.file, license: pack.license });
  }

  // Kontaktní arch po kategoriích (`_sheet-<kategorie>.png`) místo jednoho archu přes 500 modelů.
  for (const category of [...new Set(rows.map((row) => row.category))].sort()) {
    const previews = rows.filter((row) => row.category === category && existsSync(path.join(publicDir, `${row.assetId}.png`)))
      .map((row) => ({ id: row.assetId, png: readFileSync(path.join(publicDir, `${row.assetId}.png`)) }));
    const name = `_sheet-${category}.png`;
    writeFileSync(path.join(publicDir, name), await contactSheet(previews));
    keep.add(name);
  }

  for (const pack of usedPacks.values()) copyFileSync(licenseFiles.get(pack.id), path.join(root, licenseFileOf(pack.id)));
  for (const name of readdirSync(publicDir)) if (!keep.has(name)) rmSync(path.join(publicDir, name), { recursive: true, force: true });
  for (const name of readdirSync(path.join(publicDir, 'licenses'))) if (!usedPacks.has(name.replace(/\.txt$/, ''))) rmSync(path.join(publicDir, 'licenses', name));
  writeFileSync(path.join(publicDir, 'PROVENANCE.md'), provenanceMarkdown(rows, [...usedPacks.values()]));

  catalog.assets = [...others, ...entries];
  writeFileSync(path.join(root, 'src/assets/catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  writeFileSync(path.join(root, 'src/assets/catalog-index.json'), `${JSON.stringify(catalogIndex(catalog), null, 2)}\n`);

  const byName = new Map(rows.map((row) => [row.assetId, row]));
  const records = [];
  const walk = (dir) => {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { walk(name); continue; }
      const model = byName.get(entry.name.replace(/(-lod\d)?\.(glb|png)$/, ''));
      if (model) {
        records.push(disclosureRecord(name, {
          reason: `CC0 model "${model.noun}" from ${model.pack}, normalized and recoloured by scripts/assets/cc0/normalize.mjs${entry.name.endsWith('.png') ? '; this file is a preview render of it' : ''}.`,
          source: model.pageUrl, author: model.author, license: model.license,
          attribution: `${model.noun} (${model.file}) from ${model.pack} by ${model.author}, ${model.license}`,
          reviewNote: `Pack licence text stored at ${licenseFileOf(model.pack)} and checked against the declared licence by scripts/assets/cc0/fetch.mjs; promote.mjs --check re-checks it.`,
        }));
      } else {
        const pack = usedPacks.get(entry.name.replace(/\.txt$/, ''));
        records.push(disclosureRecord(name, {
          reason: pack ? `Licence text shipped inside the ${pack.id} pack, kept as evidence for its CC0 models.` : 'Provenance table or contact sheet of the CC0 models, generated by scripts/assets/cc0.',
          source: pack ? pack.pageUrl : 'scripts/assets/cc0/promote.mjs',
          author: pack ? pack.author : [...new Set(rows.map((row) => row.author))].join('; '),
          license: 'CC0-1.0',
          attribution: pack ? `${pack.id} by ${pack.author}, CC0 1.0` : `Renders and table of CC0 models by ${[...new Set(rows.map((row) => row.author.replace(/ \(.*\)$/, '')))].sort().join(', ')}, CC0 1.0`,
          reviewNote: 'Covers only CC0 1.0 material; every model it lists has its own disclosure record.',
        }));
      }
    }
  };
  walk(PUBLIC_DIR);
  disclosure.entries = [...disclosure.entries.filter((entry) => !(entry.kind === 'asset' && entry.name.startsWith(`${PUBLIC_DIR}/`))), ...records];
  writeFileSync(path.join(root, 'disclosure.json'), `${JSON.stringify(disclosure, null, 2)}\n`);

  const totalBytes = folderBytes(publicDir);
  const report = {
    about: 'P26A T11 – which normalized CC0 models made the catalog and why the rest did not. Written by scripts/assets/cc0/promote.mjs.',
    budget, totalBytes,
    promoted: rows.map(({ assetId, category, bytes }) => ({ assetId, category, bytes })),
    dropped: dropped.map(({ assetId, category, bytes, reason }) => ({ assetId, category, bytes, reason })),
    failed: manifest.failed.map(({ assetId, error }) => ({ assetId, reason: `normalize failed: ${error}` })),
  };
  writeFileSync(path.join(root, 'scripts/assets/cc0/promote-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return { promoted: entries.length, dropped: dropped.length, files: records.length, totalBytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--check')) {
    const { promoted, dropped, files, totalBytes } = await promote();
    console.log(`${promoted} CC0 models in the catalog (${dropped} dropped), ${files} files disclosed, ${totalBytes} B`);
  }
  const read = (file) => JSON.parse(readFileSync(path.join(ROOT, file), 'utf8'));
  const problems = checkCatalog({ catalog: read('src/assets/catalog.json'), disclosure: read('disclosure.json') });
  for (const problem of problems) console.error(problem);
  console.log(problems.length ? `${problems.length} problems` : 'CC0 catalog entries: licences, licence texts and disclosure OK');
  process.exitCode = problems.length ? 1 : 0;
}
