#!/usr/bin/env node
/**
 * P57 T6: přegenerovat modely knihovny se skóre pod 6 (`judge.json` `below6` bez top 50 – ty dělá T8).
 *
 *   node scripts/p57/regen.mjs --batch 1 [--size 20] [--out D:/caches/p57/regen]
 *
 * Dávka N = id `(N-1)*size … N*size` v pořadí použití. Kolo 1 (zadání `b`, semínko 1) a kolo 2
 * jen pro id bez vítěze (zadání `a`, semínko 2) jdou přes `ops/gen3d/batch.py` s vlastní cache
 * (sdílená by vrátila starý model) a s opravou z `[judge_fix]` v `features.toml`. Kandidát se
 * uniformně přeškáluje do starého boxu a zjednoduší tak, aby LOD1 nevyšel těžší než starý (T5 by
 * ho jinak odmítl); pak ho slepě soudí Opus na mřížkách 3×3 – spolu se starými modely, které Opus
 * v T4 nesoudil, aby nové i staré skóre dal týž soudce (Codex má strop 30/den). Vítěz se skóre
 * ≥ 6 a vyšším než staré jde přes `replaceModels` (T5); výsledek každého id v `regen.json`.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REPORT = path.join(ROOT, 'evals/play/p57/regen.json');
export const PASS = 6;
/** ±10 % na osu v `replaceModels`; rezerva na zaokrouhlení `outward`. */
export const MAX_SPREAD = 1.2;
const ROUNDS = [{ round: 1, attempt: 'b1' }, { round: 2, attempt: 'a2' }];
// Třída šablony zadání (`config.toml` `[prompts.*]`); ostatní jména jsou `prop`.
const CLASSES = {
  quadruped: ['bear', 'donkey', 'squirrel', 'frog', 'manticore'],
  biped: ['baby', 'mummy', 'santa', 'frost giant', 'gang'],
  flyer: ['brown owl', 'toucan', 'pigeon'],
  swimmer: ['clownfish', 'koi', 'turbot', 'manta ray'],
  vehicle: ['moon lander', 'planet rover', 'mine cart', 'train', 'fighter jet', 'sailboat', 'ride'],
};
export const classOf = (noun) => Object.keys(CLASSES).find((name) => CLASSES[name].includes(noun)) ?? 'prop';

/** Cíle T6 v pořadí `below6` (podle použití), bez top 50. */
export const targets = (judge, usage) => {
  const top50 = new Set(usage.top300.slice(0, 50));
  return judge.below6.filter((id) => !top50.has(id));
};

/** Staré skóre od Opuse: z T4, jinak z dnešního přesoudu (`null` = ještě nesouzeno). */
export const oldOpusOf = (model) => model.claude?.score ?? null;

/** Natažení po osách nejvýš tolikrát (plán „Co nevíme“: TRELLIS mění proporce); zbytek posoudí soudce. */
export const MAX_STRETCH = 1.5;

/**
 * Měřítko [x, y, z] do starého boxu: stejné na všech osách, když se tvar vejde do ±10 %,
 * jinak přesně na starý box, dokud poměr os nepřesáhne `MAX_STRETCH`; jinak `null`.
 */
export function fitScale(dims, oldDims) {
  const ratios = dims.map((value, axis) => value / oldDims[axis]);
  const spread = Math.max(...ratios) / Math.min(...ratios);
  if (spread > MAX_STRETCH) return null;
  if (spread > MAX_SPREAD) return ratios.map((ratio) => 1 / ratio);
  const uniform = 1 / Math.sqrt(Math.max(...ratios) * Math.min(...ratios));
  return [uniform, uniform, uniform];
}

/** Vítěz kola: nejlepší kandidát se skóre ≥ 6 a vyšším než staré skóre téhož soudce. */
export function winnerOf(attempts, oldScore) {
  const passing = attempts.filter((attempt) => attempt.score !== null && attempt.score !== undefined && attempt.score >= PASS && attempt.score > oldScore);
  return passing.sort((a, b) => b.score - a.score)[0] ?? null;
}

/** Výsledek id bez vítěze nebo s odmítnutím z `replaceModels`. */
export function resultOf(attempts, refused) {
  if (refused) return refused.startsWith('bounds:') ? 'rejected-bounds' : 'kept-old';
  return attempts.length > 0 && attempts.every((attempt) => attempt.fit === 'bounds') ? 'rejected-bounds' : 'kept-old';
}

const triangles = (doc) => doc.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives())
  .reduce((sum, prim) => sum + (prim.getIndices() ?? prim.getAttribute('POSITION')).getCount() / 3, 0);

/** Přeškáluje kandidáta do starého boxu a zjednoduší LOD0 na `budget`; vrátí rozměry a trojúhelníky. */
export async function fit(input, output, oldDims, budget) {
  const { NodeIO } = await import('@gltf-transform/core');
  const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
  const { getBounds, prune, simplify, weld } = await import('@gltf-transform/functions');
  const { MeshoptSimplifier } = await import('meshoptimizer');
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(input);
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  const box = getBounds(scene);
  const scale = fitScale([0, 1, 2].map((axis) => box.max[axis] - box.min[axis]), oldDims);
  if (scale === null) return { fit: 'bounds' };
  // Obal bez otočení: měřítko jde po osách světa a kolem počátku, pivot dole uprostřed zůstane.
  const wrapper = doc.createNode('p57-fit').setScale(scale);
  for (const node of scene.listChildren()) {
    scene.removeChild(node);
    wrapper.addChild(node);
  }
  scene.addChild(wrapper);
  await MeshoptSimplifier.ready;
  for (let error = 0.01; triangles(doc) > budget && error <= 1; error *= 4) {
    await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: (budget / triangles(doc)) * 0.95, error }), prune());
  }
  const tris = triangles(doc);
  if (tris > budget) return { fit: 'lod1-budget', scale, triangles: tris };
  writeFileSync(output, await io.writeBinary(doc));
  const after = getBounds(doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0]);
  return { fit: 'ok', scale: scale.map((value) => Number(value.toFixed(4))), triangles: tris, dims: [0, 1, 2].map((axis) => after.max[axis] - after.min[axis]) };
}

export const dimsOf = (bounds) => [0, 1, 2].map((axis) => bounds.max[axis] - bounds.min[axis]);
export const shuffleKey = (seed, key) => createHash('sha256').update(`${seed}:${key}`).digest('hex');

async function main() {
  if (!process.features.typescript) {
    const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
    process.exit(run.status ?? 1);
  }
  const { scoreSheet, paletteOf } = await import('../p37d/judge-sheet.mjs');
  const { replaceModels } = await import('../p37d/promote-batch.mjs');
  const { sheetEntries, mergeAttempts } = await import('./judge-library.mjs');
  const { assertNotTrainingDir } = await import('../assets/qa-astra.mjs');
  const args = process.argv.slice(2);
  const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const batchNo = Number(flag('--batch'));
  const size = Number(flag('--size', '20'));
  const read = (file) => JSON.parse(readFileSync(path.join(ROOT, file), 'utf8'));
  const judge = read('evals/play/p57/judge.json');
  const usage = read('evals/play/p57/usage.json');
  const catalog = read('src/assets/catalog.json');
  const byId = new Map(catalog.assets.map((asset) => [asset.assetId, asset]));
  const leafOf = new Map(sheetEntries(usage).filter((entry) => entry.leaf).map((entry) => [entry.id, entry.leaf]));
  const out = path.resolve(flag('--out', 'D:/caches/p57/regen'), `batch-${batchNo}`);
  assertNotTrainingDir(out);
  mkdirSync(out, { recursive: true });

  const report = existsSync(REPORT) ? JSON.parse(readFileSync(REPORT, 'utf8')) : {
    about: 'P57 T6: library models scored below 6 (top 50 excluded, T8) regenerated by ops/gen3d with the judge-driven fix from features.toml [judge_fix], up to 2 attempts (prompt b seed 1, then prompt a seed 2). Each candidate is scaled uniformly into the old box and simplified so its LOD1 stays under the old one, then judged blind by Opus 5.5 on 3x3 grids (same question as T4); old models Opus did not score in T4 are rejudged on the same grids so old and new come from the same judge. replaced = new score >= 6 and above the old one, swapped in by promote-batch --replace (T5).',
    batches: {}, models: {},
  };
  const save = () => writeFileSync(REPORT, `${JSON.stringify(report, null, 1)}\n`);
  const ids = targets(judge, usage).slice((batchNo - 1) * size, batchNo * size).filter((id) => !report.models[id]?.result);
  if (ids.length === 0) return console.log(`batch ${batchNo}: nothing left`);
  report.batches[batchNo] = { ids, startedAt: new Date().toISOString(), ...report.batches[batchNo] };
  save();

  const state = new Map(ids.map((id) => {
    const model = judge.models[id];
    return [id, { id, noun: byId.get(id).tags[0], old: model, oldOpus: oldOpusOf(model), attempts: [] }];
  }));
  const imageModel = { klein: 'FLUX.2-klein-4B', zimage: 'Z-Image-Turbo' }[/^image_model\s*=\s*"(\w+)"/m.exec(readFileSync(path.join(ROOT, 'ops/gen3d/config.toml'), 'utf8'))[1]];

  for (const { round, attempt } of ROUNDS) {
    const todo = [...state.values()].filter((item) => !winnerOf(item.attempts, item.oldOpus ?? item.old.score));
    if (todo.length === 0) break;
    const dir = path.join(out, `round-${round}`);
    mkdirSync(path.join(dir, 'fit'), { recursive: true });
    const nounsFile = path.join(dir, 'nouns.json');
    writeFileSync(nounsFile, JSON.stringify({ nouns: todo.map((item) => ({ noun: item.noun, class: classOf(item.noun), flat: false })) }));
    const record = path.join(dir, 'batch.json');
    console.log(`batch ${batchNo} round ${round}: generating ${todo.length} (${attempt})`);
    const gen = spawnSync('uv', ['run', 'batch.py', '--from', nounsFile, '--limit', '999', '--record', record, '--sheet', path.join(dir, 'sheet.png'), '--attempts', attempt, '--no-quarantine', '--start-comfy'],
      { cwd: path.join(ROOT, 'ops/gen3d'), env: { ...process.env, GEN3D_CACHE_DIR: path.join(dir, 'cache') }, stdio: 'inherit' });
    if (gen.status !== 0) throw new Error(`batch.py exit ${gen.status}`);
    const records = new Map(JSON.parse(readFileSync(record, 'utf8')).records.map((entry) => [entry.noun, entry]));

    const cells = [];
    for (const item of todo) {
      const made = records.get(item.noun);
      const asset = byId.get(item.id);
      const entry = { round, prompt: attempt[0], seed: Number(attempt.slice(1)) };
      item.attempts.push(entry);
      if (made?.verdict !== 'passed') {
        entry.gate = made?.reason ?? 'no record';
        continue;
      }
      const budget = Math.floor(asset.lods.find((lod) => lod.level === 1).triangles * 2 * 0.9);
      const glb = path.join(dir, 'fit', `${item.id}.glb`);
      Object.assign(entry, await fit(made.glb, glb, dimsOf(asset.bounds), budget));
      if (entry.fit !== 'ok') continue;
      entry.glb = glb;
      cells.push({ key: `new:${item.id}:${round}`, glb, leaf: leafOf.get(item.id) });
    }
    if (round === 1) {
      // Staré modely, které Opus v T4 neviděl: přesoud na týchž listech, aby srovnání dal týž soudce.
      for (const item of todo.filter((item) => item.oldOpus === null)) {
        cells.push({ key: `old:${item.id}`, glb: path.join(ROOT, 'public', byId.get(item.id).lods.find((lod) => lod.level === 0).path), leaf: leafOf.get(item.id) });
      }
    }
    if (cells.length > 0) {
      cells.sort((a, b) => shuffleKey(`${batchNo}-${round}`, a.key).localeCompare(shuffleKey(`${batchNo}-${round}`, b.key)));
      // `qa-sheets` hotový list přeskočí: jiná sada buněk (navázaný běh) musí dostat jiný adresář.
      const sheets = path.join(dir, `sheets-${shuffleKey('cells', cells.map((cell) => cell.key).join(',')).slice(0, 8)}`);
      writeFileSync(path.join(dir, 'glb-list.json'), JSON.stringify(cells.map(({ key, glb }) => ({ id: key, glb }))));
      writeFileSync(path.join(dir, 'ids.json'), JSON.stringify(cells.map(({ key, leaf }) => (leaf ? { id: key, leaf } : { id: key }))));
      spawnSync(process.execPath, [path.join(ROOT, 'scripts/assets/qa-sheets.mjs'), '--grid', '3', '--glb-list', path.join(dir, 'glb-list.json'), '--ids', path.join(dir, 'ids.json'), '--out', sheets], { stdio: 'inherit' });
      const plan = JSON.parse(readFileSync(path.join(sheets, 'grid-index.json'), 'utf8'));
      const scored = new Map();
      const queue = [...plan.sheets];
      const worker = async () => {
        for (let sheet = queue.shift(); sheet !== undefined; sheet = queue.shift()) {
          const png = path.join(sheets, `${sheet.sheet}.png`);
          let got = (await scoreSheet(png, sheet.cells.length, path.join(dir, 'judge'), 'claude')).cells;
          if (got.some((cell) => cell === null)) got = mergeAttempts(got, (await scoreSheet(png, sheet.cells.length, path.join(dir, 'judge'), 'claude')).cells);
          sheet.cells.forEach((key, index) => scored.set(key, got[index]));
          console.log(`${sheet.sheet}: ${got.map((cell) => cell?.score ?? '-').join(' ')}`);
        }
      };
      await Promise.all([worker(), worker()]);
      for (const item of todo) {
        const entry = item.attempts.at(-1);
        const cell = scored.get(`new:${item.id}:${round}`);
        if (cell !== undefined) Object.assign(entry, { score: cell?.score ?? null, reason: cell ? `${cell.name}: ${cell.reason}` : 'unread' });
        const old = scored.get(`old:${item.id}`);
        if (old) item.oldOpus = old.score;
      }
    }
    for (const item of todo) report.models[item.id] = { ...report.models[item.id], noun: item.noun, oldScore: item.old.score, oldJudge: ['codex', 'claude'].filter((name) => item.old[name]).join('+'), oldOpus: item.oldOpus, attempts: item.attempts.map(({ glb, ...rest }) => rest) };
    save();
  }

  const winners = [...state.values()].map((item) => ({ item, win: winnerOf(item.attempts, item.oldOpus ?? item.old.score) })).filter(({ win }) => win);
  const entries = [];
  for (const { item, win } of winners) {
    entries.push({
      id: item.id, nouns: [item.noun], glb: win.glb, bounds: win.dims, palette: await paletteOf(win.glb),
      source: { pipeline: 'ops/gen3d', imageModel, shapeModel: 'TRELLIS.2-4B', seed: win.seed },
      licence: 'LicenseRef-Worldsmith-Generated',
      checked: { judge: `P57 T6 blind 1-10 grid, Opus 5.5: ${win.score} (old ${item.oldOpus ?? item.old.score})`, verdict: 'pass' },
    });
  }
  const batch = { schema: 'catalog-batch.v1', entries };
  writeFileSync(path.join(out, 'catalog-batch.json'), `${JSON.stringify(batch, null, 1)}\n`);
  const { replaced, skipped } = entries.length > 0 ? await replaceModels(batch) : { replaced: [], skipped: [] };
  const refusedOf = new Map(skipped.map((entry) => [entry.id, entry.reason]));
  for (const item of state.values()) {
    const win = winners.find((entry) => entry.item === item)?.win;
    const refused = refusedOf.get(item.id);
    const model = report.models[item.id];
    model.newScore = win?.score ?? (Math.max(0, ...item.attempts.map((attempt) => attempt.score ?? 0)) || null);
    model.result = replaced.includes(item.id) ? 'replaced' : resultOf(item.attempts, refused);
    if (refused) model.reason = refused;
  }
  report.batches[batchNo].finishedAt = new Date().toISOString();
  save();
  const count = (result) => ids.filter((id) => report.models[id].result === result);
  console.log(`batch ${batchNo}: replaced ${count('replaced').length}, kept-old ${count('kept-old').length}, rejected-bounds ${count('rejected-bounds').length}; replaced ${count('replaced').join(' ')}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
