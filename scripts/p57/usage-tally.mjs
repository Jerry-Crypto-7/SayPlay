#!/usr/bin/env node
/**
 * Sčítání použití modelů (P57 T2): které modely porotce ve hrách vidí nejčastěji.
 * Věty dev sad projdou `census()` ze `scripts/play-scene-census.mjs` (rychlá verze bez
 * režiséra: hrdina, nepřítel, zbytek obsazení, kulisy sady, vegetace) a každý model katalogu
 * dostane počet scén (vět), ve kterých se objeví, a počet výskytů – model v kulisách
 * i ve vegetaci téže scény je 1 scéna a 2 výskyty. Id mimo katalog (riggované postavy
 * `rigged:*`, primitiva) jdou do `unknown`, ne do pořadí: P57 je soudit ani vyměnit neumí.
 *
 *   node scripts/p57/usage-tally.mjs [--out evals/play/p57/usage.json]
 *
 * Sady: p30 dev, p54c dev, p55 holdout (otevřený, `holdout-opened.json`) a 12 vět auditu.
 * Nikdy zapečetěné sady. Výstup: `models` (pořadí), `top300`, `sample100` (`pure-rand`,
 * semínko 57, z katalogu mimo top 300), `settings` (světy podle počtu scén) a `unknown`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { uniformInt } from 'pure-rand/distribution/uniformInt';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const SETS = ['evals/play/p30/dev.json', 'evals/play/p54c/dev.json', 'evals/play/p55/holdout.json', 'evals/play/p57/audit-12.json'];
export const TOP = 300;
export const SAMPLE = 100;
export const SEED = 57;

/** Role modelu ve scéně: obsazení bez hrdiny a nepřítele je `cast`. */
const rolesOf = (row) => [
  ['hero', [row.hero]],
  ['enemy', [row.enemy]],
  ['cast', row.cast.filter((id) => id !== row.hero && id !== row.enemy)],
  ['scenery', row.scenery],
  ['flora', row.flora],
];

const bump = (record, key, by = 1) => {
  record[key] = (record[key] ?? 0) + by;
};

/**
 * Řádky sčítání → pořadí modelů katalogu (`known`) podle scén, pak výskytů, pak id;
 * `top` je prvních `options.top` id, `settings` světy podle počtu scén.
 */
export function tally(rows, known, options = {}) {
  const models = new Map();
  const unknown = {};
  const settings = new Map();
  for (const row of rows) {
    const setting = row.setting.trim().toLowerCase();
    const world = settings.get(setting) ?? { setting, scenes: 0, looks: {}, kit: row.kit };
    world.scenes += 1;
    bump(world.looks, row.look);
    settings.set(setting, world);
    const seen = new Set();
    for (const [role, ids] of rolesOf(row)) {
      for (const id of ids) {
        const first = !seen.has(id);
        seen.add(id);
        if (!known.has(id)) {
          unknown[id] ??= { scenes: 0, uses: 0 };
          unknown[id].scenes += first ? 1 : 0;
          unknown[id].uses += 1;
          continue;
        }
        const model = models.get(id) ?? { id, scenes: 0, uses: 0, roles: {}, settings: {} };
        if (first) {
          model.scenes += 1;
          bump(model.settings, setting);
        }
        model.uses += 1;
        bump(model.roles, role);
        models.set(id, model);
      }
    }
  }
  const ranked = [...models.values()].sort((a, b) => b.scenes - a.scenes || b.uses - a.uses || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    models: ranked,
    top: ranked.slice(0, options.top ?? TOP).map((model) => model.id),
    settings: [...settings.values()].sort((a, b) => b.scenes - a.scenes || (a.setting < b.setting ? -1 : 1)),
    unknown: Object.fromEntries(Object.entries(unknown).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

/** Vzorek `count` id katalogu mimo `top`; ocas se seřadí podle id, takže stejné semínko = stejný vzorek. */
export function sampleTail(catalogIds, top, { seed, count }) {
  const skip = new Set(top);
  const pool = catalogIds.filter((id) => !skip.has(id)).sort();
  const rng = xoroshiro128plus(seed);
  const sample = [];
  while (sample.length < count && pool.length > 0) sample.push(pool.splice(uniformInt(rng, 0, pool.length - 1), 1)[0]);
  return sample;
}

async function main() {
  const at = process.argv.indexOf('--out');
  const out = resolve(ROOT, at === -1 ? 'evals/play/p57/usage.json' : process.argv[at + 1]);
  const { census } = await import(pathToFileURL(join(ROOT, 'scripts', 'play-scene-census.mjs')).href);
  const catalog = JSON.parse(readFileSync(join(ROOT, 'src', 'assets', 'catalog.json'), 'utf8')).assets.map((asset) => asset.assetId);
  const rows = [];
  const sets = [];
  for (const set of SETS) {
    const report = census(JSON.parse(readFileSync(join(ROOT, set), 'utf8')).sentences);
    rows.push(...report.rows);
    sets.push({ set, measured: report.measured, skipped: report.skipped.length });
  }
  const result = tally(rows, new Set(catalog));
  const usage = {
    about: 'P57 T2 model usage: dev sentences through the scene census (fast version, no director). scenes = sentences whose scene shows the model, uses = role slots it fills there (hero, enemy, cast, scenery, flora). Ranked by scenes, then uses, then id. unknown = ids outside src/assets/catalog.json (rigged characters, primitives). sample100 = pure-rand seed 57 over catalog ids outside top300.',
    sets,
    scenes: rows.length,
    catalog: catalog.length,
    used: result.models.length,
    top300: result.top,
    sample100: sampleTail(catalog, result.top, { seed: SEED, count: SAMPLE }),
    settings: result.settings,
    unknown: result.unknown,
    models: result.models,
  };
  writeFileSync(out, `${JSON.stringify(usage, null, 1)}\n`);
  console.log(`${rows.length} scén z ${sets.length} sad, ${result.models.length} modelů katalogu použito, top ${usage.top300.length}, vzorek ${usage.sample100.length}, ${Object.keys(result.unknown).length} id mimo katalog`);
  console.log(`světy: ${result.settings.slice(0, 15).map((world) => `${world.setting} ${world.scenes} (kit ${world.kit})`).join(', ')}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && !process.features.typescript) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', pathToFileURL(join(ROOT, 'scripts', 'ts-paths.mjs')).href, fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', cwd: ROOT });
  process.exit(run.status ?? 1);
} else if (isMain) await main();
