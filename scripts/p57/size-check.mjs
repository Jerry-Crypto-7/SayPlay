#!/usr/bin/env node
/**
 * P57 T11: brána velikosti po výměnách modelů.
 *
 *   node scripts/p57/size-check.mjs [--base 72665fdc] [--head HEAD]
 *
 * `public/assets` (trackované soubory, `git ls-tree`) smí proti výchozímu commitu P57 narůst nejvýš
 * o 15 % a žádný model vyměněný pod stejným id (`provenance.replacedAt`) nesmí mít LOD1 větší než
 * původní – telefon stahuje LOD1, na desktopu by nafouknutý model vypadal jako zlepšení. Exit 1 s
 * výpisem porušení.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MAX_GROWTH = 0.15;

/** LOD1, nebo nejhrubší LOD u modelu, který LOD1 nemá. */
const lod1 = (asset) => (asset.lods.find((lod) => lod.level === 1) ?? asset.lods.at(-1))?.bytes;

/** `{ bytes, catalog }` výchozího a nového stavu → `{ growth, failures }`. */
export function sizeGate(base, head) {
  const growth = Math.round(((head.bytes - base.bytes) / base.bytes) * 1000) / 1000;
  const failures = [];
  if (growth > MAX_GROWTH) failures.push(`public/assets grew ${(growth * 100).toFixed(1)} % (${base.bytes} → ${head.bytes} B), cap ${MAX_GROWTH * 100} %`);
  const before = new Map(base.catalog.assets.map((asset) => [asset.assetId, lod1(asset)]));
  for (const asset of head.catalog.assets) {
    if (!asset.provenance?.replacedAt || !before.has(asset.assetId)) continue;
    const [now, was] = [lod1(asset), before.get(asset.assetId)];
    if (now > was) failures.push(`${asset.assetId}: LOD1 ${now} B > original ${was} B`);
  }
  return { growth, failures };
}

function stateAt(rev) {
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
  const bytes = git('ls-tree', '-r', '-l', rev, 'public/assets').split('\n').filter(Boolean)
    .reduce((sum, line) => sum + Number(line.split(/\s+/)[3]), 0);
  return { bytes, catalog: JSON.parse(git('show', `${rev}:src/assets/catalog.json`)) };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const [baseRev, headRev] = [flag('--base', '72665fdc'), flag('--head', 'HEAD')];
  const [base, head] = [stateAt(baseRev), stateAt(headRev)];
  const { growth, failures } = sizeGate(base, head);
  const replaced = head.catalog.assets.filter((asset) => asset.provenance?.replacedAt).length;
  console.log(`size-check ${baseRev}..${headRev}: public/assets ${base.bytes} → ${head.bytes} B (${(growth * 100).toFixed(1)} %), ${replaced} replaced models checked`);
  for (const failure of failures) console.log(`FAIL ${failure}`);
  process.exit(failures.length > 0 ? 1 : 0);
}
