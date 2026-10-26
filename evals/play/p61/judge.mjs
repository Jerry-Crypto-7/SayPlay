#!/usr/bin/env node
/**
 * P61 T1: slepý soudce kvality hry. Na větu jeden list: řádek = jedna hra (rychlá hra, hra ze čtení; v T8 obojí za
 * `main` i větev), každý řádek 3 snímky ze hry z `shots.mjs`. Řádky nesou jen písmena A/B/C…, pořadí losuje
 * `pure-rand` xoroshiro128plus + Fisher–Yates se seedem zapsaným v JSON. Soudce dostane jen `sheet.png` v prázdném
 * `mkdtemp` (`ask()` z `scripts/p37d/judge-sheet.mjs`) a větu v otázce – žádné jméno produktu, větve ani cestu.
 *
 *   node evals/play/p61/judge.mjs --shots <name>=<dir>[,<name>=<dir>] --out <file.json> [--judge claude|codex]
 *     [--seed 61026] [--runs 2] [--view desktop|phone] [--sheets <dir>] [--only <id,id>] [--no-judge]
 *
 * `--shots main=D:/caches/p61/main-dev` čte `<dir>/shots.json` ze `shots.mjs`; strany listu jsou `<name>-quick` a
 * `<name>-reading` (jen když hra ze čtení vznikla). `--runs 2` soudí tytéž listy dvakrát a zapíše rozptyl.
 * Mediány: věrnost a „hrál bych“ po stranách; `<name>-after-reading` = hra, kterou hráč hraje po příchodu čtení –
 * hra ze čtení, a když nevznikla, rychlá hra. Listy leží v `--sheets` (výchozí `D:/caches/p61/sheets`), mimo repo.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { uniformInt } from 'pure-rand/distribution/uniformInt';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && !process.features.typescript) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}

export const JUDGE_SEED = 61026;
const LETTERS = 'ABCDEFGH';

export const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rows'],
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['side', 'fidelity', 'wouldPlay', 'reason'],
        properties: { side: { type: 'string' }, fidelity: { type: 'number' }, wouldPlay: { type: 'number' }, reason: { type: 'string' } },
      },
    },
  },
};

/** Otázka nad listem: jen věta a písmena řádků (znění P60 T9, aby čísla šla srovnat). */
export const questionFor = (sentence, letters) =>
  `The image sheet.png shows ${letters.length} game${letters.length === 1 ? '' : 's'} made from the same sentence, one per row labelled ${letters.join(', ')}, each row three screenshots taken while playing. The sentence: "${sentence}". For each row give fidelity 0-1 (how much the screenshots show what the sentence asks for: characters, setting, goal, threats) and wouldPlay 0-1 (how much it looks like a game you would actually want to play on a phone), plus a one-sentence reason. Judge only what is visible; ignore orientation and resolution differences and any small toast messages. Do not search the web. Answer only as JSON per the schema, one entry per row.`;

/** Odpověď platí, jen když každé písmeno listu má právě jeden řádek a obě čísla leží v 0..1. */
export function isAnswerFor(value, letters) {
  if (!Array.isArray(value?.rows) || value.rows.length !== letters.length) return false;
  const inUnit = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
  return letters.every((side) => value.rows.filter((row) => row?.side === side && inUnit(row.fidelity) && inUnit(row.wouldPlay) && typeof row.reason === 'string').length === 1);
}

/**
 * Pořadí stran na listech: jeden proud xoroshiro128plus ze seedu, Fisher–Yates věta po větě. Týž seed a tytéž
 * věty dají totéž pořadí; `kind` a `dir` zůstávají v plánu, na list jde jen písmeno.
 */
export function planSheets(sentences, seed = JUDGE_SEED) {
  const rng = xoroshiro128plus(seed);
  const plan = sentences.map((item) => {
    const sides = [...item.sides];
    for (let k = sides.length - 1; k > 0; k -= 1) {
      const j = uniformInt(rng, 0, k);
      [sides[k], sides[j]] = [sides[j], sides[k]];
    }
    return { id: item.id, sentence: item.text, rows: sides.map((side, k) => ({ side: LETTERS[k], ...side })) };
  });
  return { seed, generator: 'pure-rand xoroshiro128plus + uniformInt, Fisher-Yates per sentence in order', plan };
}

/** Jediný text na listu: písmeno řádku. */
export const sheetLabels = (rows) => rows.map((row) => row.side);

const round = (x) => Math.round(x * 1000) / 1000;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const medianOf = (scores) => (scores.length === 0 ? null : { fidelity: round(median(scores.map((s) => s.fidelity))), wouldPlay: round(median(scores.map((s) => s.wouldPlay))), n: scores.length });

/**
 * Skóre po větách a mediány po stranách. `names` jsou strany měření (`main`, `p61`); pro každou se navíc počítá
 * `<name>-after-reading`: hra ze čtení, když vznikla, jinak rychlá hra – to hráč hraje po příchodu čtení.
 * List bez platné odpovědi do mediánů nejde a je ve `skipped`.
 */
export function summarize(plan, answers, ...names) {
  const sentences = [];
  const skipped = [];
  for (const item of plan) {
    const answer = answers[item.id];
    if (!isAnswerFor(answer, item.rows.map((row) => row.side))) {
      skipped.push(item.id);
      continue;
    }
    const scores = {};
    for (const row of item.rows) {
      const { fidelity, wouldPlay, reason } = answer.rows.find((entry) => entry.side === row.side);
      scores[row.kind] = { fidelity, wouldPlay, reason };
    }
    for (const name of names) {
      const played = scores[`${name}-reading`] ?? scores[`${name}-quick`];
      if (played) scores[`${name}-after-reading`] = played;
    }
    sentences.push({ id: item.id, sentence: item.sentence, scores });
  }
  const kinds = [...new Set(sentences.flatMap((row) => Object.keys(row.scores)))].sort();
  const medians = Object.fromEntries(kinds.map((kind) => [kind, medianOf(sentences.map((row) => row.scores[kind]).filter(Boolean))]));
  return { medians, sentences, skipped };
}

// Dlaždice 16:9 pro desktop 1280 × 720, 9:16 pro telefon; tři snímky na řádek, vlevo jen písmeno.
const TILE = { desktop: { w: 384, h: 216 }, phone: { w: 160, h: 284 } };
const LABEL = 56;

async function drawSheet(rows, view, file) {
  const { default: sharp } = await import('sharp');
  const { w, h } = TILE[view];
  const composites = [];
  for (const [r, row] of rows.entries()) {
    const top = r * (h + 8);
    composites.push({ input: Buffer.from(`<svg width="${LABEL}" height="${h}"><text x="12" y="${h / 2 + 15}" font-size="42" font-family="Arial" font-weight="bold" fill="#fff">${row.side}</text></svg>`), left: 0, top });
    for (const [i, shot] of row.shots.entries()) {
      const input = await sharp(shot).resize(w, h, { fit: 'contain', background: '#202020' }).png().toBuffer();
      composites.push({ input, left: LABEL + i * (w + 6), top });
    }
  }
  await sharp({ create: { width: LABEL + 3 * (w + 6), height: rows.length * (h + 8), channels: 3, background: '#555555' } }).composite(composites).png().toFile(file);
}

/** Strany věty ze `shots.json`: `<name>-quick` vždy, `<name>-reading` jen se snímky hry ze čtení. */
function sidesOf(measurements, view) {
  const byId = new Map();
  for (const { name, rows } of measurements) {
    for (const row of rows) {
      const entry = byId.get(row.id) ?? { id: row.id, text: row.sentence, sides: [] };
      for (const kind of ['quick', 'reading']) {
        const shots = row.shots?.[view]?.[kind] ?? [];
        if (shots.length === 3 && shots.every((shot) => existsSync(shot))) entry.sides.push({ kind: `${name}-${kind}`, shots });
      }
      byId.set(row.id, entry);
    }
  }
  return [...byId.values()].filter((entry) => entry.sides.length > 0);
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const judge = flag('--judge', 'claude');
  const seed = Number(flag('--seed', String(JUDGE_SEED)));
  const runs = Number(flag('--runs', '1'));
  const view = flag('--view', 'desktop');
  const out = path.resolve(flag('--out'));
  const sheets = path.resolve(flag('--sheets', 'D:/caches/p61/sheets'));
  const only = flag('--only')?.split(',');
  if (!['claude', 'codex'].includes(judge) || !TILE[view] || !flag('--out') || !flag('--shots')) throw new Error('usage: --shots <name>=<dir>[,…] --out <file> [--judge claude|codex] [--view desktop|phone]');

  const measurements = flag('--shots').split(',').map((pair) => {
    const [name, dir] = pair.split('=');
    return { name, dir, ...JSON.parse(readFileSync(path.join(dir, 'shots.json'), 'utf8')) };
  });
  const names = measurements.map((m) => m.name);
  const sentences = sidesOf(measurements, view).filter((entry) => !only || only.includes(entry.id));
  const { plan, generator } = planSheets(sentences, seed);
  mkdirSync(path.join(sheets, 'answers'), { recursive: true });
  const schemaFile = path.join(sheets, 'schema.json');
  writeFileSync(schemaFile, JSON.stringify(ANSWER_SCHEMA));
  for (const item of plan) {
    item.sheet = path.join(sheets, `${item.id}-${view}.png`);
    await drawSheet(item.rows, view, item.sheet);
  }
  const record = {
    schema: 'p61-judge.v1',
    judgedAt: new Date().toISOString(),
    judge: judge === 'claude' ? 'claude-opus-5-5 (claude -p --safe-mode)' : 'codex exec',
    view,
    seed,
    generator,
    measurements: measurements.map(({ name, label, commit, measuredAt, base }) => ({ name, label, commit, measuredAt, base })),
    plan: plan.map(({ id, sentence, rows }) => ({ id, sentence, rows: rows.map(({ side, kind }) => ({ side, kind })) })),
    runs: [],
  };
  if (args.includes('--no-judge')) {
    writeFileSync(out, `${JSON.stringify(record, null, 1)}\n`);
    return;
  }
  // Souběh 1 (limit 429); hotová odpověď se při dalším běhu nepřeptává.
  const { ask } = await import('../../../scripts/p37d/judge-sheet.mjs');
  for (let run = 1; run <= runs; run += 1) {
    const answers = {};
    for (const item of plan) {
      const letters = item.rows.map((row) => row.side);
      const answerFile = path.join(sheets, 'answers', `${item.id}-${view}-${judge}-${seed}-run${run}.json`);
      if (!existsSync(answerFile)) {
        const result = await ask(item.sheet, schemaFile, answerFile, questionFor(item.sentence, letters), judge, (value) => isAnswerFor(value, letters));
        if (!existsSync(answerFile)) console.error(JSON.stringify({ id: item.id, run, error: `${judge} exit ${result.code}: ${result.stderr}` }));
      }
      if (existsSync(answerFile)) answers[item.id] = JSON.parse(readFileSync(answerFile, 'utf8'));
      console.log(JSON.stringify({ id: item.id, run, ok: isAnswerFor(answers[item.id], letters) }));
    }
    record.runs.push({ run, ...summarize(plan, answers, ...names) });
  }
  if (record.runs.length === 2) {
    // Rozptyl soudce: rozdíl dvou běhů na týchž listech, po větách a stranách.
    const [a, b] = record.runs;
    const diffs = a.sentences.flatMap((row) => {
      const other = b.sentences.find((entry) => entry.id === row.id);
      return other ? Object.keys(row.scores).filter((kind) => !kind.endsWith('after-reading') && other.scores[kind]).map((kind) => ({ id: row.id, kind, fidelity: round(Math.abs(row.scores[kind].fidelity - other.scores[kind].fidelity)), wouldPlay: round(Math.abs(row.scores[kind].wouldPlay - other.scores[kind].wouldPlay)) })) : [];
    });
    record.variance = { pairs: diffs.length, medianAbsDiff: medianOf(diffs), maxAbsDiff: diffs.length === 0 ? null : { fidelity: Math.max(...diffs.map((d) => d.fidelity)), wouldPlay: Math.max(...diffs.map((d) => d.wouldPlay)) }, diffs };
  }
  writeFileSync(out, `${JSON.stringify(record, null, 1)}\n`);
  console.log(JSON.stringify({ out, medians: record.runs.map((r) => r.medians), skipped: record.runs.map((r) => r.skipped) }));
}

if (isMain) await main();
