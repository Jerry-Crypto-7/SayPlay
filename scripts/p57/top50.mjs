#!/usr/bin/env node
/**
 * P57 T8: top 50 nejpoužívanějších modelů na 8+.
 *
 *   node scripts/p57/top50.mjs --batch 1 --round 1 [--size 10] [--out D:/caches/p57/top50]
 *   node scripts/p57/top50.mjs --batch 1 --round 2 --fixes <{id: oprava}.json> --finish
 *
 * Cíle: top 50 podle `usage.json` – gen3d vždy (i s 8+), CC0 a originály jen pod 8. Kolo = 4
 * kandidáti (zadání a/b × 2 semínka) přes `ops/gen3d/batch.py --profile hero`, každý pokus
 * s vlastní cache. Kandidát se vejde do starého boxu (`fit` z T6, strop LOD0 hero), Opus
 * vybere nejlepšího z mřížky 2×2 a ten jde na druhý slepý soud na mřížkách 3×3 – spolu se
 * starými modely, které Opus v T4 nesoudil, aby nové i staré skóre dal týž soudce. Vítěz
 * kola = skóre ≥ 8 a vyšší než staré. Kolo 2 jen pro id bez vítěze, s opravou zadání
 * z důvodu soudce (`--fixes`, jinak `[judge_fix]`). Průběh v `<out>/batch-N/state.json`;
 * `--finish` vymění vítěze přes `replaceModels(..., { profile: 'hero' })` (LOD1 nejvýš
 * starý) a zapíše `evals/play/p57/top50.json` se souhrnem přes všech 50.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classOf, dimsOf, fit, resultOf, shuffleKey } from './regen.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REPORT = path.join(ROOT, 'evals/play/p57/top50.json');
const GENERATED = 'LicenseRef-Worldsmith-Generated';
export const HERO_PASS = 8;
/** 2 zadání × 2 semínka na kolo; druhé kolo jiná semínka. */
export const ROUND_ATTEMPTS = { 1: ['a1', 'b1', 'a2', 'b2'], 2: ['a3', 'b3', 'a4', 'b4'] };

/** Cíle T8 v pořadí použití: gen3d vždy, ostatní jen se skóre pod 8. */
export function heroTargets(judge, usage, catalog) {
  const byId = new Map(catalog.assets.map((asset) => [asset.assetId, asset]));
  return usage.top300.slice(0, 50).filter((id) => byId.get(id).provenance.license === GENERATED || !(judge.models[id]?.score >= HERO_PASS));
}

/** Nejlepší kandidát z mřížky 2×2 podle `pick`; nečitelné buňky ven, shoda → dřívější. */
export const pickBest = (candidates) => candidates.filter((candidate) => typeof candidate.pick === 'number')
  .reduce((best, candidate) => (best && best.pick >= candidate.pick ? best : candidate), null);

/** Vítěz kola: druhý soud ≥ 8 a víc, než má starý model od téhož soudce. */
export const heroWins = (score, old) => typeof score === 'number' && score >= HERO_PASS && score > (old ?? Number.NEGATIVE_INFINITY);

/** Souhrn přes celou top 50: kolik má skóre ≥ 8 a kdo zůstal pod, se skóre a důvodem. */
export function heroSummary(usage, judge, models) {
  const below = [];
  let atLeast8 = 0;
  for (const id of usage.top300.slice(0, 50)) {
    const model = models[id];
    const old = judge.models[id];
    const score = model?.result === 'replaced' ? model.newScore : (model?.oldOpus ?? old?.score ?? null);
    if (score !== null && score >= HERO_PASS) atLeast8++;
    else below.push({ id, score, reason: model?.reason ?? (old?.claude ?? old?.codex)?.reason ?? 'unjudged' });
  }
  return { atLeast8, of: 50, below };
}

async function main() {
  if (!process.features.typescript) {
    const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
    process.exit(run.status ?? 1);
  }
  const { scoreSheet, paletteOf } = await import('../p37d/judge-sheet.mjs');
  const { replaceModels } = await import('../p37d/promote-batch.mjs');
  const { HERO_MAX_TRIANGLES } = await import('../assets/cc0/normalize.mjs');
  const { sheetEntries, mergeAttempts } = await import('./judge-library.mjs');
  const { assertNotTrainingDir } = await import('../assets/qa-astra.mjs');
  const args = process.argv.slice(2);
  const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const batchNo = Number(flag('--batch'));
  const size = Number(flag('--size', '10'));
  const round = flag('--round') === undefined ? null : Number(flag('--round'));
  const read = (file) => JSON.parse(readFileSync(path.join(ROOT, file), 'utf8'));
  const judge = read('evals/play/p57/judge.json');
  const usage = read('evals/play/p57/usage.json');
  const catalog = read('src/assets/catalog.json');
  const byId = new Map(catalog.assets.map((asset) => [asset.assetId, asset]));
  const leafOf = new Map(sheetEntries(usage).filter((entry) => entry.leaf).map((entry) => [entry.id, entry.leaf]));
  const out = path.resolve(flag('--out', 'D:/caches/p57/top50'), `batch-${batchNo}`);
  assertNotTrainingDir(out);
  mkdirSync(out, { recursive: true });

  const ids = heroTargets(judge, usage, catalog).slice((batchNo - 1) * size, batchNo * size);
  const stateFile = path.join(out, 'state.json');
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {
    startedAt: new Date().toISOString(),
    models: Object.fromEntries(ids.map((id) => [id, { id, noun: byId.get(id).tags[0], oldScore: judge.models[id].score, oldOpus: judge.models[id].claude?.score ?? null, rounds: [] }])),
  };
  const saveState = () => writeFileSync(stateFile, `${JSON.stringify(state, null, 1)}\n`);
  saveState();

  // Dva souběžní Opusové nad listy; nečitelná buňka dostane druhý pokus.
  const judgeCells = async (dir, name, cells, grid) => {
    const sheets = path.join(dir, `${name}-${shuffleKey('cells', cells.map((cell) => cell.key).join(',')).slice(0, 8)}`);
    mkdirSync(sheets, { recursive: true });
    writeFileSync(path.join(sheets, 'glb-list.json'), JSON.stringify(cells.map(({ key, glb }) => ({ id: key, glb }))));
    writeFileSync(path.join(sheets, 'ids.json'), JSON.stringify(cells.map(({ key, leaf }) => (leaf ? { id: key, leaf } : { id: key }))));
    spawnSync(process.execPath, [path.join(ROOT, 'scripts/assets/qa-sheets.mjs'), '--grid', String(grid), '--glb-list', path.join(sheets, 'glb-list.json'), '--ids', path.join(sheets, 'ids.json'), '--out', sheets], { stdio: 'inherit' });
    const queue = [...JSON.parse(readFileSync(path.join(sheets, 'grid-index.json'), 'utf8')).sheets];
    const scored = new Map();
    const worker = async () => {
      for (let sheet = queue.shift(); sheet !== undefined; sheet = queue.shift()) {
        const png = path.join(sheets, `${sheet.sheet}.png`);
        let got = (await scoreSheet(png, sheet.cells.length, path.join(dir, 'judge'), 'claude')).cells;
        if (got.some((cell) => cell === null)) got = mergeAttempts(got, (await scoreSheet(png, sheet.cells.length, path.join(dir, 'judge'), 'claude')).cells);
        sheet.cells.forEach((key, index) => scored.set(key, got[index]));
        console.log(`${name} ${sheet.sheet}: ${got.map((cell) => cell?.score ?? '-').join(' ')}`);
      }
    };
    await Promise.all([worker(), worker()]);
    return scored;
  };

  if (round !== null) {
    const todo = Object.values(state.models).filter((item) => !item.rounds.some((done) => done.won || done.round === round));
    const fixes = flag('--fixes') ? JSON.parse(readFileSync(flag('--fixes'), 'utf8')) : {};
    const dir = path.join(out, `round-${round}`);
    mkdirSync(dir, { recursive: true });
    const nounsFile = path.join(dir, 'nouns.json');
    writeFileSync(nounsFile, JSON.stringify({ nouns: todo.map((item) => ({ noun: item.noun, class: classOf(item.noun), flat: false, ...(fixes[item.id] ? { fix: fixes[item.id] } : {}) })) }));
    const candidates = new Map(todo.map((item) => [item.id, []]));
    for (const attempt of ROUND_ATTEMPTS[round]) {
      const sub = path.join(dir, attempt);
      mkdirSync(path.join(sub, 'fit'), { recursive: true });
      const record = path.join(sub, 'batch.json');
      console.log(`top50 batch ${batchNo} round ${round} ${attempt}: generating ${todo.length}`);
      const gen = spawnSync('uv', ['run', 'batch.py', '--from', nounsFile, '--limit', '999', '--record', record, '--sheet', path.join(sub, 'sheet.png'), '--attempts', attempt, '--profile', 'hero', '--no-quarantine', '--start-comfy'],
        { cwd: path.join(ROOT, 'ops/gen3d'), env: { ...process.env, GEN3D_CACHE_DIR: path.join(sub, 'cache') }, stdio: 'inherit' });
      if (gen.status !== 0) throw new Error(`batch.py exit ${gen.status}`);
      const records = new Map(JSON.parse(readFileSync(record, 'utf8')).records.map((entry) => [entry.noun, entry]));
      for (const item of todo) {
        const made = records.get(item.noun);
        const entry = { prompt: attempt[0], seed: Number(attempt.slice(1)), key: `${item.id}:${attempt}` };
        candidates.get(item.id).push(entry);
        if (made?.verdict !== 'passed') {
          entry.gate = made?.reason ?? 'no record';
          continue;
        }
        const glb = path.join(sub, 'fit', `${item.id}.glb`);
        Object.assign(entry, await fit(made.glb, glb, dimsOf(byId.get(item.id).bounds), HERO_MAX_TRIANGLES));
        if (entry.fit === 'ok') entry.glb = glb;
      }
    }

    // Výběr z mřížky 2×2: jedna mřížka na id, pořadí kandidátů losované.
    for (const item of todo) {
      const ready = candidates.get(item.id).filter((entry) => entry.glb);
      if (ready.length < 2) {
        if (ready.length === 1) ready[0].pick = 0;
        continue;
      }
      const cells = ready.map((entry) => ({ key: entry.key, glb: entry.glb, leaf: leafOf.get(item.id) }))
        .sort((a, b) => shuffleKey(`pick-${round}`, a.key).localeCompare(shuffleKey(`pick-${round}`, b.key)));
      const scored = await judgeCells(dir, `pick-${item.id}`, cells, 2);
      for (const entry of ready) entry.pick = scored.get(entry.key)?.score ?? null;
    }

    // Druhý soud: vybraní a staré modely bez skóre od Opuse na mřížkách 3×3.
    const second = [];
    for (const item of todo) {
      const best = pickBest(candidates.get(item.id));
      if (best) second.push({ key: `new:${item.id}:${round}`, glb: best.glb, leaf: leafOf.get(item.id) });
    }
    if (round === 1) {
      for (const item of todo.filter((item) => item.oldOpus === null)) {
        second.push({ key: `old:${item.id}`, glb: path.join(ROOT, 'public', byId.get(item.id).lods.find((lod) => lod.level === 0).path), leaf: leafOf.get(item.id) });
      }
    }
    second.sort((a, b) => shuffleKey(`${batchNo}-${round}`, a.key).localeCompare(shuffleKey(`${batchNo}-${round}`, b.key)));
    const scored = second.length > 0 ? await judgeCells(dir, 'second', second, 3) : new Map();
    for (const item of todo) {
      const old = scored.get(`old:${item.id}`);
      if (old) item.oldOpus = old.score;
      const best = pickBest(candidates.get(item.id));
      const cell = scored.get(`new:${item.id}:${round}`);
      item.rounds.push({
        round, fix: fixes[item.id] ?? null,
        attempts: candidates.get(item.id).map(({ key, ...rest }) => rest),
        pick: best ? `${best.prompt}${best.seed}` : null, glb: best?.glb ?? null, dims: best?.dims ?? null, seed: best?.seed ?? null,
        score: cell?.score ?? null, reason: cell ? `${cell.name}: ${cell.reason}` : null,
        won: heroWins(cell?.score, item.oldOpus ?? item.oldScore),
      });
    }
    saveState();
    const won = todo.filter((item) => item.rounds.at(-1).won);
    console.log(`top50 batch ${batchNo} round ${round}: won ${won.length}/${todo.length}; ${todo.map((item) => `${item.id} ${item.rounds.at(-1).score ?? '-'}`).join(', ')}`);
  }

  if (!args.includes('--finish')) return;
  const imageModel = { klein: 'FLUX.2-klein-4B', zimage: 'Z-Image-Turbo' }[/^image_model\s*=\s*"(\w+)"/m.exec(readFileSync(path.join(ROOT, 'ops/gen3d/config.toml'), 'utf8'))[1]];
  const winners = Object.values(state.models).map((item) => ({ item, win: item.rounds.find((done) => done.won) })).filter(({ win }) => win);
  const entries = [];
  for (const { item, win } of winners) {
    entries.push({
      id: item.id, nouns: [item.noun], glb: win.glb, bounds: win.dims, palette: await paletteOf(win.glb),
      source: { pipeline: 'ops/gen3d', imageModel, shapeModel: 'TRELLIS.2-4B', seed: win.seed },
      licence: GENERATED,
      checked: { judge: `P57 T8 hero, blind 1-10 grid, Opus 5.5: ${win.score} (old ${item.oldOpus ?? item.oldScore})`, verdict: 'pass' },
    });
  }
  const batch = { schema: 'catalog-batch.v1', entries };
  writeFileSync(path.join(out, 'catalog-batch.json'), `${JSON.stringify(batch, null, 1)}\n`);
  const { replaced, skipped } = entries.length > 0 ? await replaceModels(batch, { profile: 'hero' }) : { replaced: [], skipped: [] };
  const refusedOf = new Map(skipped.map((entry) => [entry.id, entry.reason]));

  const report = existsSync(REPORT) ? JSON.parse(readFileSync(REPORT, 'utf8')) : {
    about: 'P57 T8: the 50 most-used library models pushed to 8+. Targets: every gen3d model in the top 50 (even at 8+), CC0 and originals only below 8. Per round 4 candidates (image prompt a/b x 2 seeds) by ops/gen3d with the hero finishing profile, each scaled into the old box; Opus 5.5 picks the best on a 2x2 grid, the pick is scored blind on 3x3 grids (old models Opus did not score in T4 rejudged on the same grids). A round wins at >= 8 and above the old score; round 2 only for ids without a winner, with the first round judge reason turned into the prompt fix. Winners swapped in by promote-batch replaceModels (profile hero: LOD0 up to 8000 triangles, LOD1 at most the old LOD1).',
    batches: {}, models: {}, summary: null,
  };
  for (const item of Object.values(state.models)) {
    const refused = refusedOf.get(item.id);
    const attempts = item.rounds.flatMap((done) => done.attempts);
    const best = item.rounds.reduce((top, done) => (done.score !== null && (top === null || done.score > top.score) ? done : top), null);
    report.models[item.id] = {
      noun: item.noun, set: byId.get(item.id).lods[0].path.split('/').at(-2), oldScore: item.oldScore, oldOpus: item.oldOpus,
      rounds: item.rounds.map(({ glb, dims, ...rest }) => ({ ...rest, attempts: rest.attempts.map(({ glb: file, dims: size, ...attempt }) => attempt) })),
      newScore: best?.score ?? null,
      result: replaced.includes(item.id) ? 'replaced' : resultOf(attempts, refused),
      ...(refused ? { reason: refused } : !replaced.includes(item.id) && best?.reason ? { reason: best.reason } : {}),
    };
  }
  report.batches[batchNo] = { ids, startedAt: state.startedAt, finishedAt: new Date().toISOString() };
  report.summary = heroSummary(usage, judge, report.models);
  writeFileSync(REPORT, `${JSON.stringify(report, null, 1)}\n`);
  const count = (result) => ids.filter((id) => report.models[id].result === result);
  console.log(`top50 batch ${batchNo}: replaced ${count('replaced').length}, kept-old ${count('kept-old').length}, rejected-bounds ${count('rejected-bounds').length}; top 50 at 8+: ${report.summary.atLeast8}/50; replaced ${count('replaced').join(' ')}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
