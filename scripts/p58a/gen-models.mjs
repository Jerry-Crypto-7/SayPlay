#!/usr/bin/env node
/**
 * P58A T7: dogenerovat modely slov z vět, která hra kreslila jen nejbližším cizím modelem.
 *
 *   node D:/claude/_shared/gpu-lock.mjs -- node scripts/p58a/gen-models.mjs [--out D:/caches/p58a/gen]
 *
 * Jména z `evals/play/p58a/gen-nouns.json` jdou přes `ops/gen3d/batch.py` (kolo 1 zadání `b`
 * semínko 1, při pádu brány `a`; kolo 2 jen pro jména bez vítěze, semínko 2; kolo 3 semínka 3 a 4
 * s předkontrolou – 3D jen z obrázku, který Opus slepě pozná, P46F tak měl ~70 % poznaných) se
 * zadáním podle třídy a znakem z `features.toml`. Kandidáty slepě soudí Opus na mřížkách 3×3 (týž dotaz 1–10
 * jako P57 T4). Vítěz musí mít skóre ≥ 7 **a** soudce ho musí pojmenovat jedním z `names` –
 * dobře udělaný křeček místo sysla slovu z věty nepomůže. Vítěze povýší `promoteBatch` jako
 * `gen3d-<jméno>` se štítky `words`; výsledek každého jména v `evals/play/p58a/gen-models.json`.
 * Opakované spuštění nad týmž `--out` znovu použije hotová kola (`batch.json`, mřížky, odpovědi).
 * Vzor: `scripts/p57/kit-fill.mjs`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const NOUNS = path.join(ROOT, 'evals/play/p58a/gen-nouns.json');
const REPORT = path.join(ROOT, 'evals/play/p58a/gen-models.json');
export const PASS = 7;
const ROUNDS = [{ round: 1, attempts: 'b1,a1' }, { round: 2, attempts: 'a2,b2' }, { round: 3, attempts: 'b3,a3,b4', precheck: true }];

export const idOf = (noun) => `gen3d-${noun.replace(/ /g, '-')}`;

/** Soudce jmenoval model slovem z `names` (celé slovo, bez ohledu na velikost písmen). */
export const named = (name, names) =>
  typeof name === 'string' && names.some((alias) => new RegExp(`\\b${alias}\\b`, 'i').test(name));

/** Nejlepší pokus se skóre ≥ `PASS`, který soudce pojmenoval správně; jinak `null`. */
export const winnerOf = (attempts, names) =>
  attempts.filter((attempt) => attempt.score >= PASS && named(attempt.name, names)).sort((a, b) => b.score - a.score)[0] ?? null;

async function main() {
  if (!process.features.typescript) {
    const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
    process.exit(run.status ?? 1);
  }
  const { scoreCells, scoreSheet, paletteOf } = await import('../p37d/judge-sheet.mjs');
  const { promoteBatch } = await import('../p37d/promote-batch.mjs');
  const { mergeAttempts } = await import('../p57/judge-library.mjs');
  const { shuffleKey } = await import('../p57/regen.mjs');
  const { assertNotTrainingDir } = await import('../assets/qa-astra.mjs');
  const args = process.argv.slice(2);
  const out = path.resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : 'D:/caches/p58a/gen');
  assertNotTrainingDir(out);
  mkdirSync(out, { recursive: true });
  const catalog = JSON.parse(readFileSync(path.join(ROOT, 'src/assets/catalog.json'), 'utf8'));
  const inCatalog = new Set(catalog.assets.map((asset) => asset.assetId));
  const done = existsSync(REPORT) ? new Set(JSON.parse(readFileSync(REPORT, 'utf8')).results.filter((row) => row.result === 'generated').map((row) => row.id)) : new Set();
  const results = new Map();
  const state = new Map();
  for (const entry of JSON.parse(readFileSync(NOUNS, 'utf8')).nouns) {
    const id = idOf(entry.noun);
    if (inCatalog.has(id) && !done.has(id)) results.set(id, { noun: entry.noun, id, result: 'skipped', reason: 'id already in the catalog' });
    else state.set(id, { ...entry, id, attempts: [] });
  }
  const imageModel = { klein: 'FLUX.2-klein-4B', zimage: 'Z-Image-Turbo' }[/^image_model\s*=\s*"(\w+)"/m.exec(readFileSync(path.join(ROOT, 'ops/gen3d/config.toml'), 'utf8'))[1]];

  for (const { round, attempts, precheck } of ROUNDS) {
    const todo = [...state.values()].filter((item) => !winnerOf(item.attempts, item.names));
    if (todo.length === 0) break;
    const dir = path.join(out, `round-${round}`);
    mkdirSync(dir, { recursive: true });
    const nounsFile = path.join(dir, 'nouns.json');
    const record = path.join(dir, 'batch.json');
    if (existsSync(record)) console.log(`gen round ${round}: reusing ${record}`);
    else {
      writeFileSync(nounsFile, JSON.stringify({ nouns: todo.map(({ noun, class: body, flat }) => ({ noun, class: body, flat })) }));
      console.log(`gen round ${round}: generating ${todo.length} (${attempts})`);
      const gen = spawnSync('uv', ['run', 'batch.py', '--from', nounsFile, '--limit', '999', '--record', record, '--sheet', path.join(dir, 'sheet.png'), '--attempts', attempts, '--no-quarantine', '--start-comfy', ...(precheck ? ['--precheck', '--judge', 'claude'] : [])],
        { cwd: path.join(ROOT, 'ops/gen3d'), env: { ...process.env, GEN3D_CACHE_DIR: path.join(dir, 'cache') }, stdio: 'inherit' });
      if (gen.status !== 0) throw new Error(`batch.py exit ${gen.status}`);
    }
    const records = new Map(JSON.parse(readFileSync(record, 'utf8')).records.map((entry) => [entry.noun, entry]));

    const cells = [];
    for (const item of todo) {
      const made = records.get(item.noun);
      const entry = { round, prompt: made?.variant ?? null, seed: made?.seed ?? null };
      item.attempts.push(entry);
      if (made?.verdict !== 'passed') {
        entry.gate = made?.reason ?? 'no record';
        continue;
      }
      entry.glb = made.glb;
      cells.push({ key: `new:${item.id}:${round}`, glb: made.glb });
    }
    if (cells.length === 0) continue;
    cells.sort((a, b) => shuffleKey(`p58a-${round}`, a.key).localeCompare(shuffleKey(`p58a-${round}`, b.key)));
    const sheets = path.join(dir, `sheets-${shuffleKey('cells', cells.map((cell) => cell.key).join(',')).slice(0, 8)}`);
    writeFileSync(path.join(dir, 'glb-list.json'), JSON.stringify(cells.map(({ key, glb }) => ({ id: key, glb }))));
    writeFileSync(path.join(dir, 'ids.json'), JSON.stringify(cells.map(({ key }) => ({ id: key }))));
    if (!existsSync(path.join(sheets, 'grid-index.json'))) {
      spawnSync(process.execPath, [path.join(ROOT, 'scripts/assets/qa-sheets.mjs'), '--grid', '3', '--glb-list', path.join(dir, 'glb-list.json'), '--ids', path.join(dir, 'ids.json'), '--out', sheets], { stdio: 'inherit' });
    }
    const plan = JSON.parse(readFileSync(path.join(sheets, 'grid-index.json'), 'utf8'));
    const scored = new Map();
    const queue = [...plan.sheets];
    const answers = path.join(dir, 'judge', 'answers');
    const worker = async () => {
      for (let sheet = queue.shift(); sheet !== undefined; sheet = queue.shift()) {
        const png = path.join(sheets, `${sheet.sheet}.png`);
        // Odpovědi Opuse z dřívějšího spuštění se znovu nečtou.
        const cached = (existsSync(answers) ? readdirSync(answers) : []).filter((file) => file.startsWith(`${sheet.sheet}-claude-`)).sort()
          .map((file) => scoreCells(JSON.parse(readFileSync(path.join(answers, file), 'utf8')), sheet.cells.length));
        let got = cached.length > 0 ? cached.reduce(mergeAttempts) : (await scoreSheet(png, sheet.cells.length, path.join(dir, 'judge'), 'claude')).cells;
        if (got.some((cell) => cell === null) && cached.length < 2) got = mergeAttempts(got, (await scoreSheet(png, sheet.cells.length, path.join(dir, 'judge'), 'claude')).cells);
        sheet.cells.forEach((key, index) => scored.set(key, got[index]));
        console.log(`${sheet.sheet}: ${got.map((cell) => (cell ? `${cell.score} ${cell.name}` : '-')).join(' | ')}`);
      }
    };
    await Promise.all([worker(), worker()]);
    for (const item of todo) {
      const cell = scored.get(`new:${item.id}:${round}`);
      if (cell !== undefined) Object.assign(item.attempts.at(-1), { score: cell?.score ?? null, name: cell?.name ?? null, reason: cell?.reason ?? 'unread' });
    }
  }

  const entries = [];
  for (const item of state.values()) {
    const win = winnerOf(item.attempts, item.names);
    if (!win || done.has(item.id)) continue;
    entries.push({
      id: item.id, nouns: item.words, glb: win.glb, palette: await paletteOf(win.glb),
      source: { pipeline: 'ops/gen3d', imageModel, shapeModel: 'TRELLIS.2-4B', seed: win.seed },
      licence: 'LicenseRef-Worldsmith-Generated',
      checked: { judge: `P58A T7 blind 1-10 grid, Opus 5.5: ${win.score} "${win.name}"`, verdict: 'pass' },
    });
  }
  const batch = entries.length > 0 ? await promoteBatch({ schema: 'catalog-batch.v1', entries }) : { promoted: [], skipped: [] };
  const promoted = new Set([...done, ...batch.promoted]);
  const refused = new Map(batch.skipped.map((entry) => [entry.id, entry.reason]));
  for (const item of state.values()) {
    const win = winnerOf(item.attempts, item.names);
    const tried = item.attempts.map(({ round, score, name, reason, gate }) => ({ round, score: score ?? null, name: name ?? null, reason: reason ?? gate ?? null }));
    results.set(item.id, promoted.has(item.id)
      ? { noun: item.noun, id: item.id, result: 'generated', score: win?.score ?? null, name: win?.name ?? null, tried }
      : { noun: item.noun, id: item.id, result: 'skipped', reason: refused.get(item.id) ?? `no attempt scored >= ${PASS} under a matching name`, tried });
  }
  const rows = [...results.values()];
  writeFileSync(REPORT, `${JSON.stringify({
    about: 'P58A T7 (scripts/p58a/gen-models.mjs): every noun of gen-nouns.json, generated or skipped with the reason; `tried` lists each round with the blind Opus score and the name it gave. Skipped nouns keep the nearest model from T6.',
    pass: PASS, results: rows,
  }, null, 1)}\n`);
  console.log(`gen-models: generated ${rows.filter((row) => row.result === 'generated').map((row) => row.noun).join(', ')}; skipped ${rows.filter((row) => row.result === 'skipped').length}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
