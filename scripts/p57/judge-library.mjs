#!/usr/bin/env node
/**
 * Soud knihovny P57 (T3/T4): top 300 podle použití a vzorek 100 (`evals/play/p57/usage.json`)
 * na mřížkách 3×3 (`scripts/assets/qa-sheets.mjs --grid 3 --ids`, pořadí podle použití),
 * každý list skóre 1–10 na buňku (`judge-sheet.mjs` `scoreSheet`). Liché listy soudí Codex,
 * sudé Opus, každý desátý oba (shoda soudců). Codex má strop 30 volání za den v
 * `evals/play/p57/codex-calls.json` (strop 50 je sdílený s P56); po něm jde list Opusovi.
 * Buňka, kterou soudce nepřečetl, dostane druhý pokus; co nepřečte ani ten, zůstane `null`.
 * Soudce vidí jen `sheet.png` v prázdném `mkdtemp` (`blindQuestion`).
 *
 *   node scripts/p57/judge-library.mjs [--out D:/caches/p57/judge] [--report evals/play/p57/judge.json]
 *     [--opus-workers 2] [--only-sheets 1-4] [--calibration <soubor s textem>]
 *
 * Surové odpovědi a `scores.json` (navazuje se na ně) leží v `--out`, souhrn v `--report`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

export const CODEX_DAILY_CAP = 30;
export const COUNTER = path.join(ROOT, 'evals/play/p57/codex-calls.json');
/** Shoda soudců: buňka sedí, když se skóre liší nejvýš o tolik bodů. */
export const AGREE_WITHIN = 2;

/** Soudci listu `n` (od 1): lichý Codex, sudý Opus, každý desátý oba – Opus první, Codex druhý. */
export const judgesFor = (n) => (n % 10 === 0 ? ['claude', 'codex'] : n % 2 === 1 ? ['codex'] : ['claude']);

/** Jedno volání Codexu dnes: pod stropem ho započte do souboru a vrátí `true`, jinak `false`. */
export function takeCodexCall(file, day, cap = CODEX_DAILY_CAP) {
  const counts = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  if ((counts[day] ?? 0) >= cap) return false;
  counts[day] = (counts[day] ?? 0) + 1;
  writeFileSync(file, `${JSON.stringify(counts, null, 1)}\n`);
  return true;
}

/** Pořadí soudu: top 300 podle použití, pak vzorek; každé id jednou. */
export const judgeIds = (usage) => [...new Set([...usage.top300, ...usage.sample100])];

/** Listí louky (`MEADOW_FLORA.leaf`): vegetace je nejčastěji v louce. */
export const MEADOW_LEAF = '#4f9a3a';

/**
 * Položky pro `qa-sheets.mjs --ids`: model, který je ve hrách hlavně vegetací (aspoň polovina
 * výskytů), dostane barvu listí, jak ho hra kreslí – šedé listí katalogu by soudce trestal za
 * barvu, kterou hráč nikdy nevidí.
 */
export function sheetEntries(usage) {
  const used = new Map(usage.models.map((model) => [model.id, model]));
  return judgeIds(usage).map((id) => {
    const model = used.get(id);
    return model !== undefined && (model.roles.flora ?? 0) * 2 >= model.uses ? { id, leaf: MEADOW_LEAF } : { id };
  });
}

/** Buňky listu zpět na modely přes `grid-index.json`: `{ assetId: { sheet, cell, …skóre } | null }`. */
export const cellsBack = (sheet, scored) => Object.fromEntries(sheet.cells.map((id, index) => [id, scored[index] ? { sheet: sheet.sheet, ...scored[index] } : null]));

/** Spojí dva pokusy jednoho soudce: buňka z prvního zůstane, díra se doplní z druhého. */
export const mergeAttempts = (first, second) => first.map((cell, index) => cell ?? second[index] ?? null);

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const round = (value, digits = 2) => (value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits);

/**
 * Souhrn soudu: skóre modelu je průměr soudců, kteří buňku přečetli; shoda na překryvu je podíl
 * buněk s rozdílem ≤ `AGREE_WITHIN`; `below6` a `top50Below8` jsou vstupy přegenerování (T6, T8).
 */
export function summarize(usage, plan, scores) {
  const rank = new Map(judgeIds(usage).map((id, index) => [id, index]));
  const top = new Set(usage.top300);
  const top50 = new Set(usage.top300.slice(0, 50));
  const models = {};
  const pairs = [];
  for (const sheet of plan.sheets) {
    const judged = scores[sheet.sheet] ?? {};
    const back = Object.fromEntries(Object.entries(judged).filter(([, run]) => Array.isArray(run.cells)).map(([judge, run]) => [judge, cellsBack(sheet, run.cells)]));
    for (const id of sheet.cells) {
      const byJudge = Object.fromEntries(Object.entries(back).map(([judge, cells]) => [judge, cells[id]]));
      const read = Object.values(byJudge).filter((cell) => cell !== null);
      const score = read.length === 0 ? null : read.reduce((sum, cell) => sum + cell.score, 0) / read.length;
      models[id] = { rank: rank.get(id) + 1, group: top.has(id) ? 'top300' : 'sample100', sheet: sheet.sheet, cell: sheet.cells.indexOf(id) + 1, score: round(score), ...byJudge };
      if (byJudge.codex && byJudge.claude) pairs.push(Math.abs(byJudge.codex.score - byJudge.claude.score));
    }
  }
  const group = (name) => Object.values(models).filter((model) => model.group === name && model.score !== null).map((model) => model.score);
  const spread = (values) => ({ count: values.length, median: median(values), mean: round(values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1)), below6: values.filter((value) => value < 6).length, atLeast8: values.filter((value) => value >= 8).length });
  const ids = Object.keys(models).sort((a, b) => models[a].rank - models[b].rank);
  return {
    judged: ids.length,
    nulls: ids.filter((id) => models[id].score === null),
    agreement: { cells: pairs.length, within: AGREE_WITHIN, share: pairs.length === 0 ? null : round(pairs.filter((diff) => diff <= AGREE_WITHIN).length / pairs.length, 3), meanDiff: pairs.length === 0 ? null : round(pairs.reduce((sum, diff) => sum + diff, 0) / pairs.length) },
    distribution: { top300: spread(group('top300')), sample100: spread(group('sample100')) },
    below6: ids.filter((id) => models[id].score !== null && models[id].score < 6),
    top50Below8: ids.filter((id) => top50.has(id) && models[id].score !== null && models[id].score < 8),
    models: Object.fromEntries(ids.map((id) => [id, models[id]])),
  };
}

const today = () => new Date().toLocaleDateString('sv-SE');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function main() {
  if (!process.features.typescript) {
    const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
    process.exit(run.status ?? 1);
  }
  const { scoreSheet, scoreQuestion } = await import('../p37d/judge-sheet.mjs');
  const { assertNotTrainingDir } = await import('../assets/qa-astra.mjs');
  const args = process.argv.slice(2);
  const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const out = path.resolve(flag('--out', 'D:/caches/p57/judge'));
  const report = path.resolve(ROOT, flag('--report', 'evals/play/p57/judge.json'));
  const usage = JSON.parse(readFileSync(path.join(ROOT, 'evals/play/p57/usage.json'), 'utf8'));
  const calibration = flag('--calibration') ? readFileSync(path.resolve(flag('--calibration')), 'utf8').trim() : '';
  assertNotTrainingDir(out);
  mkdirSync(out, { recursive: true });

  const sheetsDir = path.join(out, 'sheets');
  const indexFile = path.join(sheetsDir, 'grid-index.json');
  if (!existsSync(indexFile)) {
    const idsFile = path.join(out, 'ids.json');
    writeFileSync(idsFile, JSON.stringify(sheetEntries(usage)));
    // Selhání vykreslení zapíše `failures.json` a vrátí 1; prázdná buňka dostane od soudce „broken“.
    spawnSync(process.execPath, [path.join(ROOT, 'scripts/assets/qa-sheets.mjs'), '--grid', '3', '--ids', idsFile, '--out', sheetsDir], { stdio: 'inherit' });
  }
  const plan = JSON.parse(readFileSync(indexFile, 'utf8'));
  const [from, to] = (flag('--only-sheets', `1-${plan.sheets.length}`)).split('-').map(Number);
  const scoresFile = path.join(out, 'scores.json');
  const scores = existsSync(scoresFile) ? JSON.parse(readFileSync(scoresFile, 'utf8')) : {};
  const save = () => {
    writeFileSync(scoresFile, `${JSON.stringify(scores, null, 1)}\n`);
    writeFileSync(report, `${JSON.stringify({ about: 'P57 T4 library judge: top300 by usage + sample100, 3x3 grids, score 1-10 per cell (recognisable, silhouette, Toy Box style, broken mesh). Odd sheets Codex, even sheets Opus, every tenth both (agreement). score = mean of the judges that read the cell; null = unread after two attempts.', question: scoreQuestion(9), calibration: calibration || null, ...summarize(usage, plan, scores) }, null, 1)}\n`);
  };

  const claudeQueue = [];
  const codexQueue = [];
  for (const [index, sheet] of plan.sheets.entries()) {
    if (index + 1 < from || index + 1 > to) continue;
    for (const judge of judgesFor(index + 1)) {
      const done = scores[sheet.sheet]?.[judge];
      if (done && (done.cells.every((cell) => cell !== null) || done.attempts >= 2)) continue;
      (judge === 'codex' ? codexQueue : claudeQueue).push({ sheet, judge });
    }
  }
  console.log(`listů ${plan.sheets.length}, ve frontě Codex ${codexQueue.length}, Opus ${claudeQueue.length}`);

  const judgeOnce = async ({ sheet, judge }, reroutedFrom) => {
    const png = path.join(sheetsDir, `${sheet.sheet}.png`);
    const before = scores[sheet.sheet]?.[judge];
    const run = await scoreSheet(png, sheet.cells.length, out, judge, calibration);
    const cells = before ? mergeAttempts(before.cells, run.cells) : run.cells;
    scores[sheet.sheet] = { ...scores[sheet.sheet], [judge]: { cells, attempts: (before?.attempts ?? 0) + 1, seconds: run.seconds, ...(reroutedFrom ? { reroutedFrom } : {}), ...(run.error ? { error: run.error } : {}) } };
    save();
    const read = cells.filter((cell) => cell !== null);
    console.log(`${sheet.sheet} ${judge}: ${read.length}/${cells.length} buněk, skóre ${read.map((cell) => cell.score).join(' ')} (${run.seconds} s)${run.error ? ` – ${run.error.slice(0, 120)}` : ''}`);
    return cells.every((cell) => cell !== null);
  };
  /** Do dvou pokusů; druhý jen pro díry. */
  const judgeSheet = async (task, reroutedFrom) => {
    if (await judgeOnce(task, reroutedFrom)) return;
    if ((scores[task.sheet.sheet][task.judge].attempts ?? 0) < 2) await judgeOnce(task, reroutedFrom);
  };

  let codexDone = false;
  const codexWorker = async () => {
    for (let task = codexQueue.shift(); task !== undefined; task = codexQueue.shift()) {
      const attempts = 2 - (scores[task.sheet.sheet]?.codex?.attempts ?? 0);
      let left = attempts;
      while (left > 0) {
        if (!takeCodexCall(COUNTER, today())) {
          // Strop: list jde Opusovi; překryvný list Opus už soudí, Codex tam jen chybí.
          const overlap = judgesFor(plan.sheets.indexOf(task.sheet) + 1).includes('claude');
          if (overlap) {
            scores[task.sheet.sheet] = { ...scores[task.sheet.sheet], codexSkipped: 'daily cap' };
            save();
          } else claudeQueue.push({ sheet: task.sheet, judge: 'claude', reroutedFrom: 'codex' });
          break;
        }
        const complete = await judgeOnce(task);
        left -= 1;
        if (complete) break;
      }
    }
    codexDone = true;
  };
  const claudeWorker = async () => {
    for (;;) {
      const task = claudeQueue.shift();
      if (task === undefined) {
        if (codexDone) return;
        await sleep(2000);
        continue;
      }
      await judgeSheet(task, task.reroutedFrom);
    }
  };
  await Promise.all([codexWorker(), ...Array.from({ length: Number(flag('--opus-workers', '2')) }, claudeWorker)]);
  save();
  const summary = summarize(usage, plan, scores);
  console.log(`souzeno ${summary.judged - summary.nulls.length}/${summary.judged}, null ${summary.nulls.length}, shoda ${summary.agreement.share} na ${summary.agreement.cells} buňkách, pod 6: ${summary.below6.length}, top 50 pod 8: ${summary.top50Below8.length}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
