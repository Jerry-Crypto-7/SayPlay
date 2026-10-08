#!/usr/bin/env node
/**
 * Slepý soud celé knihovny (P43 T11): mřížky 3×3 (`scripts/assets/qa-sheets.mjs --grid 3`)
 * → Codex přes předplatné (`codex exec -i`) → „co je v buňce N?“ bez jména a bez cesty
 * → verdikt na model: poznatelný, sedí jméno z katalogu, navržené jméno, skutečná velikost.
 *
 *   node scripts/p43/library-judge.mjs --grids D:/caches/p43/grids --max-calls 25
 *     [--out evals/assets/p43-qa/verdicts.json] [--concurrency 3]
 *
 * Běží po denních dávkách: `--max-calls` je tvrdý strop volání za běh (sdílený denní strop
 * Codexu je 50 napříč projekty) a souzený list se znovu neptá. Neúspěšné volání se do stropu
 * počítá, list zůstane na příště. Verdikty se ukládají po každém listu.
 * Odpovědi nikdy do trénovacích dat (podmínky OpenAI).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain && !process.features.typescript) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
const { ask, matches } = await import('../p37d/judge-sheet.mjs');

export function questionFor(cells) {
  return `The attached image is a contact sheet of ${cells} numbered cells; each cell shows ONE 3D game model, numbered 1-${cells} in its top-left corner, with its bounding size printed bottom-left. For EVERY cell answer what the object is. Reply only with the JSON the schema asks for, one entry per cell: cell = the cell number, name = the most likely common English noun (1-3 words), alternatives = up to 3 other plausible names, recognizable = false when no object can be made out, realSize = the typical length in meters of the longest side of the REAL object you named (ignore the printed size).`;
}

export function schemaFor(cells) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['cells'],
    properties: {
      cells: {
        type: 'array',
        minItems: cells,
        maxItems: cells,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['cell', 'name', 'alternatives', 'recognizable', 'realSize'],
          properties: {
            cell: { type: 'integer' },
            name: { type: 'string' },
            alternatives: { type: 'array', items: { type: 'string' }, maxItems: 3 },
            recognizable: { type: 'boolean' },
            realSize: { type: 'number' },
          },
        },
      },
    },
  };
}

/** Listy, kterým chybí verdikt aspoň u jedné buňky. */
export function pendingSheets(index, verdicts) {
  return index.sheets.filter((sheet) => sheet.cells.some((assetId) => verdicts[assetId] === undefined));
}

/**
 * Odpověď soudce → verdikt na model. Buňky musí sedět jedna k jedné (čísla 1..n, každé jednou),
 * jinak `null`: posunutá buňka by dala verdikt cizímu modelu.
 */
export function verdictsOf(sheet, answer, namesOf) {
  const cells = answer?.cells;
  if (!Array.isArray(cells) || cells.length !== sheet.cells.length) return null;
  const numbers = new Set(cells.map((entry) => entry.cell));
  if (numbers.size !== cells.length || cells.some((entry) => !Number.isInteger(entry.cell) || entry.cell < 1 || entry.cell > cells.length)) return null;
  const out = {};
  for (const entry of cells) {
    const assetId = sheet.cells[entry.cell - 1];
    const fits = (guess) => namesOf(assetId).some((noun) => matches(noun, guess));
    const nameFits = entry.recognizable && (fits(entry.name) || entry.alternatives.some(fits));
    out[assetId] = {
      sheet: sheet.sheet,
      cell: entry.cell,
      name: entry.name,
      alternatives: entry.alternatives,
      recognizable: entry.recognizable,
      nameFits,
      suggestedName: entry.recognizable && !nameFits ? entry.name : null,
      realSize: entry.realSize,
    };
  }
  return out;
}

/** Jedna denní dávka: nejvýš `maxCalls` volání `call(sheet)` nad listy bez verdiktu. */
export async function judgeSlice({ index, verdicts, maxCalls, call, namesOf, save = () => {}, concurrency = 1 }) {
  const queue = pendingSheets(index, verdicts).slice(0, Math.max(0, maxCalls));
  const failed = [];
  let calls = 0;
  const worker = async () => {
    for (let sheet = queue.shift(); sheet !== undefined; sheet = queue.shift()) {
      calls += 1;
      const judged = verdictsOf(sheet, await call(sheet.sheet, sheet.cells.length), namesOf);
      if (judged === null) {
        failed.push(sheet.sheet);
        continue;
      }
      Object.assign(verdicts, judged);
      save();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return { calls, failed };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const grids = path.resolve(flag('--grids', 'D:/caches/p43/grids'));
  const maxCalls = Number(flag('--max-calls', 'NaN'));
  if (!Number.isInteger(maxCalls) || maxCalls < 0) throw new Error('--max-calls <n> is required (shared daily Codex budget)');
  const outFile = path.resolve(flag('--out', path.join(ROOT, 'evals/assets/p43-qa/verdicts.json')));
  const concurrency = Number(flag('--concurrency', '3'));

  const index = JSON.parse(readFileSync(path.join(grids, 'grid-index.json'), 'utf8'));
  const { assets } = JSON.parse(readFileSync(path.join(ROOT, 'src/assets/catalog.json'), 'utf8'));
  const byId = new Map(assets.map((asset) => [asset.assetId, [asset.label, ...asset.tags]]));
  const namesOf = (assetId) => byId.get(assetId) ?? [assetId];
  const file = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : { schema: 'p43-library-verdicts.v1', verdicts: {} };
  const save = () => {
    mkdirSync(path.dirname(outFile), { recursive: true });
    const sorted = Object.fromEntries(Object.entries(file.verdicts).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(outFile, `${JSON.stringify({ ...file, verdicts: sorted }, null, 1)}\n`);
  };

  const work = mkdtempSync(path.join(os.tmpdir(), 'p43-judge-'));
  const call = async (sheet, cells) => {
    const schemaFile = path.join(work, `schema-${cells}.json`);
    if (!existsSync(schemaFile)) writeFileSync(schemaFile, JSON.stringify(schemaFor(cells)));
    const answerFile = path.join(work, `${sheet}.json`);
    const run = await ask(path.join(grids, `${sheet}.png`), schemaFile, answerFile, questionFor(cells));
    try {
      return JSON.parse(readFileSync(answerFile, 'utf8'));
    } catch {
      console.log(`${sheet}: no answer (codex exit ${run.code}) ${run.stderr.replaceAll('\n', ' ')}`);
      return null;
    }
  };
  const run = await judgeSlice({ index, verdicts: file.verdicts, maxCalls, call, namesOf, save, concurrency });
  save();
  rmSync(work, { recursive: true, force: true });
  const verdicts = Object.values(file.verdicts);
  const total = index.sheets.reduce((sum, sheet) => sum + sheet.cells.length, 0);
  console.log(
    `calls ${run.calls}/${maxCalls}, failed ${run.failed.length}; covered ${verdicts.length}/${total}, recognisable ${verdicts.filter((v) => v.recognizable).length}, name fits ${verdicts.filter((v) => v.nameFits).length}; sheets left ${pendingSheets(index, file.verdicts).length}`,
  );
}

if (isMain) await main();
